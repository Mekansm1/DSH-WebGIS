/**
 * 空间统计（纯 TS / turf）：核密度、平均最近邻、全局 Moran's I。
 * 全部为纯函数、返回结构化结果（ok:false + 中文消息或 ok:true + 统计量），供 geo-tools 包装。
 */
import type { BBox, Feature, FeatureCollection, Point } from 'geojson'
import { bbox as turfBbox } from '@turf/bbox'
import { centroid } from '@turf/centroid'
import { distance } from '@turf/distance'
import { feature as makeFeature, featureCollection as fc } from '@turf/helpers'
import { booleanIntersects } from '@turf/boolean-intersects'
import { intersect as turfIntersect } from '@turf/intersect'
import { bboxOf, geometryTypesOf } from './geo-processing.js'

/** 核密度网格上限（防 runaway）。 */
export const MAX_GRID_CELLS = 40000

const DEG_LAT_PER_M = 1 / 110540
function degLonPerM(lat: number): number {
  return 1 / (111320 * Math.cos((lat * Math.PI) / 180))
}

export type KernelResult =
  | { ok: false; message: string }
  | { ok: true; geojson: FeatureCollection; gridCols: number; gridRows: number }

export type AnnResult =
  | { ok: false; message: string }
  | { ok: true; observed: number; expected: number; r: number; n: number; areaM2: number }

export type MoranResult =
  | { ok: false; message: string }
  | {
      ok: true
      I: number
      expected: number
      variance: number
      z: number
      /** p 值：permutations>0 时为置换检验，否则正态解析近似。 */
      p: number
      n: number
      neighbors: number
      weightType: WeightType
      /** 实际使用的检验方式（置换次数 / 'normal'）。 */
      test: string
      note?: string
    }

/** 空间权重矩阵类型。 */
export type WeightType = 'queen' | 'rook' | 'distance' | 'knn'

/** 权重构造参数。 */
export interface WeightOptions {
  /** 权重方式；缺省按几何自动选（面 → queen，点/线 → knn）。 */
  type?: WeightType
  /** distance 方式的距离阈值（米）。 */
  distanceMeters?: number
  /** knn 的邻居数（默认 5，钳制 1..50）。 */
  k?: number
}

/** 权重矩阵（对称 0/1）。 */
export interface WeightMatrix {
  w: number[][]
  /** Σ w_ij（含对称两份）。 */
  S0: number
  /** 相邻对数（无向，不含对称重复）。 */
  neighborPairs: number
  type: WeightType
  note?: string
}

export type WeightResult = { ok: true; matrix: WeightMatrix } | { ok: false; message: string }

/** 仅点要素检查，返回点数组或错误消息。 */
function pointsOnly(fc: FeatureCollection, what: string): Feature<Point>[] | string {
  const types = geometryTypesOf(fc)
  if (types.length === 0) return '没有可处理的要素'
  if (types.some((t) => t !== 'Point')) return `${what}仅支持点要素（MultiPoint 请先用 webgis_explode 拆分）`
  const points = fc.features.filter((f): f is Feature<Point> => f?.geometry?.type === 'Point')
  if (points.length === 0) return '没有点要素'
  return points
}

/**
 * quartic 核密度：对点要素生成规则网格，每格中心计算核密度（带宽 radiusMeters）。
 * 默认半径 5000m、格距 500m；格数超 MAX_GRID_CELLS 报错。
 */
