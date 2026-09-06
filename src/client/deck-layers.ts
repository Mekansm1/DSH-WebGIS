/**
 * deck.gl 渲染层（**预留给后续出图效果：轨迹图 ArcLayer / 散点图 ScatterplotLayer 等**）。
 *
 * ⚠️ 热力图展示方式已退回 maplibre 原生渲染（`MapView` 的 makeHeatLayer / hexbinFC+makeHexLayer，
 * 缩放流畅无重算），本模块当前不被任何代码引用、不进 bundle，仅保留作 deck.gl 集成的
 * 参考入口与可复用模式：
 * - 集成：`@deck.gl/mapbox` 的 `MapboxOverlay({ interleaved: true })`（共享 maplibre WebGL 上下文，
 *   截图/像素拾取同 canvas；样式切换后自动重注入，见 MapView 曾有实现），`map.addControl(overlay)` 挂载，
 *   `overlay.setProps({ layers })` 推送图层；
 * - 图层：`@deck.gl/layers` / `@deck.gl/aggregation-layers` 按需引入，props 纯函数构造可单测。
 *
 * 本文件里的 HeatmapLayer / HexagonLayer 构造保留为 API 用法示例（不用于热力图渲染）。
 * 权重语义沿用旧 hexbin：要素带 density 属性 → 按 density 求和；否则按点数计数。
 */
import { HeatmapLayer, HexagonLayer } from '@deck.gl/aggregation-layers'
import type { Feature, FeatureCollection, Point } from 'geojson'
import { pickHexSizeMeters } from './hex-bins.js'

export type DeckMode = 'plane' | 'hex'

/** 一张热力图图层所需的最小编制信息（图层注册表摘要 + 客户端数据缓存）。 */
export interface DeckLayerSpec {
  /** 图层 id（与图层注册表一致）。 */
  id: string
  mode: DeckMode
  geojson: FeatureCollection
  bbox: [number, number, number, number] | null
  visible: boolean
}

/** 热色带（深蓝 → 青 → 绿 → 黄 → 橙 → 红），与旧 maplibre 热力图一致。 */
export const HEAT_RAMP: Array<[number, number, number]> = [
  [35, 74, 135],
  [48, 142, 178],
  [120, 198, 121],
  [254, 221, 87],
  [244, 110, 50],
  [170, 20, 20],
]

/** 扫出要素集里 density 属性的峰值（无 density 属性返回 0）。 */
export function maxDensityOf(geo: FeatureCollection): number {
  let max = 0
  for (const f of geo.features) {
    const d = Number(f?.properties?.density)
    if (Number.isFinite(d) && d > max) max = d
  }
  return max
}

/** 蜂窝柱最大高度（米）：按图层 bbox 短边比例钳制 40–200m，避免大尺度失真。 */
export function hexHeightFor(bbox: [number, number, number, number] | null): number {
  if (!bbox) return 100
  const [w, s, e, n] = bbox
  const midLat = (s + n) / 2
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180)
  const mPerDegLat = 110540
  const short = Math.min((e - w) * mPerDegLon, (n - s) * mPerDegLat)
  return Math.max(40, Math.min(200, short * 0.02))
}

/** bbox 短边换算成米（局部米制，规避球面经纬度直接取样形变）。 */
function bboxMeters(bbox: [number, number, number, number] | null): { widthM: number; heightM: number } | null {
  if (!bbox) return null
  const [w, s, e, n] = bbox
  const midLat = (s + n) / 2
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180)
  const mPerDegLat = 110540
  return { widthM: Math.abs(e - w) * mPerDegLon, heightM: Math.abs(n - s) * mPerDegLat }
}

/** 六边形格距（米）：沿用 hex-bins 的「bbox 短边约 40 格」策略，缺 bbox 时给 8km 兜底。
 *  deck 的 radius = 六边形外接圆半径，相邻格心间距 = radius×√3，故在 pickHexSizeMeters 上除 √3 才对齐旧蜂窝密度。 */
export function hexRadiusFor(bbox: [number, number, number, number] | null): number {
  const m = bboxMeters(bbox)
  if (!m) return 8000
  return pickHexSizeMeters(m.widthM, m.heightM) / Math.sqrt(3)
}

