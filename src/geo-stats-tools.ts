/**
 * dsh-webgis GIS 工具层 · 空间统计域（功能 4）：kernel_density / average_nearest_neighbor /
 * moran_i / moran_inspect / local_moran。
 *
 * 莫兰指数按「先诊断 → 用户确认 → 再计算」的流程设计：
 *  - `webgis_moran_inspect` 只做数据体检（图层/几何/数值字段可用性），返回推荐字段与默认参数，
 *    不执行任何统计；AI 必须把结果展示给用户并征得确认后再调用下面两个计算工具。
 *  - `webgis_moran_i`（全局 I，可换 queen/rook/distance/knn 权重、可置换检验）
 *  - `webgis_local_moran`（LISA：产出带 lisa_class 的新图层，看「哪里聚集」）
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { FeatureCollection } from 'geojson'
import type { DisplayMode } from './geo-processing.js'
import {
  defaultWeightFor, opAverageNearestNeighbor, opKernelDensity, opLocalMoranI, opMoranI,
  PERMUTATIONS_DEFAULT, type WeightType,
} from './geo-stats.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

/** 权重方式参数的 schema 片段（三个工具共用文案）。 */
const WEIGHT_PARAMS = {
  weight: {
    type: 'string',
    enum: ['queen', 'rook', 'distance', 'knn'],
    description: '空间权重：queen=面共边/共点相邻（默认，仅面）；rook=仅共边（仅面）；distance=距离阈值内相邻（点/线/面）；knn=最近 K 个邻居（点/线/面）',
  },
  distanceMeters: { type: 'number', description: 'distance 权重的距离阈值（米），仅 weight=distance 时必填' },
  k: { type: 'integer', description: 'knn 的邻居数（默认 5，1..50）' },
  permutations: { type: 'integer', description: `置换检验次数（默认 0=正态解析近似；${PERMUTATIONS_DEFAULT} 次更可靠，固定 seed 可复现）` },
  seed: { type: 'integer', description: '置换检验随机种子（默认 42）' },
} as const

/** 数值字段体检结果（只含判断，不含原始数据）。 */
export interface FieldReport {
  field: string
  valid: number
  nullRate: number
  min: number
  max: number
  mean: number
  std: number
  unique: number
  /** 推荐 / 不推荐原因（推荐时为 undefined）。 */
  excluded?: string
}

/** 标识列/编码列（不推荐用于统计）。 */
const IDENT_RE = /^(objectid|fid|gid|ogc_fid|id|uuid|.*_id|.*id|code|.*code|.*编码|.*代码|.*编号)$/i

/** 扫描图层属性里的数值字段（含空值率/分布/唯一值），并给出推荐与排除原因。
 *  （统计指数目录 geo-indices.ts 的通用体检复用它——只判定、不计算。） */
export function inspectFields(fc: FeatureCollection): { recommended: FieldReport[]; excluded: FieldReport[] } {
  const feats = fc.features
  const n = feats.length
  const keys = new Set<string>()
  for (const f of feats) {
    for (const k of Object.keys(f?.properties ?? {})) keys.add(k)
  }
  const recommended: FieldReport[] = []
  const excluded: FieldReport[] = []
  for (const field of keys) {
    const raw = feats.map((f) => f?.properties?.[field])
    const nums: number[] = []
    let nullish = 0
    let nonNumeric = 0
    for (const v of raw) {
      if (v == null || v === '') { nullish++; continue }
      if (typeof v === 'boolean') { nonNumeric++; continue }
      const x = typeof v === 'number' ? v : Number(v)
      if (!Number.isFinite(x)) { nonNumeric++; continue }
      nums.push(x)
    }
    const valid = nums.length
    const nullRate = n > 0 ? Number(((nullish + nonNumeric) / n).toFixed(3)) : 1
    const report: FieldReport = {
      field,
      valid,
      nullRate,
      min: valid ? Math.min(...nums) : 0,
      max: valid ? Math.max(...nums) : 0,
      mean: 0,
      std: 0,
      unique: new Set(nums).size,
    }
    if (valid) {
      const mean = nums.reduce((a, b) => a + b, 0) / valid
      const varr = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / valid
      report.mean = Number(mean.toFixed(4))
      report.std = Number(Math.sqrt(varr).toFixed(4))
    }
    let why: string | undefined
    // 标识/编码列优先按「无空间意义」排除（即使是数值型 ID 也一样），比「非数值字段」更能说明原因。
    if (IDENT_RE.test(field)) why = '标识/编码列（ID、代码等，无空间意义）'
    else if (nonNumeric > 0 && valid === 0) why = '非数值字段'
    else if (valid < 3) why = `有效数值过少（${valid} 个）`
    else if (report.unique <= 1) why = '取值恒定（方差为 0）'
    else if (nullRate > 0.5) why = `空值/无效值过多（${Math.round(nullRate * 100)}%）`
    if (why) excluded.push({ ...report, excluded: why })
    else recommended.push(report)
  }
  recommended.sort((a, b) => b.valid - a.valid)
  return { recommended, excluded }
}

