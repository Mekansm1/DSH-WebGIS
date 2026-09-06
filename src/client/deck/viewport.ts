/**
 * 视口裁剪纯函数（客户端，deck controller 与 node 单测共用）：
 * bbox 面积比 / 覆盖判定 / 外扩 / 序列化。无任何运行时 import，可在 node 直接加载。
 *
 * 设计约定：
 *  - 视口裁剪只在「收益明显」（view 面积 < 层面积 55%，或无层 bbox 且 zoom≥15）才启用；
 *  - 取数窗口 = 当前视野按 {@link FETCH_PAD} 外扩（减少后续平移重拉）；
 *  - 覆盖率跳过 = 当前视野仍落在上次成功拉到的窗口内 → 本层不重拉（渲染层不动）。
 */

/** 经纬度 bbox（WGS84，度）：west/south/east/north。 */
export interface Bbox {
  west: number
  south: number
  east: number
  north: number
}

/** 视口裁剪收益门控：view/layer 面积比阈值（< 该值才值得裁剪）。 */
export const CULL_RATIO = 0.55
/** 无层 bbox 时启用视口裁剪的最低 zoom。 */
export const CULL_MIN_ZOOM = 15
/** 取数窗口外扩比例（每边相对窗口宽/高）。 */
export const FETCH_PAD = 0.25
/** 覆盖判定容差（度，吸收 bbox 序列化到 3 位小数的舍入）。 */
export const COVER_MARGIN_DEG = 0.0005

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** 经纬度每边按自身宽/高比例外扩：west 减 width*pad、east 加 width*pad（纬度同理）。
 *  经度钳制 ±180、纬度钳制 ±90；退化区间（宽或高 ≤ 0）原样返回（仍是新副本）。 */
export function paddedBbox(bb: Bbox, pad: number): Bbox {
  const width = bb.east - bb.west
  const height = bb.north - bb.south
  if (!(width > 0) || !(height > 0)) return { ...bb }
  const dx = width * pad
  const dy = height * pad
  return {
    west: clamp(bb.west - dx, -180, 180),
    south: clamp(bb.south - dy, -90, 90),
    east: clamp(bb.east + dx, -180, 180),
    north: clamp(bb.north + dy, -90, 90),
  }
}

/** 近似球面面积（度²）：`(east-west) * cos(中纬) * (north-south)`；宽/高取正、面积恒正（非有限输入 → 0）。 */
export function bboxArea(bb: Bbox): number {
  const w = Math.abs(bb.east - bb.west)
  const h = Math.abs(bb.north - bb.south)
  const mid = ((bb.north + bb.south) / 2) * (Math.PI / 180)
  const area = Math.abs(w * Math.cos(mid) * h)
  return Number.isFinite(area) ? area : 0
}

/** view/layer 面积比。层面积为 0 或非有限 → Infinity（视口相对层无限大，收益门控应走保守全档位）。 */
export function areaRatio(view: Bbox, layer: Bbox): number {
  const layerArea = bboxArea(layer)
  if (!(layerArea > 0)) return Infinity
  return bboxArea(view) / layerArea
}

/** outer 是否包含 inner：inner 四边都在 outer 内（每边各外放 marginDeg 容差），用于「平移仍在已加载窗口内 → 跳过取数」。 */
export function bboxContains(outer: Bbox, inner: Bbox, marginDeg = 0): boolean {
  return inner.west >= outer.west - marginDeg
    && inner.east <= outer.east + marginDeg
    && inner.south >= outer.south - marginDeg
    && inner.north <= outer.north + marginDeg
}

/** 序列化为 `west,south,east,north`，各值 `Number(v.toFixed(3))`（去尾零；与 host bbox 参数一致）。 */
export function bboxStr(bb: Bbox): string {
  return [bb.west, bb.south, bb.east, bb.north]
    .map((v) => String(Number(v.toFixed(3))))
    .join(',')
}

/** 容错解析 `west,south,east,north`（容忍前后/段间空白）；非法（段数不足/空段/非数值）抛 Error
 *  （controller 只喂自己 {@link bboxStr} 序列化的串，不会触发）。 */
export function fromBboxStr(str: string): Bbox {
  const segs = String(str).trim().split(',')
  if (segs.length !== 4) throw new Error(`非法 bbox 字符串: ${str}`)
  const nums = segs.map((seg) => {
    const t = seg.trim()
    if (t === '') throw new Error(`非法 bbox 字符串: ${str}`)
    return Number(t)
  })
  if (nums.some((n) => !Number.isFinite(n))) throw new Error(`非法 bbox 字符串: ${str}`)
  return { west: nums[0]!, south: nums[1]!, east: nums[2]!, north: nums[3]! }
}

/** 收益门控：本层是否值得走视口裁剪。
 *  有层 bbox：view/layer 面积比 < {@link CULL_RATIO} → 裁剪；层面积退化/非有限 → 保守 false（旧全档位）。
 *  无层 bbox（极少数）：zoom ≥ {@link CULL_MIN_ZOOM} 才裁剪，否则保守 false。 */
export function shouldViewportCull(view: Bbox, layerBbox: Bbox | null, zoom: number): boolean {
  if (layerBbox) {
    const r = areaRatio(view, layerBbox)
    return Number.isFinite(r) && r < CULL_RATIO
  }
  return zoom >= CULL_MIN_ZOOM
}