export function opKernelDensity(
  input: FeatureCollection,
  radiusMeters = 5000,
  cellSizeMeters = 500,
): KernelResult {
  if (!(radiusMeters > 0) || !(cellSizeMeters > 0)) return { ok: false, message: 'radiusMeters/cellSizeMeters 必须为正数' }
  const points = pointsOnly(input, '核密度')
  if (typeof points === 'string') return { ok: false, message: points }
  const b = bboxOf(input)
  if (!b) return { ok: false, message: '无法确定计算范围' }
  const [w, s, e, n] = b
  const midLat = (s + n) / 2
  const dLon = degLonPerM(midLat) * cellSizeMeters
  const dLat = DEG_LAT_PER_M * cellSizeMeters
  const cols = Math.max(1, Math.ceil((e - w) / dLon))
  const rows = Math.max(1, Math.ceil((n - s) / dLat))
  if (cols * rows > MAX_GRID_CELLS) {
    return { ok: false, message: `网格过密（${cols}×${rows}，上限 ${MAX_GRID_CELLS} 格），请增大 cellSizeMeters` }
  }
  const k = 3 / Math.PI
  const out: Feature[] = []
  for (let r = 0; r < rows; r++) {
    const cy = s + (r + 0.5) * dLat
    for (let c = 0; c < cols; c++) {
      const cx = w + (c + 0.5) * dLon
      let density = 0
      for (const p of points) {
        const d = distance([cx, cy], p.geometry.coordinates, { units: 'meters' })
        if (d >= radiusMeters) continue
        const u = d / radiusMeters
        density += k * (1 - u * u) * (1 - u * u)
      }
      out.push(makeFeature({ type: 'Point', coordinates: [cx, cy] }, { density: Number(density.toFixed(4)) }))
    }
  }
  return { ok: true, geojson: fc(out), gridCols: cols, gridRows: rows }
}

/**
 * 平均最近邻指数（ANN）：实测最近邻均距 / CSR 期望均距（0.5·√(A/n)）。r<1 聚集、>1 分散。
 */
export function opAverageNearestNeighbor(input: FeatureCollection): AnnResult {
  const points = pointsOnly(input, '平均最近邻')
  if (typeof points === 'string') return { ok: false, message: points }
  if (points.length < 2) return { ok: false, message: '至少需要 2 个点要素' }
  const b = bboxOf(input)
  if (!b) return { ok: false, message: '无法确定计算范围' }
  const [w, s, e, n] = b
  const midLat = (s + n) / 2
  const midLng = (w + e) / 2
  const widthM = distance([w, midLat], [e, midLat], { units: 'meters' })
  const heightM = distance([midLng, s], [midLng, n], { units: 'meters' })
  const areaM2 = widthM * heightM
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    let best = Infinity
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue
      const d = distance(points[i]!.geometry.coordinates, points[j]!.geometry.coordinates, { units: 'meters' })
      if (d < best) best = d
    }
    sum += best
  }
  const observed = sum / points.length
  const expected = 0.5 * Math.sqrt(areaM2 / points.length)
  return { ok: true, observed, expected, r: observed / expected, n: points.length, areaM2 }
}

