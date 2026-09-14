/**
 * 统计指数目录：把「用户说的指数」翻译成「需要什么数据」，并给出可行性判定。
 *
 * 设计要点（与莫兰指数那条线一致，这里只是把它抬成通用前置）：
 *  - **只判定，不计算**。{@link judgeIndex} 读的是图层摘要（几何类型/要素数/字段体检），
 *    不重拉数据、不跑统计；判定结论交给 AI 展示给用户、征得确认后才调对应计算工具。
 *  - **注册表是加速项，不是白名单**。命中目录 → 给出候选字段 + 建议参数；
 *    不在目录里 → 由工具层走兜底（报数据形态，交给 SQL/表达式路径），而不是回一句「不支持」。
 *  - 判定要如实说明「缺什么」：要素太少、几何不匹配、只有抽样、没有可用数值列、字段含负值……
 *    错误的默认值和看起来像模像样的假结果，才是这套流程真正要拦的东西。
 *
 * 覆盖的是「数据需求形态」而不是穷举指数：形态就那么几种（单数值列 / 分类列 / 数值列+几何+空间关系 /
 * 点+研究区），指数可以无限往里挂。新增一个指数 = 一个字段级 `fieldFilter` + 一个 compute + 一条注册项。
 */
import type { Feature, FeatureCollection } from 'geojson'
import { MAX_GRID_CELLS, defaultWeightFor, makeWeightMatrix, minMax, type WeightOptions } from './geo-stats.js'

// ---------------------------------------------------------------- 类型

export type IndexFamily = 'field' | 'spatial'

/** 注册表里的指数 id（计算工具与之一一对应）。 */
export type IndexId = 'gini' | 'shannon' | 'getis_ord' | 'kernel_density' | 'moran_i' | 'local_moran' | 'ann'

/** 字段体检结果。结构上与 geo-stats-tools.ts 的 FieldReport 相同——这里只声明判定用得到的字段，
 *  避免「纯逻辑层反向依赖工具层」。 */
export interface FieldStat {
  field: string
  valid: number
  /** 空值 + 非数值的绝对个数（与 geo-stats-tools.FieldReport 同构）。 */
  missing: number
  nullRate: number
  min: number
  max: number
  mean: number
  std: number
  unique: number
  excluded?: string
}

/** 一个图层的数据形态（判定的全部输入；来自图层摘要 + 字段体检）。 */
export interface LayerShape {
  id: string
  name: string
  geometryTypes: string[]
  featureCount: number
  /** false = 大文件抽样显示（真数据在 duckTable）。 */
  materialized: boolean
  totalCount?: number
  bbox: [number, number, number, number] | null
  recommendedFields: FieldStat[]
  excludedFields: FieldStat[]
}

/** 指数对数据的要求。 */
export interface IndexNeeds {
  /** 需要的几何类型；null = 不要求几何（纯属性统计）。 */
  geometry: 'point' | 'polygon' | 'line' | 'any' | null
  /** 需要至少一个可用数值列。 */
  numericField: boolean
  /** 需要分类/分组列。 */
  categoryField: boolean
  minFeatures: number
  /** true = 抽样图层直接判不可行（结果会失真）；false = 只警告。 */
  fullData: boolean
  /** 抽样时给警告（与 fullData 互斥使用）。 */
  warnOnSample?: boolean
}

export interface IndexParamDoc {
  name: string
  required: boolean
  default?: string
  description: string
}

export interface IndexSpec {
  id: IndexId
  name: string
  /** 用户口语/别名（模糊匹配用）。 */
  aliases: string[]
  family: IndexFamily
  summary: string
  needs: IndexNeeds
  params: IndexParamDoc[]
  /** 是否产出新图层（能上图）。 */
  emitsLayer: boolean
  /** 计算工具名（卡片里告诉用户下一步调谁）。 */
  tool: string
  caveats: string[]
  /** 字段级硬性要求：返回排除原因（null = 该字段可用）。 */
  fieldFilter?: (f: FieldStat) => string | null
  /** 按图层尺度推荐参数（目前只有核密度需要——它的默认值跟范围强相关）。 */
  suggest?: (shape: LayerShape) => { params: Record<string, string | number>; note: string }
}

/** 单个图层的可行性判定结果。 */
export interface IndexVerdict {
  layerId: string
  layerName: string
  feasible: boolean
  /** 不可行原因（空 = 可行）。 */
  reasons: string[]
  /** 可行但有保留（抽样、权重退化等）。 */
  warnings: string[]
  /** 可用候选字段（已过 fieldFilter）。 */
  candidates: FieldStat[]
  /** 被字段级要求排除的字段及原因。 */
  fieldIssues: Array<{ field: string; reason: string }>
  suggestedParams: Record<string, string | number>
  suggestNote?: string
}

// ---------------------------------------------------------------- 缺失值：不替用户决定

/**
 * 缺失值处理策略。**不传 = 不替用户决定**：有缺失就返回 {@link MissingDecision}，
 * 把「丢弃 / 当 0 / 当成一个类别」的选择交回对话，由模型问用户。
 *
 * 这与莫兰指数已经确立的「勘察 → 告知 → 确认 → 计算」是同一个范式，
 * 只是对象从「用哪个字段」换成了「缺失值怎么办」。
 */
export type MissingPolicy = 'drop' | 'zero' | 'asCategory'

/**
 * 「缺失值需要先确认」的结果 —— **不是错误**，是待用户拍板。
 * 调用方（工具层）应把 message 原样交给模型去问用户，而不是当成失败重试。
 */
