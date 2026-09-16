/**
 * dsh-webgis GIS 工具层 · 叠加类域（仅面；每侧先 union 成一个要素）：clip / intersect /
 * difference / union。注册逻辑与工具行为与拆分前 geo-tools.ts 完全一致，
 * 仅把 sess/schema/文案等共享件来源从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GisLayer } from './geo-processing.js'
import {
  opClip,
  opDifference,
  opIntersect,
  opUnion,
  requireFeatures,
  requireMaterialized,
  requirePolygonOnly,
} from './geo-processing.js'
import { ISOLATED_NOTE, type GeoToolRuntime } from './geo-tools-runtime.js'
import { GEO_TOOL_TIMEOUTS, layerScale, workerBudget } from './geo-job-policy.js'

export function registerOverlayTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, COMMON, LAYER_RESULT_SCHEMA, LAYER_PARAM, text, runGeoOp } = rt

  /** 叠加类都是双图层算子:门控判据是 pairs(两层要素数之积),只看一层会严重低估。 */
  const pairScale = (a: GisLayer, b: GisLayer): number => layerScale(a) * layerScale(b)

  // 叠加类共用校验：两侧都须为已物化的面图层。
  const overlayGuard = (
    resolve: (id: unknown) => GisLayer | string,
    args: { layer: unknown },
    other: string,
  ): { a: GisLayer; b: GisLayer } | { ok: false; message: string } => {
    const a = resolve(args.layer)
    if (typeof a === 'string') return { ok: false as const, message: a }
    const b = resolve(other)
    if (typeof b === 'string') return { ok: false as const, message: b }
    const pa = requirePolygonOnly(a, '叠加')
    if (pa) return { ok: false as const, message: pa }
    const pb = requirePolygonOnly(b, '叠加')
    if (pb) return { ok: false as const, message: pb }
    const fa = requireFeatures(a)
    if (fa) return { ok: false as const, message: fa }
    const fb = requireFeatures(b)
    if (fb) return { ok: false as const, message: fb }
    const ma = requireMaterialized(a, '叠加')
    if (ma) return { ok: false as const, message: ma }
    const mb = requireMaterialized(b, '叠加')
    if (mb) return { ok: false as const, message: mb }
    return { a, b }
  }

  ctx.tools.register(defineTool({
    name: 'webgis_clip',
    description: COMMON + '用 overlay 面图层裁剪 layer，保留 layer 在 overlay 范围内的部分（仅支持面要素）。'
    + ISOLATED_NOTE,
    parameters: {
      layer: LAYER_PARAM,
      overlay: { type: 'string', required: true, description: '裁剪边界图层 id（须为面要素）' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: GEO_TOOL_TIMEOUTS.op,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const g = overlayGuard(resolve, args, args.overlay)
      if (!('a' in g)) return Promise.resolve(g)
      const r = await runGeoOp<ReturnType<typeof opClip>>({
        exec,
        job: { kind: 'clip', a: g.a, b: g.b },
        budgetMs: workerBudget(GEO_TOOL_TIMEOUTS.op),
        sync: () => opClip(g.a, g.b),
        scale: pairScale(g.a, g.b),
      })
      if (!r.ok) return r
      return pushResult('裁剪', r.value, `${g.a.name} × ${g.b.name}`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_intersect',
    description: COMMON + '求两个面图层几何相交的部分（仅支持面要素）。'
    + ISOLATED_NOTE,
    parameters: {
      layerA: { type: 'string', required: true, description: '第一个面图层 id' },
      layerB: { type: 'string', required: true, description: '第二个面图层 id' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: GEO_TOOL_TIMEOUTS.op,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const g = overlayGuard(resolve, { layer: args.layerA }, args.layerB)
      if (!('a' in g)) return Promise.resolve(g)
      const r = await runGeoOp<ReturnType<typeof opIntersect>>({
        exec,
        job: { kind: 'intersect', a: g.a, b: g.b },
        budgetMs: workerBudget(GEO_TOOL_TIMEOUTS.op),
        sync: () => opIntersect(g.a, g.b),
        scale: pairScale(g.a, g.b),
      })
      if (!r.ok) return r
      return pushResult('求交', r.value, `${g.a.name} ∩ ${g.b.name}`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_difference',
    description: COMMON + '从 layer 面图层中减去 overlay 覆盖的区域（仅支持面要素）。'
    + ISOLATED_NOTE,
    parameters: {
      layer: LAYER_PARAM,
      overlay: { type: 'string', required: true, description: '被减去的面图层 id' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: GEO_TOOL_TIMEOUTS.op,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const g = overlayGuard(resolve, args, args.overlay)
      if (!('a' in g)) return Promise.resolve(g)
      const r = await runGeoOp<ReturnType<typeof opDifference>>({
        exec,
        job: { kind: 'difference', a: g.a, b: g.b },
        budgetMs: workerBudget(GEO_TOOL_TIMEOUTS.op),
        sync: () => opDifference(g.a, g.b),
        scale: pairScale(g.a, g.b),
      })
      if (!r.ok) return r
      return pushResult('差集', r.value, `${g.a.name} - ${g.b.name}`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_union',
    description: COMMON + '合并两个面图层为单个面（仅支持面要素）。'
    + ISOLATED_NOTE,
    parameters: {
      layerA: { type: 'string', required: true, description: '第一个面图层 id' },
      layerB: { type: 'string', required: true, description: '第二个面图层 id' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: GEO_TOOL_TIMEOUTS.op,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const g = overlayGuard(resolve, { layer: args.layerA }, args.layerB)
      if (!('a' in g)) return Promise.resolve(g)
      const r = await runGeoOp<ReturnType<typeof opUnion>>({
        exec,
        job: { kind: 'union', a: g.a, b: g.b },
        budgetMs: workerBudget(GEO_TOOL_TIMEOUTS.op),
        sync: () => opUnion(g.a, g.b),
        scale: pairScale(g.a, g.b),
      })
      if (!r.ok) return r
      return pushResult('并集', r.value, `${g.a.name} ∪ ${g.b.name}`)
    },
  }))
}
