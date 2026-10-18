/**
 * 专题配色（thematic / choropleth）纯函数：把属性字段分箱成若干类，每类给一个颜色。
 *
 * 与项目其它部分一致的两条纪律：
 * 1. **数值只由程序算**：分箱断点、每级要素数全在这里算，模型只负责选字段与看结果；
 * 2. **缺失值必须显性**：空值/非数值不会被当成 0 混进某一级，而是单独归到「无数据」并计数上报 ——
 *    否则一张专题图会把「没有值」画成「值很小」，这是最典型的静默误导。
 */
import type { Feature, FeatureCollection } from 'geojson'
import { minMax } from './geo-stats.js'

/** 分箱方法。 */
export type ClassifyMethod =
  /** 自然断点（Fisher-Jenks）：让类内方差最小，属性突变处切分。 */
  | 'jenks'
  /** 分位数：每类要素数尽量相等。 */
  | 'quantile'
  /** 等间距：按 (max-min)/k 均分。 */
  | 'equal'
  /** 分类（文字/离散取值）：每个不同取值一个颜色。 */
  | 'category'
  /** 自定义区间：用户直接给定升序断点（区间边界），每级一个颜色。 */
  | 'manual'

export const METHOD_LABEL: Record<ClassifyMethod, string> = {
  jenks: '自然断点',
  quantile: '分位数',
  equal: '等间距',
  category: '按类别',
  manual: '自定义区间',
}

/** 色带目录：顺序型（数值）与定性型（分类）分开，避免用彩虹色画有序数据。 */
export const RAMPS: Record<string, string[]> = {
  // 顺序型（数值用）
  blues: ['#eff3ff', '#bdd7e7', '#6baed6', '#3182bd', '#08519c'],
  greens: ['#edf8e9', '#bae4b3', '#74c476', '#31a354', '#006d2c'],
  oranges: ['#feedde', '#fdbe85', '#fd8d3c', '#e6550d', '#a63603'],
  reds: ['#fee5d9', '#fcae91', '#fb6a4a', '#de2d26', '#a50f15'],
  purples: ['#f2f0f7', '#cbc9e2', '#9e9ac8', '#756bb1', '#54278f'],
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  // 分歧型（有中心意义的数值用，如增减、偏离均值）
  spectral: ['#d7191c', '#fdae61', '#ffffbf', '#abdda4', '#2b83ba'],
  // 定性型（分类用）
  set2: ['#66c2a5', '#fc8d62', '#8da0cb', '#e78ac3', '#a6d854', '#ffd92f', '#e5c494', '#b3b3b3'],
}

/** 无数据要素的固定颜色（中性灰）——不参与色带，永远单独一档。 */
export const NO_DATA_COLOR = '#9ca3af'

export const DEFAULT_RAMP = 'blues'
export const CATEGORY_RAMP = 'set2'
export const DEFAULT_CLASSES = 5
export const MAX_CLASSES = 12
/**
 * Jenks 是 O(n²k)，超过这个规模改用抽样子集求断点（并在结果里如实标注 sampledFrom）。
 * 2000 时约 10M 次运算（几十毫秒）；再大就会让一次工具调用卡住秒级。
 */
export const JENKS_SAMPLE_CAP = 2000
/**
 * 分类方法的**软上限**：超过 50 个不同取值时不再默默截断，而是把选择交回用户
 * （全部上色 / 改用数值分箱 / 先筛选）。用户确认后仍可上色的硬上限见 MAX_CATEGORIES_HARD。
 */
export const MAX_CATEGORIES = 50
/** 全部上色的硬上限（防止给一个 10 万取值的 id 列硬出一条巨型 match 表达式）。 */
export const MAX_CATEGORIES_HARD = 500

/** 按目标类别数从色带采样（色带不够长时循环取，够长时均匀抽）。 */
export function rampColors(ramp: string, n: number): string[] {
  const base = RAMPS[ramp] ?? RAMPS[DEFAULT_RAMP]!
  if (n <= 0) return []
  if (n === 1) return [base[Math.floor(base.length / 2)]!]
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    out.push(base[Math.round(t * (base.length - 1))]!)
  }
  return out
}

