/**
 * deck.gl 出图图层构造：弧线图 / 轨迹图 / 围墙图 / 辐射图。
 *
 * 仅依赖 @deck.gl/layers + @deck.gl/geo-layers（不拉 aggregation-layers，热力图仍是 maplibre 原生）。
 * 图层由客户端 MapView 在 deck 模式下注册进 deck 注册表，本模块负责把「图层几何 + 出图参数」转成
 * deck Layer 实例（纯配置层，可 Node 直接单测）：
 *
 * - arc    弧线图：LineString 每段首尾点连弧（OD 流向），ArcLayer
 * - trips  轨迹图：LineString 全路径静态显示 + 白色高亮头点逐顶点移动，PathLayer + ScatterplotLayer×2
 * - wall   围墙图：面要素拉伸成 3D 半透明围栏/AOI 块（deck 9.3.11 无 WallLayer，用 PolygonLayer extruded 等效），
 *                  PolygonLayer
 * - radial 辐射图：点要素绕点画米制半径圆（影响范围），ScatterplotLayer
 *
 * 权重/半径/高度缺省都按图层 bbox 自动推算，用户/AI 可经 modeParams 覆盖（radius/height/width/speed/trail）。
 */
import { ArcLayer, PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson'

export type DeckChartMode = 'arc' | 'trips' | 'wall' | 'radial'

/** 一个 deck 出图层所需的最小规格（图层注册表摘要 + 客户端数据缓存 + 出图参数）。 */
export interface DeckChartSpec {
  /** 图层 id（与图层注册表一致）。 */
  id: string
  mode: DeckChartMode
  geojson: FeatureCollection
  bbox: [number, number, number, number] | null
  color: string
  visible: boolean
  /** 出图数值参数：radius=辐射半径米、height=围墙高米、width=线宽像素、speed/trail=轨迹动画。 */
  params?: Record<string, number>
}

/** #rrggbb / #rgb → [r, g, b]；非法输入回退默认橙红 #f97316（与 RESULT_COLORS[0] 一致）。 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  if (!Number.isFinite(n) || full.length !== 6) return [249, 115, 22]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** bbox 短边换算成米（局部米制，规避球面经纬度直接取样形变）。 */
function bboxShortMeters(bbox: [number, number, number, number] | null): number | null {
  if (!bbox) return null
  const [w, s, e, n] = bbox
  const midLat = (s + n) / 2
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180)
  const mPerDegLat = 110540
  return Math.min((e - w) * mPerDegLon, (n - s) * mPerDegLat)
}

// ---- 几何提取 ----

/** 坐标对是否有效（x/y 为有限数）。非法坐标（NaN/undefined）会让 deck 图层渲染抛错、中断 interleaved 帧。 */
function validPos(p: number[] | undefined | null): boolean {
  return !!p && Number.isFinite(p[0]) && Number.isFinite(p[1])
}

/** 只留 LineString / 展开 MultiLineString 成多条 LineString（弧线/轨迹吃线）；含非法坐标的线整条跳过。空/缺数据返回空数组。 */
function lineFeatures(fc: FeatureCollection | undefined | null): Feature<LineString>[] {
  const out: Feature<LineString>[] = []
  for (const f of fc?.features ?? []) {
    if (!f?.geometry) continue
    if (f.geometry.type === 'LineString') {
      if (f.geometry.coordinates.every((c) => validPos(c))) out.push(f as Feature<LineString>)
    } else if (f.geometry.type === 'MultiLineString') {
      for (const coords of f.geometry.coordinates) {
        if (coords.every((c) => validPos(c))) {
          out.push({ ...f, geometry: { type: 'LineString', coordinates: coords } } as Feature<LineString>)
        }
      }
    }
  }
  return out
}

/** 只留 Polygon / MultiPolygon（围墙吃面；getPolygon 原样喂 coordinates 即可处理两者）；含非法坐标的面整块跳过。空/缺数据返回空数组。 */
function polygonFeatures(fc: FeatureCollection | undefined | null): Feature<Polygon>[] {
  const out: Feature<Polygon>[] = []
  for (const f of fc?.features ?? []) {
    if (!f?.geometry) continue
    if (f.geometry.type === 'Polygon') {
      if (f.geometry.coordinates.every((ring) => ring.every((c) => validPos(c)))) out.push(f as unknown as Feature<Polygon>)
    } else if (f.geometry.type === 'MultiPolygon') {
      if (f.geometry.coordinates.every((poly) => poly.every((ring) => ring.every((c) => validPos(c))))) {
        out.push(f as unknown as Feature<Polygon>)
      }
    }
  }
  return out
}

/** 只留 Point（辐射吃点）；非法坐标的点跳过。空/缺数据返回空数组。 */
function pointFeatures(fc: FeatureCollection | undefined | null): Feature<Point>[] {
  const out: Feature<Point>[] = []
  for (const f of fc?.features ?? []) {
    if (f?.geometry?.type === 'Point' && validPos(f.geometry.coordinates)) out.push(f as Feature<Point>)
  }
  return out
}

// ---- 出图参数默认值 ----

