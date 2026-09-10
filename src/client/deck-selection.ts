/**
 * 点选高亮的 **deck.gl 侧**实现，视觉与 maplibre 侧 `map-highlight.ts` 的 gis-sel 对齐：
 * 面 = 蓝色半透明填充 + 深蓝粗框线；线 = 深蓝粗线；点 = 蓝色圆点（无顶点小圆点）。
 *
 * 为什么 deck 也要单独有一份：
 * maplibre 的 `moveLayer` 只能调整 **maplibre 自己的** 图层顺序；deck 图层画在 MapboxOverlay 的
 * group 自定义层里（deck.gl 的 `resolveLayerGroups` 在 group 不存在时会 `map.addLayer` 补一个，
 * 补出来的 group 直接落在栈顶），一旦它压在 gis-sel 之上，maplibre 侧怎么置顶都盖不回来 ——
 * 表现就是「高亮面被原图层盖住」。
 * 因此：点中的要素由哪个渲染器画，就交给哪个渲染器高亮（maplibre 命中 → gis-sel；deck 命中 → 本模块）。
 */
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'

/** 高亮配色（与 map-highlight.ts 保持一致，改一处要两处一起改）。 */
const FILL: [number, number, number, number] = [59, 130, 246, 128]
const LINE: [number, number, number, number] = [30, 58, 138, 255]
const DOT: [number, number, number, number] = [37, 99, 235, 217]

const LINE_WIDTH = 3.5
const DOT_RADIUS = 7

type Geom = { type?: string; coordinates?: unknown }

/** 单个要素几何 → deck 高亮层（null / 未知几何 / 非法坐标返回空数组，调用方据此跳过）。 */
export function makeSelectionLayers(geometry: unknown): Layer[] {
  if (!geometry || typeof geometry !== 'object') return []
  const { type, coordinates } = geometry as Geom
  const common = { id: 'gis-sel', pickable: false, visible: true }
  if (type === 'Point' || type === 'MultiPoint') {
    const positions = type === 'Point' ? [coordinates] : coordinates
    if (!Array.isArray(positions) || positions.length === 0) return []
    return [new ScatterplotLayer({
      ...common,
      data: positions as Array<[number, number]>,
      getPosition: (p) => p,
      getFillColor: DOT,
      getLineColor: LINE,
      stroked: true,
      getLineWidth: 2.5,
      lineWidthUnits: 'pixels',
      getRadius: DOT_RADIUS,
      radiusUnits: 'pixels',
      // 与 maplibre circle 层同语义：半径按像素，最小 7px（缩小时也看得见）
      radiusMinPixels: DOT_RADIUS,
    })]
  }
  if (type === 'LineString') {
    if (!Array.isArray(coordinates) || coordinates.length < 2) return []
    return [new PathLayer({
      ...common,
      data: [coordinates] as Array<Array<[number, number]>>,
      getPath: (p) => p,
      getColor: LINE,
      getWidth: LINE_WIDTH,
      widthUnits: 'pixels',
      widthMinPixels: LINE_WIDTH,
    })]
  }
  if (type === 'MultiLineString') {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return []
    return [new PathLayer({
      ...common,
      data: coordinates as Array<Array<[number, number]>>,
      getPath: (p) => p,
      getColor: LINE,
      getWidth: LINE_WIDTH,
      widthUnits: 'pixels',
      widthMinPixels: LINE_WIDTH,
    })]
  }
  if (type === 'Polygon') {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return []
    return [makePolygonLayer([coordinates as Array<Array<[number, number]>>])]
  }
  if (type === 'MultiPolygon') {
    if (!Array.isArray(coordinates) || coordinates.length === 0) return []
    return [makePolygonLayer(coordinates as Array<Array<Array<[number, number]>>>)]
  }
  return []
}

/** 面高亮：蓝色半透明填充 + 深蓝粗框线（data 为「多边形数组」，即 Polygon 的 coordinates 直接当一项）。 */
function makePolygonLayer(data: Array<Array<Array<[number, number]>>>): Layer {
  return new PolygonLayer({
    id: 'gis-sel',
    pickable: false,
    visible: true,
    data,
    getPolygon: (p) => p,
    filled: true,
    stroked: true,
    getFillColor: FILL,
    getLineColor: LINE,
    getLineWidth: LINE_WIDTH,
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: LINE_WIDTH,
  })
}
