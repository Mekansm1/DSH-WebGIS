/**
 * dsh-webgis GIS 工具层 · 矢量扩展域（功能 4）：smooth / reproject / regular_grid /
 * voronoi / attribute_join / select_by_location。注册逻辑与工具行为与拆分前
 * geo-tools.ts 完全一致，仅把 sess/schema/文案等共享件来源从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BBox } from 'geojson'
import type { GisLayer, JoinRelation } from './geo-processing.js'
import {
  opAttributeJoin,
  opRegularGrid,
  opReproject,
  opSelectByLocation,
  opSmooth,
  opVoronoi,
  requireFeatures,
  requireMaterialized,
} from './geo-processing.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

export function registerVectorTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, COMMON, LAYER_RESULT_SCHEMA, LAYER_PARAM, text } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_smooth',
    description: COMMON + '对线/面图层做 Chaikin 平滑（角切），顶点数随迭代翻倍（默认 1 次，1–5）。',
    parameters: {
      layer: LAYER_PARAM,
      iterations: { type: 'integer', description: '平滑迭代次数（默认 1，越界自动钳制到 1–5）' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(layer, '平滑')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      try {
        const iterations = typeof args.iterations === 'number' ? args.iterations : 1
        return Promise.resolve(pushResult('平滑', opSmooth(layer, iterations), layer.name))
      } catch (err) {
        return Promise.resolve({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_reproject',
    description: COMMON + '在 WGS84 与 Web Mercator 之间重投影。to=mercator 时坐标为米制（用于链式量算/缓冲；直接上图可能偏离视野，可再转回 wgs84）。',
    parameters: {
      layer: LAYER_PARAM,
      to: { type: 'string', enum: ['mercator', 'wgs84'], description: '目标投影：mercator（Web Mercator，米制）或 wgs84（经纬度），默认 mercator' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const to = args.to === 'wgs84' ? 'wgs84' : 'mercator'
      return Promise.resolve(pushResult('重投影', opReproject(layer, to), layer.name))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_regular_grid',
    description: COMMON + '按 bbox 与格边长生成规则方格网（单位默认 kilometers），用于采样/统计。',
    parameters: {
      bbox: { type: 'json', description: '范围 [west, south, east, north]（经纬度，w<e、s<n）' },
      cellSize: { type: 'number', required: true, description: '格边长（大于 0）' },
      unit: { type: 'string', enum: ['miles', 'kilometers', 'meters', 'feet', 'yards', 'degrees'], description: '格边长单位，默认 kilometers' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { pushResult } = sess(exec)
      const bbox = Array.isArray(args.bbox) && args.bbox.length === 4 ? args.bbox as unknown as BBox : null
      if (!bbox) return Promise.resolve({ ok: false, message: 'bbox 必须为 [west, south, east, north] 四个数字' })
      const cellSize = Number(args.cellSize)
      const unit = typeof args.unit === 'string' ? args.unit : 'kilometers'
      try {
        return Promise.resolve(pushResult('规则格网', opRegularGrid(bbox, cellSize, unit), 'bbox'))
      } catch (err) {
        return Promise.resolve({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_voronoi',
    description: COMMON + '对点图层生成泰森多边形（Voronoi），每点一个面（范围默认图层外扩 10%，可传 bbox 限定）。',
    parameters: {
      layer: LAYER_PARAM,
      bbox: { type: 'json', description: '计算范围 [west, south, east, north]（可选）' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(layer, '泰森多边形')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      const bbox = Array.isArray(args.bbox) && args.bbox.length === 4 ? args.bbox as unknown as BBox : undefined
      try {
        return Promise.resolve(pushResult('泰森多边形', opVoronoi(layer, bbox), layer.name))
      } catch (err) {
        return Promise.resolve({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_attribute_join',
    description: COMMON + '按字段值做属性连接（inner join）：把 joinLayer 的属性按目标字段并入 target，无匹配的要素丢弃。',
    parameters: {
      target: LAYER_PARAM,
      joinLayer: { type: 'string', required: true, description: '被连接图层 id（属性来源）' },
      targetField: { type: 'string', required: true, description: 'target 图层的连接字段' },
      joinField: { type: 'string', description: 'joinLayer 的连接字段（默认与 targetField 同名）' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const target = resolve(args.target)
      if (typeof target === 'string') return Promise.resolve({ ok: false, message: target })
      const join = resolve(args.joinLayer)
      if (typeof join === 'string') return Promise.resolve({ ok: false, message: join })
      const targetField = typeof args.targetField === 'string' ? args.targetField : ''
      if (!targetField) return Promise.resolve({ ok: false, message: 'targetField 不能为空' })
      const joinField = typeof args.joinField === 'string' ? args.joinField : undefined
      try {
        return Promise.resolve(pushResult('属性连接', opAttributeJoin(target, join, targetField, joinField), `${target.name} ← ${join.name}`))
      } catch (err) {
        return Promise.resolve({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_select_by_location',
    description: COMMON + '按位置筛选要素：保留与 overlay 图层（任一要素满足）或 bbox 满足空间关系的要素。relation：contains（含）/within（在内）/intersects（相交）。overlay 与 bbox 二选一。',
    parameters: {
      layer: LAYER_PARAM,
      relation: { type: 'string', enum: ['contains', 'within', 'intersects'], description: '空间关系（默认 intersects）' },
      overlay: { type: 'string', description: '参考图层 id（任一要素满足即保留）' },
      bbox: { type: 'json', description: '或 bbox [west, south, east, north]' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(layer, '位置筛选')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      const relation = (args.relation === 'contains' || args.relation === 'within' ? args.relation : 'intersects') as JoinRelation
      const hasOverlay = typeof args.overlay === 'string' && args.overlay !== ''
      const bbox = Array.isArray(args.bbox) && args.bbox.length === 4 ? args.bbox as unknown as BBox : undefined
      if (hasOverlay === Boolean(bbox)) return Promise.resolve({ ok: false, message: 'overlay 与 bbox 必须且只能提供一个' })
      const overlay = hasOverlay ? resolve(args.overlay) : undefined
      if (hasOverlay && typeof overlay === 'string') return Promise.resolve({ ok: false, message: overlay })
      try {
        return Promise.resolve(pushResult('位置筛选', opSelectByLocation(layer, relation, overlay as GisLayer | undefined, bbox), layer.name))
      } catch (err) {
        return Promise.resolve({ ok: false, message: err instanceof Error ? err.message : String(err) })
      }
    },
  }))
}
