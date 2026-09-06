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
import type { GeoToolRuntime } from './geo-tools-runtime.js'

export function registerQueryTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, COMMON, LAYER_RESULT_SCHEMA, LAYER_PARAM, text } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_select_by_value',
    description: COMMON + '按属性字段值筛选要素，输出新图层。数值字段按数值比较，其余按文本；in 用逗号分隔多个值；is_null/not_null 忽略 value。',
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
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const fieldErr = requireField(layer, args.field)
      if (fieldErr) return Promise.resolve({ ok: false, message: fieldErr })
      const value = typeof args.value === 'string' ? args.value : undefined
      const out = opSelectByValue(layer, args.field, args.operator as SelectOperator, value)
      return Promise.resolve(pushResult('筛选', out, `${layer.name}(${args.field})`))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_spatial_join',
    description: COMMON + '空间连接：对 target 每个要素统计与 joinLayer 中满足 relation 的要素数量，写入 _joinCount 属性（并复制首个匹配要素的 name 到 _joinName）。relation: contains=target 包含 join；within=target 位于 join 内；intersects=相交。',
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
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const target = resolve(args.target)
      if (typeof target === 'string') return Promise.resolve({ ok: false, message: target })
      const join = resolve(args.joinLayer)
      if (typeof join === 'string') return Promise.resolve({ ok: false, message: join })
      const ferr = requireFeatures(target)
      if (ferr) return Promise.resolve({ ok: false, message: ferr })
      const merr = requireMaterialized(target, '空间连接')
      if (merr) return Promise.resolve({ ok: false, message: merr })
      const out = opSpatialJoin(target, join, args.relation as JoinRelation)
      return Promise.resolve(pushResult('空间连接', out, `${target.name} ← ${join.name}`))
    },
  }))
}