export interface MissingDecision {
  ok: false
  /** 判定标记：区分「需要用户选择」与「真的算不了」。 */
  missingDecision: true
  field: string
  missing: number
  total: number
  /** 该指数支持的选择（原样作为 missing 参数回传）。 */
  options: MissingPolicy[]
  message: string
}

/**
 * 组装「缺失值请先确认」的结果。
 * @param why - 为什么这个指数的缺失不能随便处理；各指数影响不同，必须说清而不是套话。
 */
function missingDecision(
  field: string,
  missing: number,
  total: number,
  options: Array<{ id: MissingPolicy; label: string }>,
  why: string,
): MissingDecision {
  return {
    ok: false,
    missingDecision: true,
    field,
    missing,
    total,
    options: options.map((o) => o.id),
    message: `字段 ${field} 有 ${missing} 个空值或非数值（有效 ${total - missing}/${total}）。${why}`
      + '**请先与用户确认怎么处理，不要替用户决定** —— '
      + options.map((o) => `${o.label} → 传 missing="${o.id}"`).join('；')
      + '；或者先让用户把这些要素过滤掉再算。',
  }
}

/** 判定一个结果是不是「等用户选缺失值策略」。 */
export function isMissingDecision(r: unknown): r is MissingDecision {
  return !!r && typeof r === 'object' && (r as { missingDecision?: unknown }).missingDecision === true
}

// ---------------------------------------------------------------- 计算：基尼系数

export type GiniResult =
  | MissingDecision
  | { ok: false; message: string }
  | {
      ok: true
      gini: number
      n: number
      /** 缺失值个数（未缺失时为 0）。 */
      missing: number
      /** 实际采用的处理策略；'none' = 本来就没缺失。 */
      missingPolicy: 'none' | 'drop' | 'zero'
      sum: number
      mean: number
      min: number
      max: number
    }

/**
 * 属性值 → 数值。**不能用 Number(v) 直接转**：`Number(null)` / `Number('')` / `Number(false)` 都是 0，
 * 会让空值悄悄当成 0 参与计算（空值多的字段会得出看似正常、实则错误的结果）。空值/空串/布尔一律给 NaN。
 */
function numericValue(v: unknown): number {
  if (typeof v === 'number') return v
  if (v == null || v === '' || typeof v === 'boolean') return Number.NaN
  return Number(v)
}

/** 取数值列（非法/空值跳过并计数）。 */
function collectNumbers(feats: Feature[], field: string): { xs: number[]; skipped: number } {
  const xs: number[] = []
  let skipped = 0
  for (const f of feats) {
    const v = f?.properties?.[field]
    const x = numericValue(v)
    if (Number.isFinite(x)) xs.push(x)
    else skipped++
  }
  return { xs, skipped }
}

/**
 * 基尼系数（单数值列，非负）：
 *   G = 2·Σ(i·x_(i)) / (n·Σx) − (n+1)/n   （x 升序，i 从 1 开始）
 * 0 = 完全平均，→1 = 完全不平均。负值无意义（比率型指标），直接报错。
 */
export function opGini(
  input: FeatureCollection,
  field: string,
  opts: { missing?: MissingPolicy } = {},
): GiniResult {
  const feats = input.features.filter((f) => f?.properties)
  if (feats.length < 3) return { ok: false, message: `至少需要 3 个要素（当前 ${feats.length} 个）` }
  const { xs: present, skipped } = collectNumbers(feats, field)
  let xs = present
  let missingPolicy: 'none' | 'drop' | 'zero' = 'none'
  if (skipped > 0) {
    if (opts.missing === 'drop') missingPolicy = 'drop'
    else if (opts.missing === 'zero') {
      missingPolicy = 'zero'
      // 基尼只看数值多重集，补 skipped 个 0 与「逐行填 0」等价。
      xs = [...present, ...new Array<number>(skipped).fill(0)]
    } else if (opts.missing === 'asCategory') {
      return { ok: false, message: '基尼系数按数值列计算，「把缺失当成一个类别」（missing="asCategory"）不适用；请改用 missing="drop" 或 missing="zero"。' }
    } else {
      return missingDecision(field, skipped, feats.length, [
        { id: 'drop', label: '丢弃这些要素后计算（= 认定它们不属于总体）' },
        { id: 'zero', label: '把它们当 0 参与计算（= 认定它们份额为零）' },
      ], '基尼系数对这两种处理的答案差别很大，而且含义不同 —— 不是可随便取的默认值。')
    }
  }
  if (xs.length < 3) return { ok: false, message: `字段 ${field} 的有效数值不足（${xs.length} 个）` }
  const sum = xs.reduce((a, b) => a + b, 0)
  const { min } = minMax(xs)
  if (min < 0) return { ok: false, message: `字段 ${field} 含负值（${min}）：基尼系数要求非负` }
  if (!(sum > 0)) return { ok: false, message: `字段 ${field} 合计为 0，无法计算基尼系数` }
  const sorted = [...xs].sort((a, b) => a - b)
  let acc = 0
  for (let i = 0; i < sorted.length; i++) acc += (i + 1) * sorted[i]!
  const n = sorted.length
  const gini = (2 * acc) / (n * sum) - (n + 1) / n
  return {
    ok: true,
    gini: Number(gini.toFixed(4)),
    n,
    missing: skipped,
    missingPolicy,
    sum: Number(sum.toFixed(4)),
    mean: Number((sum / n).toFixed(4)),
    min,
    max: minMax(xs).max,
  }
}

