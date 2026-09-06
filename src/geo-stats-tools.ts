/**
 * dsh-webgis GIS 工具层 · 空间统计域（功能 4）：kernel_density / average_nearest_neighbor /
 * moran_i。注册逻辑与工具行为与拆分前 geo-tools.ts 完全一致，仅把 sess/schema/文案等
 * 共享件来源从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { DisplayMode } from './geo-processing.js'
import { opAverageNearestNeighbor, opKernelDensity, opMoranI } from './geo-stats.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

export function registerStatsTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, COMMON, MODE_LABEL, REMINDER, LAYER_RESULT_SCHEMA, LAYER_PARAM, STAT_RESULT_SCHEMA, text } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_kernel_density',
    description: COMMON + '对点图层做 quartic 核密度估计，输出规则网格点图层（含 density 属性，值越大越密集）。mode 指定展示方式。默认 radiusMeters 5000、cellSizeMeters 500、mode plane。',
    parameters: {
      layer: LAYER_PARAM,
      radiusMeters: { type: 'number', description: '核带宽（米），默认 5000' },
      cellSizeMeters: { type: 'number', description: '网格间距（米），默认 500；格数超 40000 会报错' },
      mode: {
        type: 'string', enum: ['points', 'plane', 'hex'],
        description: '展示方式：points=原始点；plane=平面热力图（默认，maplibre 原生平滑热色）；hex=蜂窝热力图（六边形柱，柱高=密度，地图自动俯仰视角）',
      },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const radius = typeof args.radiusMeters === 'number' ? args.radiusMeters : 5000
      const cell = typeof args.cellSizeMeters === 'number' ? args.cellSizeMeters : 500
      const mode: DisplayMode = args.mode === 'hex' || args.mode === 'points' ? args.mode : 'plane'
      const res = opKernelDensity(layer.geojson, radius, cell)
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const out = pushResult('核密度', res.geojson, layer.name, mode)
      const sampleNote = layer.materialized === false ? `（注意：基于上图抽样子集计算，共 ${layer.totalCount ?? '?'} 行、上图 ${layer.featureCount} 行）` : ''
      return Promise.resolve({ ...out, message: `${out.message}。展示方式：${MODE_LABEL[mode]}。${sampleNote}${REMINDER}` })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_average_nearest_neighbor',
    description: COMMON + '计算平均最近邻指数（ANN）：r<1 呈聚集、r≈1 随机、r>1 分散。返回统计值（不生成新图层）。',
    parameters: { layer: LAYER_PARAM },
    output: { schema: STAT_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const res = opAverageNearestNeighbor(layer.geojson)
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const annSample = layer.materialized === false ? `（基于抽样 ${layer.featureCount}/${layer.totalCount ?? '?'} 行）` : ''
      return Promise.resolve({
        ok: true,
        stat: 'ann',
        value: { observed: res.observed, expected: res.expected, r: res.r, n: res.n, areaM2: res.areaM2 },
        message: `平均最近邻指数 R=${res.r.toFixed(3)}（<1 聚集 / ≈1 随机 / >1 分散），实测均距 ${res.observed.toFixed(0)}m、期望 ${res.expected.toFixed(0)}m${annSample}`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_moran_i',
    description: COMMON + '计算全局 Moran I（面要素 queen 邻接）：I>0 空间正自相关（同值聚集）、I≈0 随机、I<0 负自相关。返回 I/z/p（不生成新图层）。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '数值属性字段（如人口、密度）' },
    },
    output: { schema: STAT_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const field = typeof args.field === 'string' ? args.field : ''
      if (!field) return Promise.resolve({ ok: false, message: 'field 不能为空' })
      const res = opMoranI(layer.geojson, field)
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const moranSample = layer.materialized === false ? `（基于抽样 ${layer.featureCount}/${layer.totalCount ?? '?'} 行）` : ''
      return Promise.resolve({
        ok: true,
        stat: 'moran_i',
        value: { I: res.I, expected: res.expected, variance: res.variance, z: res.z, p: res.p, n: res.n, neighbors: res.neighbors },
        message: `Moran I=${res.I.toFixed(4)}，z=${res.z.toFixed(2)}，p=${res.p.toFixed(4)}（${res.neighbors} 对相邻要素）${moranSample}`,
      })
    },
  }))
}