/** 围墙高度（米）：bbox 短边比例钳制 40–500m（突出 AOI，比蜂窝柱略高）。 */
export function wallHeightFor(bbox: [number, number, number, number] | null, params?: Record<string, number>): number {
  if (params?.height) return params.height
  const short = bboxShortMeters(bbox)
  if (short == null) return 200
  return Math.max(40, Math.min(500, short * 0.05))
}

/** 辐射圆半径（米）：bbox 短边约 1/10（覆盖整个图层范围），可经 params.radius 覆盖。 */
export function radialRadiusFor(bbox: [number, number, number, number] | null, params?: Record<string, number>): number {
  if (params?.radius) return params.radius
  const short = bboxShortMeters(bbox)
  if (short == null) return 50000
  return Math.max(500, short / 10)
}

/** 轨迹 loopLength：所有轨迹的最大时间戳（缺时间属性时按顶点索引合成，等价路径长度-1）。 */
function tripsLoopLength(paths: Array<{ path: [number, number, number][]; timestamps: number[] }>): number {
  let max = 0
  for (const p of paths) max = Math.max(max, ...p.timestamps)
  return max > 0 ? max : 1
}

/** 轨迹动画相位（0~1，到 1 回绕）：tripsTime 为已流逝时间（秒，可无限增长），speed 为相位每秒增速。
 *  注意：tripsTime 必须在外部「持续累加、不取模」，这里才乘 speed 再取模——否则相位上限会被压成 speed，
 *  头点永远走不到终点就回绕（speed=0.1 时只走 10%）。 */
export function tripsProgress(tripsTime: number, speed = 0.1): number {
  return (tripsTime * speed) % 1
}

/** 从一条线的属性里取逐顶点时间戳：优先 timestamps/time/times 数组，缺省按索引合成。 */
function tripsOf(f: Feature<LineString>): { path: [number, number, number][]; timestamps: number[] } {
  const path = f.geometry.coordinates.map((c) => [c[0], c[1], 0] as [number, number, number])
  const tsProp = f.properties?.timestamps ?? f.properties?.time ?? f.properties?.times
  const timestamps = Array.isArray(tsProp) && tsProp.length === path.length
    ? tsProp.map(Number)
    : path.map((_, i) => i)
  return { path, timestamps }
}

// ---- 图层构造 ----

/** 弧线流量字段候选（opt-in：spec.params.flow 为真才启用映射，避免现有弧线图层因带 value/count 字段意外变色）。 */
const FLOW_FIELDS = ['flow', 'value', 'volume', 'count'] as const

/** 取一条线要素的流量值：命中候选字段且可解析为数值时返回该值，否则 NaN。 */
function flowOf(f: Feature<LineString>): number {
  for (const k of FLOW_FIELDS) {
    const v = f.properties?.[k]
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) return n
  }
  return NaN
}

