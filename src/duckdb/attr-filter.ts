/**
 * 属性筛选下推（SQL）：把 geo-processing 的 matchSelect 语义翻译成 DuckDB WHERE 子句，并执行全表筛选。
 *
 * ## 为什么需要
 * 大图层（`materialized === false`）的 `layer.geojson` **只是上图抽样**（≤ engine.threshold 行，
 * 默认 5 万），真数据在 DuckDB 内存表里。Turf 路线（opSelectByValue）只遍历 geojson，
 * 在 60 万行的 shp 上会**静默**给出"基于 5 万抽样"的结果——命中集看起来完全正常，实际是错的。
 * 下推后由 DuckDB 在全表上执行，`webgis_select_by_value` 命中大图层时自动改道到这里。
 *
 * ## 语义保真
 * `selectWhereSql` 逐条对齐 matchSelect/matchSelect 依赖的 normEq，**包括它们的怪癖**：
 * - `isNull = (值 == null || 值 === '')`：空字符串在 matchSelect 里也算缺失；
 * - 「数值比较」的前置是**两边都能解析为有限数**：JS `Number()` 不认 `'0x10'`，
 *   且 `Infinity`/`NaN` 不算有限数 → 用 `try_cast` + `isfinite`，不用裸 `CAST`；
 * - `gt/gte/lt/lte` 在任一侧非数值时，落到字符串分支的 `default` → **恒 false**；
 * - `in` 逐候选走 normEq（先字面量比、再数值比）。normEq 有 `Number(null) === 0` 的强转，
 *   所以候选里出现 `'0'`/`''` 时，NULL 与空字符串也算命中——**这是 JS 行为，如实翻译，不擅自"修正"**，
 *   否则大图层与小图层会给出不同的命中集（那比"口径怪"更糟）。
 *
 * 已知的刻意分歧（见 tests/attr-filter.test.mjs 的 KNOWN_DIVERGENCE）：**进制前缀字符串**
 * ——`'0x10'`/`'0b101'`/`'0o17'` 在 JS 里 `Number()` 能解析成整数，DuckDB 的 `try_cast` 给 NULL，
 * 于是这类值在比较类运算符下 JS 走数值路径、SQL 走文本路径。GIS 属性数据里不出现，不为此加 SQL 分支。
 * 改本文件必须同步跑那个测试。
 */
import type { FeatureCollection } from 'geojson'
import type { GisLayer, SelectOperator } from '../geo-processing.js'
import type { FullTableAttrFilter } from '../geo-tools-runtime.js'
import type { DuckDbEngine } from './engine.js'
import {
  buildGeomSelect, DUCK_RID, friendlyDuckError, geometryRowsToGeoJSON, quoteIdent, rowsToGeoJSON,
} from './geometry.js'
import type { DuckGeomSpec } from './types.js'
import { escIdent, inlineValue } from './filters.js'
import { geomFamiliesOf, geomFamiliesOfWkb, geometrySampleRows, type GeomFamily } from './sampling.js'

/** 与 matchSelect 的 isNull 对齐：NULL 或空字符串都算缺失。 */
function isNullSql(c: string): string {
  return `(${c} IS NULL OR CAST(${c} AS VARCHAR) = '')`
}

/**
 * 与 matchSelect 的「可解析为有限数」对齐：try_cast 成功、非 inf/nan、且不是空字符串。
 * `try_cast('Infinity' AS DOUBLE)` 会成功但 JS 的 Number.isFinite 为 false → 必须加 isfinite。
 */
function isNumSql(c: string): string {
  return `(try_cast(${c} AS DOUBLE) IS NOT NULL AND isfinite(try_cast(${c} AS DOUBLE)) AND CAST(${c} AS VARCHAR) <> '')`
}

/** 数值列取值（仅在 isNumSql 为真时有意义）。 */
function numOf(c: string): string {
  return `try_cast(${c} AS DOUBLE)`
}

