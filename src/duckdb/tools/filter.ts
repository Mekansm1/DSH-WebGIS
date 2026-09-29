import { acquireLayer, type LayerLease } from '../layer-access.js'
/**
 * DuckDB 工具注册：webgis_filter_layer / webgis_layer_stats / webgis_export_layer（自 src/duckdb-tools.ts 拆分）。
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

export function registerLayerFilterTools(ctx: Context, deps: DuckToolDeps): void {
  const { engine, sess } = deps

  ctx.tools.register(defineTool({
    name: 'webgis_filter_layer',
    description: '组合筛选图层完整数据并生成新图层。where 多字段等值、bbox 范围、center+radius 球面米距离、polygon/polygonLayer 面内筛选（ST_Within，不含边界）可叠加。自动识别普通图层和全表来源。'
      + '结果保留完整命中集，limit 只限制显示；超过加载上限返回缩小范围建议。单字段比较/包含可用 webgis_select_by_value。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id' },
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
      const original = resolve(args.layer)
      if (typeof original === 'string') return { ok: false, message: original }
      let lease: LayerLease | undefined
      let resultTable: string | undefined
      try {
        lease = await acquireLayer(engine, original)
        const layer = lease.layer
        const table = layer.duckTable
        const coords = layer.duckCoords
        const geom = layer.duckGeom
        const parts = [buildEqualityClause(args as Record<string, unknown>)]
        if (args.bbox) {
          const bb = args.bbox as { west?: unknown; south?: unknown; east?: unknown; north?: unknown }
          const w = num(bb.west), south = num(bb.south), east = num(bb.east), n = num(bb.north)
          if (w == null || south == null || east == null || n == null || w > east || south > n) throw new Error('bbox 需合法 west/south/east/north')
          if (coords) parts.push(bboxPredText(quoteIdent(coords.lon), quoteIdent(coords.lat), { west: w, south, east, north: n }))
          else {
            if (!(await engine.ensureSpatial())) throw new Error('空间筛选需要 spatial 扩展')
            parts.push(`ST_Intersects(${rowGeomExprOf(duckGeomSourceOf(layer))}, ST_MakeEnvelope(${w}, ${south}, ${east}, ${n}))`)
          }
        }
        if (args.center !== undefined || args.radius !== undefined) {
          const p = await requirePointableLonLat(engine, layer)
          const c = args.center as { lon?: unknown; lat?: unknown } | undefined
          const lon = num(c?.lon), lat = num(c?.lat), radius = num(args.radius)
          if (lon == null || lat == null || radius == null || radius < 0) throw new Error('radius 需非负米数并配 center={lon,lat}')
          parts.push(haversinePredText(p.lon, p.lat, lon, lat, radius))
        }
        if (args.polygon !== undefined || args.polygonLayer !== undefined) {
          if (!(await engine.ensureSpatial())) throw new Error('围栏筛选需要 spatial 扩展')
          const fence = fenceWktText(args as Record<string, unknown>, resolve)
          parts.push(`ST_Within(${rowGeomExprOf(duckGeomSourceOf(layer))}, ST_GeomFromText(${inlineValue(fence)})::GEOMETRY)`)
        }
        const clause = combineWhereText(parts)
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
        resultTable = resTable
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
        resultTable = undefined
        return {
          ...push,
          status: 'ok',
          count,
          table: resTable,
          message: `${push.message}（命中 ${count} 行，上图 ${fc.features.length} 行${clustered ? '，已聚合显示' : ''}）`,
        }
      } catch (err) {
        return { ok: false, message: `筛选失败: ${friendlyDuckError(err)}` }
      } finally {
        if (resultTable) await engine.dropTable(resultTable).catch(() => {})
        await lease?.release()
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_layer_stats',
    description: '返回图层完整数据概览：总行数，可选字段的去重数、最小/最大/均值和 Top10 分布。自动读取全表或当前已物化数据，无需判断来源；不建图层。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id' },
      field: { type: 'string', description: '要统计的字段名（缺省只返回总行数）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          stat: { type: 'string' },
          scope: { type: 'string' },
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
      if (layer.materialized === false && !table) return { ok: false, message: '完整数据不可用，请重新加载；不能统计抽样代替全量' }
      const field = typeof args.field === 'string' && args.field ? args.field : null
      try {
        if (layer.materialized !== false) {
          const features = layer.geojson.features
          const value: Record<string, unknown> = { count: features.length }
          if (field) {
            if (!features.some(f => Object.hasOwn(f.properties ?? {}, field))) {
              // 同 requireField：0 要素时报「图层空」而不是「字段不存在」（后者会让模型
              // 转告用户"你的数据没有这一列"，而其实有——只是上一层筛空了）。
              return { ok: false, message: features.length === 0
                ? `图层 ${layer.id} 没有要素（0 行），无法按字段 ${field} 统计（请先确认筛选条件是否过窄）`
                : `字段 ${field} 不存在` }
            }
            const vals = features.map(f => f.properties?.[field] ?? null)
            const present = vals.filter(v => v !== null)
            value.distinct = new Set(present.map(v => JSON.stringify(v))).size
            const numeric = present.every(v => typeof v === 'number')
            const sorted = [...present].sort((a, b) => numeric ? Number(a) - Number(b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0)
            value.min = sorted[0] ?? null
            value.max = sorted.at(-1) ?? null
            if (numeric) value.avg = present.length ? present.reduce((a: number, b) => a + Number(b), 0) / present.length : null
            const counts = new Map<string, { value: unknown; count: number }>()
            for (const v of vals) {
              const key = JSON.stringify(v)
              const entry = counts.get(key) ?? { value: v, count: 0 }
              entry.count++
              counts.set(key, entry)
            }
            value.top = [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 10)
          }
          return { ok: true, scope: 'full_table', stat: field ?? 'count', value: value as JsonValue,
            message: `图层 ${layer.id} 共 ${features.length} 行（完整图层统计）` }
        }
        const info = await engine.tableInfo(table!)
        if (field && !(await engine.describe(table!)).some(c => c.name === field)) return { ok: false, message: `字段 ${field} 不存在` }
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
          scope: 'full_table',
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
      '【导出一个图层为文件】把图层的当前内容导出为 CSV（几何列以 WKT 保存）或 GeoJSON，返回文件绝对路径。path 可选（缺省 ~/.dsh/webgis-exports/）。'
      + '⚠ 三个「导出」别混：本工具产**文件**（CSV/GeoJSON）；用户要**图片**用 webgis_export_map；'
      + '用户要**当前视野的底图数据**（河流/道路/建筑等）用 webgis_export_basemap（那个不产文件，是新建图层）。'
      + '注意：DuckDB 大文件图层导出的是上图子集（抽样）；要导出完整筛选结果，先用支持该图层类型的筛选工具筛出子集再导出。',
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