/** 一批线要素的流量峰值；全缺失/全非正返回 0（调用方据此退化为常量样式）。 */
function maxFlowOf(data: Feature<LineString>[]): number {
  let max = 0
  for (const f of data) {
    const n = flowOf(f)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/** 弧线图：LineString 首点 → 末点连弧（OD 流向），颜色=图层色（起点实、终点透）。
 *  params.greatCircle 开启大圆（沿地球表面最短路径，OD 流向图标准画法）；
 *  params.flow 开启流量映射：线宽 1~1+width 像素、颜色深浅随 flow/value/volume/count 字段（缺省常量，兼容旧行为）。 */
function makeArcLayer(spec: DeckChartSpec): ArcLayer {
  const [r, g, b] = hexToRgb(spec.color)
  const data = lineFeatures(spec.geojson)
  const flowEnabled = Boolean(spec.params?.flow)
  const maxFlow = flowEnabled ? maxFlowOf(data) : 0
  // 流量映射需要字段有值；全缺失/全 0 时退化为常量（不崩、保持旧样式）。
  const useFlow = flowEnabled && maxFlow > 0
  const baseWidth = spec.params?.width ?? 2
  const peakWidth = spec.params?.width ?? 6
  return new ArcLayer({
    id: `deck-${spec.id}-arc`,
    data,
    getSourcePosition: (f) => f.geometry.coordinates[0] as [number, number],
    getTargetPosition: (f) => f.geometry.coordinates[f.geometry.coordinates.length - 1] as [number, number],
    getSourceColor: useFlow
      ? (f: Feature<LineString>) => [r, g, b, 150 + Math.round((flowOf(f) / maxFlow) * 105)]
      : [r, g, b, 220],
    getTargetColor: useFlow
      ? (f: Feature<LineString>) => [r, g, b, 60 + Math.round((flowOf(f) / maxFlow) * 90)]
      : [r, g, b, 110],
    getWidth: useFlow
      ? (f: Feature<LineString>) => 1 + (flowOf(f) / maxFlow) * peakWidth
      : baseWidth,
    widthUnits: 'pixels',
    greatCircle: Boolean(spec.params?.greatCircle),
    visible: spec.visible,
    pickable: false,
  })
}

/** 当前时间戳下轨迹头的位置：在路径顶点间按时间插值，与 TripsLayer 的头部同步。 */
function headPosition(trip: { path: [number, number, number][]; timestamps: number[] }, t: number): [number, number] {
  const { path, timestamps } = trip
  if (path.length === 0) return [0, 0]
  if (t <= timestamps[0]!) return [path[0]![0], path[0]![1]]
  const last = timestamps.length - 1
  if (t >= timestamps[last]!) return [path[last]![0], path[last]![1]]
  for (let i = 0; i < last; i++) {
    const t0 = timestamps[i]!
    const t1 = timestamps[i + 1]!
    if (t >= t0 && t < t1) {
      const k = (t - t0) / (t1 - t0)
      const a = path[i]!
      const b = path[i + 1]!
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]
    }
  }
  return [path[last]![0], path[last]![1]]
}

/** 轨迹图：整条路径静态显示（PathLayer 输出全 polyline，起点→终点一眼可见），
 *  白色高亮头点从起点缓缓走到终点（ScatterplotLayer 光晕+核心两层）。
 *  头点进度由客户端 rAF 推进（0~1 归一化），currentTime = progress * loopLength（与 getTimestamps 同尺度）。 */
function makeTripsLayer(spec: DeckChartSpec, progress: number): Layer[] {
  const [r, g, b] = hexToRgb(spec.color)
  const trips = lineFeatures(spec.geojson).map(tripsOf)
  const loopLength = tripsLoopLength(trips)
  const currentTime = progress * loopLength
  // 全路径静态连线（不再做拖尾动画）：整条起→终默认就显示，轨迹点只在线上移动。
  const path = new PathLayer({
    id: `deck-${spec.id}-trips-path`,
    data: trips,
    getPath: (d) => d.path,
    getColor: [r, g, b, 200],
    widthUnits: 'pixels',
    getWidth: spec.params?.width ?? 3,
    visible: spec.visible,
    pickable: false,
  })
  // 白色高亮头点：同一 progress 下插值当前位置，光晕 + 核心两层叠出「高亮」效果。
  const heads = trips.map((t) => ({ position: headPosition(t, currentTime) }))
  const halo = new ScatterplotLayer({
    id: `deck-${spec.id}-trips-head-halo`,
    data: heads,
    getPosition: (d: { position: [number, number] }) => d.position,
    getRadius: 12,
    radiusUnits: 'pixels',
    getFillColor: [255, 255, 255, 60],
    visible: spec.visible,
    pickable: false,
  })
  const core = new ScatterplotLayer({
    id: `deck-${spec.id}-trips-head`,
    data: heads,
    getPosition: (d: { position: [number, number] }) => d.position,
    getRadius: 5,
    radiusUnits: 'pixels',
    getFillColor: [255, 255, 255, 255],
    visible: spec.visible,
    pickable: false,
  })
  return [path, halo, core]
}

/** 围墙图：面要素拉伸成 3D 半透明围栏（deck 9.3.11 无 WallLayer，PolygonLayer extruded 等效 AOI 块）。
 *  高度可经 params.height 覆盖；描边宽可经 params.width（像素）覆盖，缺省 2。 */
function makeWallLayer(spec: DeckChartSpec): PolygonLayer {
  const [r, g, b] = hexToRgb(spec.color)
  const height = wallHeightFor(spec.bbox, spec.params)
  return new PolygonLayer({
    id: `deck-${spec.id}-wall`,
    data: polygonFeatures(spec.geojson),
    getPolygon: (f) => f.geometry.coordinates,
    extruded: true,
    wireframe: false,
    getElevation: height,
    getFillColor: [r, g, b, 130],
    getLineColor: [r, g, b, 255],
    lineWidthMinPixels: spec.params?.width ?? 2,
    stroked: true,
    opacity: 0.85,
    visible: spec.visible,
    pickable: false,
  })
}

/** 辐射图：点要素绕点画米制半径圆（影响范围），fill 透 + stroke 实，半径可经 params.radius 覆盖。 */
function makeRadialLayer(spec: DeckChartSpec): ScatterplotLayer {
  const [r, g, b] = hexToRgb(spec.color)
  const radius = radialRadiusFor(spec.bbox, spec.params)
  return new ScatterplotLayer({
    id: `deck-${spec.id}-radial`,
    data: pointFeatures(spec.geojson),
    getPosition: (f) => f.geometry.coordinates as [number, number],
    getRadius: radius,
    radiusUnits: 'meters',
    filled: true,
    stroked: true,
    getFillColor: [r, g, b, 55],
    getLineColor: [r, g, b, 230],
    lineWidthMinPixels: 2,
    visible: spec.visible,
    pickable: false,
  })
}

/** 按 mode 分发出图图层。trips 需要外部传入当前动画进度（客户端 rAF 推进）。 */
export function makeDeckChartLayers(spec: DeckChartSpec, currentTime = 0): Layer[] {
  switch (spec.mode) {
    case 'arc':
      return [makeArcLayer(spec)]
    case 'trips':
      return makeTripsLayer(spec, currentTime)
    case 'wall':
      return [makeWallLayer(spec)]
    case 'radial':
      return [makeRadialLayer(spec)]
  }
}
