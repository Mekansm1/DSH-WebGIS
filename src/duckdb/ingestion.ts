/**
 * DuckDB 大数据加载（ingestion）：本地 CSV / 矢量文件 / 大 GeoJSON → DuckDB 内存表 +
 * 上图抽样（≤阈值小文件全量物化，大文件留表按 zoom 分级拉取）。
 * 拆分自 src/duckdb-tools.ts；供 webgis_load_dataset 与 /webgis/import 复用。
 */
import type { BBox, FeatureCollection } from 'geojson'
import { getDuckDb, type DuckDbEngine } from './engine.js'
import type { DuckGeomSpec, VectorTableInfo } from './types.js'
import {
  buildGeomSelect, DUCK_RID, detectCoordColumns, detectGeomColumn, detectGeomFormat,
  duckTableFullBBox, geometryRowsToGeoJSON, quoteIdent, rowsToGeoJSON,
} from './geometry.js'
import { geomFamiliesOf, geomFamiliesOfWkb, geometrySampleRows, type GeomFamily } from './sampling.js'
import {
  crsRangeWarning, crsReport, friendlyDuckError, type SourceCrsInfo,
} from './geometry.js'
import { bbox as turfBbox } from '@turf/bbox'
import { buildEqualityClause } from './filters.js'
import { DECK_FROM } from '../render-policy.js'

/** loadCsvSourceData 的产出：CSV → 图层显示的抽样/全量 geojson + 可选 duck 句柄。 */
export interface CsvLayerData {
  totalCount: number
  geojson: FeatureCollection
  duckTable?: string
  duckCoords?: { lon: string; lat: string }
  duckGeom?: DuckGeomSpec
  families?: GeomFamily[]
  small: boolean
  note: string
  fullBbox?: BBox | null
  /**
   * geojson 是否装着全部**可用**数据（供 `pushResult` 直接采用，不经 `!duckTable` 反推）。
   *
   * ⚠ 与 `small` 是同一件事但**必须显式传递**：`small` 只表示"没留表"，而图层是否可编辑要看
   * 「有没有被抽样隐藏的行」。坐标不可解析被丢弃的行不算隐藏（它们本就不含信息），
   * 所以丢弃行不会让图层变成不可编辑。
   */
  materialized: boolean
}

/** 所有入口共用 CSV 参数；filter 定义图层子集，limit 仅限制展示。 */
export interface CsvSourceOptions {
  lonField?: string
  latField?: string
  geometryColumn?: string
  sourceCrs?: string
  filter?: unknown
  limit?: number
}