function bboxOverlap(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

/** erf（Abramowitz–Stegun 7.1.26 近似，±1.5e-7）。 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax)
  return sign * y
}

/** 固定种子 PRNG（mulberry32）：置换检验可复现。 */
function makeRng(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 要素的代表点（点取坐标，面/线取质心）；取不到返回 null。 */
function representativeCoord(f: Feature): [number, number] | null {
  const g = f.geometry
  if (!g) return null
  if (g.type === 'Point') {
    const c = g.coordinates as number[]
    const x = c?.[0]
    const y = c?.[1]
    return Number.isFinite(x) && Number.isFinite(y) ? [x as number, y as number] : null
  }
  try {
    const c = centroid(f as never).geometry.coordinates as number[]
    const x = c?.[0]
    const y = c?.[1]
    return Number.isFinite(x) && Number.isFinite(y) ? [x as number, y as number] : null
  } catch {
    return null
  }
}

/** 取要素的全部边界顶点（Polygon/MultiPolygon 环上的点）。 */
function ringVertices(f: Feature): number[][] {
  const g = f.geometry
  if (!g) return []
  const out: number[][] = []
  const pushRing = (ring: unknown): void => {
    if (!Array.isArray(ring)) return
    for (const c of ring) {
      if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) out.push([c[0] as number, c[1] as number])
    }
  }
  if (g.type === 'Polygon') {
    for (const ring of g.coordinates) pushRing(ring)
  } else if (g.type === 'MultiPolygon') {
    for (const poly of g.coordinates) for (const ring of poly) pushRing(ring)
  }
  return out
}

/** 两要素共享的边界顶点数（容差 1e-9，用于 rook 判定）。 */
function sharedVertexCount(a: Feature, b: Feature): number {
  const va = ringVertices(a)
  const vb = ringVertices(b)
  let count = 0
  for (const pa of va) {
    for (const pb of vb) {
      if (Math.abs(pa[0]! - pb[0]!) < 1e-9 && Math.abs(pa[1]! - pb[1]!) < 1e-9) { count++; break }
    }
  }
  return count
}

/** 按几何类型给出默认权重方式：面 → queen；点/线 → knn。 */
export function defaultWeightFor(types: string[]): WeightType {
  return types.length > 0 && types.every((t) => t === 'Polygon' || t === 'MultiPolygon') ? 'queen' : 'knn'
}

/** knn 可支持的最大要素数（O(n²) 排序；超过请改用 distance/queen）。 */
const KNN_MAX_N = 5000
/** 置换检验默认/上限次数。 */
export const PERMUTATIONS_DEFAULT = 999
export const PERMUTATIONS_MAX = 9999

/**
 * 构造空间权重矩阵（对称 0/1）：
 * - queen：面要素共边或共点（booleanIntersects）
 * - rook：面要素共边（相交结果为线；仅共点不算）
 * - distance：代表点 haversine 距离 ≤ distanceMeters（bbox 预过滤）
 * - knn：每要素最近 k 个邻居（代表点距离）
 * 面方式要求全为面要素；distance/knn 点/线/面都支持。
 */
export function makeWeightMatrix(feats: Feature[], opts: WeightOptions = {}): WeightResult {
  const types = geometryTypesOf({ type: 'FeatureCollection', features: feats } as FeatureCollection)
  const type = opts.type ?? defaultWeightFor(types)
  const n = feats.length
  const w: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  let S0 = 0
  let neighborPairs = 0
  const link = (i: number, j: number): void => {
    if (w[i]![j] === 1) return
    w[i]![j] = 1
    w[j]![i] = 1
    S0 += 2
    neighborPairs += 1
  }

  if (type === 'queen' || type === 'rook') {
    if (!(types.length > 0 && types.every((t) => t === 'Polygon' || t === 'MultiPolygon'))) {
      return { ok: false, message: `${type} 权重仅支持面要素（Polygon/MultiPolygon）；点/线请改用 distance 或 knn` }
    }
    const bboxes: BBox[] = feats.map((f) => {
      try { return turfBbox(f) } catch { return [Infinity, Infinity, -Infinity, -Infinity] as BBox }
    })
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (!bboxOverlap(bboxes[i]!, bboxes[j]!)) continue
        try {
          if (type === 'queen') {
            if (booleanIntersects(feats[i]!, feats[j]!)) link(i, j)
          } else if (sharedVertexCount(feats[i]!, feats[j]!) >= 2) {
            // rook：共享 ≥2 个边界顶点 = 共边；仅共点（1 个顶点）不算。
            // （@turf/intersect 对「仅共享边」返回 null——零面积，故用顶点判定。）
            link(i, j)
          }
        } catch {
          // 几何异常视为不相邻
        }
      }
    }
    return { ok: true, matrix: { w, S0, neighborPairs, type, ...(type === 'rook' ? { note: 'rook：仅共边相邻（仅共点不算）' } : {}) } }
  }

  const coords = feats.map(representativeCoord)
  if (coords.some((c) => c == null)) return { ok: false, message: '有要素无法取得代表点（几何缺失或非法），无法构造距离权重' }

  if (type === 'distance') {
    const threshold = opts.distanceMeters
    if (!(typeof threshold === 'number' && threshold > 0)) return { ok: false, message: 'distance 权重需要 distanceMeters（米，>0）' }
    const bboxes: BBox[] = feats.map((f) => {
      try { return turfBbox(f) } catch { return [Infinity, Infinity, -Infinity, -Infinity] as BBox }
    })
    // 按阈值换算的度数扩张做 bbox 预过滤，避免全量 haversine
    for (let i = 0; i < n; i++) {
      const ci = coords[i]!
      const dLat = threshold / 110540
      const dLon = threshold / (111320 * Math.max(0.01, Math.cos((ci[1] * Math.PI) / 180)))
      for (let j = i + 1; j < n; j++) {
        const bj = bboxes[j]!
        if (bj[0]! > ci[0] + dLon || bj[2]! < ci[0] - dLon || bj[1]! > ci[1] + dLat || bj[3]! < ci[1] - dLat) continue
        const d = distance(ci, coords[j]!, { units: 'meters' })
        if (d > 0 && d <= threshold) link(i, j)
      }
    }
    return { ok: true, matrix: { w, S0, neighborPairs, type, note: `distance 阈值 ${threshold}m` } }
  }

  // knn：每要素最近 k 个邻居
  const k = Math.max(1, Math.min(50, Math.round(opts.k ?? 5)))
  if (n < k + 1) return { ok: false, message: `knn 需要至少 k+1=${k + 1} 个要素（当前 ${n} 个）` }
  if (n > KNN_MAX_N) {
    return { ok: false, message: `knn 权重上限 ${KNN_MAX_N} 个要素（当前 ${n} 个）；请改用 distance 或 queen，或先缩小图层范围` }
  }
  for (let i = 0; i < n; i++) {
    const ci = coords[i]!
    const ds: Array<{ j: number; d: number }> = []
    for (let j = 0; j < n; j++) {
      if (j === i) continue
      ds.push({ j, d: distance(ci, coords[j]!, { units: 'meters' }) })
    }
    ds.sort((a, b) => a.d - b.d)
    for (const { j } of ds.slice(0, k)) link(i, j)
  }
  return { ok: true, matrix: { w, S0, neighborPairs, type, note: `knn k=${k}` } }
}

