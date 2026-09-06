/**
 * dsh-webgis GIS 工具层 · 构造类域：buffer / centroids / convex_hull / bounding_box /
 * dissolve / simplify / explode。注册逻辑与工具行为与拆分前 geo-tools.ts 完全一致，
 * 仅把 sess/schema/文案等共享件来源从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  opBBoxPolygon,
  opBuffer,
  opCentroids,
  opConvexHull,
  opDissolve,
  opExplode,
  opSimplify,
  requireFeatures,
  requireField,
  requireMaterialized,
  requirePolygonOnly,
} from './geo-processing.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

export function registerConstructTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, COMMON, LAYER_RESULT_SCHEMA, LAYER_PARAM, text } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_buffer',
    description: COMMON + '对指定图层做缓冲区分析（buffer），结果生成新的面图层。distance 为缓冲区半径，unit 为半径单位。',
    parameters: {
      layer: LAYER_PARAM,
      distance: { type: 'number', required: true, description: '缓冲区半径（大于 0）' },
      unit: {
        type: 'string',
        enum: ['miles', 'kilometers', 'meters', 'feet', 'yards', 'degrees'],
        description: '半径单位，默认 kilometers',
      },
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
      const merr = requireMaterialized(layer, '缓冲')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      const distance = Number(args.distance)
      if (!Number.isFinite(distance) || distance <= 0) {
        return Promise.resolve({ ok: false, message: 'distance 必须是大于 0 的数字' })
      }
      const unit = typeof args.unit === 'string' ? args.unit : 'kilometers'
      const out = opBuffer(layer, distance, unit)
      return Promise.resolve(pushResult('缓冲', out, layer.name))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_centroids',
    description: COMMON + '求图层每个要素的几何质心，输出点图层（保留原属性）。',
    parameters: { layer: LAYER_PARAM },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(layer, '质心')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      return Promise.resolve(pushResult('质心', opCentroids(layer), layer.name))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_convex_hull',
    description: COMMON + '计算图层全部要素的最小凸包，输出面图层。',
    parameters: { layer: LAYER_PARAM },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(layer, '凸包')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      return Promise.resolve(pushResult('凸包', opConvexHull(layer), layer.name))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_bounding_box',
    description: COMMON + '生成包裹图层全部要素的外接矩形面。',
    parameters: { layer: LAYER_PARAM },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      return Promise.resolve(pushResult('外接矩形', opBBoxPolygon(layer), layer.name))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_dissolve',
    description: COMMON + '按属性字段合并相邻面要素（溶解）；不传 field 则把全部要素合并为一个。仅支持面要素。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', description: '按该属性字段分组溶解；省略则全图溶解为一个要素' },
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
      const perr = requirePolygonOnly(layer, '溶解')
      if (perr) return Promise.resolve({ ok: false, message: perr })
      const merr = requireMaterialized(layer, '溶解')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      const field = typeof args.field === 'string' && args.field ? args.field : undefined
      if (field) {
        const fieldErr = requireField(layer, field)
        if (fieldErr) return Promise.resolve({ ok: false, message: fieldErr })
      }
      return Promise.resolve(pushResult('溶解', opDissolve(layer, field), layer.name))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_simplify',
    description: COMMON + '用 Douglas-Peucker 算法简化图层几何。tolerance 单位为坐标度数（WGS84，非米），建议从 0.001 起试。',
    parameters: {
      layer: LAYER_PARAM,
      tolerance: { type: 'number', required: true, description: '简化容差（坐标度数，大于 0）' },
      highQuality: { type: 'boolean', description: '是否高质量算法（更慢），默认 false' },
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
      const merr = requireMaterialized(layer, '简化')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      const tolerance = Number(args.tolerance)
      if (!Number.isFinite(tolerance) || tolerance <= 0) {
        return Promise.resolve({ ok: false, message: 'tolerance 必须是大于 0 的数字' })
      }
      const out = opSimplify(layer, tolerance, args.highQuality === true)
      return Promise.resolve(pushResult('简化', out, layer.name))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_explode',
    description: COMMON + '把多部件要素拆分为单部件要素（MultiPolygon→Polygon 等），输出拆分后的新图层。',
    parameters: { layer: LAYER_PARAM },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const ferr = requireFeatures(layer)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(layer, '拆分')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      return Promise.resolve(pushResult('拆分', opExplode(layer), layer.name))
    },
  }))
}