/**
 * 文本类分支下「值 → 文本」的渲染，对齐 JS 的 `String(x)`。
 *
 * 关键：**取决于列的声明类型，不能用 try_cast 猜**。JS 侧的值来自 Arrow——数值列给 number
 * （`String(12)` = `'12'`），文本列给 string（`String('012')` = `'012'`，前导零保留）。
 * 用 try_cast 去猜会把 VARCHAR 的 `'012'` 也"重渲染"成 `'12'`，静默改掉用户数据的语义。
 *
 * - 数值列：DuckDB `CAST(12.0 AS VARCHAR)` 多出小数尾巴 `'12.0'`，会让 `contains '0'` /
 *   `ends_with '0'` 把整数型 DOUBLE 全算命中 → 整数先转 BIGINT 再转文本。
 * - 文本列：原样 CAST，一个字符都不动。
 *
 * 已知残余分歧：`1e-7` 这类极小值 JS 给 `'1e-7'`、DuckDB 给 `'1e-07'`（指数补零）。
 * 属文本类运算符 + 极端浮点的角落，不再特殊处理。
 */
function jsTextOf(c: string, kind: ColumnKind): string {
  if (kind === 'text') return `CAST(${c} AS VARCHAR)`
  const n = numOf(c)
  return `(CASE WHEN ${n} = trunc(${n}) AND abs(${n}) < 1e15`
    + ` THEN CAST(CAST(${n} AS BIGINT) AS VARCHAR) ELSE CAST(${c} AS VARCHAR) END)`
}