/** 数值字段标准化：返回观测值、z 值与 Σz²；非法/常量返回错误消息。 */
function standardize(
  feats: Feature[],
  field: string,
): { ok: true; xs: number[]; z: number[]; s2: number; mean: number } | { ok: false; message: string } {
  // ⚠ 不能直接 Number(v)：Number(null) / Number('') / Number(false) 都是 0，
  // 会让空值、空串、布尔悄悄当成 0 参与计算，得出「看起来正常但错」的结果。
  const xs: number[] = []
  let missing = 0
  for (const f of feats) {
    const v = f.properties?.[field]
    const x = typeof v === 'number' ? v : v == null || v === '' || typeof v === 'boolean' ? Number.NaN : Number(v)
    if (Number.isFinite(x)) xs.push(x)
    else { xs.push(Number.NaN); missing++ }
  }
  if (missing > 0) {
    return {
      ok: false,
      message: `字段 ${field} 有 ${missing}/${feats.length} 个空值或非数值：空间自相关要求每个要素都有值`
        + '（请先用 webgis_select_by_value / webgis_filter_layer 过滤掉这些要素，或改用别的字段）',
    }
  }
  const n = xs.length
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const z = xs.map((x) => x - mean)
  const s2 = z.reduce((a, b) => a + b * b, 0)
  if (s2 === 0) return { ok: false, message: `字段 ${field} 为常量，无法计算空间自相关` }
  return { ok: true, xs, z, s2, mean }
}

/** 全局 I 及其解析期望/方差（给定权重与 z）。 */
function moranStats(w: number[][], z: number[], s2: number, S0: number): { I: number; expected: number; variance: number } {
  const n = z.length
  let wzz = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) wzz += (w[i]?.[j] ?? 0) * (z[i] ?? 0) * (z[j] ?? 0)
  }
  const I = (n / S0) * (wzz / s2)
  const expected = -1 / (n - 1)
  // S1 = Σ w²（二值对称 → S0）；S2 = Σ (row_i + col_i)²
  let S2 = 0
  for (let i = 0; i < n; i++) {
    let row = 0
    let col = 0
    for (let j = 0; j < n; j++) {
      row += w[i]?.[j] ?? 0
      col += w[j]?.[i] ?? 0
    }
    const rc = row + col
    S2 += rc * rc
  }
  const S1 = S0
  const variance = (n * n * S1 - n * S2 + 3 * S0 * S0) / ((n * n - 1) * S0 * S0) - expected * expected
  return { I, expected, variance }
}