/** 喂给 deck 聚合图层的点数量上限（超限均匀抽稀）。 */
export const MAX_DECK_POINTS = 150_000

/** 只留 Point 要素（聚合图层只吃点；非点直接跳过）。
 *  超 MAX_DECK_POINTS 均匀抽稀（每第 N 个取一个，确定性）：deck 聚合成本随点数近似线性，
 *  抽稀后聚合结果归一化，视觉几乎不变——这是放大缩小时卡顿/迟滞的最大来源。 */
function pointData(fc: FeatureCollection, cap = MAX_DECK_POINTS): Array<Feature<Point>> {
  const pts: Array<Feature<Point>> = []
  for (const f of fc.features) {
    if (f?.geometry?.type === 'Point') pts.push(f as Feature<Point>)
  }
  if (pts.length <= cap) return pts
  const step = Math.ceil(pts.length / cap)
  const out: Array<Feature<Point>> = []
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]!)
  return out
}

/** 点要素权重：要素带 density 用 density（可为 0），否则计 1（等价旧 hexbin 的密度求和/点数计数）。 */
function weightOf(f: Feature<Point>): number {
  const d = Number(f?.properties?.density)
  return Number.isFinite(d) ? d : 1
}

/** Point 要素取经纬度。 */
function pointPos(f: Feature<Point>): [number, number] {
  return f.geometry.coordinates as [number, number]
}

export function makeDeckLayer(spec: DeckLayerSpec): HeatmapLayer | HexagonLayer {
  return spec.mode === 'plane' ? makeHeatmapLayer(spec) : makeHexagonLayer(spec)
}

/** 平面热力图：deck HeatmapLayer（GPU 加权热力）。域留空自动归一化。 */
export function makeHeatmapLayer(spec: DeckLayerSpec): HeatmapLayer {
  return new HeatmapLayer({
    id: `deck-${spec.id}-plane`,
    data: pointData(spec.geojson),
    getPosition: pointPos,
    getWeight: weightOf,
    aggregation: 'SUM',
    radiusPixels: 40,
    intensity: 1,
    threshold: 0.05,
    // 性能：聚合权重图纹理降到 1024（默认 2048），debounce 降到 50ms（默认 500，放大后要等半秒才更新）。
    // 数据侧另有 MAX_DECK_POINTS 抽稀，三重压缩聚合成本换流畅缩放。
    weightsTextureSize: 1024,
    debounceTimeout: 50,
    colorRange: HEAT_RAMP,
    // 域留空自动：按实际聚合像素权重归一，颜色从蓝到红连续渐变。
    // 不要显式给 [0, maxDensity]——聚合权重（像素上 SUM）远超单要素 density，会把高密区压成单色。
    pickable: false,
    visible: spec.visible,
    opacity: 0.85,
  })
}

/** 蜂窝热力图：deck HexagonLayer（3D 六边形柱）。域留空自动归一化。 */
export function makeHexagonLayer(spec: DeckLayerSpec): HexagonLayer {
  const maxHeight = hexHeightFor(spec.bbox)
  return new HexagonLayer({
    id: `deck-${spec.id}-hex`,
    data: pointData(spec.geojson),
    getPosition: pointPos,
    getColorWeight: weightOf,
    getElevationWeight: weightOf,
    colorAggregation: 'SUM',
    elevationAggregation: 'SUM',
    radius: hexRadiusFor(spec.bbox),
    elevationRange: [0, maxHeight],
    colorRange: HEAT_RAMP,
    extruded: true,
    coverage: 0.9,
    // 域留空自动：deck 按实际聚合值算 [min,max]，既把柱高/颜色归一化到 elevationRange/colorRange，
    // 也保证没有格子被丢弃——显式域若小于密集区的聚合 SUM，shader 会把超界格子整格丢弃（图斑缺失）。
    pickable: false,
    visible: spec.visible,
    opacity: 0.82,
    material: { ambient: 0.35, diffuse: 0.6, shininess: 32, specularColor: [60, 60, 60] },
  })
}
