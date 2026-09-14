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
      let crsInfo: SourceCrsInfo | null = null
      if (geomFormat === 'geometry') {
        crsInfo = await engine.detectSourceCrs(table, geomCol.name)
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
      const fullBbox = duckTable
        ? await duckTableFullBBox(engine, duckTable, { geom: { column: geomCol.name, format: geomFormat, sourceCrs } })
        : undefined
      // 坐标系与范围自检：**小文件也要说** —— 投影数据当经纬度用，小文件同样会落错位置。
      const crsLine = crsInfo ? `；几何列 ${geomCol.name}：${crsReport(crsInfo)}` : ''
      const rangeWarn = crsInfo
        ? crsRangeWarning(fullBbox ?? (turfBbox(geojson as never) as unknown as number[]), crsInfo.status)
        : ''
      return {
        totalCount: info.count,
        geojson,
        duckTable,
        duckGeom: { column: geomCol.name, format: geomFormat, sourceCrs },
        ...(duckTable ? { fullBbox } : {}),
        families: families.length > 1 ? families : undefined,
        small,
        note: (small ? '' : `（共 ${info.count} 行，抽样上图 ${geojson.features.length} 行）`)
          + crsLine + (rangeWarn ? `\n${rangeWarn}` : ''),
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
    const fullBbox = duckTable
      ? await duckTableFullBBox(engine, duckTable, { coords: { lon, lat } })
      : undefined
    return {
      totalCount: info.count,
      geojson,
      duckTable,
      duckCoords: { lon, lat },
      ...(duckTable ? { fullBbox } : {}),
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
  return `${base}（可改用 webgis_load_dataset 走常规导入）`
}
