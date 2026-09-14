/**
 * DuckDB 工具注册：webgis_load_csv（CSV → DuckDB 建表 → 上图）（自 src/duckdb-tools.ts 拆分）。
 */
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BBox, Feature, FeatureCollection } from 'geojson'
import type { GisLayer } from '../../geo-processing.js'
import {
  buildGeomSelect, DUCK_RID, friendlyDuckError, geometryRowsToGeoJSON, normalizeValue, quoteIdent, rowsToGeoJSON,
  type DuckColumn, type DuckGeomFormat, type DuckGeomSpec, type VectorTableInfo,
} from '../../duckdb.js'
import {
  bboxPredText, combineWhereText, duckTableFullBBox, geomExprFor, haversinePredText,
  pointLonLatExprOf, qref, rowGeomExprOf, tableBBoxOf,
} from '../geometry.js'
import {
  buildEqualityClause, buildFilterClause, buildPolygonClause, eqClauseText, escIdent,
  finiteInt, geojsonToWkt, inlineValue, num, sanitizeRows,
} from '../filters.js'
import {
  duckGeomSourceOf, fenceWktText, requirePointableLonLat, runDuckRetry, text, type DuckToolDeps,
} from '../tools-shared.js'
import { duckGeomFamiliesOf, geomFamiliesOf, geomFamiliesOfWkb, geometrySampleRows, type GeomFamily } from '../sampling.js'
import { csvLoadError, loadCsvSourceData, loadVectorSourceData } from '../ingestion.js'
import { toCsv, toGeoJSON } from '../../geo-export.js'
import { effectiveCluster, resolveClusterMode, validateSql, type ClusterParam } from '../../postgis.js'
import {
  crsRangeWarning, crsReport, detectCoordColumns, detectGeomColumn, detectGeomFormat, type SourceCrsInfo,
} from '../geometry.js'
import { bbox as turfBbox } from '@turf/bbox'

/** FeatureCollection 的 bbox（坐标范围自检用）。 */
const bboxOf = (fc: FeatureCollection): number[] => turfBbox(fc as never) as unknown as number[]
import type { DuckGeomSource } from '../types.js'
import { DECK_FROM } from '../../render-policy.js'

export function registerLoadCsvTool(ctx: Context, deps: DuckToolDeps): void {
  const { engine, sess } = deps

  ctx.tools.register(defineTool({
    name: 'webgis_load_csv',
    description:
      '【加载 CSV 一律用本工具】把本地 CSV 经 DuckDB 建表后上地图（分析型入口）。'
      + '⚠ 用户说「加载/导入 CSV」时用它，**不要用 webgis_load_dataset**（那条是 GeoJSON / shapefile 的主路径，且不保留可再筛选的内存表）。'
      + '大文件（默认超 5 万行）经 DuckDB 内存表秒级建表：自动识别经纬度列'
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
        // 检出结论（含"是假设还是事实"）要一路带到给模型看的话里 —— 见 geometry.crsReport。
        let crsInfo: SourceCrsInfo | null =
          sourceCrsArg !== undefined ? { crs: sourceCrsArg, mixed: false, srids: [], status: 'declared' } : null
        if (sourceCrsArg === undefined && geomFormat === 'geometry') {
          const detected = await engine.detectSourceCrs(table, geomCol.name)
          if (detected.mixed) {
            await engine.dropTable(table).catch(() => {})
            return {
              ok: false,
              message: `CSV 几何列 ${geomCol.name} 含多个 SRID（${detected.srids.join(', ')}）：不自动整列重投影，`
                + '请显式传 sourceCrs 或先清洗数据。',
            }
          }
          crsInfo = detected
          sourceCrs = detected.crs
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
        // 坐标系必须**每次都说**：crs=null 有三种成因（已声明 4326 / 未声明 / 探不出来），
        // 后两种只是"假设按 WGS84 解释"，不说出来模型就会把假设当事实用。见 geometry.crsReport。
        const crsLine = crsInfo ? `；${crsReport(crsInfo)}` : ''
        // 范围自检：坐标越界 ≈ 投影坐标被当经纬度用了（最危险的一类静默错误）。
        const rangeWarn = crsInfo ? crsRangeWarning(bboxOf(fc), crsInfo.status) : ''
        const push = await pushResult(`CSV - ${base}`, fc, {
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
          message: (small
            ? `${push.message}（共 ${info.count} 行全部上图；几何列 ${geomCol.name}${crsLine}）`
            : `${push.message}（共 ${info.count} 行，抽样上图 ${fc.features.length} 行；几何列 ${geomCol.name}${crsLine}；`
              + `DuckDB 内存表 ${duckTable} 已建，可继续筛选）`) + (rangeWarn ? `\n${rangeWarn}` : ''),
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
      const push = await pushResult(`CSV - ${base}`, fc, {
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

}
