/**
 * DuckDB 本地 CSV 工具层：把 DuckDB 引擎暴露为 DSH 工具（方案见 D:\dsh webgis\DuckDB实现方案.md）。
 *
 * 阶段 1：`webgis_load_csv`（建表 → 上图，小文件常规加载 / 大文件抽样+聚合）。
 * 阶段 2：`webgis_filter_layer` / `webgis_layer_stats` / `webgis_sql_layer` / `webgis_export_layer`
 *         （筛选 → 新表新图层、统计不建图层、只读 SQL、筛完导出）。
 *
 * 与 geo-tools / db-tools 共用同一条「产出 FeatureCollection → 注册图层(source) → 客户端渲染」
 * 管道，图层 id 前缀 `csv_<n>`。大文件图层带 `duckTable`/`duckCoords` 句柄，被
 * webgis_remove_layer / webgis_clear_layers 移除时经 index.ts 接线的 onRemoveLayer 联动 DROP。
 */
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BBox, Feature, FeatureCollection } from 'geojson'
import type { GisLayer } from './geo-processing.js'
import { makeResultLayer, requireLayer } from './geo-processing.js'
import {
  buildGeomSelect,
  detectCoordColumns,
  detectGeomColumn,
  detectGeomFormat,
  DUCK_RID,
  friendlyDuckError,
  geometryRowsToGeoJSON,
  getDuckDb,
  normalizeValue,
  quoteIdent,
  rowsToGeoJSON,
  type DuckColumn,
  type DuckDbEngine,
  type DuckDbOptions,
  type DuckGeomFormat,
  type DuckGeomSpec,
  type VectorTableInfo,
} from './duckdb.js'
import { effectiveCluster, resolveClusterMode, validateSql, type ClusterParam } from './postgis.js'
import { toCsv, toGeoJSON } from './geo-export.js'
import { DECK_FROM } from './render-policy.js'

/** 工具层所需的图层注册表状态（index.ts 传入的 state 结构上满足此接口）。 */
export interface DuckToolsState {
  layers: GisLayer[]
}

export interface DuckDbToolsOptions {
  duckdb?: DuckDbOptions
  /** 测试注入独立引擎（进程级懒单例的阈值无法在单测里隔离）；缺省用 getDuckDb()。 */
  engine?: DuckDbEngine
}

/** CSV 来源图层默认颜色（绿色；区别于 postgis 橙 / gis-result 蓝）。 */
const CSV_COLOR = '#10b981'

/** 结果图层 id 递增计数器（进程内）。 */
let csvSeq = 0

/** webgis_sql_layer 的结果行数硬上限（用户 limit 可调到的最大值）。 */
const MAX_SQL_ROWS = 50000

/** 几何“族”（deck 一族一层 / arrow 只吃单族的划分单位；Multi* 归并到单件族）。 */
export type GeomFamily = 'point' | 'line' | 'polygon'

/** 族 → duckdb spatial 的 ST_GeometryType 返回串（大写）。 */
const FAMILY_GEOM_TYPES: Record<GeomFamily, string[]> = {
  point: ['POINT', 'MULTIPOINT'],
  line: ['LINESTRING', 'MULTILINESTRING'],
  polygon: ['POLYGON', 'MULTIPOLYGON'],
}

/** 行数组（ST_GeometryType 结果）→ 几何族集合（Multi* 归并到单件族）。 */
function rowsToFamilies(rows: Array<Record<string, unknown>>): GeomFamily[] {
  const fams = new Set<GeomFamily>()
  for (const r of rows) {
    const t = String(r.t ?? '').toUpperCase()
    for (const [fam, types] of Object.entries(FAMILY_GEOM_TYPES)) {
      if ((types as string[]).includes(t)) fams.add(fam as GeomFamily)
    }
  }
  return [...fams]
}

/** 表里 GEOMETRY 列的几何族集合（空表/出错返回 []；需 spatial 扩展）。 */
export async function geomFamiliesOf(engine: DuckDbEngine, table: string, col: string): Promise<GeomFamily[]> {
  try {
    const rows = await engine.run(
      `SELECT DISTINCT ST_GeometryType(${quoteIdent(col)}) AS t FROM ${table} WHERE ${quoteIdent(col)} IS NOT NULL`,
    )
    return rowsToFamilies(rows)
  } catch {
    return []
  }
}

/** duckGeom 层几何族（兼容 WKT/WKB 列：先转几何再 ST_GeometryType；GEOMETRY 列直用）。
 *  空表/出错返回 []。需 spatial 扩展。 */
export async function duckGeomFamiliesOf(
  engine: DuckDbEngine,
  table: string,
  spec: DuckGeomSpec,
): Promise<GeomFamily[]> {
  try {
    const inner = geomExprOfCol(spec.column, spec.format) // 只做格式解析，不做 CRS 变换（族与 CRS 无关）
    const rows = await engine.run(
      `SELECT DISTINCT ST_GeometryType(${inner}) AS t FROM ${table} WHERE ${quoteIdent(spec.column)} IS NOT NULL`,
    )
    return rowsToFamilies(rows)
  } catch {
    return []
  }
}

/** WKB BLOB 几何列的几何族集合（先 ST_GeomFromWKB 再 ST_GeometryType；空表/出错返回 []；需 spatial）。 */
export async function geomFamiliesOfWkb(engine: DuckDbEngine, table: string, col: string): Promise<GeomFamily[]> {
  return duckGeomFamiliesOf(engine, table, { column: col, format: 'wkb', sourceCrs: null })
}

function familyWhere(geomSql: string, fam: GeomFamily): string {
  return `ST_GeometryType(${geomSql}) IN (${FAMILY_GEOM_TYPES[fam].map((t) => `'${t}'`).join(', ')})`
}

/**
 * 几何列抽样：多族时**各族各抽一份再合并**（保证每族都上图，不静默丢族）；单族/未知退化为 USING SAMPLE。
 * colToGeom 可选：把列名转成可被 ST_GeometryType 包裹的几何表达式（WKB BLOB 列需 ST_GeomFromWKB(col)，
 * GEOMETRY 列/缺省直接引用列本身）。分层 WHERE 只判断族、不改输出（selList 已含 CRS 转换）。
 */
async function geometrySampleRows(
  engine: DuckDbEngine,
  table: string,
  selList: string,
  col: string,
  families: GeomFamily[],
  maxRows: number,
  colToGeom?: (col: string) => string,
): Promise<Array<Record<string, unknown>>> {
  if (families.length <= 1) {
    return engine.run(`SELECT ${selList} FROM ${table} USING SAMPLE ${Math.max(1, maxRows)} ROWS`)
  }
  const geomSql = colToGeom ? colToGeom(col) : quoteIdent(col)
  const per = Math.max(1, Math.floor(maxRows / families.length))
  const parts = families.map((f) => `(SELECT ${selList} FROM ${table} WHERE ${familyWhere(geomSql, f)} USING SAMPLE ${per} ROWS)`)
  return engine.run(parts.join(' UNION ALL '))
}

/** loadCsvSourceData 的产出：CSV → 图层显示的抽样/全量 geojson + 可选 duck 句柄。 */
export interface CsvLayerData {
  totalCount: number
  geojson: FeatureCollection
  duckTable?: string
  duckCoords?: { lon: string; lat: string }
  duckGeom?: DuckGeomSpec
  families?: GeomFamily[]
  /** 是否已全量物化（≤ 阈值小文件：不留内存表、geojson 即全部）。 */
  small: boolean
  /** 追加到返回 message 的说明片段（大文件抽样提示）。 */
  note: string
}

/**
 * CSV 文件 → DuckDB 建表 → 图层数据（load_dataset 大 CSV 走这里防 JS 整表物化 OOM；
 * 与 webgis_load_csv 共用 createTableFromCsv 与列识别/几何 CRS 逻辑）。
 * sourcePath 为本地路径（支持 *.csv 通配）。≤阈值小文件全量物化并 DROP 表；大文件留表 + 抽样 geojson。
 * 仅自动识别（无显式 lon/geometryColumn/filter/limit）——分析型参数仍走 webgis_load_csv。
 */
export async function loadCsvSourceData(engine: DuckDbEngine, sourcePath: string): Promise<CsvLayerData> {
  const table = engine.nextTableName()
  let info: { count: number; columns: string[] }
  try {
    info = await engine.createTableFromCsv(table, sourcePath)
  } catch (err) {
    await engine.dropTable(table).catch(() => {})
    throw new Error(csvLoadError(err))
  }
  const small = info.count <= engine.threshold
  const desc = await engine.describe(table)
  const coords = detectCoordColumns(info.columns)
  const autoGeom = coords.lon && coords.lat ? null : detectGeomColumn(desc)
  const geomCol = autoGeom ? desc.find((c) => c.name === autoGeom) ?? null : null
  const geomFormat = geomCol ? detectGeomFormat(geomCol) : null
  try {
    if (geomCol && geomFormat) {
      if (!(await engine.ensureSpatial())) {
        await engine.dropTable(table).catch(() => {})
        throw new Error('CSV 几何列上图需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）')
      }
      let sourceCrs: string | null = null
      if (geomFormat === 'geometry') {
        const crsInfo = await engine.detectSourceCrs(table, geomCol.name)
        if (crsInfo.mixed) {
          await engine.dropTable(table).catch(() => {})
          throw new Error(
            `CSV 几何列 ${geomCol.name} 含多个 SRID（${crsInfo.srids.join(', ')}）：请先清洗数据或改用 webgis_load_csv 显式传 sourceCrs`,
          )
        }
        sourceCrs = crsInfo.crs
      }
      const families = geomFormat === 'geometry' ? await geomFamiliesOf(engine, table, geomCol.name) : []
      const attrs = info.columns.filter((c) => c !== geomCol.name && c !== DUCK_RID)
      const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(geomCol.name, geomFormat, sourceCrs)].join(', ')
      let geojson: FeatureCollection
      let duckTable: string | undefined
      if (small) {
        geojson = geometryRowsToGeoJSON(await engine.run(`SELECT ${selList} FROM ${table}`), attrs)
        await engine.dropTable(table)
      } else {
        geojson = geometryRowsToGeoJSON(
          await geometrySampleRows(engine, table, selList, geomCol.name, families, engine.threshold),
          attrs,
        )
        duckTable = table
      }
      const crsPart = sourceCrs && sourceCrs !== 'EPSG:4326' ? `，几何列已从 ${sourceCrs} 转 4326` : ''
      return {
        totalCount: info.count,
        geojson,
        duckTable,
        duckGeom: { column: geomCol.name, format: geomFormat, sourceCrs },
        families: families.length > 1 ? families : undefined,
        small,
        note: small ? '' : `（共 ${info.count} 行，抽样上图 ${geojson.features.length} 行${crsPart}）`,
      }
    }
    const lon = coords.lon
    const lat = coords.lat
    if (!lon || !lat) {
      await engine.dropTable(table).catch(() => {})
      throw new Error(`CSV 未找到经纬度列或可自动识别的几何列（列：${info.columns.join(', ')}）`)
    }
    let geojson: FeatureCollection
    let duckTable: string | undefined
    if (small) {
      geojson = rowsToGeoJSON(await engine.query(table, ''), lon, lat)
      await engine.dropTable(table)
    } else {
      geojson = rowsToGeoJSON(await engine.run(`SELECT * FROM ${table} USING SAMPLE ${engine.threshold} ROWS`), lon, lat)
      duckTable = table
    }
    return {
      totalCount: info.count,
      geojson,
      duckTable,
      duckCoords: { lon, lat },
      small,
      note: small ? '' : `（共 ${info.count} 行，抽样上图 ${geojson.features.length} 行）`,
    }
  } catch (err) {
    await engine.dropTable(table).catch(() => {})
    throw err
  }
}

