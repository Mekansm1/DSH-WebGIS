/**
 * DuckDB 工具注册：webgis_filter_layer / webgis_layer_stats / webgis_export_layer（自 src/duckdb-tools.ts 拆分）。
 */
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
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

export function registerLayerFilterTools(ctx: Context, deps: DuckToolDeps): void {
  const { engine, sess } = deps

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
        const push = await pushResult(`筛选 - ${layer.name}`, fc, {
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

}