export async function loadCsvSourceData(engine: DuckDbEngine, sourcePath: string, opts: CsvSourceOptions = {}): Promise<CsvLayerData> {
  let table = engine.nextTableName()
  try {
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) throw new Error('limit 必须是正整数')
    const info = await engine.createTableFromCsv(table, sourcePath)
    let desc = await engine.describe(table)
    const coords = detectCoordColumns(info.columns, opts.lonField, opts.latField)
    if ((opts.lonField || opts.latField) && (!coords.lon || !coords.lat)) throw new Error('lonField/latField 必须同时指定且为实际列名')
    if (opts.geometryColumn && !info.columns.includes(opts.geometryColumn)) throw new Error(`几何列 ${opts.geometryColumn} 不存在`)
    let geomName = opts.geometryColumn ?? (coords.lon && coords.lat ? null : detectGeomColumn(desc))
    let transformed = false
    if (!geomName && coords.lon && coords.lat && opts.sourceCrs && !/^(EPSG:)?4326$/i.test(opts.sourceCrs)) {
      if (!(await engine.ensureSpatial())) throw new Error('坐标转换需要 spatial 扩展')
      geomName = '__webgis_geometry'
      while (info.columns.includes(geomName)) geomName += '_'
      const crs = opts.sourceCrs.replace(/'/g, "''")
      await engine.exec(`ALTER TABLE ${table} ADD COLUMN ${quoteIdent(geomName)} GEOMETRY`)
      await engine.exec(`UPDATE ${table} SET ${quoteIdent(geomName)} = ST_Transform(ST_Point(TRY_CAST(${quoteIdent(coords.lon)} AS DOUBLE), TRY_CAST(${quoteIdent(coords.lat)} AS DOUBLE)), '${crs}', 'EPSG:4326', always_xy := true)`)
      desc = await engine.describe(table)
      transformed = true
    }
    let geomCol = geomName ? desc.find(c => c.name === geomName) : undefined
    let geomFormat = geomCol ? detectGeomFormat(geomCol) : null
    if (!opts.geometryColumn && !transformed && !geomFormat) { geomName = null; geomCol = undefined }
    if (geomName && !geomFormat) throw new Error(`指定几何列 ${geomName} 无法识别格式`)
    if (!geomCol && (!coords.lon || !coords.lat)) throw new Error(`未找到经纬度列或几何列（列：${info.columns.join(', ')}）；请传 lonField/latField 或 geometryColumn`)
    if (opts.filter !== undefined) {
      if (!opts.filter || typeof opts.filter !== 'object' || Array.isArray(opts.filter)) throw new Error('filter 必须是等值条件对象')
      for (const field of Object.keys(opts.filter)) if (!info.columns.includes(field)) throw new Error(`筛选字段 ${field} 不存在`)
      const clause = buildEqualityClause({ filter: opts.filter })
      if (clause) {
        const filtered = engine.nextTableName()
        try { await engine.createFilterTable(filtered, table, `WHERE ${clause}`) }
        catch (err) { await engine.dropTable(filtered).catch(() => {}); throw err }
        await engine.dropTable(table)
        table = filtered
      }
    }
    const totalCount = (await engine.tableInfo(table)).count
    // limit 语义（2026-09-18 用户定，恢复合并前行为）：
    //   ≤阈值的小文件 → **LIMIT 取前 N 行**（确定性、可复现，与文档「展示行数上限」一致）
    //   >阈值的大文件 → **抽样 N 行**（大文件本来就不该只看前 N 行）
    //   缺省：小文件全量、大文件按阈值抽样。
    // ⚠ cap 不能再被 engine.threshold 二次钳制（上一版写成 Math.min(a, b, engine.threshold)）：
    // 那会让 limit:80000 在大表上静默变成 50000，与文档承诺不符。
    const withinThreshold = totalCount <= engine.threshold
    const cap = Math.min(totalCount, opts.limit ?? (withinThreshold ? totalCount : engine.threshold))
    let sourceCrs: string | null = null
    let crsInfo: SourceCrsInfo | null = null
    let families: GeomFamily[] = []
    let geojson: FeatureCollection
    if (geomCol && geomFormat) {
      if (!(await engine.ensureSpatial())) throw new Error('CSV 几何列上图需要 DuckDB spatial 扩展')
      sourceCrs = transformed ? null : opts.sourceCrs ?? null
      if (opts.sourceCrs) crsInfo = { crs: opts.sourceCrs, mixed: false, srids: [], status: 'declared' }
      else if (geomFormat === 'geometry') {
        crsInfo = await engine.detectSourceCrs(table, geomCol.name)
        if (crsInfo.mixed) throw new Error('CSV 几何列含多个 SRID，请显式传 sourceCrs 或先清洗数据')
        sourceCrs = crsInfo.crs
      }
      families = geomFormat === 'geometry' ? await geomFamiliesOf(engine, table, geomCol.name) : []
      const attrs = info.columns.filter(c => c !== geomCol.name && c !== DUCK_RID)
      const select = [...attrs.map(quoteIdent), buildGeomSelect(geomCol.name, geomFormat, sourceCrs)].join(', ')
      // 「取前 N 行」按 __rid（= 源文件行序，建表时 row_number 定序）排，不能用 DuckDB 的
      // 默认扫描顺序碰运气 —— 那样同一份文件两次加载可能给出不同的"前 N 行"。
      const rows = withinThreshold
        ? await engine.run(`SELECT ${select} FROM ${table} ORDER BY ${quoteIdent(DUCK_RID)} LIMIT ${cap}`)
        : await geometrySampleRows(engine, table, select, geomCol.name, families, cap)
      geojson = geometryRowsToGeoJSON(rows, attrs)
    } else {
      const rows = withinThreshold
        ? await engine.query(table, `ORDER BY ${quoteIdent(DUCK_RID)} LIMIT ${cap}`)
        : await engine.run(`SELECT * FROM ${table} USING SAMPLE ${Math.max(1, cap)} ROWS`)
      geojson = rowsToGeoJSON(rows, coords.lon!, coords.lat!)
    }
    const shape = geomCol && geomFormat
      ? { duckGeom: { column: geomCol.name, format: geomFormat, sourceCrs } }
      : { duckCoords: { lon: coords.lon!, lat: coords.lat! } }
    // `small`（是否丢表）与 `materialized`（geojson 是否装着全部数据）在这里是**同一个值**，
    // 逐个说清三种情形：
    //   小文件、没被 limit 截断 → 读全、丢表、可编辑
    //   小文件、被 limit 截断   → 只上图前 N 行，但**表必须留着**（limit 只截展示，不丢可分析数据）
    //   大文件                  → 留表 + 抽样展示
    // ⚠ 两个都不再拿 `geojson.features.length === totalCount` 当判据：坐标不可解析的行会被
    // rowsToGeoJSON 丢掉，一行丢掉就把整份小文件误判成"抽样"，图层随之留表变不可编辑，
    // 而守卫的报错还说"请先筛出全量再分析"——那正是它刚做的事。
    const sampled = !withinThreshold
    const truncated = cap < totalCount
    const keepsAll = withinThreshold && !truncated
    const small = keepsAll
    // 只有大文件是"随机抽样"；小文件被 limit 截断是"取前 N 行"，两种都不算全量。
    const dropped = sampled || truncated ? 0 : totalCount - geojson.features.length
    const fullBbox = keepsAll ? undefined : await duckTableFullBBox(engine, table, { coords: shape.duckCoords, geom: shape.duckGeom })
    if (keepsAll) await engine.dropTable(table)
    const crsLine = crsInfo ? `；${crsReport(crsInfo)}` : ''
    const rangeWarn = crsInfo ? crsRangeWarning(fullBbox ?? turfBbox(geojson), crsInfo.status) : ''
    // 丢弃的行必须显式说出来，否则「源 3 行、图上 2 行」会被读成抽样。
    const droppedNote = dropped > 0 ? `；⚠ 其中 ${dropped} 行坐标无法解析已跳过（不参与后续分析）` : ''
    const truncNote = truncated && withinThreshold ? `；limit 只截展示，其余 ${totalCount - cap} 行仍可用于筛选与统计` : ''
    return {
      totalCount, geojson, small, ...shape,
      // 显式给 materialized，不让上层按行数猜：keepsAll 时 geojson 装着全部**可用**行
      // （被丢弃的行本就不含信息，不是被隐藏的）；否则确有行没进 geojson。
      materialized: keepsAll,
      ...(keepsAll ? {} : { duckTable: table, fullBbox }),
      ...(families.length > 1 ? { families } : {}),
      note: `源文件 ${info.count} 行，图层 ${totalCount} 行，显示 ${geojson.features.length} 行`
        + `${sampled ? '（随机抽样）' : truncated ? `（取前 ${cap} 行）` : '（全量）'}`
        + `${truncNote}${droppedNote}${crsLine}`
        + (rangeWarn ? `\n${rangeWarn}` : ''),
    }
  } catch (err) {
    await engine.dropTable(table).catch(() => {})
    throw new Error(csvLoadError(err))
  }
}