/** DuckDB 列类型 → 该列的值在 JS 侧是什么（决定文本渲染与数值路径的走向）。 */
export function columnKindOf(duckType: string): ColumnKind {
  return /^(U?(TINY|SMALL|BIG|HUGE)?INT|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/i.test(duckType.trim())
    ? 'number'
    : 'text'
}

/** LIKE 元字符转义，配 ESCAPE '\'（否则用户搜 "50%" 会变成通配）。 */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * matchSelect 的 in 分支：`value.split(',').map(trim).some(v => normEq(actual, v))`。
 * `!value` 直接 false（空串也是 falsy），与 JS 一致。
 */
function inSql(c: string, value: string | undefined, kind: ColumnKind): string {
  if (!value) return 'FALSE'
  const parts: string[] = []
  const text = jsTextOf(c, kind)
  for (const cand of value.split(',').map((s) => s.trim())) {
    // normEq 第一步：String(actual) === cand
    parts.push(`${text} = ${inlineValue(cand)}`)
    // normEq 第二步：两边都能解析为有限数时按数值比
    const n = Number(cand)
    if (Number.isFinite(n)) {
      parts.push(`(${isNumSql(c)} AND ${numOf(c)} = ${inlineValue(n)})`)
      // normEq 的强转：Number(null) === Number('') === 0 → 候选为 0 时，NULL/空串也算命中
      if (n === 0) parts.push(isNullSql(c))
    }
    // String(null) === 'null'
    if (cand === 'null') parts.push(`${c} IS NULL`)
  }
  return `(${parts.join(' OR ')})`
}

/** 列在 JS 侧的取值形态（由 DuckDB 列类型决定，见 columnKindOf）。 */
export type ColumnKind = 'text' | 'number'

/**
 * 把 matchSelect(field, operator, value) 翻译为 DuckDB WHERE 子句正文（**不带前导 WHERE**）。
 * 返回的子句在任意行上的真值 === matchSelect(该行该列值, operator, value)。
 *
 * `kind` 必须传实际列类型（用 columnKindOf(duckType) 得到）——它决定文本渲染方式，
 * 猜错会静默改掉数据语义（见 jsTextOf）。
 */
export function selectWhereSql(
  field: string,
  operator: SelectOperator,
  value: string | undefined,
  kind: ColumnKind,
): string {
  const c = escIdent(field)
  // is_null / not_null / in 在 matchSelect 里先于 isNull 短路返回，单独处理。
  if (operator === 'is_null') return isNullSql(c)
  if (operator === 'not_null') return `(NOT ${isNullSql(c)})`
  if (operator === 'in') return inSql(c, value, kind)

  // 比较类运算符：null/'' 一律不命中（matchSelect 的 `if (isNull) return false`）。
  const notNull = `(NOT ${isNullSql(c)})`
  const v = value
  // vn：JS 侧 `value === undefined || value === '' ? NaN : Number(value)`
  const vn = v === undefined || v === '' ? NaN : Number(v)
  const vnFinite = Number.isFinite(vn)
  const textOf = (): string => jsTextOf(c, kind)

  switch (operator) {
    case 'eq':
      // an===vn（数值路径）或 s===value（文本路径）；`an` 非有限时只走文本路径。
      return vnFinite
        ? `(${notNull} AND ((${isNumSql(c)} AND ${numOf(c)} = ${inlineValue(vn)}) OR ((NOT ${isNumSql(c)}) AND ${textOf()} = ${inlineValue(v)})))`
        : `(${notNull} AND ${textOf()} = ${inlineValue(v ?? '')})`
    case 'neq':
      // an!==vn（数值路径）或 s!==value（文本路径）
      return vnFinite
        ? `(${notNull} AND ((${isNumSql(c)} AND ${numOf(c)} <> ${inlineValue(vn)}) OR ((NOT ${isNumSql(c)}) AND ${textOf()} <> ${inlineValue(v)})))`
        : `(${notNull} AND ${textOf()} <> ${inlineValue(v ?? '')})`
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // 任一侧非数值 → JS 落到字符串分支的 default → 恒 false
      if (!vnFinite) return 'FALSE'
      const op = operator === 'gt' ? '>' : operator === 'gte' ? '>=' : operator === 'lt' ? '<' : '<='
      return `(${notNull} AND ${isNumSql(c)} AND ${numOf(c)} ${op} ${inlineValue(vn)})`
    }
    case 'contains':
    case 'starts_with':
    case 'ends_with': {
      // matchSelect：`value !== undefined && String(actual).op(value)`
      if (v === undefined) return 'FALSE'
      const esc = likeEscape(v)
      const pattern = operator === 'contains' ? `%${esc}%` : operator === 'starts_with' ? `${esc}%` : `%${esc}`
      return `(${notNull} AND ${textOf()} LIKE ${inlineValue(pattern)} ESCAPE '\\')`
    }
    default:
      return 'FALSE'
  }
}

/** 属性筛选全表执行结果（成功）。 */
export interface AttrFilterOk {
  ok: true
  /** 全表命中行数。 */
  count: number
  /** 结果 DuckDB 表名（新图层持有，可继续链式筛选）。 */
  table: string
  /** 上图用 geojson（仍可能只是抽样——与 webgis_filter_layer 同口径）。 */
  geojson: FeatureCollection
  duckGeom?: DuckGeomSpec
  duckCoords?: { lon: string; lat: string }
  message: string
}

export type AttrFilterResult = AttrFilterOk | { ok: false; message: string }

/**
 * 在图层所持 DuckDB 内存表的**全表**上按属性筛选，物化结果表 + 产出上图 geojson。
 *
 * 与 webgis_filter_layer 共用同一套「结果表 + 抽样上图」口径：命中的行全部留在结果表里
 * （可继续链式筛选 / 全量统计），上图只取 ≤ engine.threshold 行（多几何族按族分层抽样）。
 * 调用方负责把返回的 table/geojson 挂到新图层上。
 */