/** HSL → #rrggbb（distinctPalette 专用；输入已钳制到合法范围）。 */
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const k = (n: number): number => (n + h / 30) % 12
  const a = sn * Math.min(ln, 1 - ln)
  const f = (n: number): number => ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const to = (x: number): string => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}

/**
 * 生成 n 个区分度较好的颜色（类别数超过内置色带长度时使用）。
 * 黄金角步进（137.508°）让相邻类别色相尽量拉开；明度/饱和度周期性变化增加区分度。
 * 结果确定性（同 n 同色），便于复现图例。
 */
export function distinctPalette(n: number): string[] {
  const out: string[] = []
  const GOLDEN_ANGLE = 137.508
  for (let i = 0; i < n; i++) {
    const h = (i * GOLDEN_ANGLE) % 360
    const s = i % 2 === 0 ? 62 : 48
    const l = i % 3 === 0 ? 52 : 42
    out.push(hslToHex(h, s, l))
  }
  return out
}

/** 数值 → 数值（空/空串/布尔一律 NaN，绝不静默当 0）。与 geo-indices.numericValue 同规则。 */
export function numericValue(v: unknown): number {
  if (typeof v === 'number') return v
  if (v == null || v === '' || typeof v === 'boolean') return Number.NaN
  return Number(v)
}

/**
 * 自然断点（Fisher-Jenks 动态规划）：让「类内平方偏差之和」最小 —— 即断点落在属性突变处。
 *
 * 实现用前缀和直接算区间偏差，**不用 `=== 0` 当"未赋值"哨兵**（单元素组偏差恰为 0，
 * 那个经典写法会把它误判成未访问而覆盖最优解）。返回升序断点，长度 ≤ k-1。
 */