/** 本地矢量文件扩展名集合（DuckDB spatial ST_Read/GDAL 直读；webgis_load_dataset 路由用）。 */
export const VECTOR_SOURCE_EXTS = ['shp', 'gdb', 'gpkg', 'kml', 'tab', 'mif', 'dgn']

/** loadVectorSourceData 的输入：路径 + 可选图层/源坐标系。 */
export interface VectorSourceDataOpts {
  layer?: string
  sourceCrs?: string | null
}

/** loadVectorSourceData 的输入：路径 + 可选图层/源坐标系。 */

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
    // 用户显式指定 = 已声明；自动探测的结论（含"是假设还是事实"）要一路带到给模型看的话里。
    let crsInfo: SourceCrsInfo =
      sourceCrs != null ? { crs: sourceCrs, mixed: false, srids: [], status: 'declared' } : { crs: null, mixed: false, srids: [], status: 'assumed-undefined' }
    if (sourceCrs == null && geomFormat === 'geometry') {
      crsInfo = await engine.detectSourceCrs(table, geomName)
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
    const fullBbox = duckTable
      ? await duckTableFullBBox(engine, duckTable, { geom: { column: geomName, format: geomFormat, sourceCrs } })
      : undefined
    const crsLine = `；几何列 ${geomName}：${crsReport(crsInfo)}`
    const rangeWarn = crsRangeWarning(
      fullBbox ?? (turfBbox(geojson as never) as unknown as number[]),
      crsInfo.status,
    )
    return {
      totalCount: created.count,
      geojson,
      duckTable,
      duckGeom: { column: geomName, format: geomFormat, sourceCrs },
      ...(duckTable ? { fullBbox } : {}),
      ...(families && families.length > 1 ? { families } : {}),
      small,
      // 同 CSV 路径：丢弃行不算抽样，显式给 materialized 而不是让上层按行数猜。
      materialized: small,
      note: (small ? '' : `（共 ${created.count} 行，抽样上图 ${geojson.features.length} 行）`)
        + crsLine + (rangeWarn ? `\n${rangeWarn}` : ''),
    }
  } catch (err) {
    await engine.dropTable(table).catch(() => {})
    throw err
  }
}

