/**
 * maplibre 渲染规格：几何→图层类型、填充/描边/点样式、热力与蜂窝层、
 * supercluster 聚合圆/数字层，以及图层 id/source 命名与「内容形态」签名。
 * 自 MapView.tsx 拆分。
 */
import type { ExpressionSpecification, FilterSpecification, LayerSpecification } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import type { DisplayMode, LayerSummary } from './gis-types.js'

export type RenderKind = 'fill' | 'line' | 'circle'

/** 按几何类型决定该图层渲染哪几类 maplibre layer。 */
export function renderKinds(types: string[]): RenderKind[] {
  const k: RenderKind[] = []
  if (types.some((t) => t.includes('Polygon'))) k.push('fill')
  if (types.some((t) => t.includes('LineString'))) k.push('line')
  if (types.some((t) => t.includes('Point'))) k.push('circle')
  return k.length > 0 ? k : ['circle']
}

/** 渲染样式（color 为整体底色；fillColor 覆盖填充、pointRadius/strokeWidth 控制点位大小与描边）。 */
export interface RenderStyle {
  color: string
  pointRadius?: number
  pointStrokeWidth?: number
  fillColor?: string
}

/** 渲染一个普通要素层；聚合模式下 circle 层带 filter 排除聚合点（!has point_count）。
 *  fill 层填充=fillColor??color、边界=color；circle 层填充=fillColor??color、描边=color。 */
export function makeRenderLayer(id: string, srcId: string, kind: RenderKind, style: RenderStyle, filter?: FilterSpecification): LayerSpecification {
  const base = filter ? { filter } : {}
  if (kind === 'fill') {
    return { ...base, id, type: 'fill', source: srcId, paint: { 'fill-color': style.fillColor ?? style.color, 'fill-opacity': 0.45, 'fill-outline-color': style.color } }
  }
  if (kind === 'line') {
    return { ...base, id, type: 'line', source: srcId, paint: { 'line-color': style.color, 'line-width': 2 } }
  }
  return { ...base, id, type: 'circle', source: srcId, paint: {
    'circle-color': style.fillColor ?? style.color,
    'circle-radius': style.pointRadius ?? 2,
    'circle-stroke-width': style.pointStrokeWidth ?? 1,
    'circle-stroke-color': style.color,
  } }
}

/** 简单压暗十六进制色（f 比例 <1 更暗）；非法输入原样返回。供面图层外轮廓与填充色区分（同色时边界不可见）。 */
export function darkenHex(hex: string, f = 0.55): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return hex
  const n = parseInt(m[1]!, 16)
  const r = Math.round(((n >> 16) & 255) * f)
  const g = Math.round(((n >> 8) & 255) * f)
  const b = Math.round((n & 255) * f)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

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

/** 平面热力图：maplibre 原生 heatmap 层。weight 按 density 归一化到 [0,1]；无 density 则按点数计数（weight=1）。 */
export function makeHeatLayer(id: string, srcId: string, maxDensity: number): LayerSpecification {
  const weight: ExpressionSpecification | number = maxDensity > 0
    ? ['case', ['has', 'density'],
        ['interpolate', ['linear'], ['get', 'density'], 0, 0, maxDensity, 1],
        1]
    : 1
  return {
    id,
    type: 'heatmap',
    source: srcId,
    paint: {
      'heatmap-weight': weight,
      'heatmap-intensity': 1,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'],
        0, 'rgba(0, 0, 0, 0)',
        0.1, 'rgba(35, 74, 135, 0.55)',
        0.3, 'rgb(48, 142, 178)',
        0.5, 'rgb(120, 198, 121)',
        0.7, 'rgb(254, 221, 87)',
        0.9, 'rgb(244, 110, 50)',
        1, 'rgb(170, 20, 20)'] as ExpressionSpecification,
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 10, 6, 20, 12, 34] as ExpressionSpecification,
      'heatmap-opacity': 0.85,
    },
  }
}

/** 蜂窝热力图：六边形柱（fill-extrusion），柱高=density 归一化×maxHeight，颜色热色带。 */
export function makeHexLayer(id: string, srcId: string, maxDensity: number, maxHeight: number): LayerSpecification {
  const h = maxDensity > 0 ? maxHeight : 0
  return {
    id,
    type: 'fill-extrusion',
    source: srcId,
    paint: {
      'fill-extrusion-color': maxDensity > 0
        ? ['interpolate', ['linear'], ['get', 'density'],
            0, '#234a87', maxDensity * 0.25, '#308eb2', maxDensity * 0.5, '#78c679',
            maxDensity * 0.75, '#fedd57', maxDensity, '#f06e32'] as ExpressionSpecification
        : '#234a87',
      'fill-extrusion-height': maxDensity > 0
        ? ['interpolate', ['linear'], ['get', 'density'], 0, 0, maxDensity, h] as ExpressionSpecification
        : 0,
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.82,
      'fill-extrusion-vertical-gradient': false,
    },
  }
}