export function jenksBreaks(values: number[], k: number): number[] {
  const xs = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  const n = xs.length
  if (n === 0) return []
  if (!(xs[n - 1]! > xs[0]!)) return [] // 取值恒定 → 无可分之处
  const kk = Math.max(2, Math.min(k, n))
  // 前缀和：Σx 与 Σx²，用于 O(1) 求任意区间的组内偏差
  const s1 = new Array<number>(n + 1).fill(0)
  const s2 = new Array<number>(n + 1).fill(0)
  for (let i = 0; i < n; i++) {
    s1[i + 1] = s1[i]! + xs[i]!
    s2[i + 1] = s2[i]! + xs[i]! * xs[i]!
  }
  /** 下标区间 [a, b) 的组内偏差平方和。 */
  const ssd = (a: number, b: number): number => {
    const w = b - a
    if (w <= 0) return 0
    const sum = s1[b]! - s1[a]!
    return s2[b]! - s2[a]! - (sum * sum) / w
  }
  const INF = Number.POSITIVE_INFINITY
  // dp[j][l] = 前 l 个元素分成 j 类的最小总偏差；back 记录最优切分点
  const dp = Array.from({ length: kk + 1 }, () => new Array<number>(n + 1).fill(INF))
  const back = Array.from({ length: kk + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let l = 1; l <= n; l++) dp[1]![l] = ssd(0, l)
  for (let j = 2; j <= kk; j++) {
    for (let l = j; l <= n; l++) {
      for (let m = j - 1; m < l; m++) {
        const cand = dp[j - 1]![m]! + ssd(m, l)
        if (cand < dp[j]![l]!) {
          dp[j]![l] = cand
          back[j]![l] = m
        }
      }
    }
  }
  const breaks: number[] = []
  let l = n
  for (let j = kk; j >= 2; j--) {
    const m = back[j]![l]!
    // ⚠ 取「上一组的**末元素**」而不是「本组首元素」：分类规则是 x <= 断点 归前一组，
    // 用首元素会把两簇交界处那个值错划进前一组（如 [1..4,100..104] 会切出「≤100」）。
    breaks.unshift(xs[m - 1]!)
    l = m
  }
  return [...new Set(breaks)].sort((a, b) => a - b)
}

/** 分位数断点：每类要素数尽量相等（类数不超过样本数）。 */
export function quantileBreaks(values: number[], k: number): number[] {
  const xs = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  const n = xs.length
  if (n === 0) return []
  if (!(xs[n - 1]! > xs[0]!)) return []
  const kk = Math.max(2, Math.min(k, n))
  const out: number[] = []
  for (let i = 1; i < kk; i++) {
    // 第 i 个分位：取「第 i 组最后一个元素」的值作为闭区间上界
    out.push(xs[Math.ceil((i * n) / kk) - 1]!)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/** 等间距断点：按 (max-min)/k 均分。分区由**取值范围**决定，故允许类数多于样本数（会出现空类）。 */
export function equalBreaks(values: number[], k: number): number[] {
  const xs = values.filter(Number.isFinite)
  if (xs.length === 0) return []
  const { min, max } = minMax(xs)
  if (!(max > min)) return []
  const kk = Math.max(2, Math.min(k, MAX_CLASSES))
  const step = (max - min) / kk
  const out: number[] = []
  for (let i = 1; i < kk; i++) out.push(min + step * i)
  return out
}

/** 一个专题配色方案（存在图层上，客户端据此上色）。 */
export interface ThematicSpec {
  field: string
  method: ClassifyMethod
  /** 展开后的颜色，长度 = breaks.length + 1（数值）或 = categories.length（分类）。 */
  colors: string[]
  /** 数值型：升序内部分界点（k 级 → k-1 个）。 */
  breaks: number[]
  /** 分类型：与 colors 一一对应的取值（字符串化）。 */
  categories?: string[]
  /** 该字段有多少要素没有值（单独用 NO_DATA_COLOR 画）。 */
  missing: number
  /** 分箱所依据的样本量（Jenks 大图层会抽样）；= 有效值总数时不出现。 */
  sampledFrom?: number
  ramp: string
}

export interface ThematicResult {
  ok: true
  spec: ThematicSpec
  /** 每级要素数（数值型长度 = breaks+1；分类型长度 = categories.length）。 */
  counts: number[]
  /** 每级可读标签（给用户看图例）。 */
  labels: string[]
}

export interface ThematicFailure {
  ok: false
  message: string
}

export interface ThematicOptions {
  field: string
  method: ClassifyMethod
  classes?: number
  ramp?: string
  /** 直接指定颜色（覆盖 ramp）。 */
  colors?: string[]
  /** method='manual' 时的升序区间断点（长度 = 级数-1）。 */
  breaks?: number[]
  /** method='category' 且不同取值 > MAX_CATEGORIES 时，用户确认后置 true 才全部上色。 */
  allCategories?: boolean
}

/** 数值区间 → 可读标签。 */
function rangeLabel(lo: number | null, hi: number | null): string {
  const f = (v: number): string => (Math.abs(v) >= 1000 ? v.toFixed(0) : Number(v.toFixed(4)).toString())
  if (lo === null) return `≤ ${f(hi!)}`
  if (hi === null) return `> ${f(lo)}`
  return `${f(lo)} ~ ${f(hi)}`
}

/** 把区间标签缩短（深拷贝给调用方，避免外部改动内部数组）。 */
function pickSample(xs: number[], cap: number): { sample: number[]; sampled: boolean } {
  if (xs.length <= cap) return { sample: xs, sampled: false }
  // 等距抽样（保持分布形状），固定步长可复现。
  const step = xs.length / cap
  const out: number[] = []
  for (let i = 0; i < cap; i++) out.push(xs[Math.floor(i * step)]!)
  return { sample: out, sampled: true }
}

/**
 * 依据图层的某个字段生成专题配色方案。
 *
 * ⚠ 缺值处理是**显式**的，不是可选项：空值不参与分箱，单独计入 `missing`
 * 并用 NO_DATA_COLOR 画 —— 把「没有值」画成「值很小」是最典型的静默误导。
 */
export function buildThematic(fc: FeatureCollection, opts: ThematicOptions): ThematicResult | ThematicFailure {
  const feats = fc.features.filter((f) => f?.properties) as Feature[]
  if (feats.length === 0) return { ok: false, message: '图层没有要素，无法做专题配色' }
  const field = opts.field
  const method = opts.method

  if (method === 'category') {
    const counts = new Map<string, number>()
    let missing = 0
    for (const f of feats) {
      const v = f.properties?.[field]
      if (v == null || v === '') { missing++; continue }
      const key = String(v)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    if (counts.size === 0) {
      return { ok: false, message: `字段 ${field} 没有任何非空取值，无法按类别上色` }
    }
    if (counts.size === 1) {
      return { ok: false, message: `字段 ${field} 只有一个取值（${[...counts.keys()][0]}），不需要专题配色 —— 用 webgis_set_layer_style 的 color 参数设置单色即可` }
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
    // 超过软上限不再默默截断：把选择交回用户（全部上色 / 改数值分箱 / 先筛选）。
    if (sorted.length > MAX_CATEGORIES && !opts.allCategories) {
      return {
        ok: false,
        message: `字段 ${field} 有 ${sorted.length} 个不同取值（超过 ${MAX_CATEGORIES} 个）。全部按类别上色会产生大量图例并可能影响渲染性能。`
          + '请先让用户在以下方案中选择：① 确认全部上色（再次调用时传 allCategories:true）'
          + '② 若该字段本质是数值，改用 jenks/quantile/equal 或自定义区间（method=manual + breaks）'
          + '③ 先筛选出关注的类别再上色。',
      }
    }
    if (sorted.length > MAX_CATEGORIES_HARD) {
      return {
        ok: false,
        message: `字段 ${field} 有 ${sorted.length} 个不同取值，超过全部上色的硬上限 ${MAX_CATEGORIES_HARD}，无法一次全部上色；请先筛选或改用数值分箱。`,
      }
    }
    const picked = sorted
    const ramp = opts.ramp ?? CATEGORY_RAMP
    // 类别数超过内置色带长度时自动生成区分度足够的颜色（否则相邻类别会拿到同一个颜色）。
    const autoColors = picked.length > (RAMPS[ramp]?.length ?? 0)
      ? distinctPalette(picked.length)
      : rampColors(ramp, picked.length)
    const colors = opts.colors ?? autoColors
    if (colors.length < picked.length) {
      return { ok: false, message: `给了 ${colors.length} 个颜色但有 ${picked.length} 个类别，颜色数不足` }
    }
    const categories = picked.map(([k]) => k)
    const spec: ThematicSpec = {
      field, method, categories, breaks: [], colors: colors.slice(0, categories.length),
      missing, ramp: opts.colors ? 'custom' : ramp,
    }
    const labels = categories.map((c, i) => `${c}（${picked[i]![1]}）`)
    return { ok: true, spec, counts: picked.map(([, c]) => c), labels }
  }

  // 数值列（manual 与自动分箱共用）
  const xs: number[] = []
  let missing = 0
  for (const f of feats) {
    const x = numericValue(f.properties?.[field])
    if (Number.isFinite(x)) xs.push(x)
    else missing++
  }

  // ---- 自定义区间（用户给定断点 + 颜色）----
  if (method === 'manual') {
    const raw = opts.breaks
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: false, message: `method=manual 需要提供 breaks（升序区间边界数组），例如 [0, 100, 500, 1000] 表示 4 级` }
    }
    const breaks = raw.map(Number)
    if (!breaks.every((b) => Number.isFinite(b))) {
      return { ok: false, message: 'breaks 必须是有限数值数组' }
    }
    if (!breaks.every((b, i) => i === 0 || b > breaks[i - 1]!)) {
      return { ok: false, message: `breaks 必须严格升序（当前：${breaks.join(', ')}）` }
    }
    if (breaks.length > MAX_CLASSES - 1) {
      return { ok: false, message: `breaks 最多 ${MAX_CLASSES - 1} 个（即最多 ${MAX_CLASSES} 级），当前 ${breaks.length} 个` }
    }
    if (xs.length === 0) {
      return { ok: false, message: `字段 ${field} 没有任何有效数值，无法按区间上色` }
    }
    const levels = breaks.length + 1
    const ramp = opts.ramp ?? DEFAULT_RAMP
    const colors = opts.colors ?? rampColors(ramp, levels)
    if (colors.length < levels) {
      return { ok: false, message: `给了 ${colors.length} 个颜色但分了 ${levels} 级，颜色数不足` }
    }
    const counts = new Array<number>(levels).fill(0)
    for (const x of xs) {
      let idx = breaks.findIndex((b) => x <= b)
      if (idx === -1) idx = levels - 1
      counts[idx]! += 1
    }
    const labels = counts.map((c, i) => {
      const lo = i === 0 ? null : breaks[i - 1]!
      const hi = i === levels - 1 ? null : breaks[i]!
      return `${rangeLabel(lo, hi)}（${c}）`
    })
    const spec: ThematicSpec = {
      field, method, breaks, colors: colors.slice(0, levels), missing,
      ramp: opts.colors ? 'custom' : ramp,
    }
    return { ok: true, spec, counts, labels }
  }

  // ---- 数值型（jenks / quantile / equal）----
  if (xs.length < 3) {
    return { ok: false, message: `字段 ${field} 的有效数值不足（${xs.length} 个），无法分箱` }
  }
  const { min, max } = minMax(xs)
  if (!(max > min)) {
    return { ok: false, message: `字段 ${field} 取值恒定（${min}），无法分箱 —— 用 webgis_set_layer_style 的 color 参数设置单色即可` }
  }
  const k = Math.max(2, Math.min(opts.classes ?? DEFAULT_CLASSES, MAX_CLASSES))
  const { sample, sampled } = method === 'jenks' ? pickSample(xs, JENKS_SAMPLE_CAP) : { sample: xs, sampled: false }
  const breaks =
    method === 'jenks' ? jenksBreaks(sample, k)
      : method === 'quantile' ? quantileBreaks(sample, k)
        : equalBreaks(sample, k)
  if (breaks.length === 0) {
    return { ok: false, message: `字段 ${field} 用「${METHOD_LABEL[method]}」分不出箱（数据过于集中），可改用等间距或减少级数` }
  }
  const levels = breaks.length + 1
  const ramp = opts.ramp ?? DEFAULT_RAMP
  const colors = opts.colors ?? rampColors(ramp, levels)
  if (colors.length < levels) {
    return { ok: false, message: `给了 ${colors.length} 个颜色但分了 ${levels} 级，颜色数不足` }
  }
  // 每级要素数（用全量而非样本，如实反映分布）
  const counts = new Array<number>(levels).fill(0)
  for (const x of xs) {
    let idx = breaks.findIndex((b) => x <= b)
    if (idx === -1) idx = levels - 1
    counts[idx]! += 1
  }
  const labels = counts.map((c, i) => {
    const lo = i === 0 ? null : breaks[i - 1]!
    const hi = i === levels - 1 ? null : breaks[i]!
    return `${rangeLabel(lo, hi)}（${c}）`
  })
  const spec: ThematicSpec = {
    field, method, breaks, colors: colors.slice(0, levels), missing,
    ...(sampled ? { sampledFrom: xs.length } : {}),
    ramp: opts.colors ? 'custom' : ramp,
  }
  return { ok: true, spec, counts, labels }
}

/** 结果 → 给用户看的图例文本。 */
export function formatLegend(spec: ThematicSpec, labels: string[]): string {
  const head = `专题配色：字段「${spec.field}」按${METHOD_LABEL[spec.method]}分 ${spec.colors.length} 级`
  const body = spec.colors.map((c, i) => `${c} ${labels[i] ?? ''}`).join('；')
  return `${head}。${body}`
}