/** 本地矢量文件扩展名集合（DuckDB spatial ST_Read/GDAL 直读；webgis_load_dataset 路由用）。 */
export const VECTOR_SOURCE_EXTS = ['shp', 'gdb', 'gpkg', 'kml', 'tab', 'mif', 'dgn']

/** loadVectorSourceData 的输入：路径 + 可选图层/源坐标系。 */
export interface VectorSourceDataOpts {
  /** GDB/GPKG 等多图层源的 GDAL 图层名（缺省读第一层）。 */
  layer?: string
  /** 源坐标系（如 EPSG:3857，转 4326 上图；缺省按 WGS84 解释）。 */
  sourceCrs?: string | null
}

/** loadVectorSourceData 的产出：矢量 → 图层显示的抽样/全量 geojson + 可选 duck 句柄（无 duckCoords 点列，几何列即源）。 */
export type VectorLayerData = Omit<CsvLayerData, 'duckCoords'>

/**
 * 本地矢量文件（.shp/.gdb/.gpkg/.kml/.tab/.mif…）→ DuckDB spatial `ST_Read` 直读建表 → 图层数据。
 * 超大 .shp 不再先经 shpjs 把全量要素物化成 JS geojson——GDAL 侧一次扫描建内存表，大文件留表 + 抽样上图。
 * ≤阈值小文件全量物化并 DROP 表。几何列 format 按实际检出（GEOMETRY 或 WKB BLOB）：
 * sourceCrs 显式传入优先；GEOMETRY 列 ST_SRID 自动检出（本 duckdb 若无 st_srid 函数则返回 null 按 WGS84）。
 * 多几何族（Point+Polygon 混合）走族分层抽样 + families 标注（makeResultLayer 据此禁 Arrow）。
 */
export async function loadVectorSourceData(
  engine: DuckDbEngine,
  path: string,
  opts: VectorSourceDataOpts = {},
): Promise<VectorLayerData> {
  const table = engine.nextTableName()
  let created: VectorTableInfo
  try {
    created = await engine.createTableFromVector(table, path, { layer: opts.layer })
  } catch (err) {
    await engine.dropTable(table).catch(() => {})
    throw err
  }
  const small = created.count <= engine.threshold
  const geomName = created.geomCol
  const geomFormat = created.geomFormat
  if (!geomName || !geomFormat) {
    await engine.dropTable(table).catch(() => {})
    throw new Error(`矢量文件「${path}」没有可自动识别的几何列（列：${created.columns.join(', ')}）`)
  }
  const attrs = created.columns.filter((c) => c !== geomName && c !== DUCK_RID)
  try {
    let sourceCrs = typeof opts.sourceCrs === 'string' && opts.sourceCrs ? opts.sourceCrs : null
    if (sourceCrs == null && geomFormat === 'geometry') {
      const crsInfo = await engine.detectSourceCrs(table, geomName)
      if (crsInfo.mixed) {
        await engine.dropTable(table).catch(() => {})
        throw new Error(
          `矢量几何列 ${geomName} 含多个 SRID（${crsInfo.srids.join(', ')}）：不自动整列重投影，请显式传 sourceCrs 或先清洗数据`,
        )
      }
      sourceCrs = crsInfo.crs
    }
    const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(geomName, geomFormat, sourceCrs)].join(', ')
    let geojson: FeatureCollection
    let duckTable: string | undefined
    let families: GeomFamily[] | undefined
    if (small) {
      geojson = geometryRowsToGeoJSON(await engine.run(`SELECT ${selList} FROM ${table}`), attrs)
      await engine.dropTable(table)
    } else {
      // 几何族（全量统计；多族分层抽样每族都上图 + 禁 Arrow）：WKB BLOB 列要先 ST_GeomFromWKB 才能 ST_GeometryType。
      families = geomFormat === 'geometry'
        ? await geomFamiliesOf(engine, table, geomName)
        : geomFormat === 'wkb'
          ? await geomFamiliesOfWkb(engine, table, geomName)
          : []
      const colToGeom = geomFormat === 'wkb' ? (c: string) => `ST_GeomFromWKB(${quoteIdent(c)})` : undefined
      geojson = geometryRowsToGeoJSON(
        await geometrySampleRows(engine, table, selList, geomName, families, engine.threshold, colToGeom),
        attrs,
      )
      duckTable = table
    }
    const crsPart = sourceCrs && sourceCrs !== 'EPSG:4326' ? `，几何已从 ${sourceCrs} 转 4326` : ''
    return {
      totalCount: created.count,
      geojson,
      duckTable,
      duckGeom: { column: geomName, format: geomFormat, sourceCrs },
      ...(families && families.length > 1 ? { families } : {}),
      small,
      note: small ? '' : `（共 ${created.count} 行，抽样上图 ${geojson.features.length} 行${crsPart}）`,
    }
  } catch (err) {
    await engine.dropTable(table).catch(() => {})
    throw err
  }
}

/** ingestBigGeojson 的产出：大 SHP/GeoJSON 灌表后图层所需句柄 + 上图抽样。 */
export interface IngestBigResult {
  duckTable: string
  duckGeom: DuckGeomSpec
  totalCount: number
  /** 上图抽样（≤ threshold 行，多族分层抽样已含每族）。 */
  geojson: FeatureCollection
  /** duck 表几何族（多族时 makeResultLayer 禁 Arrow——arrow 只能编单族，避免静默丢族）。 */
  families?: GeomFamily[]
}

/**
 * 大数据统一加载（SHP/GeoJSON/上传共用）：要素 >10 万（DECK_FROM）→ 灌进 DuckDB 内存表，
 * 挂 duckTable/duckGeom → 图层走 arrow + zoom 分级 + worker earcut（与 webgis_load_csv 大文件一致）。
 * ≤10 万返回 null（保持纯 geojson，走 maplibre）。无几何列的大纯属性数据回退 null。
 * 多几何族 / 混合 SRID 时不走 Arrow（分别回退 geojson 分层渲染 / 整体回退），避免静默丢族或乱重投影。
 * 调用方在图层移除时经 dropLayerResources 联动 DROP 内存表。
 */
export async function ingestBigGeojson(
  fc: FeatureCollection,
  engine: DuckDbEngine = getDuckDb(),
  minRows: number = DECK_FROM,
): Promise<IngestBigResult | null> {
  const totalCount = fc.features.length
  if (totalCount <= minRows) return null
  const table = engine.nextTableName()
  const { geomColumn } = await engine.createTableFromGeoJson(table, fc)
  if (!geomColumn) {
    await engine.dropTable(table).catch(() => {})
    return null
  }
  const crsInfo = await engine.detectSourceCrs(table, geomColumn)
  if (crsInfo.mixed) {
    // 混合 SRID 且无显式指定：自动整列重投影会把其中一部分转错坐标系 → 拒绝，回退纯 geojson 渲染。
    console.warn(`[webgis] 数据集含多个 SRID（${crsInfo.srids.join(', ')}），跳过自动重投影与 Arrow，回退抽样 geojson 上图`)
    await engine.dropTable(table).catch(() => {})
    return null
  }
  const sourceCrs = crsInfo.crs
  // 几何族（全量统计）：多族时按族分层抽样（每族都上图）并把 Arrow 留给单族。
  const families = await geomFamiliesOf(engine, table, geomColumn)
  // 上图抽样 geojson（≤ threshold 行）；全量数据留在 duckTable，arrow 按 zoom 分级拉取。
  const attrs = (await engine.describe(table)).filter((c) => c.name !== geomColumn && c.name !== DUCK_RID).map((c) => c.name)
  const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(geomColumn, 'geometry', sourceCrs)].join(', ')
  const rows = await geometrySampleRows(engine, table, selList, geomColumn, families, engine.threshold)
  const geojson = geometryRowsToGeoJSON(rows, attrs)
  return {
    duckTable: table,
    duckGeom: { column: geomColumn, format: 'geometry', sourceCrs },
    totalCount,
    geojson,
    ...(families.length > 1 ? { families } : {}),
  }
}

function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** 幂等读查询带 1 次短退避重试：layer_stats 这类轻 SQL 在低资源/全量测试下偶发 native 抖动，
 *  重试一次即稳定（纯读无副作用）。 */
async function runDuckRetry(engine: DuckDbEngine, sql: string, tries = 2): Promise<Awaited<ReturnType<DuckDbEngine['run']>>> {
  for (let i = 0; i < tries; i++) {
    try {
      return await engine.run(sql)
    } catch (err) {
      if (i === tries - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw new Error('unreachable')
}

/** load_csv 系列失败文案：按错误类型给可行动提示（temp/内存/超时各给对应建议），其余建议 load_dataset。 */
function csvLoadError(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err)
  const base = `DuckDB 加载 CSV 失败: ${friendlyDuckError(err)}`
  if (/超时|timeout/i.test(msg)) {
    return `${base}（建表超时：千万级 × 多列大文件需较长时间，引擎已放宽到 5 分钟；仍超时可调大 duckdb.memoryLimit 减少落盘、或先按地市拆分文件）`
  }
  if (/temp|temporary|memory|out of memory/i.test(msg)) {
    return `${base}（疑似内存/临时目录问题：已把 temp_directory 指到系统临时目录；仍失败请调大 duckdb.memoryLimit 或减小加载规模）`
  }
  return `${base}（可改用 webgis_load_dataset 走常规导入）`
}

/** 数值化；非法返回 null。 */
function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 正整数化；非法返回 null。 */
function finiteInt(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
}

/** SQL 字符串字面量（单引号翻倍转义）——engine 侧不绑定参数，DDL 场景内联更稳。 */
function inlineValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  return `'${String(v).replace(/'/g, "''")}'`
}

/** SQL 标识符（列名）双引号转义，兼容中文/大写/保留字列名。 */
function escIdent(k: string): string {
  return `"${k.replace(/"/g, '""')}"`
}

/** 等于筛选子句（where/filter JSON 对象，多字段取交集，返回不带 WHERE 的列等条件；空则 ''）。几何图层（无经纬度列）也能用。 */
function buildEqualityClause(args: Record<string, unknown>): string {
  const parts: string[] = []
  // 等于筛选：filter_layer 用 where，load_csv 用 filter（同一个 JSON 对象形状）。
  const eq = args.where ?? args.filter
  if (eq && typeof eq === 'object' && !Array.isArray(eq)) {
    for (const [k, v] of Object.entries(eq as Record<string, unknown>)) {
      if (v === undefined || v === null) continue
      parts.push(`${escIdent(k)} = ${inlineValue(v)}`)
    }
  }
  return parts.join(' AND ')
}

/**
 * 把筛选参数（where 等于 / bbox 范围 / radius 半径）拼成内联 WHERE 子句（无则返回 ''）。
 * 值全部转义 + 列名双引号转义，无注入面；半径用 haversine 大圆距离 SQL。bbox/radius 需要经纬度列。
 */
function buildFilterClause(args: Record<string, unknown>, coords: { lon: string; lat: string }): string {
  const parts: string[] = []
  const eq = buildEqualityClause(args)
  if (eq) parts.push(`(${eq})`)
  const bb = args.bbox as { west?: unknown; south?: unknown; east?: unknown; north?: unknown } | undefined
  if (bb && typeof bb === 'object') {
    const west = num(bb.west); const south = num(bb.south)
    const east = num(bb.east); const north = num(bb.north)
    if (west == null || south == null || east == null || north == null) {
      throw new Error('bbox 需提供 west/south/east/north 四个数值')
    }
    parts.push(`${escIdent(coords.lon)} BETWEEN ${west} AND ${east}`)
    parts.push(`${escIdent(coords.lat)} BETWEEN ${south} AND ${north}`)
  }
  const center = args.center as { lon?: unknown; lat?: unknown } | undefined
  const radius = num(args.radius)
  if (center != null || radius != null) {
    const clon = num(center?.lon); const clat = num(center?.lat)
    if (clon == null || clat == null || radius == null) {
      throw new Error('radius 需配 center={lon,lat} 和米制半径')
    }
    const latQ = escIdent(coords.lat); const lonQ = escIdent(coords.lon)
    parts.push(
      `(6371008.8 * acos(least(1.0, greatest(-1.0, `
      + `sin(radians(${latQ})) * sin(radians(${clat})) + `
      + `cos(radians(${latQ})) * cos(radians(${clat})) * cos(radians(${lonQ}) - radians(${clon}))`
      + `)))) <= ${radius}`,
    )
  }
  return parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : ''
}

/** 预览行 JSON 安全化（复用 duckdb.normalizeValue：BigInt/Date/二进制/Interval/List/Struct 归一化）。 */
function sanitizeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) out[k] = normalizeValue(v)
    return out
  })
}