// ---------------------------------------------------------------- 计算：香农熵 / 多样性

export type ShannonMode = 'category' | 'value'

/** category 模式下把缺失当成独立类别时使用的键名。 */
export const SHANNON_MISSING_KEY = '(空值/缺失)'

export type ShannonResult =
  | MissingDecision
  | { ok: false; message: string }
  | {
      ok: true
      h: number
      hMax: number
      evenness: number
      categories: number
      mode: ShannonMode
      n: number
      missing: number
      missingPolicy: 'none' | 'drop' | 'asCategory'
      top: Array<{ key: string; share: number }>
    }

/**
 * 香农熵 H = −Σ p·ln p（越大越分散，越小越集中）。
 * 两种解读：
 *  - `category`：字段当作类别名，频数即占比。适合土地利用类型、行业等分类列（含数值编码列）。
 *  - `value`：字段当作丰度/规模（人口、GDP、销量），每行的数值占总量之比为 p。要求非负。
 * 不传模式时自动判：数值占比 >0.9 且唯一值 >12 → value，否则 category（编码列因此落在 category）。
 * 同时给出 Pielou 均匀度 E = H / ln S（S 为类别数，S≤1 时为 0）。
 */
export function opShannon(
  input: FeatureCollection,
  field: string,
  mode: ShannonMode | 'auto' = 'auto',
  opts: { missing?: MissingPolicy } = {},
): ShannonResult {
  const feats = input.features.filter((f) => f?.properties)
  if (feats.length < 3) return { ok: false, message: `至少需要 3 个要素（当前 ${feats.length} 个）` }

  let picked: ShannonMode = mode === 'auto' ? 'category' : mode
  if (mode === 'auto') {
    let numeric = 0
    let blank = 0
    const distinct = new Set<number>()
    for (const f of feats) {
      const v = f.properties?.[field]
      const x = typeof v === 'number' ? v : v == null || v === '' ? Number.NaN : Number(v)
      if (Number.isFinite(x)) { numeric++; distinct.add(x) } else blank++
    }
    const present = feats.length - blank
    if (present > 0 && numeric / present > 0.9 && distinct.size > 12) picked = 'value'
  }

  const shares: Array<{ key: string; share: number }> = []
  let skipped = 0
  let missingPolicy: 'none' | 'drop' | 'asCategory' = 'none'
  if (picked === 'value') {
    // 丰度解读下缺失值「丢弃」与「当 0」在数学上等价：0 份额对 H 没有贡献。
    // （真去补 0 反而有害 —— 会多出一个 p=0 的类别抬高 S，进而把均匀度 H/lnS 算小，
    //   并且 0·ln0 在 JS 里是 NaN。）所以这里不给「选」，只如实报告。
    if (opts.missing === 'asCategory') {
      return { ok: false, message: `字段 ${field} 按数值（丰度）解读，缺失值不是一个类别（missing="asCategory" 不适用）；用 missing="drop" 即可（与当 0 等价）。` }
    }
    const { xs, skipped: sk } = collectNumbers(feats, field)
    skipped = sk
    missingPolicy = skipped > 0 ? 'drop' : 'none'
    if (xs.length < 3) return { ok: false, message: `字段 ${field} 的有效数值不足（${xs.length} 个）` }
    const { min } = minMax(xs)
    if (min < 0) return { ok: false, message: `字段 ${field} 含负值（${min}）：按数值（丰度）解读时要求非负，或改用 mode=category` }
    const total = xs.reduce((a, b) => a + b, 0)
    if (!(total > 0)) return { ok: false, message: `字段 ${field} 合计为 0，无法计算香农熵` }
    // 每行一个“类别”（同一取值合并），p = 该取值合计 / 总量
    const byVal = new Map<string, number>()
    for (const f of feats) {
      const v = f.properties?.[field]
      const x = typeof v === 'number' ? v : v == null || v === '' ? Number.NaN : Number(v)
      if (!Number.isFinite(x)) continue
      const key = String(v)
      byVal.set(key, (byVal.get(key) ?? 0) + x)
    }
    for (const [key, s] of byVal) shares.push({ key, share: s / total })
  } else {
    // 类别解读下缺失值「丢弃」与「当成一个独立类别」是不同的指标：
    // 后者会把 H 和类别数 S 一起抬高（均匀度 H/lnS 也变），这是用户该自己决定的事。
    const blanks = feats.reduce((a, f) => {
      const v = f.properties?.[field]
      return a + (v == null || v === '' ? 1 : 0)
    }, 0)
    if (blanks > 0 && opts.missing !== 'drop' && opts.missing !== 'asCategory') {
      return missingDecision(field, blanks, feats.length, [
        { id: 'drop', label: '丢弃这些要素（不把它们算作一个类别）' },
        { id: 'asCategory', label: `把它们当成一个独立类别「${SHANNON_MISSING_KEY}」` },
      ], '按类别解读时这两种处理会得到不同的熵值 —— 当成一类会同时抬高 H 和类别数，丢弃则不会。')
    }
    const asCategory = blanks > 0 && opts.missing === 'asCategory'
    missingPolicy = blanks > 0 ? (asCategory ? 'asCategory' : 'drop') : 'none'
    const byVal = new Map<string, number>()
    for (const f of feats) {
      const v = f.properties?.[field]
      if (v == null || v === '') {
        if (!asCategory) { skipped++; continue }
        byVal.set(SHANNON_MISSING_KEY, (byVal.get(SHANNON_MISSING_KEY) ?? 0) + 1)
        continue
      }
      const key = String(v)
      byVal.set(key, (byVal.get(key) ?? 0) + 1)
    }
    // missing 要如实报缺失个数，与采用哪种策略无关。
    if (asCategory) skipped = blanks
    const total = asCategory ? feats.length : feats.length - skipped
    if (total < 3 || byVal.size < 2) {
      return { ok: false, message: `字段 ${field} 的类别不足（${byVal.size} 类）：香农熵至少需要 2 个类别、3 个有效值` }
    }
    for (const [key, c] of byVal) shares.push({ key, share: c / total })
  }

  let h = 0
  for (const { share } of shares) h -= share * Math.log(share)
  const s = shares.length
  const hMax = s > 1 ? Math.log(s) : 0
  shares.sort((a, b) => b.share - a.share)
  return {
    ok: true,
    h: Number(h.toFixed(4)),
    hMax: Number(hMax.toFixed(4)),
    evenness: hMax > 0 ? Number((h / hMax).toFixed(4)) : 0,
    categories: s,
    mode: picked,
    n: feats.length,
    missing: skipped,
    missingPolicy,
    top: shares.slice(0, 5).map((t) => ({ key: t.key, share: Number(t.share.toFixed(4)) })),
  }
}