/** 聚合圈最大半径（px），随数量增长。 */
export const CLUSTER_BASE_RADIUS: Array<[number, number]> = [
  [0, 34], [100, 46], [1000, 60], [10000, 74], [100000, 92],
]

/** 把 #rrggbb 往白色（percent>0）或黑色（percent<0）方向调亮/调暗，用于生成加深色阶。 */
export function shadeColor(hex: string, percent: number): string {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const num = parseInt(full, 16)
  if (!Number.isFinite(num) || full.length !== 6) return hex
  const amt = Math.round(2.55 * percent)
  const r = Math.min(255, Math.max(0, (num >> 16) + amt))
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amt))
  const b = Math.min(255, Math.max(0, (num & 0xff) + amt))
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`
}

/** 圈色：以图层基色为基准，数量越大颜色越深（浅色 → 基色 → 深色）。 */
export function clusterColorFor(base: string): ExpressionSpecification {
  const stops: Array<[number, string]> = [
    [0, shadeColor(base, 42)],
    [10, shadeColor(base, 20)],
    [100, base],
    [1000, shadeColor(base, -22)],
    [10000, shadeColor(base, -45)],
  ]
  return ['interpolate', ['linear'], ['get', 'point_count'], ...stops.flat()] as ExpressionSpecification
}

/** 圈半径：按 point_count 插值（数量越大圈越大）。 */
export function clusterRadius(): ExpressionSpecification {
  return ['interpolate', ['linear'], ['get', 'point_count'], ...CLUSTER_BASE_RADIUS.flat()] as ExpressionSpecification
}

/** supercluster 聚合圈：单层 circle + circle-blur 羽化边缘（内发光），点击放大（见 click handler）。 */
export function makeClusterLayer(id: string, srcId: string, color: string): LayerSpecification {
  return {
    id,
    type: 'circle',
    source: srcId,
    filter: ['has', 'point_count'],
    paint: {
      'circle-color': clusterColorFor(color),
      'circle-radius': clusterRadius(),
      'circle-blur': 1,
    },
  }
}

/** 聚合圈中心数字：官方 supercluster 模式（symbol + text-field 取 point_count_abbreviated，如 1.2k）。 */
export function makeClusterCountLayer(id: string, srcId: string): LayerSpecification {
  return {
    id,
    type: 'symbol',
    source: srcId,
    filter: ['has', 'point_count'],
    layout: {
      'text-field': ['get', 'point_count_abbreviated'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['get', 'point_count'], 0, 12, 1000, 14, 100000, 18],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0, 0, 0, 0.55)',
      'text-halo-width': 1.5,
    },
  }
}

export const LAYER_KINDS: RenderKind[] = ['fill', 'line', 'circle']

/** 一个图层的全部可能渲染层后缀（普通 fill/line/circle + 聚合 + 平面热力 heat + 蜂窝 hex + 面描边 outline）。 */
export const ALL_RENDER_SUFFIXES: string[] = [...LAYER_KINDS, 'cluster', 'cluster-count', 'heat', 'hex', 'outline']

/** 渲染轻量 GeoJSON（/webgis/layer-render）每个要素自带的键：稳定行号（= layer.geojson.features 下标）与所属图层 id。 */
export const RENDER_ROW_KEY = '__i'

export const RENDER_LAYER_KEY = '__layer'

/** deck.gl 出图的展示方式（弧线/轨迹/围墙/辐射）；这些模式走 deck 注册表渲染，不建 maplibre 层。 */
export const DECK_MODES: ReadonlySet<DisplayMode> = new Set(['arc', 'trips', 'wall', 'radial'])

export const SRC = (id: string) => `gis-${id}`

export const RID = (id: string, kind: string) => `gis-${id}-${kind}`

/** 蜂窝归并结果专用 source（与原图层 source 分开，避免污染 points 数据）。 */
export const SRC_HEX = (id: string) => `gis-${id}-hex`

/** 图层“内容形态”签名：rev 之外的渲染关键属性变化也驱动重建（同 id 换数据集/几何形态/渲染器时兜底）。
 *  若不比较这些，换 dataset 时 rev 都归 0、颜色样式又恰好相同 → 变更判定 miss、旧层残留新数据不拉。 */
export function layerShapeKey(s: {
  geometryTypes?: string[]; renderer?: string; dataFormat?: string; name?: string; source?: string
}): string {
  return JSON.stringify({ gt: s.geometryTypes, ren: s.renderer, df: s.dataFormat, name: s.name, src: s.source })
}
