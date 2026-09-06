/**
 * 蜂窝热力图六边形归并（纯函数，浏览器/Node 双端可测）。
 *
 * 把点要素归入六边形格（pointy-top 轴向坐标系，Red Blob Games 同款），
 * 输出覆盖整片区域的六边形 Polygon 要素：
 * - 要素带 `density` 属性 → 每格按 density **求和**（复用核密度结果）；
 * - 无 `density` → 每格按**点数**计数（count）。
 * 空格子也生成（density:0 / count:0），保证蜂窝面完整。
 *
 * 只做归并、不重算核密度——切换展示方式不触发任何服务端计算。
 * 全部用局部米制坐标，规避球面经纬度直接取样的形变。
 */

import type { Feature, FeatureCollection, Polygon } from 'geojson'

/** 蜂窝格数上限（超出会放大格距，控制渲染成本）。 */
export const MAX_HEX_CELLS = 12000
/** 目标：bbox 短边约分成 40 个六边形。 */
export const TARGET_DIVISIONS = 40
/** 最小格距（米）。 */
export const MIN_HEX_METERS = 30

const DEG_LAT_PER_M = 1 / 110540
const degLonPerM = (lat: number): number => 1 / (111320 * Math.cos((lat * Math.PI) / 180))
const SQRT3 = Math.sqrt(3)

/** 依据 bbox 尺寸（米）选一个合适的六边形格距（米）：短边 /40，超格数上限再放大。 */
export function pickHexSizeMeters(widthM: number, heightM: number): number {
  let cell = Math.min(widthM, heightM) / TARGET_DIVISIONS
  const predicted = (widthM * heightM * 1.1547) / (cell * cell)
  if (predicted > MAX_HEX_CELLS) {
    cell = Math.sqrt((widthM * heightM * 1.1547) / MAX_HEX_CELLS)
  }
  return Math.max(MIN_HEX_METERS, cell)
}

/** 轴向坐标取整（标准 hexRound：三轴取整后把偏差最大的轴用另外两轴修正）。 */
function hexRound(q: number, r: number): [number, number] {
  const s = -q - r
  let rq = Math.round(q)
  let rr = Math.round(r)
  const rs = Math.round(s)
  const dq = Math.abs(rq - q)
  const dr = Math.abs(rr - r)
  const ds = Math.abs(rs - s)
  if (dq > dr && dq > ds) rq = -rr - rs
  else if (dr > ds) rr = -rq - rs
  return [rq, rr]
}

interface HexAcc {
  q: number
  r: number
  sum: number
  count: number
}

/** 点要素 → 蜂窝 Polygon 要素。cellSizeMeters 缺省时按输入 bbox 自动选。 */
export function hexbinFC(input: FeatureCollection, cellSizeMeters?: number): FeatureCollection<Polygon> {
  const pts: Array<{ lng: number; lat: number; density: number }> = []
  let hasDensity = false
  let w = Infinity
  let s = Infinity
  let e = -Infinity
  let n = -Infinity

  for (const f of input.features) {
    const g = f?.geometry
    if (!g) continue
    const densityRaw = f?.properties?.density
    const density = Number.isFinite(Number(densityRaw)) ? Number(densityRaw) : 0
    if (Number.isFinite(Number(densityRaw))) hasDensity = true
    const coords = g.type === 'Point' ? [g.coordinates] : g.type === 'MultiPoint' ? g.coordinates : []
    for (const c of coords) {
      const lng = c[0] ?? 0
      const lat = c[1] ?? 0
      if (lng < w) w = lng
      if (lng > e) e = lng
      if (lat < s) s = lat
      if (lat > n) n = lat
      pts.push({ lng, lat, density })
    }
  }
  if (pts.length === 0) return { type: 'FeatureCollection', features: [] }

  const midLat = (s + n) / 2
  const dLon = degLonPerM(midLat)
  const widthM = (e - w) / dLon
  const heightM = (n - s) / DEG_LAT_PER_M
  let cell = cellSizeMeters ?? pickHexSizeMeters(widthM, heightM)

  // 归并 + 超格保护（一次）：轴向菱形格数超上限 → 放大格距重跑。
  const hexes = new Map<string, HexAcc>()
  for (let attempt = 0; attempt < 2; attempt++) {
    hexes.clear()
    const R = cell / SQRT3
    let qmin = Infinity
    let qmax = -Infinity
    let rmin = Infinity
    let rmax = -Infinity
    for (const p of pts) {
      const dx = (p.lng - w) / dLon
      const dy = (p.lat - s) / DEG_LAT_PER_M
      const qf = ((SQRT3 / 3) * dx - (1 / 3) * dy) / R
      const rf = ((2 / 3) * dy) / R
      const [q, r] = hexRound(qf, rf)
      if (q < qmin) qmin = q
      if (q > qmax) qmax = q
      if (r < rmin) rmin = r
      if (r > rmax) rmax = r
      const key = `${q},${r}`
      const acc = hexes.get(key) ?? { q, r, sum: 0, count: 0 }
      acc.sum += p.density
      acc.count += 1
      hexes.set(key, acc)
    }
    if (attempt === 0 && Number.isFinite(qmin) && (qmax - qmin + 3) * (rmax - rmin + 3) > MAX_HEX_CELLS) {
      cell = Math.max(MIN_HEX_METERS, cell * Math.sqrt(((qmax - qmin + 3) * (rmax - rmin + 3)) / MAX_HEX_CELLS))
      continue
    }

    // 生成整片蜂窝（qmin-1..qmax+1 × rmin-1..rmax+1，含空格子）。
    const out: Feature<Polygon>[] = []
    for (let q = qmin - 1; q <= qmax + 1; q++) {
      for (let r = rmin - 1; r <= rmax + 1; r++) {
        const acc = hexes.get(`${q},${r}`)
        const sum = acc?.sum ?? 0
        const count = acc?.count ?? 0
        const cx = SQRT3 * R * (q + r / 2)
        const cy = 1.5 * R * r
        const ring: number[][] = []
        for (let i = 0; i < 6; i++) {
          const ang = ((60 * i - 30) * Math.PI) / 180
          ring.push([w + (cx + R * Math.cos(ang)) * dLon, s + (cy + R * Math.sin(ang)) * DEG_LAT_PER_M])
        }
        ring.push(ring[0]!)
        out.push({
          type: 'Feature',
          properties: { density: hasDensity ? Math.round(sum * 10000) / 10000 : count, count },
          geometry: { type: 'Polygon', coordinates: [ring] },
        })
      }
    }
    return { type: 'FeatureCollection', features: out }
  }
  return { type: 'FeatureCollection', features: [] }
}