/** GeoJSON Polygon / MultiPolygon → WKT（坐标转 [lon lat] 对）。不支持返回 null。 */
function geojsonToWkt(geom: unknown): string | null {
  if (!geom || typeof geom !== 'object') return null
  const g = geom as { type?: string; coordinates?: unknown }
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    const rings = (g.coordinates as unknown[][]).map((ring) =>
      `(${(ring as number[][]).map((p) => `${p[0]} ${p[1]}`).join(', ')})`,
    )
    return `POLYGON(${rings.join(', ')})`
  }
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    const polys = (g.coordinates as unknown[][][]).map((poly) =>
      `(${(poly as unknown[][]).map((ring) =>
        `(${(ring as number[][]).map((p) => `${p[0]} ${p[1]}`).join(', ')})`,
      ).join(', ')})`,
    )
    return `MULTIPOLYGON(${polys.join(', ')})`
  }
  return null
}

/** 构造围栏（in-polygon）筛选子句：polygon=GeoJSON 面；polygonLayer=取该图层首个面要素作围栏。 */
function buildPolygonClause(
  args: Record<string, unknown>,
  coords: { lon: string; lat: string },
  resolve: (id: unknown) => GisLayer | string,
): string {
  let geom: unknown
  const raw = args.polygon
  if (raw && typeof raw === 'object') geom = raw
  const layerId = typeof args.polygonLayer === 'string' && args.polygonLayer ? args.polygonLayer : ''
  if (layerId) {
    const layer = resolve(layerId)
    if (typeof layer === 'string') throw new Error(layer)
    const g = layer.geojson.features
      .find((f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon')?.geometry
    if (!g) throw new Error(`图层 ${layerId} 没有面要素可作围栏`)
    geom = g
  }
  if (geom === undefined) return ''
  const wkt = geojsonToWkt(geom)
  if (!wkt) throw new Error('polygon 需要是 GeoJSON 的 Polygon / MultiPolygon 几何')
  return `ST_Within(ST_Point(${escIdent(coords.lon)}, ${escIdent(coords.lat)}), ST_GeomFromText(${inlineValue(wkt)})::GEOMETRY)`
}

// ============================================================================
// 空间分析工具（webgis_spatial_filter / webgis_spatial_aggregate）共享 helper。
// 语义：DuckDB 管「全表/大表的空间筛选/相交/聚合」，Turf 管筛小后的探索制图。
// 距离统一 haversine 球面（米，地球半径 6371008.8，与 buildFilterClause 一致）。
// 不引导对百万几何全量 buffer 并宣称全量上图——结果一律带 scope/sourceCount/resultCount/
// displayedCount/note（full_table / filtered / sample_display）。
// ============================================================================

/** intersects_layer：对方图层为纯 GeoJSON（无 duckTable）时允许的最大要素数。 */
const SPATIAL_TEMP_MAX = 20000
/** spatial_aggregate attribute 分组上限。 */
const AGG_GROUP_LIMIT = 2000
/** grid 聚合默认格子尺寸（米）与格子数上限。 */
const GRID_DEFAULT_CELL_M = 1000
const GRID_DEFAULT_MAX_CELLS = 2000
const GRID_MAX_CELLS = 100000

/** 图层「内存表几何源」的两种形态：经纬度点列（duckCoords）或几何列（duckGeom）。 */
interface DuckGeomSource {
  coords?: { lon: string; lat: string }
  geom?: DuckGeomSpec
}

/** SQL 标识符（列/表）引用：可选表限定（JOIN 消歧）。 */
function qref(name: string, qual?: string): string {
  return qual ? `${quoteIdent(qual)}.${quoteIdent(name)}` : quoteIdent(name)
}

/** 几何列 → 可被 ST_* 包裹的解析表达式（只做格式解析，不做 CRS 变换）。 */
function geomExprOfCol(col: string, format: DuckGeomFormat): string {
  const id = quoteIdent(col)
  if (format === 'geometry') return id
  if (format === 'wkt') return `ST_GeomFromText(regexp_replace(${id}, '^SRID=\\\\d+;', ''))`
  return `ST_GeomFromWKB(${id})`
}

/** 几何列 → ST_* 表达式（含可选表限定 + CRS 归一化到 4326）。与 duckdb.buildGeomExpr 对齐。 */
function geomExprFor(spec: DuckGeomSpec, qual?: string): string {
  const id = qref(spec.column, qual)
  let g: string
  if (spec.format === 'geometry') g = id
  else if (spec.format === 'wkt') g = `ST_GeomFromText(regexp_replace(${id}, '^SRID=\\\\d+;', ''))`
  else g = `ST_GeomFromWKB(${id})`
  const src = spec.sourceCrs
  if (src && src !== 'EPSG:4326' && src !== '4326') {
    g = `ST_Transform(${g}, '${src.replace(/'/g, '')}', 'EPSG:4326', true)`
  }
  return g
}

/** 图层一行 → 4326 几何表达式（duckCoords → ST_Point(lon,lat)；duckGeom → 几何列）。 */
function rowGeomExprOf(src: DuckGeomSource, qual?: string): string {
  if (src.coords) return `ST_Point(${qref(src.coords.lon, qual)}, ${qref(src.coords.lat, qual)})`
  if (src.geom) return geomExprFor(src.geom, qual)
  throw new Error('图层没有可用的几何（缺 duckCoords/duckGeom 句柄）')
}

/** 点化源的行经纬度表达式：duckCoords → 列；duckGeom 点 → ST_X/ST_Y（几何已归一 4326）。 */
function pointLonLatExprOf(src: DuckGeomSource, qual?: string): { lon: string; lat: string } {
  if (src.coords) return { lon: qref(src.coords.lon, qual), lat: qref(src.coords.lat, qual) }
  if (src.geom) {
    const g = geomExprFor(src.geom, qual)
    return { lon: `ST_X(${g})`, lat: `ST_Y(${g})` }
  }
  throw new Error('图层没有可用的几何（缺 duckCoords/duckGeom 句柄）')
}

/** 图层源形状摘要。 */
function duckGeomSourceOf(layer: GisLayer): DuckGeomSource {
  return { coords: layer.duckCoords, geom: layer.duckGeom }
}

/** 等值子句（无 WHERE 前缀的列条件串；空串无）——复用现有 where/filter 形状。 */
function eqClauseText(args: Record<string, unknown>): string {
  return buildEqualityClause(args)
}

/** 拼 WHERE 文本：若干（可空）片段求 AND；空 → ''。 */
function combineWhereText(parts: string[]): string {
  const active = parts.filter((p) => p && p.trim() !== '')
  return active.length > 0 ? `WHERE ${active.map((p) => `(${p})`).join(' AND ')}` : ''
}

/** bbox 经纬度区间谓词。 */
function bboxPredText(lonExpr: string, latExpr: string, bb: { west: number; south: number; east: number; north: number }): string {
  return `${lonExpr} BETWEEN ${bb.west} AND ${bb.east} AND ${latExpr} BETWEEN ${bb.south} AND ${bb.north}`
}

/** haversine 大圆距离（米）≤ radius 谓词。 */
function haversinePredText(lonExpr: string, latExpr: string, clon: number, clat: number, radius: number): string {
  return `(6371008.8 * acos(least(1.0, greatest(-1.0, `
    + `sin(radians(${latExpr})) * sin(radians(${clat})) + `
    + `cos(radians(${latExpr})) * cos(radians(${clat})) * cos(radians(${lonExpr}) - radians(${clon}))`
    + `)))) <= ${radius}`
}

/** 从 polygon GeoJSON / polygonLayer 解析出围栏 WKT（复用 geojsonToWkt；非面抛错）。 */
function fenceWktText(args: Record<string, unknown>, resolve: (id: unknown) => GisLayer | string): string {
  let geom: unknown
  const raw = args.polygon
  if (raw && typeof raw === 'object') geom = raw
  const layerId = typeof args.polygonLayer === 'string' && args.polygonLayer ? args.polygonLayer : ''
  if (layerId) {
    const layer = resolve(layerId)
    if (typeof layer === 'string') throw new Error(layer)
    const g = layer.geojson.features
      .find((f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon')?.geometry
    if (!g) throw new Error(`图层 ${layerId} 没有面要素可作围栏`)
    geom = g
  }
  if (geom === undefined) throw new Error('within_polygon 模式需提供 polygon（GeoJSON 面）或 polygonLayer（面图层 id）')
  const wkt = geojsonToWkt(geom)
  if (!wkt) throw new Error('polygon 需要是 GeoJSON 的 Polygon / MultiPolygon 几何')
  return wkt
}

/** 判定并返回「点化源」的经纬度表达式。非点状几何 → 抛可行动中文错误。 */
async function requirePointableLonLat(
  engine: DuckDbEngine,
  layer: GisLayer,
): Promise<{ lon: string; lat: string }> {
  const src = duckGeomSourceOf(layer)
  if (src.coords) return pointLonLatExprOf(src)
  if (src.geom) {
    if (!layer.duckTable) throw new Error(`图层 ${layer.id} 无内存表，无法判定几何族`)
    const fams = await duckGeomFamiliesOf(engine, layer.duckTable, src.geom)
    if (fams.length === 0) {
      throw new Error(`图层 ${layer.id} 的几何族无法确认（需 DuckDB spatial 扩展读取几何列）。`
        + '可改用 webgis_load_csv 传经纬度列，或先 webgis_spatial_filter 的 intersects_layer/within_polygon 筛出子集。')
    }
    if (!fams.every((f) => f === 'point')) {
      throw new Error(`此操作仅支持点状源：图层 ${layer.id} 几何族为 ${fams.join('/')}（线/面/混合几何无单一中心点）。`
        + '建议：先用 webgis_spatial_filter 的 within_polygon / intersects_layer 筛出子集，'
        + '或图层已较小时用 Turf 工具处理。')
    }
    return pointLonLatExprOf(src)
  }
  throw new Error(`图层 ${layer.id} 没有可用几何（需 duckTable 且含 duckCoords 或 duckGeom）`)
}

/** 源表 bbox（西/南/东/北；空表返回 null）。等值条件可选（作用于 where 子集）。 */
async function tableBBoxOf(
  engine: DuckDbEngine,
  table: string,
  lonExpr: string,
  latExpr: string,
  whereText: string,
): Promise<{ west: number; south: number; east: number; north: number } | null> {
  const rows = await engine.run(
    `SELECT min(${lonExpr}) AS w, min(${latExpr}) AS s, max(${lonExpr}) AS e, max(${latExpr}) AS n FROM ${table} ${whereText}`,
  )
  const r = rows[0] ?? {}
  const w = Number(r.w); const s = Number(r.s); const e = Number(r.e); const n = Number(r.n)
  if (![w, s, e, n].every((v) => Number.isFinite(v))) return null
  return { west: w, south: s, east: e, north: n }
}

/** 聚合 metric 参数解析（[{type,field}]）；缺省 [{type:'count'}]。非法抛中文错误。 */
interface AggMetric {
  type: 'count' | 'countDistinct' | 'sum' | 'avg'
  field?: string
  key: string
  sql: string
}
function parseMetrics(raw: unknown, tableCols: string[]): AggMetric[] {
  const hasCol = (f: string): boolean => f.length > 0 && tableCols.includes(f)
  const items = (Array.isArray(raw) ? raw : raw == null ? [{ type: 'count' }] : [raw]) as Array<Record<string, unknown>>
  if (items.length === 0) items.push({ type: 'count' })
  const out: AggMetric[] = []
  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx]
    if (!it || typeof it !== 'object') throw new Error(`metrics[${idx}] 需要是对象 {type,field?}`)
    const type = String(it.type ?? '')
    if (!['count', 'countDistinct', 'sum', 'avg'].includes(type)) {
      throw new Error(`metrics[${idx}].type 只支持 count/countDistinct/sum/avg，收到 ${type}`)
    }
    const field = it.field === undefined || it.field === null ? '' : String(it.field)
    if (type !== 'count') {
      if (!field) throw new Error(`metrics[${idx}] 的 ${type} 需要 field 列名`)
      if (!hasCol(field)) throw new Error(`metrics[${idx}] 的字段 ${field} 不在图层列里（可用 webgis_layer_stats/图层信息核对列名）`)
    }
    const key = type === 'count' ? 'count' : `${type === 'countDistinct' ? 'distinct' : type}_${field}`
    const fid = quoteIdent(field)
    const sql = type === 'count'
      ? 'count(*)'
      : type === 'countDistinct'
        ? `count(DISTINCT ${fid})`
        : type === 'sum'
          ? `sum(${fid})`
          : `avg(${fid})`
    out.push({ type: type as AggMetric['type'], ...(field ? { field } : {}), key, sql })
  }
  return out
}

/** 把一个数值画成 4326 网格 cell 的 Polygon（近似方形；尺寸在 SQL 侧换算好）。 */
function gridCellPolygon(lng0: number, lat0: number, dLon: number, dLat: number, i: number, j: number): Feature {
  const x0 = lng0 + i * dLon
  const x1 = lng0 + (i + 1) * dLon
  const y0 = lat0 + j * dLat
  const y1 = lat0 + (j + 1) * dLat
  const ring: number[][] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} }
}

