/**
 * 空间统计（纯 TS / turf）：核密度、平均最近邻、全局 Moran's I。
 * 全部为纯函数、返回结构化结果（ok:false + 中文消息或 ok:true + 统计量），供 geo-tools 包装。
 */
import type { BBox, Feature, FeatureCollection, Point } from 'geojson'
import { bbox as turfBbox } from '@turf/bbox'
import { distance } from '@turf/distance'
import { feature as makeFeature, featureCollection as fc } from '@turf/helpers'
import { booleanIntersects } from '@turf/boolean-intersects'
import { bboxOf, geometryTypesOf } from './geo-processing.js'

/** 核密度网格上限（防 runaway）。 */
const MAX_GRID_CELLS = 40000

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
  | { ok: true; I: number; expected: number; variance: number; z: number; p: number; n: number; neighbors: number }

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

/**
 * 全局 Moran's I（Polygon/MultiPolygon，queen 邻接）。输出 I / E / Var / z / p（正态近似）。
 */
export function opMoranI(input: FeatureCollection, field: string): MoranResult {
  const types = geometryTypesOf(input)
  if (types.length === 0) return { ok: false, message: '没有可处理的要素' }
  if (types.some((t) => t !== 'Polygon' && t !== 'MultiPolygon')) {
    return { ok: false, message: 'Moran I 仅支持面要素（Polygon/MultiPolygon）' }
  }
  const feats = input.features.filter((f) => f?.geometry)
  if (feats.length < 2) return { ok: false, message: '至少需要 2 个要素' }
  const xs = feats.map((f) => Number(f.properties?.[field]))
  if (xs.some((x) => !Number.isFinite(x))) return { ok: false, message: `字段 ${field} 必须为数值` }
  const n = feats.length
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const z = xs.map((x) => x - mean)
  const s2 = z.reduce((a, b) => a + b * b, 0)
  if (s2 === 0) return { ok: false, message: '字段为常量，无法计算 Moran I' }
  const bboxes: BBox[] = feats.map((f) => {
    try {
      return turfBbox(f)
    } catch {
      return [Infinity, Infinity, -Infinity, -Infinity] as BBox
    }
  })
  const w: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  let S0 = 0
  let neighborPairs = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!bboxOverlap(bboxes[i]!, bboxes[j]!)) continue
      try {
        if (booleanIntersects(feats[i]!, feats[j]!)) {
          w[i]![j] = 1
          w[j]![i] = 1
          S0 += 2
          neighborPairs += 1
        }
      } catch {
        // 几何异常视为不相邻
      }
    }
  }
  if (S0 === 0) return { ok: false, message: '要素之间没有相邻关系，无法计算 Moran I' }
  let wzz = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      wzz += (w[i]?.[j] ?? 0) * (z[i] ?? 0) * (z[j] ?? 0)
    }
  }
  const I = (n / S0) * (wzz / s2)
  const E = -1 / (n - 1)
  // S1 = Σ w² = S0（二值对称）；S2 = Σ (row_i + col_i)²
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
  const variance = (n * n * S1 - n * S2 + 3 * S0 * S0) / ((n * n - 1) * S0 * S0) - E * E
  const zscore = variance > 0 ? (I - E) / Math.sqrt(variance) : 0
  const p = 1 - erf(Math.abs(zscore) / Math.SQRT2)
  return { ok: true, I, expected: E, variance, z: zscore, p, n, neighbors: neighborPairs }
}
