import { acquireLayer, type LayerLease } from '../layer-access.js'
/**
 * DuckDB 工具注册：webgis_spatial_aggregate（全表空间聚合）（自 src/duckdb-tools.ts 拆分）。
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
import { DECK_FROM } from '../../render-policy.js'

export function registerSpatialAggregateTool(ctx: Context, deps: DuckToolDeps): void {
  const { engine, sess } = deps

  ctx.tools.register(defineTool({
    name: 'webgis_spatial_aggregate',
    description: '对图层完整数据聚合，自动识别普通图层与全表来源。kind=attribute 按 groupBy 分组返回指标；kind=grid 对点生成密度网格图层。'
      + '默认 count，metrics 支持去重计数/sum/avg，where 叠加等值条件。grid 用 lat0 将米近似换为经纬度，maxCells 取最密的前 N 格，返回说明截断与计算口径。attribute 最多返回 2000 组。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id' },
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
          totalGroups: { type: 'integer' },
          truncated: { type: 'boolean' },
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
      let layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      let lease: LayerLease | undefined
      try {
        lease = await acquireLayer(engine, layer)
        layer = lease.layer
        const table = lease.layer.duckTable
        const shape = duckGeomSourceOf(layer)
        const kind = args.kind
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
            `SELECT ${quoteIdent(gb)} AS __value, count(*) OVER () AS __groups, ${aggSels.join(', ')} FROM ${table} ${whereText} `
            + `GROUP BY 1 ORDER BY count(*) DESC LIMIT ${AGG_GROUP_LIMIT}`,
          )
          const totalGroups = Number(rows[0]?.__groups ?? 0)
          const outRows = rows.map((r) => {
            const o: Record<string, unknown> = { value: normalizeValue(r.__value) }
            metrics.forEach((m, i) => { o[m.key] = normalizeValue(r[`__a${i}`]) })
            return o
          })
          return {
            ok: true, kind, scope: 'full_table',
            sourceCount, resultCount: outRows.length, displayedCount: 0, totalGroups, truncated: totalGroups > outRows.length,
            rows: outRows as unknown as JsonValue,
            note: `全表 ${sourceCount} 行上按 ${gb} 分组聚合，共 ${totalGroups} 组，返回 ${outRows.length} 组${totalGroups > outRows.length ? '（已截断）' : ''}（未上图）。`,
            message: `按 ${gb} 分组共 ${totalGroups} 组，返回 ${outRows.length} 组（全表 ${sourceCount} 行上计算；where 子集已生效）。`,
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
          + `SELECT i, j, count(*) OVER () AS __groups, ${aggSels.join(', ')} FROM __src GROUP BY i, j `
          + `ORDER BY count(*) DESC LIMIT ${maxCells}`,
        )
        const totalGroups = Number(rows[0]?.__groups ?? 0)
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
        const push = await pushResult(`空间聚合 - ${layer.name}`, fc, { cluster: false, totalCount: features.length })
        const note = `全表 ${sourceCount} 行上按 ${cellM} 米网格聚合（参考纬度 ${lat0.toFixed(4)}°，`
          + `约 dLon=${dLon.toFixed(6)}° dLat=${dLat.toFixed(6)}°，米制近似），`
          + `共 ${totalGroups} 格，输出 ${features.length} 格${totalGroups > features.length ? '（已截断）' : ''}（scope=full_table，网格为近似多边形）。`
        return {
          ...push,
          ok: true, kind, scope: 'full_table',
          sourceCount, resultCount: features.length, displayedCount: features.length, totalGroups, truncated: totalGroups > features.length,
          note,
          message: `${push.message}（${note}）`,
        }
      } catch (err) {
        return { ok: false, message: `空间聚合失败: ${friendlyDuckError(err)}` }
      } finally {
        await lease?.release()
      }
    },
  }))

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

/** spatial_aggregate attribute 分组上限。 */
const AGG_GROUP_LIMIT = 2000

/** grid 聚合默认格子尺寸（米）与格子数上限。 */
const GRID_DEFAULT_CELL_M = 1000

const GRID_DEFAULT_MAX_CELLS = 2000

const GRID_MAX_CELLS = 100000

}