export function registerDuckDbTools(
  ctx: Context,
  stateFor: (sessionId: string | undefined) => DuckToolsState,
  opts: DuckDbToolsOptions = {},
): void {
  const engine = opts.engine ?? getDuckDb(opts.duckdb)

  /** 按本次执行的会话 id 解析其图层注册表操作闭包（CSV 图层只写回该会话自己的 state）。 */
  const sess = (exec: { agent?: { id?: string } }) => {
    const st = stateFor(exec.agent?.id)
    const layers = (): GisLayer[] => st.layers
    const resolve = (id: unknown): GisLayer | string => requireLayer(layers(), typeof id === 'string' ? id : '')
    const pushResult = (
      name: string,
      fc: FeatureCollection,
      extra: {
        cluster?: boolean
        duckTable?: string
        duckCoords?: { lon: string; lat: string }
        duckGeom?: DuckGeomSpec
        totalCount?: number
        families?: GeomFamily[]
      },
    ): {
      ok: true; layerId: string; name: string; featureCount: number; bbox: BBox | null; message: string
    } => {
      const id = `csv_${++csvSeq}`
      const layer = makeResultLayer({
        id,
        name,
        geojson: fc,
        source: 'csv',
        color: CSV_COLOR,
        cluster: extra.cluster ?? false,
        duckTable: extra.duckTable,
        duckCoords: extra.duckCoords,
        duckGeom: extra.duckGeom,
        totalCount: extra.totalCount,
        families: extra.families,
      })
      st.layers = [...layers(), layer]
      return {
        ok: true,
        layerId: id,
        name: layer.name,
        featureCount: layer.featureCount,
        bbox: layer.bbox,
        message: `生成图层 ${id}（${layer.featureCount} 个要素）`,
      }
    }
    return { st, layers, resolve, pushResult }
  }

  // ---- 阶段 1：加载 CSV → 建表 → 上图 ----
  ctx.tools.register(defineTool({
    name: 'webgis_load_csv',
    description:
      '把本地 CSV 经 DuckDB 建表后上地图（分析型入口）。大文件（默认超 5 万行）经 DuckDB 内存表秒级建表：自动识别经纬度列'
      + '（lon/lat、longitude/latitude、lng/lat、lon_wgs84/lat_wgs84、lon_/lat_ 前缀），识别失败可显式传 lonField/latField。'
      + 'path 为本地绝对路径，支持 *.csv 通配符合并同结构多文件。'
      + '≤5 万行小文件全部物化上图（常规加载，不占 DuckDB 内存）；大文件抽样显示并开启聚合（supercluster），'
      + '同时保留内存表供 webgis_filter_layer 等继续筛选。'
      + '没有经纬度列时，若存在 WKT/WKB/GEOMETRY 几何列会自动识别上图（任意几何类型，需 spatial 扩展、首次联网），'
      + '可显式传 geometryColumn 指定列、sourceCrs 指定源坐标系（默认按 WGS84；GEOMETRY 列自动 ST_SRID 检出并转 4326）。'
      + 'filter 传初始筛选条件（JSON 对象，等于匹配、多字段取交集），只影响上图子集，内存表保留全量。'
      + '返回图层 source=csv、id 前缀 csv_<n>，可被 webgis_remove_layer 移除（移除时自动释放内存表）。'
      + '经纬度列与几何列都没有时本工具不可用，请改用 webgis_load_dataset 导入通用数据集。',
    parameters: {
      path: {
        type: 'string', required: true,
        description: 'CSV 文件路径（本地绝对路径，如 D:/data/poi.csv；支持 *.csv 通配多个同结构文件）',
      },
      lonField: { type: 'string', description: '经度列名（缺省自动识别 lon/lng/longitude/lon_ 等）' },
      latField: { type: 'string', description: '纬度列名（缺省自动识别 lat/latitude/lat_ 等）' },
      geometryColumn: {
        type: 'string',
        description: '显式指定几何列（含 GEOMETRY/WKT/WKB 数据；缺省先找经纬度列，再自动识别几何列）',
      },
      sourceCrs: {
        type: 'string',
        description: '源坐标系（如 EPSG:3857，转 4326 上图；缺省按 WGS84 解释，GEOMETRY 列自动 ST_SRID 检出）',
      },
      filter: {
        type: 'json',
        description: '初始筛选条件：JSON 对象，形如 {"adname":"天河区"}（等于匹配，多字段取交集）；只影响上图子集',
      },
      limit: { type: 'integer', description: '上图子集行数上限（缺省：≤5 万行全量；大文件抽样 5 万行）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          layerId: { type: 'string' },
          name: { type: 'string' },
          featureCount: { type: 'integer' },
          totalCount: { type: 'integer' },
          table: { type: 'string' },
          bbox: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { pushResult } = sess(exec)
      const path = typeof args.path === 'string' ? args.path.trim() : ''
      if (!path) return { ok: false, message: 'path 不能为空' }

      const table = engine.nextTableName()
      let info: { count: number; columns: string[] }
      try {
        info = await engine.createTableFromCsv(table, path)
      } catch (err) {
        return { ok: false, message: csvLoadError(err) }
      }

      const lonField = typeof args.lonField === 'string' ? args.lonField : undefined
      const latField = typeof args.latField === 'string' ? args.latField : undefined
      const geometryColumn = typeof args.geometryColumn === 'string' && args.geometryColumn ? args.geometryColumn : undefined
      const sourceCrsArg = typeof args.sourceCrs === 'string' && args.sourceCrs ? args.sourceCrs : undefined
      const desc = await engine.describe(table)
      const coords = detectCoordColumns(info.columns, lonField, latField)
      // 几何路径判定：显式 geometryColumn > 经纬度列（现状优先，即使还有几何列也不改）> 自动识别几何列。
      const explicitGeom = geometryColumn ? desc.find((c) => c.name === geometryColumn) : undefined
      let geomCol: DuckColumn | undefined
      let geomFormat: DuckGeomFormat | null = null
      if (explicitGeom) {
        geomCol = explicitGeom
        geomFormat = detectGeomFormat(explicitGeom)
      } else if (!coords.lon || !coords.lat) {
        // 自动识别要 format 也命中（普通 VARCHAR 列如 name 只 +10 分，format 判 null，不当作几何列）。
        const detected = detectGeomColumn(desc)
        if (detected) {
          const c = desc.find((x) => x.name === detected)
          const f = c ? detectGeomFormat(c) : null
          if (c && f) {
            geomCol = c
            geomFormat = f
          }
        }
      }
      if (explicitGeom && !geomFormat) {
        await engine.dropTable(table)
        return {
          ok: false,
          message: `指定几何列 ${geometryColumn} 无法识别格式（类型 ${explicitGeom.type}）；`
            + '需 GEOMETRY 类型或含 WKT/WKB 的字符串列。',
        }
      }
      if (!geomCol && (!coords.lon || !coords.lat)) {
        await engine.dropTable(table)
        return {
          ok: false,
          message: `未找到经纬度列或几何列（现有列：${info.columns.join(', ')}）；可显式传 lonField/latField 或 geometryColumn，`
            + '或改用 webgis_load_dataset 导入。',
        }
      }

      const limit = finiteInt(args.limit)
      const threshold = engine.threshold
      const small = info.count <= threshold
      const base = path.split(/[\\/]/).pop() ?? path

      // ---- 几何列路径：WKT/WKB/GEOMETRY → 任意几何上图 + CRS 归一化（需 spatial）----
      if (geomCol && geomFormat) {
        if (!(await engine.ensureSpatial())) {
          await engine.dropTable(table)
          return {
            ok: false,
            message: '几何列上图需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）；'
              + '当前无法加载，可改用 lon/lat 列或 webgis_load_dataset 导入。',
          }
        }
        // CRS：显式 sourceCrs 优先；GEOMETRY 列自动探测（混合 SRID 拒绝自动整列重投影，提示显式指定）。
        let sourceCrs: string | null = sourceCrsArg ?? null
        if (sourceCrsArg === undefined && geomFormat === 'geometry') {
          const crsInfo = await engine.detectSourceCrs(table, geomCol.name)
          if (crsInfo.mixed) {
            await engine.dropTable(table).catch(() => {})
            return {
              ok: false,
              message: `CSV 几何列 ${geomCol.name} 含多个 SRID（${crsInfo.srids.join(', ')}）：不自动整列重投影，`
                + '请显式传 sourceCrs 或先清洗数据。',
            }
          }
          sourceCrs = crsInfo.crs
        }
        const attrs = info.columns.filter((c) => c !== geomCol.name && c !== DUCK_RID)
        const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(geomCol.name, geomFormat, sourceCrs)].join(', ')
        const where = buildFilterClause(args as Record<string, unknown>, { lon: '', lat: '' })
        // 几何族（仅 geometry 类型列可 ST_GeometryType；多族 → 分层抽样 + 禁 Arrow，避免静默丢族）。
        const families = geomFormat === 'geometry' ? await geomFamiliesOf(engine, table, geomCol.name) : []
        let fc: FeatureCollection
        let duckTable: string | undefined
        try {
          if (small) {
            const cap = Math.min(info.count, limit ?? info.count)
            fc = geometryRowsToGeoJSON(await engine.run(`SELECT ${selList} FROM ${table} ${where} LIMIT ${cap}`), attrs)
            await engine.dropTable(table)
            duckTable = undefined
          } else {
            const sample = Math.min(info.count, limit ?? threshold)
            if (where) {
              // 带初始筛选：样本从筛选后子集取（分布已变，直接单次抽样即可）。
              const src = `(SELECT * FROM ${table} ${where})`
              fc = geometryRowsToGeoJSON(
                await engine.run(`SELECT ${selList} FROM ${src} USING SAMPLE ${Math.max(1, sample)} ROWS`),
                attrs,
              )
            } else {
              // 无筛选：按族分层抽样（每族都上图）。
              fc = geometryRowsToGeoJSON(
                await geometrySampleRows(engine, table, selList, geomCol.name, families, sample),
                attrs,
              )
            }
            duckTable = table
          }
        } catch (err) {
          await engine.dropTable(table).catch(() => {})
          return { ok: false, message: `筛选/物化失败: ${friendlyDuckError(err)}` }
        }
        const crsNote = sourceCrs && sourceCrs !== 'EPSG:4326' ? `（几何列 ${geomCol.name} 已从 ${sourceCrs} 转 4326）` : ''
        const push = pushResult(`CSV - ${base}`, fc, {
          cluster: false,
          duckTable,
          duckGeom: { column: geomCol.name, format: geomFormat, sourceCrs },
          totalCount: info.count,
          ...(families.length > 1 ? { families } : {}),
        })
        return {
          ...push,
          status: small ? 'small' : 'loaded',
          totalCount: info.count,
          table: duckTable ?? '',
          message: small
            ? `${push.message}（共 ${info.count} 行全部上图；几何列 ${geomCol.name}${crsNote}）`
            : `${push.message}（共 ${info.count} 行，抽样上图 ${fc.features.length} 行；几何列 ${geomCol.name}${crsNote}；`
              + `DuckDB 内存表 ${duckTable} 已建，可继续筛选）`,
        }
      }

      // ---- 经纬度点路径（现状）----
      const { lon, lat } = coords as { lon: string; lat: string }
      const where = buildFilterClause(args as Record<string, unknown>, { lon, lat })
      let fc: FeatureCollection
      let duckTable: string | undefined
      try {
        if (small) {
          const cap = Math.min(info.count, limit ?? info.count)
          const suffix = [where, `LIMIT ${cap}`].filter(Boolean).join(' ')
          fc = rowsToGeoJSON(await engine.query(table, suffix), lon, lat)
          // 小文件不留内存表（图层的子集即全部数据，后续用常规工具筛选即可）。
          await engine.dropTable(table)
          duckTable = undefined
        } else {
          const sample = Math.min(info.count, limit ?? threshold)
          const src = where ? `(SELECT * FROM ${table} ${where})` : table
          fc = rowsToGeoJSON(await engine.run(`SELECT * FROM ${src} USING SAMPLE ${Math.max(1, sample)} ROWS`), lon, lat)
          // 大文件保留内存表：后续筛选工具在表上跑 SQL，产新图层。
          duckTable = table
        }
      } catch (err) {
        await engine.dropTable(table).catch(() => {})
        return { ok: false, message: `筛选/物化失败: ${friendlyDuckError(err)}` }
      }
      const isHuge = info.count > DECK_FROM
      const push = pushResult(`CSV - ${base}`, fc, {
        cluster: !small && !isHuge, // >10 万走 deck 原始点（renderer 由 makeResultLayer 决定），不再 supercluster
        duckTable,
        duckCoords: { lon, lat },
        totalCount: info.count,
      })
      return {
        ...push,
        status: small ? 'small' : 'loaded',
        totalCount: info.count,
        table: duckTable ?? '',
        message: small
          ? `${push.message}（共 ${info.count} 行全部上图${limit && limit < info.count ? `，按 limit 取前 ${fc.features.length} 行` : ''}；小文件常规加载）`
          : `${push.message}（共 ${info.count} 行，抽样上图 ${fc.features.length} 行${isHuge ? '，按真实行数走 deck.gl 原始点渲染' : '并聚合显示'}；`
            + `DuckDB 内存表 ${duckTable} 已建，可继续筛选）`,
      }
    },
  }))

  // ---- 阶段 2：筛选 → 新表新图层 ----
  ctx.tools.register(defineTool({
    name: 'webgis_filter_layer',
    description:
      '对 DuckDB CSV 大文件图层（webgis_load_csv 加载、含内存表）跑条件筛选 → 新图层（秒回）。'
      + '条件可叠加：where=等于筛选（JSON 对象、多字段取交集）、bbox={west,south,east,north} 经纬度范围、'
      + 'radius（米）+ center={lon,lat} 圆心半径（haversine 大圆距离）、'
      + 'polygon=GeoJSON 面（或 polygonLayer=面图层 id）做围栏内筛选（ST_Within，跑全表，需已联网装过 spatial 扩展）。'
      + '结果按行数自动决定加载：≤5 万直接上图、5万~10万先询问用户是否聚合（返回 need_confirm）、'
      + '10万~20万自动聚合（supercluster）、>20 万不加载返回缩小范围建议。'
      + '几何列图层（webgis_load_csv 的 WKT/WKB/GEOMETRY 列产物、无经纬度列）仅支持 where 列等于筛选；'
      + 'bbox/radius/polygon 依赖经纬度列，暂不支持。'
      + '新图层保留 DuckDB 内存表（可继续链式筛选），移除时自动释放。'
      + '只支持 source=csv 且有内存表的图层（webgis_load_csv / 本工具 / webgis_sql_layer 产物）。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标 DuckDB CSV 图层 id（webgis_list_layers 查看）' },
      where: { type: 'json', description: '等于筛选：JSON 对象 {"adname":"天河区"}，多字段取交集' },
      bbox: { type: 'json', description: '经纬度范围 {"west":113,"south":22.8,"east":114,"north":23.5}' },
      center: { type: 'json', description: '圆心 {"lon":113.32,"lat":23.11}（配 radius 用）' },
      radius: { type: 'number', description: '半径（米），配 center 用（haversine 大圆距离）' },
      polygon: {
        type: 'json',
        description: '围栏筛选：GeoJSON 面几何 {"type":"Polygon","coordinates":[[[lon,lat],...]]}；需 spatial 扩展',
      },
      polygonLayer: {
        type: 'string',
        description: '围栏筛选：用指定图层（含面要素）的几何作围栏；需 spatial 扩展',
      },
      limit: { type: 'integer', description: '上图子集行数上限（缺省按行数阈值自动）' },
      cluster: { type: 'string', enum: ['auto', 'on', 'off'], description: '渲染：auto=按行数阈值（默认）；on=强制聚合；off=强制普通' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          layerId: { type: 'string' },
          name: { type: 'string' },
          featureCount: { type: 'integer' },
          count: { type: 'integer' },
          table: { type: 'string' },
          bbox: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const table = layer.duckTable
      const coords = layer.duckCoords
      const geom = layer.duckGeom
      if (!table) {
        return { ok: false, message: `图层 ${layer.id} 不是 DuckDB 大文件图层（无内存表；请先用 webgis_load_csv 加载）` }
      }
      if (!coords && !geom) {
        return { ok: false, message: `图层 ${layer.id} 缺 DuckDB 经纬度/几何列信息` }
      }
      // 几何图层（无经纬度列）：bbox/radius/polygon 依赖经纬度列，暂不支持（列为后续项）。
      if (geom && !coords) {
        const wantsSpatialParams = (args.bbox && typeof args.bbox === 'object')
          || (args.center && typeof args.center === 'object')
          || args.radius != null
          || (args.polygon && typeof args.polygon === 'object')
          || (typeof args.polygonLayer === 'string' && args.polygonLayer)
        if (wantsSpatialParams) {
          return {
            ok: false,
            message: `图层 ${layer.id} 是几何列图层（无经纬度列），bbox/radius/polygon 围栏筛选暂不支持；`
              + '可改用 where 做列等于筛选，或先用 webgis_sql_layer 投影出经纬度列。',
          }
        }
      }
      let clause: string
      try {
        if (geom && !coords) {
          clause = buildFilterClause(args as Record<string, unknown>, { lon: '', lat: '' })
        } else {
          clause = buildFilterClause(args as Record<string, unknown>, coords as { lon: string; lat: string })
          const wantsPolygon = (args.polygon && typeof args.polygon === 'object')
            || (typeof args.polygonLayer === 'string' && args.polygonLayer)
          if (wantsPolygon) {
            if (!(await engine.ensureSpatial())) {
              return {
                ok: false,
                message: '围栏筛选需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）；'
                  + '当前无法加载，可改用 bbox/radius 或先 webgis_filter_layer 筛出子集后用 Turf 的 select_by_location。',
              }
            }
            const poly = buildPolygonClause(args as Record<string, unknown>, coords as { lon: string; lat: string }, resolve)
            if (poly) clause = clause ? `${clause} AND ${poly}` : `WHERE ${poly}`
          }
        }
      } catch (err) {
        return { ok: false, message: friendlyDuckError(err) }
      }
      try {
        const cnt = await engine.run(`SELECT count(*) AS c FROM ${table} ${clause}`)
        const count = Number(cnt[0]?.c ?? 0)
        const thr = effectiveCluster(undefined)
        const decision = resolveClusterMode({
          count,
          param: (typeof args.cluster === 'string' ? args.cluster : 'auto') as ClusterParam,
          isPoint: !geom, // supercluster 只支持点；几何图层恒 plain
          askFrom: thr.askFrom,
          autoClusterFrom: thr.autoClusterFrom,
        })
        if (decision.mode === 'ask') {
          return {
            ok: true, status: 'need_confirm', count, featureCount: 0,
            message: `筛选命中 ${count} 行（${thr.askFrom}~${thr.autoClusterFrom} 区间）。`
              + '请先询问用户是否用聚合（supercluster）显示，再携带 cluster 参数（on/off）重跑本工具。',
          }
        }
        if (count > thr.maxLoad) {
          return {
            ok: true, status: 'too_many', count, featureCount: 0,
            message: `筛选命中 ${count} 行，超过地图可加载上限 ${thr.maxLoad}，未加载。`
              + '建议：1) 加更严的 where/bbox/radius 缩小范围；2) 用 LIMIT 只取需要的部分；3) 先 webgis_layer_stats 看分布。',
          }
        }
        // 物化结果表（链式筛选用）+ 从上图。
        const resTable = engine.nextTableName()
        await engine.createFilterTable(resTable, table, clause)
        const cap = finiteInt(args.limit)
        let fc: FeatureCollection
        if (geom && !coords) {
          // 几何图层：resTable 的几何列是原始文本（VARCHAR），需重新 ST_AsGeoJSON 投影。
          const attrs = (await engine.describe(resTable)).filter((c) => c.name !== geom.column && c.name !== DUCK_RID).map((c) => c.name)
          const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(geom.column, geom.format, geom.sourceCrs)].join(', ')
          const rows = await engine.run(`SELECT ${selList} FROM ${resTable} ${cap ? `LIMIT ${cap}` : ''}`)
          fc = geometryRowsToGeoJSON(rows, attrs)
        } else {
          const rows = await engine.query(resTable, cap ? `LIMIT ${cap}` : '')
          fc = rowsToGeoJSON(rows, coords!.lon, coords!.lat)
        }
        const clustered = decision.mode === 'cluster'
        const push = pushResult(`筛选 - ${layer.name}`, fc, {
          cluster: clustered && count <= DECK_FROM, // >10 万走 deck 原始点
          duckTable: resTable,
          ...(coords ? { duckCoords: coords } : {}),
          ...(geom ? { duckGeom: { column: geom.column, format: geom.format, sourceCrs: geom.sourceCrs } } : {}),
          totalCount: count,
        })
        return {
          ...push,
          status: 'ok',
          count,
          table: resTable,
          message: `${push.message}（命中 ${count} 行，上图 ${fc.features.length} 行${clustered ? '，已聚合显示' : ''}）`,
        }
      } catch (err) {
        return { ok: false, message: `筛选失败: ${friendlyDuckError(err)}` }
      }
    },
  }))

  // ---- 阶段 2：统计（不建图层） ----
  ctx.tools.register(defineTool({
    name: 'webgis_layer_stats',
    description:
      '对 DuckDB CSV 图层（webgis_load_csv / webgis_filter_layer 产物）跑统计：总行数 +（可选字段的）'
      + 'distinct 去重数 / min / max / avg + Top10 分布。不物化数据、不建图层。'
      + '统计类查询优先用它而不是 webgis_sql_layer。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标 DuckDB CSV 图层 id（webgis_list_layers 查看）' },
      field: { type: 'string', description: '要统计的字段名（缺省只返回总行数）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stat: { type: 'string' },
          value: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const table = layer.duckTable
      if (!table) return { ok: false, message: `图层 ${layer.id} 不是 DuckDB 大文件图层（无内存表）` }
      const field = typeof args.field === 'string' && args.field ? args.field : null
      try {
        const info = await engine.tableInfo(table)
        const value: Record<string, unknown> = { count: info.count }
        if (field) {
          const fid = escIdent(field)
          // count(DISTINCT) + min/max 与 avg 分开：VARCHAR 列 avg 会报错，不能拖累整体。
          try {
            const agg = await runDuckRetry(
              engine,
              `SELECT count(DISTINCT ${fid}) AS dc, min(${fid}) AS mn, max(${fid}) AS mx FROM ${table}`,
            )
            const r = agg[0] ?? {}
            value.distinct = Number(r.dc ?? 0)
            value.min = normalizeValue(r.mn)
            value.max = normalizeValue(r.mx)
          } catch {
            // 非数值/不可比较字段：distinct/min/max 失败则略过
          }
          try {
            const avgRow = await runDuckRetry(engine, `SELECT avg(${fid}) AS av FROM ${table}`)
            const av = avgRow[0]?.av
            value.avg = (av == null || (typeof av === 'number' && !Number.isFinite(av))) ? null : normalizeValue(av)
          } catch {
            // 非数值字段 avg 报错，跳过
          }
          try {
            const top = await runDuckRetry(
              engine,
              `SELECT ${fid} AS v, count(*) AS c FROM ${table} GROUP BY 1 ORDER BY c DESC LIMIT 10`,
            )
            value.top = top.map((r) => ({ value: normalizeValue(r.v), count: Number(r.c) }))
          } catch {
            // 分组失败（如复杂类型）忽略
          }
        }
        return {
          ok: true,
          stat: field ? `字段 ${field} 统计（图层 ${layer.id}，共 ${info.count} 行）` : `图层 ${layer.id} 总行数`,
          value: value as unknown as JsonValue,
          message: `图层 ${layer.id} 共 ${info.count} 行${field ? `；字段 ${field} 统计完成` : ''}`,
        }
      } catch (err) {
        return { ok: false, message: `统计失败: ${friendlyDuckError(err)}` }
      }
    },
  }))

  // ---- 阶段 2：只读 SQL → 图层/预览 ----
  ctx.tools.register(defineTool({
    name: 'webgis_sql_layer',
    description:
      '对 DuckDB CSV 图层的内存表执行只读 SQL（仅 SELECT/WITH/EXPLAIN；禁写操作/分号/注释）。'
      + 'SQL 里用 __layer__ 指代目标图层的表，如 "SELECT adname, count(*) FROM __layer__ GROUP BY adname"。'
      + '系统先统计结果行数：超过上限（默认 5000、可用 limit 调大、硬上限 50000）不执行并给建议。'
      + '结果含几何列（GEOMETRY/WKT/WKB，自动识别、优先级高于经纬度）或经纬度列（lon/lat 等）会自动上图成新图层'
      + '（物化结果，不再可链式筛选）；都没有则返回前 10 行预览。几何列需 spatial 扩展（首次联网），可传 sourceCrs 指定源坐标系。'
      + '优先用 webgis_layer_stats（统计）和 webgis_filter_layer（筛选），本工具留给复杂 SQL。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标 DuckDB CSV 图层 id（SQL 里用 __layer__ 指代其表）' },
      sql: { type: 'string', required: true, description: '只读 SQL，__layer__ 指代目标图层的内存表' },
      limit: { type: 'integer', description: '结果行数上限（默认 5000，最大 50000）' },
      sourceCrs: {
        type: 'string',
        description: '结果几何列的源坐标系（如 EPSG:3857，转 4326 上图；缺省按 WGS84 解释）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          layerId: { type: 'string' },
          featureCount: { type: 'integer' },
          count: { type: 'integer' },
          rowCount: { type: 'integer' },
          columns: { type: 'json' },
          rows: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const table = layer.duckTable
      if (!table) return { ok: false, message: `图层 ${layer.id} 不是 DuckDB 大文件图层（无内存表）` }
      const sql = typeof args.sql === 'string' ? args.sql : ''
      let clean: string
      try {
        clean = validateSql(sql)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      const withTable = clean.replaceAll('__layer__', table)
      const cap = Math.min(finiteInt(args.limit) ?? 5000, MAX_SQL_ROWS)
      const sourceCrsArg = typeof args.sourceCrs === 'string' && args.sourceCrs ? args.sourceCrs : undefined
      try {
        const cnt = await engine.run(`SELECT count(*) AS c FROM (${withTable}) __t`)
        const count = Number(cnt[0]?.c ?? 0)
        if (count > cap) {
          return {
            ok: true, status: 'too_many', count, rowCount: 0,
            message: `查询结果 ${count} 行，超过上限 ${cap}，未执行。建议：加 WHERE 缩小范围 / 加 LIMIT / 先 GROUP BY 统计。`,
          }
        }
        // 结果列类型（几何列识别优先级 > 经纬度列）。
        const resultDesc = await engine.describe(`(${withTable})`)
        const columns = resultDesc.map((c) => c.name)
        const geomName = detectGeomColumn(resultDesc)
        const geomCol = geomName ? resultDesc.find((c) => c.name === geomName) : undefined
        const format = geomCol ? detectGeomFormat(geomCol) : null
        if (geomCol && format) {
          if (!(await engine.ensureSpatial())) {
            return {
              ok: false,
              message: 'SQL 结果含几何列，上图需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）；'
                + '当前无法加载，可去掉几何列或改用 webgis_load_dataset 导入。',
            }
          }
          const sourceCrs = sourceCrsArg ?? null
          const attrs = columns.filter((c) => c !== geomName && c !== DUCK_RID)
          const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(geomCol.name, format, sourceCrs)].join(', ')
          const geomRows = await engine.run(`SELECT ${selList} FROM (${withTable}) __q LIMIT ${cap}`)
          const fc = geometryRowsToGeoJSON(geomRows, attrs)
          const push = pushResult(`SQL - ${layer.name}`, fc, { cluster: false })
          const crsNote = sourceCrs && sourceCrs !== 'EPSG:4326' ? `（几何列 ${geomName} 已从 ${sourceCrs} 转 4326）` : ''
          return {
            ...push,
            status: 'ok',
            count,
            rowCount: geomRows.length,
            columns: columns as unknown as JsonValue,
            rows: [] as unknown as JsonValue,
            message: `${push.message}（SQL ${geomRows.length} 行；含几何列 ${geomName}${crsNote}；结果已物化，不再可链式筛选）`,
          }
        }
        const rows = await engine.run(`SELECT * FROM (${withTable}) __q LIMIT ${cap}`)
        const { lon, lat } = detectCoordColumns(columns)
        const preview = sanitizeRows(rows.slice(0, 10))
        if (!lon || !lat) {
          return {
            ok: true, status: 'no_geometry', count, rowCount: rows.length,
            columns: columns as unknown as JsonValue, rows: preview as unknown as JsonValue,
            message: `查询 ${rows.length} 行，结果无经纬度列，未建图层。返回前 ${Math.min(rows.length, 10)} 行预览。`,
          }
        }
        const fc = rowsToGeoJSON(rows, lon, lat)
        const push = pushResult(`SQL - ${layer.name}`, fc, { cluster: false })
        return {
          ...push,
          status: 'ok',
          count,
          rowCount: rows.length,
          columns: columns as unknown as JsonValue,
          rows: preview as unknown as JsonValue,
          message: `${push.message}（SQL ${rows.length} 行；结果已物化，不再可链式筛选）；返回前 ${Math.min(rows.length, 10)} 行预览。`,
        }
      } catch (err) {
        return { ok: false, message: `SQL 执行失败: ${friendlyDuckError(err)}` }
      }
    },
  }))

  // ---- 阶段 2：导出（筛完导出） ----
  ctx.tools.register(defineTool({
    name: 'webgis_export_layer',
    description:
      '把图层的当前内容导出为文件：CSV（几何列以 WKT 保存）或 GeoJSON。path 可选（缺省导出到 ~/.dsh/webgis-exports/）。'
      + '返回导出文件的绝对路径。注意：DuckDB 大文件图层导出的是上图子集（抽样）；'
      + '要导出完整筛选结果，请先 webgis_filter_layer 筛出子集，再导出结果图层。',
    parameters: {
      layer: { type: 'string', required: true, description: '要导出的图层 id（webgis_list_layers 查看）' },
      format: { type: 'string', enum: ['csv', 'geojson'], description: '导出格式：csv=逗号分隔（几何列 WKT）、geojson=GeoJSON' },
      path: { type: 'string', description: '导出文件路径（缺省 ~/.dsh/webgis-exports/ 下按图层 id 自动命名）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string' },
          format: { type: 'string' },
          featureCount: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const fmt = args.format === 'geojson' ? 'geojson' : 'csv'
      const content = fmt === 'geojson' ? toGeoJSON(layer.geojson) : toCsv(layer.geojson)
      let outPath: string
      if (typeof args.path === 'string' && args.path.trim()) {
        outPath = args.path.trim()
      } else {
        const dir = join(homedir(), '.dsh', 'webgis-exports')
        mkdirSync(dir, { recursive: true })
        outPath = join(dir, `${layer.id}-${fmt}.${fmt === 'geojson' ? 'json' : 'csv'}`)
      }
      try {
        await writeFile(outPath, content, 'utf8')
        const note = layer.duckTable
          ? '（DuckDB 大文件图层导出的是上图子集；要完整结果请先 webgis_filter_layer 再导出结果图层）'
          : ''
        return {
          ok: true,
          path: outPath,
          format: fmt,
          featureCount: layer.featureCount,
          message: `已导出 ${layer.featureCount} 行 → ${outPath}${note}`,
        }
      } catch (err) {
        return { ok: false, message: `导出失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }))

  // ---- 阶段 3：全表空间筛选（webgis_spatial_filter）----
  ctx.tools.register(defineTool({
    name: 'webgis_spatial_filter',
    description:
      '在持有 DuckDB 内存表的图层上做「全表空间筛选」→ 新图层或统计（DuckDB 管大表谓词，Turf 只管筛小后的探索）。'
      + '只对含内存表（duckTable）的图层可用，不限来源：既支持 webgis_load_csv 的经纬度点列（duckCoords），'
      + '也支持几何列图层（duckGeom，format geometry/wkb/wkt，sourceCrs 非 4326 自动转 4326）。'
      + 'mode：bbox=经纬度范围（仅点状源）；dwithin=center:{lon,lat}+distanceMeters 半径筛选'
      + '（haversine 球面米，与 filter_layer 半径一致，仅点状源）；'
      + 'within_polygon=polygon(GeoJSON 面) 或 polygonLayer(面图层 id) 作围栏（ST_Intersects，点落内即 true，线/面源也可用）；'
      + 'intersects_layer=otherLayerId 与另一图层几何相交（对方是 duck 内存表直接 join；'
      + '对方仅纯 GeoJSON 且要素 ≤20000 时临时灌表后 join，用完即删；过大/无几何会明确报错）。'
      + 'bbox/dwithin 要求可点化源（经纬度列，或几何族全为 point 的几何列）；线/面/混合几何源请用 within_polygon/intersects_layer'
      + '或先筛出子集再用 Turf。距离语义=haversine 球面米；相交/围栏按 4326 经纬度平面计算（几何源已归 4326）。'
      + '大表空间意图（全表多少个/落在哪/距某点多近/与另一层相交）优先用本工具，不要在抽样子集上跑 Turf 下结论。'
      + 'where 传可选等于筛选（JSON 对象，复用 filter_layer 语义）。output=count_only 只返回统计不建图层；'
      + '缺省 output=layer 建新图层并上图（结果仍保留 duckTable 可继续链式筛选）。'
      + '结果永远带 scope 说明：count_only=full_table（全表算，未上图）；layer 全量上图=filtered；'
      + '命中超过上图阈值只抽样显示=sample_display（会如实说明，不会把抽样说成全量）。'
      + '禁止对百万级几何默认全量 buffer 并宣称已全部上图。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标 DuckDB 图层 id（需含内存表；webgis_list_layers 查看）' },
      mode: {
        type: 'string', required: true, enum: ['bbox', 'dwithin', 'within_polygon', 'intersects_layer'],
        description: '空间筛选模式',
      },
      where: { type: 'json', description: '等于筛选：JSON 对象 {"adname":"天河区"}，多字段取交集（先过滤再空间谓词）' },
      bbox: { type: 'json', description: 'bbox 模式参数：{"west":113,"south":22.8,"east":114,"north":23.5}' },
      center: { type: 'json', description: 'dwithin 模式圆心：{"lon":113.32,"lat":23.11}' },
      distanceMeters: { type: 'number', description: 'dwithin 模式半径（米，haversine 球面距离）' },
      polygon: { type: 'json', description: 'within_polygon 模式围栏：GeoJSON 面几何 {"type":"Polygon","coordinates":[...]}' },
      polygonLayer: { type: 'string', description: 'within_polygon 模式围栏：取指定图层的首个面要素作围栏' },
      otherLayerId: { type: 'string', description: 'intersects_layer 模式：与哪个图层相交（其需可取几何）' },
      output: { type: 'string', enum: ['layer', 'count_only'], description: 'layer=建结果图层上图（默认）；count_only=只返回命中统计' },
      limit: { type: 'integer', description: '上图行数上限（默认：命中≤阈值全量，否则抽样阈值行）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          output: { type: 'string' },
          scope: { type: 'string' },
          sourceCount: { type: 'integer' },
          resultCount: { type: 'integer' },
          displayedCount: { type: 'integer' },
          count: { type: 'integer' },
          note: { type: 'string' },
          layerId: { type: 'string' },
          name: { type: 'string' },
          featureCount: { type: 'integer' },
          table: { type: 'string' },
          bbox: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const table = layer.duckTable
      if (!table) {
        return { ok: false, message: `图层 ${layer.id} 不是 DuckDB 大文件图层（无内存表；请先用 webgis_load_csv 加载，或对小层用 Turf 工具）` }
      }
      const shape = duckGeomSourceOf(layer)
      if (!shape.coords && !shape.geom) {
        return { ok: false, message: `图层 ${layer.id} 缺 DuckDB 经纬度/几何列信息` }
      }
      const mode = typeof args.mode === 'string' ? args.mode : ''
      if (!['bbox', 'dwithin', 'within_polygon', 'intersects_layer'].includes(mode)) {
        return { ok: false, message: `mode 只支持 bbox/dwithin/within_polygon/intersects_layer，收到 ${mode}` }
      }
      const isCountOnly = args.output === 'count_only'
      try {
        const eq = eqClauseText(args as Record<string, unknown>)

        /** 构造 intersects 结果：返回 count 与物化函数。rid 临时表生命周期内管理。 */
        const buildIntersects = async (): Promise<{ sourceCount: number; resultCount: number; mkTable: () => Promise<string>; dropRid: () => Promise<void> }> => {
          if (!(await engine.ensureSpatial())) {
            throw new Error('intersects_layer 需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）；当前无法加载。')
          }
          const otherId = typeof args.otherLayerId === 'string' && args.otherLayerId ? args.otherLayerId : ''
          if (!otherId) throw new Error('intersects_layer 模式需提供 otherLayerId')
          const other = resolve(otherId)
          if (typeof other === 'string') throw new Error(other)
          let otherTable: string
          let otherShape: DuckGeomSource
          let tempOther: string | null = null
          if (other.duckTable) {
            otherTable = other.duckTable
            otherShape = duckGeomSourceOf(other)
            if (!otherShape.coords && !otherShape.geom) {
              throw new Error(`对方图层 ${other.id} 有内存表但缺经纬度/几何列信息，无法相交`)
            }
          } else {
            // 纯 GeoJSON 图层：要素数在限额内才临时灌表（用完 DROP）。
            if (other.featureCount === 0) throw new Error(`对方图层 ${other.id} 没有要素可相交`)
            if (other.featureCount > SPATIAL_TEMP_MAX) {
              throw new Error(`对方图层 ${other.id} 是纯 GeoJSON（非 duck 内存表）且要素 ${other.featureCount} > ${SPATIAL_TEMP_MAX}：`
                + '过大无法临时灌表。请先对该图层用 webgis_spatial_filter 筛出子集，或用 webgis_load_csv 灌成 duck 内存表后再相交。')
            }
            tempOther = engine.nextTableName()
            const gj = await engine.createTableFromGeoJson(tempOther, other.geojson)
            if (!gj.geomColumn) {
              await engine.dropTable(tempOther).catch(() => {})
              throw new Error(`对方图层 ${other.id} 的 GeoJSON 没有可识别几何列，无法相交`)
            }
            otherTable = tempOther
            otherShape = { geom: { column: gj.geomColumn, format: 'geometry', sourceCrs: null } }
          }
          // 两侧子查询：rid + 几何表达式 + 数值化 bbox（避免触发 DuckDB SPATIAL_JOIN 崩溃/不稳）。
          const bboxSide = (tbl: string, src: DuckGeomSource, whereText: string): string => {
            const g = rowGeomExprOf(src)
            let xs: string; let xe: string; let ys: string; let ye: string
            if (src.coords) {
              const c = src.coords
              xs = `${quoteIdent(c.lon)}`; xe = `${quoteIdent(c.lon)}`
              ys = `${quoteIdent(c.lat)}`; ye = `${quoteIdent(c.lat)}`
            } else {
              xs = `ST_XMin(${g})`; xe = `ST_XMax(${g})`
              ys = `ST_YMin(${g})`; ye = `ST_YMax(${g})`
            }
            return `(SELECT ${quoteIdent(DUCK_RID)} AS ${quoteIdent('__rid')}, ${g} AS __g, `
              + `${xs} AS __x1, ${xe} AS __x2, ${ys} AS __y1, ${ye} AS __y2 FROM ${tbl} ${whereText})`
          }
          const srcSub = bboxSide(table, shape, combineWhereText([eq]))
          const othSub = bboxSide(otherTable, otherShape, '')
          const cond = '__s.__x1 <= __o.__x2 AND __s.__x2 >= __o.__x1 AND __s.__y1 <= __o.__y2 AND __s.__y2 >= __o.__y1 '
            + 'AND ST_Intersects(__s.__g, __o.__g)'
          const ridTable = engine.nextTableName()
          const dropRid = async (): Promise<void> => {
            await engine.dropTable(ridTable).catch(() => {})
          }
          try {
            await engine.exec(`CREATE TABLE ${ridTable} AS SELECT DISTINCT __s.__rid AS rid FROM ${srcSub} __s JOIN ${othSub} __o ON ${cond}`)
            // ridTable 已物化，对方临时表不再需要 → 立即 DROP（防泄漏）。
            if (tempOther) {
              await engine.dropTable(tempOther).catch(() => {})
              tempOther = null
            }
            const cnt = await engine.run(`SELECT count(*) AS c FROM ${ridTable}`)
            const resultCount = Number(cnt[0]?.c ?? 0)
            const srcCnt = await engine.run(`SELECT count(*) AS c FROM ${table}`)
            const sourceCount = Number(srcCnt[0]?.c ?? 0)
            const mkTable = async (): Promise<string> => {
              const resTable = engine.nextTableName()
              await engine.createFilterTable(resTable, table, `WHERE ${quoteIdent(DUCK_RID)} IN (SELECT rid FROM ${ridTable})`)
              await dropRid()
              return resTable
            }
            return { sourceCount, resultCount, mkTable, dropRid }
          } catch (err) {
            await dropRid()
            if (tempOther) await engine.dropTable(tempOther).catch(() => {})
            throw err
          }
        }

        let meta:
          | { kind: 'predicate'; sourceCount: number; resultCount: number; whereText: string }
          | { kind: 'intersects'; sourceCount: number; resultCount: number; mkTable: () => Promise<string>; dropRid: () => Promise<void> }

        if (mode === 'intersects_layer') {
          const b = await buildIntersects()
          meta = { kind: 'intersects', sourceCount: b.sourceCount, resultCount: b.resultCount, mkTable: b.mkTable, dropRid: b.dropRid }
        } else {
          let spatialText: string
          if (mode === 'bbox') {
            const p = await requirePointableLonLat(engine, layer)
            const bb = args.bbox as { west?: unknown; south?: unknown; east?: unknown; north?: unknown } | undefined
            const w = num(bb?.west); const s = num(bb?.south); const e = num(bb?.east); const n = num(bb?.north)
            if (bb == null || w == null || s == null || e == null || n == null) throw new Error('bbox 需提供 west/south/east/north 四个数值')
            if (w > e || s > n) throw new Error('bbox 需满足 west≤east 且 south≤north')
            spatialText = bboxPredText(p.lon, p.lat, { west: w, south: s, east: e, north: n })
          } else if (mode === 'dwithin') {
            const p = await requirePointableLonLat(engine, layer)
            const center = args.center as { lon?: unknown; lat?: unknown } | undefined
            const clon = num(center?.lon); const clat = num(center?.lat)
            const dist = num(args.distanceMeters)
            if (center == null || clon == null || clat == null || dist == null || dist < 0) {
              throw new Error('dwithin 需 center={lon,lat} 与 distanceMeters（≥0 的米数）')
            }
            spatialText = haversinePredText(p.lon, p.lat, clon, clat, dist)
          } else { // within_polygon
            if (!(await engine.ensureSpatial())) {
              throw new Error('within_polygon 需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）；当前无法加载。')
            }
            const wkt = fenceWktText(args as Record<string, unknown>, resolve)
            spatialText = `ST_Intersects(${rowGeomExprOf(shape)}, ST_GeomFromText(${inlineValue(wkt)})::GEOMETRY)`
          }
          const whereText = combineWhereText([eq, spatialText])
          const cnt = await engine.run(`SELECT count(*) AS c FROM ${table} ${whereText}`)
          const resultCount = Number(cnt[0]?.c ?? 0)
          const srcCnt = await engine.run(`SELECT count(*) AS c FROM ${table}`)
          const sourceCount = Number(srcCnt[0]?.c ?? 0)
          meta = { kind: 'predicate', sourceCount, resultCount, whereText }
        }

        const sourceCount = meta.sourceCount
        const resultCount = meta.resultCount
        const noteBase = `全表 ${sourceCount} 行上计算`

        if (isCountOnly) {
          if (meta.kind === 'intersects') await meta.dropRid()
          const message = `${noteBase}，命中 ${resultCount} 行，未上图（output=count_only）。可加更严 where/空间条件缩小，或用 output=layer 上图（超限会自动建议）。`
          return {
            ok: true, status: 'ok', output: 'count_only', scope: 'full_table',
            sourceCount, resultCount, displayedCount: 0, count: resultCount,
            note: `${noteBase}，命中 ${resultCount} 行，未上图（count_only）。`, message,
          }
        }

        const maxLoad = effectiveCluster(undefined).maxLoad
        if (resultCount > maxLoad) {
          if (meta.kind === 'intersects') await meta.dropRid()
          const message = `命中 ${resultCount} 行，超过地图加载上限 ${maxLoad}，未加载。`
            + '建议：1) output=count_only 看规模；2) 加更严的 where/空间条件；3) 分区域多次筛选。'
          return {
            ok: true, status: 'too_many', output: 'layer', scope: 'full_table',
            sourceCount, resultCount, displayedCount: 0, count: resultCount,
            note: `${noteBase}，命中 ${resultCount} 行，超过上限 ${maxLoad} 未加载。`, message,
          }
        }

        // 物化结果表（链式筛选用）
        const resTable = meta.kind === 'intersects' ? await meta.mkTable() : await (async () => {
          const t = engine.nextTableName()
          await engine.createFilterTable(t, table, meta.whereText)
          return t
        })()
        const small = resultCount <= engine.threshold
        const limitArg = finiteInt(args.limit)
        const cap = small
          ? Math.min(resultCount, limitArg ?? resultCount)
          : Math.min(engine.threshold, limitArg ?? engine.threshold)

        let fc: FeatureCollection
        let displayedCount = 0
        if (shape.geom && !shape.coords) {
          const g = shape.geom
          const attrs = (await engine.describe(resTable))
            .filter((c) => c.name !== g.column && c.name !== DUCK_RID).map((c) => c.name)
          const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(g.column, g.format, g.sourceCrs)].join(', ')
          const rows = small
            ? await engine.run(`SELECT ${selList} FROM ${resTable} LIMIT ${Math.max(1, cap)}`)
            : await engine.run(`SELECT ${selList} FROM ${resTable} USING SAMPLE ${Math.max(1, cap)} ROWS`)
          fc = geometryRowsToGeoJSON(rows, attrs)
        } else {
          const coords = shape.coords as { lon: string; lat: string }
          const rows = small
            ? await engine.query(resTable, `LIMIT ${Math.max(1, cap)}`)
            : await engine.run(`SELECT * FROM ${resTable} USING SAMPLE ${Math.max(1, cap)} ROWS`)
          fc = rowsToGeoJSON(rows, coords.lon, coords.lat)
        }
        displayedCount = fc.features.length
        const scope = small ? 'filtered' : 'sample_display'
        const clustered = !!(shape.coords && !small && resultCount <= DECK_FROM)
        const push = pushResult(`空间筛选 - ${layer.name}`, fc, {
          cluster: clustered,
          duckTable: resTable,
          ...(shape.coords ? { duckCoords: shape.coords } : {}),
          ...(shape.geom ? { duckGeom: { column: shape.geom.column, format: shape.geom.format, sourceCrs: shape.geom.sourceCrs } } : {}),
          totalCount: resultCount,
        })
        const note = small
          ? `${noteBase}，命中 ${resultCount} 行并全量上图（scope=filtered）；结果表 ${resTable} 已建，可继续筛选。`
          : `${noteBase}，命中 ${resultCount} 行，抽样上图 ${displayedCount} 行（scope=sample_display，显示为抽样非全量）；结果表 ${resTable} 已建，可继续筛选。`
        return {
          ...push,
          status: 'ok', output: 'layer', scope,
          sourceCount, resultCount, displayedCount, count: resultCount,
          table: resTable, note,
          message: `${push.message}（${note}）`,
        }
      } catch (err) {
        return { ok: false, message: `空间筛选失败: ${friendlyDuckError(err)}` }
      }
    },
  }))

  // ---- 阶段 3：全表空间聚合（webgis_spatial_aggregate）----
  ctx.tools.register(defineTool({
    name: 'webgis_spatial_aggregate',
    description:
      '在持有 DuckDB 内存表的图层上做全表聚合（DuckDB 管聚合，结果小，不喂 Turf 重算）。'
      + 'kind=grid：按近似方形网格统计点密度/数值指标 → 小网格多边形图层上图（只对点状源：经纬度列或点几何列）。'
      + '网格按参考纬度 lat0 把米制 cellSizeMeters 换算成经纬度增量（dLon=cell/(111320*cos(lat0))、dLat=cell/110540），'
      + '是米制近似（cell 尺寸随纬度会有偏差，note 会说明）；origin 西界取图层范围西边界。默认每格 count，'
      + 'metrics 可加 countDistinct/sum/avg（带 field）。maxCells（默认 2000）限制输出格数（取最密的前 N 格）。'
      + 'kind=attribute：按 groupBy 列分组聚合 → 直接返回 rows（不建图层），默认 count、可加 metrics。'
      + 'where 传可选等于筛选（先过滤再聚合）。源过大想先收敛时可先用 webgis_spatial_filter 筛出子集再聚合；'
      + '本工具直接在 duck 表上聚合，结果很小。grid 适用于全表密度/热力概览，不做逐点精确制图。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标 DuckDB 图层 id（需含内存表）' },
      kind: { type: 'string', required: true, enum: ['grid', 'attribute'], description: 'grid=规则网格聚合；attribute=按属性列分组聚合' },
      groupBy: { type: 'string', description: 'attribute 模式的分组列名' },
      metrics: {
        type: 'json',
        description: '聚合指标数组，元素形如 {"type":"count"|"countDistinct"|"sum"|"avg","field":"列名"}；缺省 [{"type":"count"}]',
      },
      where: { type: 'json', description: '等于筛选：JSON 对象 {"adname":"天河区"}（先过滤再聚合）' },
      cellSizeMeters: { type: 'number', description: 'grid 模式格边长（米，缺省 1000）' },
      lat0: { type: 'number', description: 'grid 模式参考纬度（缺省用图层范围中纬；无范围数据时必填）' },
      maxCells: { type: 'integer', description: 'grid 模式输出格数上限（缺省 2000，取最密的前 N 格）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          kind: { type: 'string' },
          scope: { type: 'string' },
          sourceCount: { type: 'integer' },
          resultCount: { type: 'integer' },
          displayedCount: { type: 'integer' },
          note: { type: 'string' },
          rows: { type: 'json' },
          layerId: { type: 'string' },
          featureCount: { type: 'integer' },
          bbox: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const table = layer.duckTable
      if (!table) {
        return { ok: false, message: `图层 ${layer.id} 不是 DuckDB 大文件图层（无内存表）` }
      }
      const shape = duckGeomSourceOf(layer)
      if (!shape.coords && !shape.geom) {
        return { ok: false, message: `图层 ${layer.id} 缺 DuckDB 经纬度/几何列信息` }
      }
      const kind = args.kind === 'attribute' ? 'attribute' : args.kind === 'grid' ? 'grid' : ''
      if (!kind) return { ok: false, message: 'kind 只支持 grid / attribute' }
      try {
        const eq = eqClauseText(args as Record<string, unknown>)
        const whereText = combineWhereText([eq])
        const desc = await engine.describe(table)
        const tableCols = desc.filter((c) => c.name !== DUCK_RID).map((c) => c.name)
        const metrics = parseMetrics(args.metrics, tableCols)
        const srcCnt = await engine.run(`SELECT count(*) AS c FROM ${table}`)
        const sourceCount = Number(srcCnt[0]?.c ?? 0)

        if (kind === 'attribute') {
          const gb = typeof args.groupBy === 'string' && args.groupBy ? args.groupBy : ''
          if (!gb) return { ok: false, message: 'attribute 模式需提供 groupBy 列名' }
          if (!tableCols.includes(gb)) {
            return { ok: false, message: `分组列 ${gb} 不在图层列里（可用 webgis_layer_info/webgis_layer_stats 核对）` }
          }
          const aggSels = metrics.map((m, i) => `${m.sql} AS __a${i}`)
          const rows = await engine.run(
            `SELECT ${quoteIdent(gb)} AS __value, ${aggSels.join(', ')} FROM ${table} ${whereText} `
            + `GROUP BY 1 ORDER BY count(*) DESC LIMIT ${AGG_GROUP_LIMIT}`,
          )
          const outRows = rows.map((r) => {
            const o: Record<string, unknown> = { value: normalizeValue(r.__value) }
            metrics.forEach((m, i) => { o[m.key] = normalizeValue(r[`__a${i}`]) })
            return o
          })
          return {
            ok: true, kind, scope: 'full_table',
            sourceCount, resultCount: outRows.length, displayedCount: 0,
            rows: outRows as unknown as JsonValue,
            note: `全表 ${sourceCount} 行上按 ${gb} 分组聚合，共 ${outRows.length} 组（未上图，rows 即结果）。`,
            message: `按 ${gb} 分组共 ${outRows.length} 组（全表 ${sourceCount} 行上计算；where 子集已生效）。`,
          }
        }

        // ---- grid ----
        const expr = await requirePointableLonLat(engine, layer)
        const cellM = num(args.cellSizeMeters) ?? GRID_DEFAULT_CELL_M
        if (!Number.isFinite(cellM) || cellM <= 0) return { ok: false, message: 'cellSizeMeters 需要 >0 的米数' }
        const maxCellsRaw = finiteInt(args.maxCells) ?? GRID_DEFAULT_MAX_CELLS
        const maxCells = Math.min(maxCellsRaw, GRID_MAX_CELLS)
        // 参考纬度/原点：优先显式 lat0；否则取数据范围中纬。
        const bb = await tableBBoxOf(engine, table, expr.lon, expr.lat, whereText)
        const lat0Num = num(args.lat0)
        if (bb == null && lat0Num == null) {
          return { ok: false, message: 'grid 需 lat0（图层无范围数据可推算参考纬度）' }
        }
        const lat0 = lat0Num ?? (bb ? (bb.south + bb.north) / 2 : 0)
        const lng0 = bb ? bb.west : -180
        const lat0Rad = (lat0 * Math.PI) / 180
        const dLon = cellM / (111320 * Math.cos(lat0Rad))
        const dLat = cellM / 110540
        if (!Number.isFinite(dLon) || dLon <= 0) return { ok: false, message: 'cellSizeMeters 换算失败（lat0 非法？）' }
        // 非 count 指标要携带原始字段列进 __src 以便外层聚合。
        const fieldCols = [...new Set(metrics.filter((m) => m.field).map((m) => m.field as string))]
        const fieldSels = fieldCols.map((f) => `${quoteIdent(f)} AS ${quoteIdent(f)}`)
        const aggSels = metrics.map((m, i) => `${m.sql} AS __a${i}`)
        const rows = await engine.run(
          `WITH __src AS (SELECT floor((${expr.lon} - ${lng0}) / ${dLon})::BIGINT AS i, `
          + `floor((${expr.lat} - ${lat0}) / ${dLat})::BIGINT AS j`
          + (fieldSels.length ? `, ${fieldSels.join(', ')}` : '')
          + ` FROM ${table} ${whereText}) `
          + `SELECT i, j, ${aggSels.join(', ')} FROM __src GROUP BY i, j `
          + `ORDER BY count(*) DESC LIMIT ${maxCells}`,
        )
        const features: Feature[] = []
        for (const r of rows) {
          const i = Number(r.i); const j = Number(r.j)
          if (!Number.isFinite(i) || !Number.isFinite(j)) continue
          const f = gridCellPolygon(lng0, lat0, dLon, dLat, i, j)
          const props: Record<string, unknown> = {}
          metrics.forEach((m, idx) => { props[m.key] = normalizeValue(r[`__a${idx}`]) })
          props.cell = [i, j]
          f.properties = props
          features.push(f)
        }
        const fc: FeatureCollection = { type: 'FeatureCollection', features }
        const push = pushResult(`空间聚合 - ${layer.name}`, fc, { cluster: false, totalCount: features.length })
        const note = `全表 ${sourceCount} 行上按 ${cellM} 米网格聚合（参考纬度 ${lat0.toFixed(4)}°，`
          + `约 dLon=${dLon.toFixed(6)}° dLat=${dLat.toFixed(6)}°，米制近似），`
          + `输出 ${features.length} 格（scope=full_table，网格为近似多边形）。`
        return {
          ...push,
          ok: true, kind, scope: 'full_table',
          sourceCount, resultCount: features.length, displayedCount: features.length,
          note,
          message: `${push.message}（${note}）`,
        }
      } catch (err) {
        return { ok: false, message: `空间聚合失败: ${friendlyDuckError(err)}` }
      }
    },
  }))
}