/** 一行字段摘要（给用户看的确认卡片用）。 */
export function fieldLine(r: FieldReport): string {
  return `${r.field}（有效 ${r.valid}，均值 ${r.mean}，标准差 ${r.std}，唯一值 ${r.unique}）`
}

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

  // ---- 莫兰分析前的数据体检（只诊断，不计算） ----
  ctx.tools.register(defineTool({
    name: 'webgis_moran_inspect',
    description: COMMON
      + '【莫兰分析第一步·必须先调用】体检可用于空间自相关分析的数据：不传 layer 时扫描当前会话全部图层，'
      + '给出每个图层的几何类型、要素数、可用数值字段（含有效值/空值率/均值/标准差/唯一值）、'
      + '被排除字段及原因、可用的权重方式与推荐默认参数；数据不足时明确说明原因与修正建议。'
      + '本工具**不执行任何统计计算**。拿到结果后必须把「推荐字段 + 默认参数 + 可选分析（全局 Moran I / 局部 LISA）」'
      + '展示给用户并等待确认（用户可指定字段、权重、距离阈值、K、置换次数）；'
      + '未获用户确认前不得直接调用 webgis_moran_i / webgis_local_moran，也不得自行替用户选字段。',
    parameters: {
      layer: { type: 'string', description: '要体检的图层 id（缺省=扫描当前会话所有图层并逐个给出结论）' },
    },
    output: { schema: STAT_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { layers, resolve } = sess(exec)
      const targets = typeof args.layer === 'string' && args.layer
        ? (() => { const l = resolve(args.layer); return typeof l === 'string' ? l : [l] })()
        : layers()
      if (typeof targets === 'string') return Promise.resolve({ ok: false, message: targets })
      if (targets.length === 0) {
        return Promise.resolve({ ok: false, stat: 'moran_inspect', value: { layers: [] }, message: '当前会话还没有任何图层：请先加载数据（webgis_load_dataset / webgis_load_csv / 数据库查询上图）再谈空间自相关分析。' })
      }

      const report: Array<Record<string, unknown>> = []
      const lines: string[] = []
      for (const layer of targets) {
        const types = layer.geometryTypes ?? []
        const n = layer.featureCount
        const { recommended, excluded } = inspectFields(layer.geojson)
        const weightHint = defaultWeightFor(types)
        const canWeight = types.length > 0 && (types.every((t) => t === 'Polygon' || t === 'MultiPolygon') || types.every((t) => t === 'Point' || t === 'MultiPoint' || t === 'LineString' || t === 'MultiLineString'))
        const reasons: string[] = []
        if (n < 3) reasons.push(`要素过少（${n} 个，空间自相关至少需要 3 个）`)
        if (types.length === 0) reasons.push('图层没有几何（纯属性表无法做空间分析）')
        if (!canWeight) reasons.push(`几何类型混杂（${types.join('/')}），无法构造统一邻接关系`)
        if (recommended.length === 0) reasons.push('没有可用的数值字段（见下）')
        const needFull = layer.materialized === false
        const warning = needFull
          ? `⚠ 该图层是大文件的抽样显示（${n}/${layer.totalCount ?? '?'} 行）：莫兰指数必须基于全量数据，`
            + '请先用 webgis_filter_layer / webgis_spatial_filter 把目标范围筛成全量图层再分析。'
          : ''

        report.push({
          layerId: layer.id,
          name: layer.name,
          featureCount: n,
          geometryTypes: types,
          materialized: layer.materialized !== false,
          totalCount: layer.totalCount,
          recommendedFields: recommended,
          excludedFields: excluded,
          defaultWeight: weightHint,
          feasible: reasons.length === 0,
          reasons,
          warning,
        })

        const excludedLine = excluded.length
          ? `已排除字段：${excluded.map((e) => `${e.field}（${e.excluded}）`).join('、')}。`
          : ''
        if (reasons.length > 0) {
          lines.push([
            `图层「${layer.name}」(${layer.id})：当前无法支持莫兰指数分析 —— ${reasons.join('；')}。`,
            excludedLine,
            '建议：换一个有数值属性的图层，或用 webgis_sql_layer 从现有表派生数值列（如密度=数量/面积）。',
          ].join(''))
          continue
        }
        const canQueen = types.every((t) => t === 'Polygon' || t === 'MultiPolygon')
        const notRecommendLine = excluded.length
          ? `不推荐：${excluded.slice(0, 6).map((e) => `${e.field}（${e.excluded}）`).join('、')}。`
          : ''
        lines.push([
          `图层「${layer.name}」(${layer.id})：${n} 个要素（${types.join('/')}），可做空间自相关分析。`,
          `推荐字段：${recommended.slice(0, 5).map(fieldLine).join('；')}。`,
          notRecommendLine,
          `可用权重：${canQueen ? 'queen（默认）/rook/distance/knn' : 'distance/knn（默认 knn k=5）'}；`,
          `默认参数：置换检验 ${PERMUTATIONS_DEFAULT} 次、显著性 α=0.05、seed=42。`,
          '可选分析：全局 Moran I（整体聚集强度）与局部 LISA（哪里 HH/LL 聚集，可上图）。',
          warning ? ` ${warning}` : '',
        ].join(''))
      }

      const anyFeasible = report.some((r) => r.feasible === true)
      const head = anyFeasible
        ? '【莫兰分析体检】以下图层可分析，请把推荐字段与默认参数展示给用户并等待确认（用户可选字段/权重/距离/K/置换次数）：'
        : '【莫兰分析体检】当前没有可直接分析的图层，原因与修正建议如下：'
      const tail = anyFeasible
        ? '确认后：整体聚集用 webgis_moran_i，热点分布用 webgis_local_moran（会生成带 lisa_class 的新图层）。'
        : '修正数据后请重新调用本工具体检。'
      return Promise.resolve({
        ok: true,
        stat: 'moran_inspect',
        value: { layers: report as unknown as JsonValue, anyFeasible, defaults: { permutations: PERMUTATIONS_DEFAULT, alpha: 0.05, seed: 42 } },
        message: `${head}\n${lines.join('\n')}\n${tail}`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_moran_i',
    description: COMMON
      + '计算全局 Moran I：I>0 空间正自相关（同值聚集）、I≈0 随机、I<0 负自相关。'
      + '权重可选 queen（面共边/共点，默认）/rook（面仅共边）/distance（距离阈值内，需 distanceMeters）/knn（最近 K 个邻居，默认 5）；'
      + '点/线图层自动用 knn。permutations>0 时用置换检验（固定 seed 可复现），更可靠。'
      + '【流程要求】应先经 webgis_moran_inspect 体检并把候选字段/参数交用户确认后再调用本工具；返回统计值，不生成新图层。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '数值属性字段（如人口、密度）' },
      ...WEIGHT_PARAMS,
    },
    output: { schema: STAT_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const field = typeof args.field === 'string' ? args.field : ''
      if (!field) return Promise.resolve({ ok: false, message: 'field 不能为空' })
      const weight = typeof args.weight === 'string' ? args.weight as WeightType : undefined
      const res = opMoranI(layer.geojson, field, {
        ...(weight ? { type: weight } : {}),
        ...(typeof args.distanceMeters === 'number' ? { distanceMeters: args.distanceMeters } : {}),
        ...(typeof args.k === 'number' ? { k: args.k } : {}),
        ...(typeof args.permutations === 'number' ? { permutations: args.permutations } : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
      })
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const moranSample = layer.materialized === false ? `（注意：基于上图抽样子集计算，共 ${layer.totalCount ?? '?'} 行、上图 ${layer.featureCount} 行——抽样会破坏空间自相关，结论不可靠）` : ''
      const sig = res.p < 0.05 ? '显著' : '不显著'
      const dir = res.I > 0 ? '正自相关（同值聚集）' : res.I < 0 ? '负自相关（高低相间）' : '接近随机'
      return Promise.resolve({
        ok: true,
        stat: 'moran_i',
        value: {
          I: res.I, expected: res.expected, variance: res.variance, z: res.z, p: res.p,
          n: res.n, neighbors: res.neighbors, weight: res.weightType, test: res.test,
          ...(res.note ? { note: res.note } : {}),
        },
        message: `Moran I=${res.I.toFixed(4)}（${dir}），z=${res.z.toFixed(2)}，p=${res.p.toFixed(4)}（${sig}）；`
          + `权重 ${res.weightType}${res.note ? `·${res.note}` : ''}，${res.neighbors} 对相邻要素，检验方式 ${res.test}${moranSample}`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_local_moran',
    description: COMMON
      + '计算 LISA 局部莫兰（局部空间自相关）并生成新图层：每个要素写入 lisa_I / lisa_lag / lisa_p / lisa_class'
      + '（HH=高值被高值包围、LL=低值被低值包围、HL=高值被低值包围、LH=低值被高值包围、nonsig=不显著），'
      + '用于看「哪里聚集」。权重与检验参数同 webgis_moran_i。'
      + '【流程要求】应先经 webgis_moran_inspect 体检并把候选字段/参数交用户确认后再调用。'
      + '返回新图层（可切展示方式按 class 查看），并汇总四类要素数。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '数值属性字段（如人口、密度）' },
      ...WEIGHT_PARAMS,
      alpha: { type: 'number', description: '显著性阈值（默认 0.05）' },
      mode: {
        type: 'string', enum: ['points', 'plane', 'hex', 'wall'],
        description: '新图层展示方式（点选 points/plane/hex，面可选 wall=3D 围墙便于突出高值），缺省沿用原图层',
      },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const field = typeof args.field === 'string' ? args.field : ''
      if (!field) return Promise.resolve({ ok: false, message: 'field 不能为空' })
      const weight = typeof args.weight === 'string' ? args.weight as WeightType : undefined
      const res = opLocalMoranI(layer.geojson, field, {
        ...(weight ? { type: weight } : {}),
        ...(typeof args.distanceMeters === 'number' ? { distanceMeters: args.distanceMeters } : {}),
        ...(typeof args.k === 'number' ? { k: args.k } : {}),
        ...(typeof args.permutations === 'number' ? { permutations: args.permutations } : {}),
        ...(typeof args.seed === 'number' ? { seed: args.seed } : {}),
        ...(typeof args.alpha === 'number' ? { alpha: args.alpha } : {}),
      })
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const mode = typeof args.mode === 'string' ? args.mode as DisplayMode : undefined
      const out = pushResult(`LISA - ${field}`, res.geojson, layer.name, mode)
      const c = res.counts
      const sampleNote = layer.materialized === false ? '（注意：基于上图抽样子集计算，抽样会破坏空间自相关，结论不可靠）' : ''
      return Promise.resolve({
        ...out,
        message: `${out.message}。全局 I=${res.I.toFixed(4)}，权重 ${res.weightType}，检验 ${res.test}，α=${res.alpha}；`
          + `分类：HH ${c.HH}、LL ${c.LL}、HL ${c.HL}、LH ${c.LH}、不显著 ${c.nonsig}（共 ${res.n} 个要素）。`
          + '新图层含 lisa_class 字段，可用 webgis_select_by_value 筛出某一类，或用 webgis_set_layer_style 调整配色突出热点。'
          + sampleNote,
      })
    },
  }))
}
