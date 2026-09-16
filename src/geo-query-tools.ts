/**
 * dsh-webgis GIS 工具层 · 查询类域：select_by_value / spatial_join。注册逻辑与工具行为
 * 与拆分前 geo-tools.ts 完全一致，仅把 sess/schema/文案等共享件来源从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JoinRelation, SelectOperator } from './geo-processing.js'
import {
  opSelectByValue,
  opSpatialJoin,
  requireFeatures,
  requireField,
  requireMaterialized,
} from './geo-processing.js'
import { ISOLATED_NOTE, type GeoToolRuntime } from './geo-tools-runtime.js'
import { GEO_TOOL_TIMEOUTS, layerScale, workerBudget } from './geo-job-policy.js'

export function registerQueryTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, COMMON, LAYER_RESULT_SCHEMA, LAYER_PARAM, text, runGeoOp } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_select_by_value',
    description: COMMON + '按属性字段值筛选要素，输出新图层。数值字段按数值比较，其余按文本；in 用逗号分隔多个值；is_null/not_null 忽略 value。'
      + '⚠ 大图层（webgis_list_layers 里 materialized=false，地图上只是抽样）本工具会**自动改道到全表**筛选，'
      + '结果图层仍带着完整内存表、可以继续筛；所以按属性筛选用它不会漏数据。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '属性字段名（用 webgis_layer_info 查看字段）' },
      operator: {
        type: 'string',
        required: true,
        enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'in', 'is_null', 'not_null'],
        description: '比较运算符',
      },
      value: { type: 'string', description: '比较值；in 用逗号分隔多个值；is_null/not_null 忽略该字段' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const fieldErr = requireField(layer, args.field)
      if (fieldErr) return { ok: false, message: fieldErr }
      const value = typeof args.value === 'string' ? args.value : undefined
      const operator = args.operator as SelectOperator
      // 大图层的 geojson 只是上图抽样（≤5 万行），在它上面筛会**静默**给出抽样结果。
      // 改道 DuckDB 跑全表，并把结果内存表挂到新图层上（可继续链式筛选）。
      if (layer.materialized === false && layer.duckTable && rt.attrFilterFullTable) {
        const full = await rt.attrFilterFullTable(layer, args.field, operator, value)
        if (!full.ok) return { ok: false, message: full.message }
        const push = pushResult('筛选', full.geojson, `${layer.name}(${args.field})`, undefined, undefined, full.extra)
        return { ...push, message: `${push.message}（${full.message}）` }
      }
      const out = opSelectByValue(layer, args.field, operator, value)
      return pushResult('筛选', out, `${layer.name}(${args.field})`)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_spatial_join',
    description: COMMON + '空间连接：对 target 每个要素统计与 joinLayer 中满足 relation 的要素数量，写入 _joinCount 属性（并复制首个匹配要素的 name 到 _joinName）。relation: contains=target 包含 join；within=target 位于 join 内；intersects=相交。'
    + ISOLATED_NOTE,
    parameters: {
      target: { type: 'string', required: true, description: '目标图层 id（其每个要素计算一次连接）' },
      joinLayer: { type: 'string', required: true, description: '连接图层 id' },
      relation: {
        type: 'string',
        required: true,
        enum: ['contains', 'within', 'intersects'],
        description: '空间关系：contains=target 包含 join；within=target 位于 join 内；intersects=相交',
      },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: GEO_TOOL_TIMEOUTS.op,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const target = resolve(args.target)
      if (typeof target === 'string') return Promise.resolve({ ok: false, message: target })
      const join = resolve(args.joinLayer)
      if (typeof join === 'string') return Promise.resolve({ ok: false, message: join })
      const ferr = requireFeatures(target)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(target, '空间连接')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      const r = await runGeoOp<ReturnType<typeof opSpatialJoin>>({
        exec,
        job: { kind: 'spatialJoin', target, join, relation: args.relation as JoinRelation },
        budgetMs: workerBudget(GEO_TOOL_TIMEOUTS.op),
        sync: () => opSpatialJoin(target, join, args.relation as JoinRelation),
        // 双图层配对:判据是 pairs
        scale: layerScale(target) * layerScale(join),
      })
      if (!r.ok) return r
      return pushResult('空间连接', r.value, `${target.name} ← ${join.name}`)
    },
  }))
}