/**
 * 本地矢量文件（.shp/.gdb/.gpkg/.kml/.tab/.mif…）→ DuckDB spatial `ST_Read` 直读建表 → 图层数据。
 * 超大 .shp 不再先经 shpjs 把全量要素物化成 JS geojson——GDAL 侧一次扫描建内存表，大文件留表 + 抽样上图。
 * ≤阈值小文件全量物化并 DROP 表。几何列 format 按实际检出（GEOMETRY 或 WKB BLOB）：
 * sourceCrs 显式传入优先；GEOMETRY 列 ST_SRID 自动检出（本 duckdb 若无 st_srid 函数则返回 null 按 WGS84）。
 * 多几何族（Point+Polygon 混合）走族分层抽样 + families 标注（makeResultLayer 据此禁 Arrow）。
 */

/** ingestBigGeojson 的产出：大 SHP/GeoJSON 灌表后图层所需句柄 + 上图抽样。 */
export interface IngestBigResult {
  duckTable: string
  duckGeom: DuckGeomSpec
  totalCount: number
  geojson: FeatureCollection
  families?: GeomFamily[]
  fullBbox?: BBox | null
}

/**
 * 大数据统一加载（SHP/GeoJSON/上传共用）：要素 >10 万（DECK_FROM）→ 灌进 DuckDB 内存表，
 * 挂 duckTable/duckGeom → 图层走 arrow + zoom 分级 + worker earcut（与 webgis_load_dataset 大文件一致）。
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
  const fullBbox = await duckTableFullBBox(engine, table, { geom: { column: geomColumn, format: 'geometry', sourceCrs } })
  return {
    duckTable: table,
    duckGeom: { column: geomColumn, format: 'geometry', sourceCrs },
    totalCount,
    geojson,
    ...(fullBbox ? { fullBbox } : {}),
    ...(families.length > 1 ? { families } : {}),
  }
}

/** load_csv 系列失败文案：按错误类型给可行动提示（temp/内存/超时各给对应建议），其余建议 load_dataset。 */
export function csvLoadError(err: unknown): string {
  const msg = String(err instanceof Error ? err.message : err)
  const base = `DuckDB 加载 CSV 失败: ${friendlyDuckError(err)}`
  if (/超时|timeout/i.test(msg)) {
    return `${base}（建表超时：千万级 × 多列大文件需较长时间，引擎已放宽到 5 分钟；仍超时可调大 duckdb.memoryLimit 减少落盘、或先按地市拆分文件）`
  }
  if (/temp|temporary|memory|out of memory/i.test(msg)) {
    return `${base}（疑似内存/临时目录问题：已把 temp_directory 指到系统临时目录；仍失败请调大 duckdb.memoryLimit 或减小加载规模）`
  }
  return `${base}（请检查文件、字段名和坐标系参数）`
}