/** 重排观测值后按权重算全局 I（置换检验用）。 */
function permutedI(w: number[][], S0: number, vals: number[]): number {
  let m = 0
  for (const v of vals) m += v
  m /= vals.length
  const zb = vals.map((x) => x - m)
  let s2b = 0
  for (const x of zb) s2b += x * x
  let wzz = 0
  for (let i = 0; i < zb.length; i++) {
    for (let j = 0; j < zb.length; j++) wzz += (w[i]?.[j] ?? 0) * (zb[i] ?? 0) * (zb[j] ?? 0)
  }
  return (zb.length / S0) * (wzz / s2b)
}

/**
 * 全局 Moran's I。权重默认按几何自动选（面 queen / 点线 knn），可用 weight/distance/k 指定；
 * permutations>0 时用置换检验（固定 seed → 可复现），否则正态解析近似。
 */
export function opMoranI(
  input: FeatureCollection,
  field: string,
  opts: WeightOptions & { permutations?: number; seed?: number } = {},
): MoranResult {
  const feats = input.features.filter((f) => f?.geometry)
  if (feats.length < 2) return { ok: false, message: '至少需要 2 个要素' }
  const st = standardize(feats, field)
  if (!st.ok) return { ok: false, message: st.message }
  const wm = makeWeightMatrix(feats, opts)
  if (!wm.ok) return { ok: false, message: wm.message }
  const { w, S0, neighborPairs, type, note } = wm.matrix
  if (S0 === 0) {
    return { ok: false, message: `${type} 权重下要素之间没有相邻关系，无法计算 Moran I（可调整距离阈值/K，或换权重方式）` }
  }
  const { I, expected, variance } = moranStats(w, st.z, st.s2, S0)
  const zscore = variance > 0 ? (I - expected) / Math.sqrt(variance) : 0
  const perms = Math.max(0, Math.min(PERMUTATIONS_MAX, Math.round(opts.permutations ?? 0)))
  const seed = opts.seed ?? 42
  if (perms > 0) {
    const rng = makeRng(seed)
    const vals = st.xs.slice()
    const absI = Math.abs(I)
    let ge = 0
    for (let b = 0; b < perms; b++) {
      for (let i = vals.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1))
        const t = vals[i]!
        vals[i] = vals[j]!
        vals[j] = t
      }
      if (Math.abs(permutedI(w, S0, vals)) >= absI) ge++
    }
    return {
      ok: true, I, expected, variance, z: zscore, p: (ge + 1) / (perms + 1),
      n: feats.length, neighbors: neighborPairs, weightType: type, test: `permutation(${perms}, seed=${seed})`,
      ...(note ? { note } : {}),
    }
  }
  return {
    ok: true, I, expected, variance, z: zscore, p: 1 - erf(Math.abs(zscore) / Math.SQRT2),
    n: feats.length, neighbors: neighborPairs, weightType: type, test: 'normal',
    ...(note ? { note } : {}),
  }
}

/** LISA 局部莫兰结果。 */
export type LocalMoranResult =
  | { ok: false; message: string }
  | {
      ok: true
      geojson: FeatureCollection
      I: number
      n: number
      neighbors: number
      weightType: WeightType
      alpha: number
      test: string
      counts: Record<'HH' | 'LL' | 'HL' | 'LH' | 'nonsig', number>
      note?: string
    }

/**
 * LISA 局部莫兰：每个要素输出 lisa_I / lisa_lag / lisa_p / lisa_class（HH/LL/HL/LH/nonsig）。
 * 显著性用置换检验（对全部观测值重排，固定 seed 可复现；>1 万要素自动退化为正态近似）。
 */
