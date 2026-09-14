/**
 * DuckDB 工具注册：webgis_sql_layer（只读 SQL → 图层/预览）（自 src/duckdb-tools.ts 拆分）。
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
import { detectCoordColumns, detectGeomColumn, detectGeomFormat } from '../geometry.js'
import type { DuckGeomSource } from '../types.js'
import { DECK_FROM } from '../../render-policy.js'

export function registerSqlTools(ctx: Context, deps: DuckToolDeps): void {
  const { engine, sess } = deps

  ctx.tools.register(defineTool({
    name: 'webgis_sql_layer',
    description:
      '对**含 DuckDB 内存表的图层**（来源不限：csv / shp / geojson 大层）执行只读 SQL（仅 SELECT/WITH/EXPLAIN；禁写操作/分号/注释）。'
      + 'SQL 里用 __layer__ 指代目标图层的表，如 "SELECT adname, count(*) FROM __layer__ GROUP BY adname"。'
      + '系统先统计结果行数：超过上限（默认 5000、可用 limit 调大、硬上限 50000）不执行并给建议。'
      + '结果含几何列（GEOMETRY/WKT/WKB，自动识别、优先级高于经纬度）或经纬度列（lon/lat 等）会自动上图成新图层'
      + '（物化结果，不再可链式筛选）；都没有则返回前 10 行预览。几何列需 spatial 扩展（首次联网），可传 sourceCrs 指定源坐标系。'
      + '优先用 webgis_layer_stats（统计）和 webgis_filter_layer（筛选），本工具留给复杂 SQL。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id（有 DuckDB 内存表即可，来源不限；SQL 里用 __layer__ 指代其表）' },
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
          const push = await pushResult(`SQL - ${layer.name}`, fc, { cluster: false })
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
        const push = await pushResult(`SQL - ${layer.name}`, fc, { cluster: false })
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

/** webgis_sql_layer 的结果行数硬上限（用户 limit 可调到的最大值）。 */
const MAX_SQL_ROWS = 50000

}
