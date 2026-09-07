/**
 * 测距纯函数（客户端 gis 用）：球面距离（haversine）+ 路径累计 + 距离文本。
 * 不依赖 react/maplibre，node 可直接单测（lib/client/measure-utils.js）。
 */

export interface Pt { lon: number; lat: number }

/** 地球平均半径（米，IUGG）。 */
const EARTH_RADIUS_M = 6371008.8

function toRad(d: number): number {
  return (d * Math.PI) / 180
}

/** 两点球面大圆距离（米）。 */
export function haversineM(a: Pt, b: Pt): number {
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** 折线路径累计长度（米）；点数 < 2 为 0。 */
export function pathMeters(pts: Pt[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += haversineM(pts[i - 1]!, pts[i]!)
  return total
}

/**
 * 逐段长度（米），长度 = 点数 - 1。
 */
export function segmentMeters(pts: Pt[]): number[] {
  const out: number[] = []
  for (let i = 1; i < pts.length; i++) out.push(haversineM(pts[i - 1]!, pts[i]!))
  return out
}

/** 闭合环周长（米）：折线各段 + 回到起点的最后一笔；<3 点返回 0。 */
export function ringPathMeters(pts: Pt[]): number {
  if (pts.length < 3) return 0
  return pathMeters(pts) + haversineM(pts[pts.length - 1]!, pts[0]!)
}

/** 球面多边形面积（m²）：turf ringArea 同款公式（球面过剩），顺/逆时针均可（取绝对值）；<3 点返回 0。 */
export function polygonAreaM2(pts: Pt[]): number {
  if (pts.length < 3) return 0
  const R2 = EARTH_RADIUS_M * EARTH_RADIUS_M
  let total = 0
  for (let i = 0; i < pts.length; i++) {
    const p1 = pts[i]!
    const p2 = pts[(i + 1) % pts.length]!
    total += toRad(p2.lon - p1.lon) * (2 + Math.sin(toRad(p1.lat)) + Math.sin(toRad(p2.lat)))
  }
  return Math.abs((total * R2) / 2)
}

/** 面积文本：≥1 km² → km²；≥1 ha → ha；否则 m²。 */
export function formatArea(m2: number): string {
  if (!Number.isFinite(m2) || m2 < 0) m2 = 0
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(2)} km²`
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`
  return `${Math.round(m2)} m²`
}

/** 距离文本：≥1 km 用 km（≤100 两位小数，>100 取整），否则按米取整。 */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) m = 0
  if (m >= 1000) {
    const km = m / 1000
    return `${km >= 100 ? km.toFixed(0) : km.toFixed(2)} km`
  }
  return `${Math.round(m)} m`
}