export function opLocalMoranI(
  input: FeatureCollection,
  field: string,
  opts: WeightOptions & { permutations?: number; seed?: number; alpha?: number } = {},
): LocalMoranResult {
  const feats = input.features.filter((f) => f?.geometry)
  if (feats.length < 2) return { ok: false, message: '至少需要 2 个要素' }
  const st = standardize(feats, field)
  if (!st.ok) return { ok: false, message: st.message }
  const wm = makeWeightMatrix(feats, opts)
  if (!wm.ok) return { ok: false, message: wm.message }
  const { w, S0, neighborPairs, type, note } = wm.matrix
  if (S0 === 0) {
    return { ok: false, message: `${type} 权重下要素之间没有相邻关系，无法计算局部莫兰（可调整距离阈值/K，或换权重方式）` }
  }
  const n = feats.length
  const { I } = moranStats(w, st.z, st.s2, S0)
  const m2 = st.s2 / n
  const alpha = typeof opts.alpha === 'number' && opts.alpha > 0 && opts.alpha < 1 ? opts.alpha : 0.05
  const seed = opts.seed ?? 42

  // 观测的局部 I 与空间滞后
  const lag = new Array<number>(n).fill(0)
  const Ii = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = 0; j < n; j++) s += (w[i]?.[j] ?? 0) * (st.z[j] ?? 0)
    lag[i] = s
    Ii[i] = ((st.z[i] ?? 0) / m2) * s
  }

  const perms = Math.max(0, Math.min(PERMUTATIONS_MAX, Math.round(opts.permutations ?? PERMUTATIONS_DEFAULT)))
  const ge = new Array<number>(n).fill(0)
  if (perms > 0) {
    // 条件置换（Anselin）：对每个要素固定其自身 z_i，重排其余要素的观测值，
    // 看该要素局部 I 在零假设下的分布 → 伪 p。全局重排会明显偏保守（小样本几乎都不显著）。
    const rng = makeRng(seed)
    for (let i = 0; i < n; i++) {
      const zi = st.z[i]!
      const absIi = Math.abs(Ii[i]!)
      // 除 i 之外的 z 值（顺序与「非 i 位置」一一对应）
      const pool = st.z.filter((_, k) => k !== i)
      const idxOf = (j: number): number => (j < i ? j : j - 1) // pool 中的下标
      for (let b = 0; b < perms; b++) {
        for (let q = pool.length - 1; q > 0; q--) {
          const r = Math.floor(rng() * (q + 1))
          const t = pool[q]!
          pool[q] = pool[r]!
          pool[r] = t
        }
        let lagStar = 0
        for (let j = 0; j < n; j++) {
          if (j === i || (w[i]?.[j] ?? 0) === 0) continue
          lagStar += pool[idxOf(j)]!
        }
        const iStar = (zi / m2) * lagStar
        if (Math.abs(iStar) >= absIi) ge[i]!++
      }
    }
  }

  const counts: Record<'HH' | 'LL' | 'HL' | 'LH' | 'nonsig', number> = { HH: 0, LL: 0, HL: 0, LH: 0, nonsig: 0 }
  const outFeatures = feats.map((f, i) => {
    const p = perms > 0 ? (ge[i]! + 1) / (perms + 1) : 1 - erf(Math.abs(Ii[i]!) / Math.SQRT2)
    const zi = st.z[i]!
    const li = lag[i]!
    let cls: 'HH' | 'LL' | 'HL' | 'LH' | 'nonsig' = 'nonsig'
    if (p < alpha) {
      if (zi > 0 && li > 0) cls = 'HH'
      else if (zi < 0 && li < 0) cls = 'LL'
      else if (zi > 0 && li < 0) cls = 'HL'
      else if (zi < 0 && li > 0) cls = 'LH'
    }
    counts[cls]++
    return {
      ...f,
      properties: {
        ...(f.properties ?? {}),
        lisa_I: Number(Ii[i]!.toFixed(6)),
        lisa_lag: Number(li.toFixed(6)),
        lisa_p: Number(p.toFixed(4)),
        lisa_class: cls,
      },
    }
  })
  return {
    ok: true,
    geojson: fc(outFeatures),
    I,
    n,
    neighbors: neighborPairs,
    weightType: type,
    alpha,
    test: perms > 0 ? `permutation(${perms}, seed=${seed})` : 'normal',
    counts,
    ...(note ? { note } : {}),
  }
}