export async function duckAttrFilter(
  engine: DuckDbEngine,
  layer: GisLayer,
  field: string,
  operator: SelectOperator,
  value: string | undefined,
): Promise<AttrFilterResult> {
  const base = layer.duckTable
  if (!base) return { ok: false, message: `图层 ${layer.id} 没有 DuckDB 内存表` }
  const geom = layer.duckGeom
  const coords = layer.duckCoords
  if (!geom && !coords) return { ok: false, message: `图层 ${layer.id} 缺经纬度/几何列信息` }

  const resTable = engine.nextTableName()
  try {
    // 列类型必须从表里查出来传给 selectWhereSql：它决定文本渲染方式（见 jsTextOf）。
    // 查不到（字段名不存在）时按文本处理，让 DuckDB 自己报「列不存在」而不是我们猜错渲染。
    const cols = await engine.describe(base)
    const kind = columnKindOf(cols.find((col) => col.name === field)?.type ?? 'VARCHAR')
    const count = await engine.createFilterTable(resTable, base, `WHERE ${selectWhereSql(field, operator, value, kind)}`)
    const cap = Math.min(count, engine.threshold)
    let fc: FeatureCollection
    if (geom) {
      // 几何列图层：结果表的几何列沿用原格式（geometry / wkb / wkt），重新投影成 geojson。
      const attrs = (await engine.describe(resTable))
        .filter((col) => col.name !== geom.column && col.name !== DUCK_RID)
        .map((col) => col.name)
      const selList = [...attrs.map((a) => quoteIdent(a)), buildGeomSelect(geom.column, geom.format, geom.sourceCrs)].join(', ')
      // 多几何族按族分层抽样：每族都上图，避免只画主族（与 loadVectorSourceData 同口径）。
      const families: GeomFamily[] = geom.format === 'geometry'
        ? await geomFamiliesOf(engine, resTable, geom.column)
        : geom.format === 'wkb'
          ? await geomFamiliesOfWkb(engine, resTable, geom.column)
          : []
      const colToGeom = geom.format === 'wkb' ? (col: string) => `ST_GeomFromWKB(${quoteIdent(col)})` : undefined
      const rows = await geometrySampleRows(engine, resTable, selList, geom.column, families, cap, colToGeom)
      fc = geometryRowsToGeoJSON(rows, attrs)
    } else {
      const rows = await engine.query(resTable, cap > 0 ? `LIMIT ${cap}` : '')
      fc = rowsToGeoJSON(rows, coords!.lon, coords!.lat)
    }
    return {
      ok: true,
      count,
      table: resTable,
      geojson: fc,
      ...(geom ? { duckGeom: geom } : {}),
      ...(coords ? { duckCoords: coords } : {}),
      message: `命中 ${count} 行，上图 ${fc.features.length} 行`,
    }
  } catch (err) {
    // 失败要 DROP 掉半成品结果表，否则内存表泄漏（引擎 LRU 只按上限驱逐）。
    await engine.dropTable(resTable).catch(() => {})
    return { ok: false, message: `筛选失败: ${friendlyDuckError(err)}` }
  }
}

/**
 * 组装 turf 域要用的 `FullTableAttrFilter`（host 在 registerGeoTools 的 deps 里注入）。
 *
 * `getEngine` 是**惰性取值**——注册工具时 DuckDB 引擎可能还没建（首次用到才 getDuckDb()），
 * 传值会在插件启动期就把引擎拉起来。测试与 index.ts 共用这一份，避免两边各写一份接线。
 */
export function createFullTableAttrFilter(getEngine: () => DuckDbEngine): FullTableAttrFilter {
  return async (layer, field, operator, value) => {
    const res = await duckAttrFilter(getEngine(), layer, field, operator as SelectOperator, value)
    if (!res.ok) return res
    return {
      ok: true,
      count: res.count,
      table: res.table,
      geojson: res.geojson,
      message: res.message,
      extra: {
        duckTable: res.table,
        ...(res.duckGeom ? { duckGeom: res.duckGeom } : {}),
        ...(res.duckCoords ? { duckCoords: res.duckCoords } : {}),
        totalCount: res.count,
      },
    }
  }
}