// ---------------------------------------------------------------- 计算：Getis-Ord Gi*

export type GetisOrdResult =
  | { ok: false; message: string }
  | {
      ok: true
      geojson: FeatureCollection
      n: number
      weightType: string
      alpha: number
      counts: { hot: number; cold: number; nonsig: number }
      hotPercent: number
      note?: string
    }

/** 标准正态 CDF（Abramowitz & Stegun 7.1.26，|误差| < 1.5e-7）。 */
function normalCdf(z: number): number {
  const a = Math.abs(z)
  const t = 1 / (1 + 0.3275911 * a)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592)
    * t * Math.exp(-a * a)
  const cdf = 0.5 * (1 + (z < 0 ? -erf : erf))
  return cdf
}

/** Benjamini-Hochberg 假发现率校正：返回与输入同序的 q 值。 */
function bhAdjusted(p: number[]): number[] {
  const n = p.length
  const idx = p.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const q = new Array<number>(n).fill(1)
  let prev = 1
  for (let k = n - 1; k >= 0; k--) {
    const { v, i } = idx[k]!
    prev = Math.min(prev, (v * n) / (k + 1))
    q[i] = prev
  }
  return q
}

/**
 * Getis-Ord Gi*（局部热点分析）：
 *   Gi*_i = (Σ_j w_ij·x_j − X̄·Σ_j w_ij) / (S·√((n·Σ_j w_ij² − (Σ_j w_ij)²) / (n−1)))
 * 权重阵为二值 0/1（与莫兰共用 {@link makeWeightMatrix}），并**含自身权重**（w_ii 置 1，Gi* 的定义如此）。
 * z > 0 为高值聚集（热点）、z < 0 为低值聚集（冷点）。
 * p 用正态近似（Esri 同法），再做 BH 假发现率校正得到 gi_q —— 要素上千时不做校正会冒出大量假热点。
 * 输出新图层：gi_z / gi_p / gi_q / gi_class（hot|cold|ns），可上图。
 */
export function opGetisOrd(
  input: FeatureCollection,
  field: string,
  opts: WeightOptions & { alpha?: number } = {},
): GetisOrdResult {
  const feats = input.features.filter((f) => f?.geometry)
  if (feats.length < 4) return { ok: false, message: `至少需要 4 个要素（当前 ${feats.length} 个）` }
  const n = feats.length
  // ⚠ 空值不能当 0 用（见 numericValue）
  const xs: number[] = []
  let bad = 0
  for (const f of feats) {
    const x = numericValue(f.properties?.[field])
    xs.push(x)
    if (!Number.isFinite(x)) bad++
  }
  if (bad > 0) {
    return { ok: false, message: `字段 ${field} 有 ${bad} 个空值/非数值：Gi* 需要每个要素都有值，请先过滤或改用别的字段` }
  }
  const wm = makeWeightMatrix(feats, opts)
  if (!wm.ok) return { ok: false, message: wm.message }
  const { w, type, note } = wm.matrix

  const mean = xs.reduce((a, b) => a + b, 0) / n
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n
  const s = Math.sqrt(variance)
  if (s === 0) return { ok: false, message: `字段 ${field} 为常量，无法做热点分析` }

  const zs = new Array<number>(n).fill(0)
  const ps = new Array<number>(n).fill(1)
  for (let i = 0; i < n; i++) {
    let sumW = 0
    let sumW2 = 0
    let sumWX = 0
    for (let j = 0; j < n; j++) {
      // Gi* 含自身：对角补 1
      const wij = (w[i]?.[j] ?? 0) + (i === j ? 1 : 0)
      if (wij === 0) continue
      sumW += wij
      sumW2 += wij * wij
      sumWX += wij * xs[j]!
    }
    const inner = (n * sumW2 - sumW * sumW) / (n - 1)
    const denom = s * Math.sqrt(Math.max(0, inner))
    const z = denom > 0 ? (sumWX - mean * sumW) / denom : 0
    zs[i] = z
    ps[i] = 2 * (1 - normalCdf(Math.abs(z)))
  }

  const qs = bhAdjusted(ps)
  const alpha = typeof opts.alpha === 'number' && opts.alpha > 0 && opts.alpha < 1 ? opts.alpha : 0.05
  const counts = { hot: 0, cold: 0, nonsig: 0 }
  const outFeatures = feats.map((f, i) => {
    const z = zs[i]!
    const q = qs[i]!
    let cls: 'hot' | 'cold' | 'ns' = 'ns'
    if (q < alpha) cls = z > 0 ? 'hot' : 'cold'
    counts[cls === 'ns' ? 'nonsig' : cls]++
    return {
      ...f,
      properties: {
        ...(f.properties ?? {}),
        gi_z: Number(z.toFixed(4)),
        gi_p: Number(ps[i]!.toFixed(4)),
        gi_q: Number(q.toFixed(4)),
        gi_class: cls,
      },
    }
  })

  return {
    ok: true,
    geojson: { type: 'FeatureCollection', features: outFeatures } as FeatureCollection,
    n,
    weightType: type,
    alpha,
    counts,
    hotPercent: Number((((counts.hot + counts.cold) / n) * 100).toFixed(2)),
    ...(note ? { note } : {}),
  }
}

// ---------------------------------------------------------------- 注册表

/** 核密度带宽/格距推荐：由图层跨度与点数推，避开「默认 5000m 把城区糊成一坨」和「格数超上限」。 */
function suggestKernel(shape: LayerShape): { params: Record<string, string | number>; note: string } {
  const b = shape.bbox
  if (!b) return { params: { radiusMeters: 5000, cellSizeMeters: 500 }, note: '图层没有范围信息，按默认 5000m / 500m 计算' }
  const [west, south, east, north] = b
  const latMid = (south + north) / 2
  const widthM = Math.abs(east - west) * 111320 * Math.max(0.01, Math.cos((latMid * Math.PI) / 180))
  const heightM = Math.abs(north - south) * 110540
  const span = Math.max(widthM, heightM, 1)
  const km = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(1)}km` : `${Math.round(m)}m`)
  // 带宽取跨度的 1/15（约 15 个核铺满，够看出结构又不糊）；钳制 50m..20km
  const radius = Math.max(50, Math.min(20000, Math.round(span / 15)))
  let cell = Math.max(20, Math.min(5000, Math.round(radius / 5)))
  // 格数上限是硬约束（超了 opKernelDensity 直接报错）。格数 = ceil(宽/格距)×ceil(高/格距)，
  // 两个 ceil 会让实际格数略大于「面积/格距²」，所以反推出来后再迭代收敛（格数随格距单调递减，必收敛）。
  const countCells = (c: number): number => Math.ceil(widthM / c) * Math.ceil(heightM / c)
  let bumped = false
  if (countCells(cell) > MAX_GRID_CELLS) {
    cell = Math.max(cell, Math.ceil(Math.sqrt((widthM * heightM) / MAX_GRID_CELLS)))
    for (let guard = 0; countCells(cell) > MAX_GRID_CELLS && guard < 10000; guard++) {
      cell = Math.max(cell + 1, Math.ceil(cell * 1.02))
    }
    bumped = true
  }
  const cells = countCells(cell)
  return {
    params: { radiusMeters: radius, cellSizeMeters: cell },
    note: `范围约 ${km(widthM)}×${km(heightM)}、${shape.featureCount} 个点，预估网格 ${cells} 格`
      + (bumped ? '（已放大格距以避开 40000 格上限）' : ''),
  }
}

/** 指数目录。新增指数 = 一条注册项；计算工具各自单独注册（schema 写死更利于 AI 理解）。 */
export const INDEX_SPECS: IndexSpec[] = [
  {
    id: 'gini',
    name: '基尼系数',
    aliases: ['基尼', '基尼系数', 'gini', '不平等', '收入差距', '贫富差距', '分布不均'],
    family: 'field',
    summary: '单个数值列在各要素间分布的不平等程度（0=完全平均，越接近 1 越不平均）',
    needs: { geometry: null, numericField: true, categoryField: false, minFeatures: 3, fullData: true },
    params: [{ name: 'field', required: true, description: '要统计的数值字段（收入、人口、面积等）' }],
    emitsLayer: false,
    tool: 'webgis_gini',
    caveats: [
      '要求字段非负且合计 > 0（含负值的比率型指标算不出有意义的基尼）',
      '基于抽样显示的子集计算会失真，必须先物化全量（筛选/空间筛选后再算）',
      '基尼是整体不平等度，看不出「哪里不平等」——那要配合 LISA/Gi* 一起看',
    ],
    fieldFilter: (f) => (f.min < 0 ? `含负值（最小 ${f.min}）：基尼系数要求非负` : null),
  },
  {
    id: 'shannon',
    name: '香农熵（多样性 / 集中度）',
    aliases: ['香农', '香农熵', '熵', '多样性', 'shannon', 'diversity', 'shdi', '集中度', '分散度'],
    family: 'field',
    summary: '数值/类别在全体要素间的分散程度：H 越大越均匀，越小越集中（附 Pielou 均匀度）',
    needs: { geometry: null, numericField: true, categoryField: false, minFeatures: 3, fullData: true },
    params: [
      { name: 'field', required: true, description: '分类字段（土地利用类型等）或数值字段（人口等丰度）' },
      { name: 'mode', required: false, default: 'auto', description: 'category=按类别计数；value=按数值当丰度；auto=按字段自动判' },
    ],
    emitsLayer: false,
    tool: 'webgis_shannon',
    caveats: [
      '按类别统计时类别数=唯一值数：字段若近似唯一标识（如编号），会得到无意义的极大值',
      '数值列默认按「丰度/规模」解读；若它是数值编码的分类列，请显式传 mode=category',
      '数值模式要求非负',
    ],
  },
  {
    id: 'getis_ord',
    name: 'Getis-Ord Gi*（热点分析）',
    aliases: ['getis', 'getis-ord', 'gi', 'gi*', '热点', '冷点', '热点分析', '冷热点', 'hotspot', '高值聚集'],
    family: 'spatial',
    summary: '找出统计显著的高值聚集（热点）/低值聚集（冷点）位置，输出可上图的新图层',
    needs: { geometry: 'any', numericField: true, categoryField: false, minFeatures: 6, fullData: true },
    params: [
      { name: 'field', required: true, description: '要分析的数值字段' },
      { name: 'weight', required: false, default: '面→queen / 点线→knn', description: '空间权重：queen/rook/distance/knn' },
      { name: 'distanceMeters', required: false, description: 'weight=distance 时的距离阈值（米）' },
      { name: 'k', required: false, default: '5', description: 'weight=knn 的邻居数' },
      { name: 'alpha', required: false, default: '0.05', description: '显著性水平' },
    ],
    emitsLayer: true,
    tool: 'webgis_getis_ord',
    caveats: [
      '权重是二值邻接，不含距离衰减（距离越远影响不减）',
      '点/线默认 knn k=5 → 至少需要 6 个要素',
      '已做 Benjamini-Hochberg 假发现率校正（gi_q）：要素多时不做校正是假热点的主要来源',
    ],
  },
  {
    id: 'kernel_density',
    name: '核密度估计',
    aliases: ['核密度', '密度图', '密度分析', 'kde', 'kernel', '热力图', '热点图'],
    family: 'spatial',
    summary: '把点图层转成规则网格密度图层（可热力图展示），看「哪里密」',
    needs: { geometry: 'point', numericField: false, categoryField: false, minFeatures: 3, fullData: false, warnOnSample: true },
    params: [
      { name: 'radiusMeters', required: false, default: '按范围推荐', description: '核带宽（米）：越小越细碎，越大越平滑' },
      { name: 'cellSizeMeters', required: false, default: '按范围推荐', description: '网格间距（米）：格数上限 40000' },
      { name: 'mode', required: false, default: 'plane', description: 'points=原始点；plane=平面热力图；hex=蜂窝热力图' },
    ],
    emitsLayer: true,
    tool: 'webgis_kernel_density',
    caveats: [
      '带宽/格距决定结果尺度：带宽太小看不出结构，太大糊成一片——所以这里按图层跨度给推荐值',
      '网格上限 40000 格：范围大时必须放大格距（否则工具直接报错）',
      '抽样显示的大文件算出的密度会偏低，需注意结果说明里的抽样提示',
    ],
    suggest: suggestKernel,
  },
  {
    id: 'moran_i',
    name: '全局莫兰指数 I',
    aliases: ['莫兰', 'moran', '空间自相关', '全局莫兰', '空间聚集', '聚集指数'],
    family: 'spatial',
    summary: '整体空间自相关：I>0 同值聚集、I≈0 随机、I<0 相间分布',
    needs: { geometry: 'any', numericField: true, categoryField: false, minFeatures: 3, fullData: true },
    params: [
      { name: 'field', required: true, description: '要分析的数值字段' },
      { name: 'weight', required: false, default: '面→queen / 点线→knn', description: '空间权重方式' },
      { name: 'distanceMeters', required: false, description: 'weight=distance 时的距离阈值（米）' },
      { name: 'k', required: false, default: '5', description: 'weight=knn 的邻居数' },
      { name: 'permutations', required: false, default: '999', description: '置换检验次数（0=正态近似）' },
      { name: 'seed', required: false, default: '42', description: '置换随机种子（固定值可复现）' },
    ],
    emitsLayer: false,
    tool: 'webgis_moran_i',
    caveats: ['必须全量数据（抽样子集会改变邻接关系）', '全局 I 只说「有没有聚集」，看不出「哪里聚集」——那要 LISA'],
  },
  {
    id: 'local_moran',
    name: '局部莫兰 LISA',
    aliases: ['lisa', '局部莫兰', '局部自相关', '聚集图', '局部聚集'],
    family: 'spatial',
    summary: '逐要素判定 HH/LL/HL/LH 聚集类型，输出可上图的新图层',
    needs: { geometry: 'any', numericField: true, categoryField: false, minFeatures: 3, fullData: true },
    params: [
      { name: 'field', required: true, description: '要分析的数值字段' },
      { name: 'weight', required: false, default: '面→queen / 点线→knn', description: '空间权重方式' },
      { name: 'alpha', required: false, default: '0.05', description: '显著性水平' },
      { name: 'permutations', required: false, default: '999', description: '条件置换次数' },
    ],
    emitsLayer: true,
    tool: 'webgis_local_moran',
    caveats: ['逐要素检验存在多重比较问题，读图时以成片聚集为准，不要追单个显著要素'],
  },
  {
    id: 'ann',
    name: '平均最近邻指数（ANN）',
    aliases: ['最近邻', 'ann', '最近邻指数', '点模式', '随机性检验'],
    family: 'spatial',
    summary: '点模式判断：R<1 聚集、R≈1 随机、R>1 分散（不产图层）',
    needs: { geometry: 'point', numericField: false, categoryField: false, minFeatures: 3, fullData: true },
    params: [{ name: 'layer', required: true, description: '点图层 id' }],
    emitsLayer: false,
    tool: 'webgis_average_nearest_neighbor',
    caveats: ['只对点要素有效', '受研究区范围（凸包面积）影响，边界外的点会被忽略'],
  },
]

// ---------------------------------------------------------------- 匹配与判定

/** 归一化用于模糊匹配：小写、去空格与常见分隔符。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_/()（）·*]+/g, '')
}

/**
 * 按用户说法模糊匹配指数。返回最佳命中（分数够高时）与前 3 个候选。
 * 命中不了的由工具层走兜底（不是「不支持」）——所以这里允许 spec 为 null。
 */
export function findIndexSpec(query: string): { spec: IndexSpec | null; candidates: IndexSpec[] } {
  const q = normalize(query)
  if (!q) return { spec: null, candidates: [] }
  const scored: Array<{ spec: IndexSpec; score: number }> = []
  for (const spec of INDEX_SPECS) {
    const keys = [spec.id, spec.name, ...spec.aliases].map(normalize)
    let score = 0
    for (const k of keys) {
      if (k === q) score = Math.max(score, 1)
      else if (k.includes(q) || q.includes(k)) score = Math.max(score, 0.7 + 0.2 * (Math.min(k.length, q.length) / Math.max(k.length, q.length)))
    }
    if (score > 0) scored.push({ spec, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]
  return { spec: best && best.score >= 0.7 ? best.spec : null, candidates: scored.slice(0, 3).map((s) => s.spec) }
}

const GEOM_FAMILY: Record<'point' | 'polygon' | 'line', string[]> = {
  point: ['Point', 'MultiPoint'],
  polygon: ['Polygon', 'MultiPolygon'],
  line: ['LineString', 'MultiLineString'],
}

/** 图层几何族：单一族返回该族，混族返回 'mixed'，无几何返回 'none'。 */
export function geometryFamily(types: string[]): 'point' | 'polygon' | 'line' | 'mixed' | 'none' {
  if (!types.length) return 'none'
  for (const fam of ['point', 'polygon', 'line'] as const) {
    if (types.every((t) => GEOM_FAMILY[fam].includes(t))) return fam
  }
  return 'mixed'
}

const FAMILY_LABEL: Record<string, string> = { point: '点', polygon: '面', line: '线', mixed: '混杂', none: '无' }

/**
 * 判定某个指数在给定图层上能不能做、缺什么、建议用什么参数。**纯判定，不计算。**
 * 所有结论都来自图层摘要（几何类型/要素数/是否抽样/字段体检），不重拉数据。
 */
export function judgeIndex(spec: IndexSpec, shape: LayerShape): IndexVerdict {
  const reasons: string[] = []
  const warnings: string[] = []
  const n = shape.featureCount
  const types = shape.geometryTypes
  const fam = geometryFamily(types)

  if (n < spec.needs.minFeatures) reasons.push(`要素过少（${n} 个，至少需要 ${spec.needs.minFeatures} 个）`)

  if (spec.needs.geometry !== null) {
    if (fam === 'none') reasons.push('图层没有几何（纯属性表），无法做空间统计')
    else if (fam === 'mixed') reasons.push(`几何类型混杂（${types.join('/')}），无法构造统一邻接关系`)
    else if (spec.needs.geometry !== 'any' && fam !== spec.needs.geometry) {
      reasons.push(`需要${FAMILY_LABEL[spec.needs.geometry]}要素，当前是${FAMILY_LABEL[fam]}（${types.join('/')}）`)
    }
  }

  const sampled = shape.materialized === false
  if (sampled) {
    if (spec.needs.fullData) {
      reasons.push(`当前是大文件的抽样显示（${n}/${shape.totalCount ?? '?'} 行）：本指数必须基于全量数据，`
        + '请先用 webgis_filter_layer / webgis_spatial_filter 筛出目标范围的全量图层再分析')
    } else if (spec.needs.warnOnSample) {
      warnings.push(`基于抽样子集（${n}/${shape.totalCount ?? '?'} 行）计算，密度数值会偏低，仅供形态参考`)
    }
  }

  // 候选字段：先过通用体检（recommendedFields 已排除 ID/常量/非数值/空值过多），再过指数级 fieldFilter
  const candidates: FieldStat[] = []
  const fieldIssues: Array<{ field: string; reason: string }> = []
  for (const f of shape.recommendedFields) {
    const why = spec.fieldFilter?.(f)
    if (why) fieldIssues.push({ field: f.field, reason: why })
    else candidates.push(f)
  }
  if (spec.needs.numericField && candidates.length === 0) {
    reasons.push(shape.recommendedFields.length === 0
      ? '没有可用的数值字段（见字段体检的排除原因）'
      : `现有数值字段都不满足本指数的要求（${fieldIssues.map((i) => `${i.field}：${i.reason}`).join('；')}）`)
  }

  // 空间类指数对缺失是硬拦（见 missingTolerance）：候选字段全都有缺失 = 当前这个图层做不了，
  // 必须在勘察阶段就判成不可行 —— 否则卡片会一边说"可以计算"一边说"不能用这个字段"，自相矛盾。
  if (missingTolerance(spec) === 'forbidden' && candidates.length > 0) {
    const dirty = candidates.filter((f) => f.missing > 0)
    if (dirty.length === candidates.length) {
      reasons.push(`候选数值字段都有缺失（${dirty.map((f) => `${f.field} 缺 ${f.missing}`).join('、')}）：`
        + '本指数的权重矩阵建立在整个要素集上，缺失不是可以「选」的处理方式')
    }
  }

  const suggestedParams: Record<string, string | number> = {}
  let suggestNote: string | undefined
  if (spec.suggest) {
    const s = spec.suggest(shape)
    Object.assign(suggestedParams, s.params)
    suggestNote = s.note
  } else if (spec.params.some((p) => p.name === 'weight') && fam !== 'none' && fam !== 'mixed') {
    // 空间类指数：默认权重按几何类型给（与计算工具内的 defaultWeightFor 一致）
    const wt = defaultWeightFor(types)
    suggestedParams.weight = wt
    if (wt === 'knn') suggestedParams.k = 5
  }

  return {
    layerId: shape.id,
    layerName: shape.name,
    feasible: reasons.length === 0,
    reasons,
    warnings,
    candidates,
    fieldIssues,
    suggestedParams,
    ...(suggestNote ? { suggestNote } : {}),
  }
}

/** 一行字段摘要（确认卡片用）。**缺值必须显性写出来** —— 用户不该拿总数去减。 */
export function fieldStatLine(f: FieldStat): string {
  return `${f.field}（有效 ${f.valid}${f.missing > 0 ? `，**缺 ${f.missing}**` : ''}，均值 ${f.mean}，标准差 ${f.std}，唯一值 ${f.unique}）`
}

/** 该指数能不能容忍缺失值；用于在勘察阶段就把「这个字段算不了」说在前面。 */
export function missingTolerance(spec: IndexSpec): 'forbidden' | 'choose' | 'equivalent' | 'none' {
  if (spec.family === 'spatial') return 'forbidden'
  if (spec.id === 'shannon') return 'choose'
  if (spec.id === 'gini') return 'choose'
  return 'none'
}

/** 判定结果 → 给用户看的可读卡片（纯字符串组装，便于单测）。 */
export function formatVerdict(spec: IndexSpec, v: IndexVerdict): string {
  const head = `【${spec.name}】图层「${v.layerName}」(${v.layerId})`
  if (!v.feasible) {
    // 候选字段全都有缺失（空间类硬拦）→ 给两条能真正走下去的路，而不是泛泛的"换个图层"。
    const allDirty = missingTolerance(spec) === 'forbidden'
      && v.candidates.length > 0 && v.candidates.every((f) => f.missing > 0)
    const fix = allDirty
      ? '建议二选一：①换一个数值完整的字段再做本指数；'
        + '②先让用户决定怎么处置这些要素（webgis_filter_layer 按属性筛掉缺该字段的要素，'
        + '或用 webgis_set_attribute 给它们补上确切的取值），把图层整理干净再做。'
        + '⚠ 不要用 0 去补 —— 空间统计的邻域关系会被填补值污染。'
      : spec.family === 'field'
        ? '建议：换一个数值属性完整的图层，或用 webgis_sql_layer 从现有表派生数值列（如密度=数量/面积）。'
        : '建议：换一个几何一致、有数值属性的图层；抽样图层先筛成全量再分析。'
    return [`${head}：当前无法计算 —— ${v.reasons.join('；')}。`, fix].join('')
  }
  const parts = [`${head}：可以计算。`]
  if (v.candidates.length) {
    parts.push(`候选字段：${v.candidates.slice(0, 5).map(fieldStatLine).join('；')}。`)
  }
  // 缺失值：在用户拍板「用这个指数」之前就把后果讲明白，而不是等他提了要求才吃一个错误。
  const tol = missingTolerance(spec)
  const withMissing = v.candidates.filter((f) => f.missing > 0)
  if (withMissing.length && tol !== 'none') {
    const list = withMissing.slice(0, 5).map((f) => `${f.field}（缺 ${f.missing}）`).join('、')
    if (tol === 'forbidden') {
      parts.push(`⛔ 下列候选字段有缺失，**不能**用于本指数：${list}。`
        + '空间自相关/热点分析的权重矩阵建立在**整个要素集**上，删掉任何一个单元都会改变全部邻接关系，'
        + '填 0 则直接污染邻域 —— 所以缺失在这里不是可以「选」的处理方式。'
        + '请让用户二选一：换一个完整的字段，或先用 webgis_filter_layer / webgis_select_by_value 过滤掉这些要素。')
    } else {
      parts.push(`⚠ 下列候选字段有缺失：${list}。`
        + '本指数对缺失的处理**会改变结果**，计算时你需要先问用户选哪种（丢弃 / 当 0 / 当成一类），工具会把选择交回给你，不会替用户决定。')
    }
  }
  if (v.fieldIssues.length) {
    parts.push(`不满足要求：${v.fieldIssues.slice(0, 5).map((i) => `${i.field}（${i.reason}）`).join('、')}。`)
  }
  const params = Object.entries(v.suggestedParams)
  if (params.length) parts.push(`建议参数：${params.map(([k, val]) => `${k}=${val}`).join('、')}。`)
  if (v.suggestNote) parts.push(`${v.suggestNote}。`)
  for (const w of v.warnings) parts.push(`⚠ ${w}。`)
  if (spec.caveats.length) parts.push(`注意：${spec.caveats.slice(0, 2).join('；')}。`)
  return parts.join('')
}
