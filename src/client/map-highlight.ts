/**
 * 点击地块高亮：独立的 gis-sel 源 + 面填充 / 粗描边 / 光晕 / 点圆点四层（样式重建后被清则下次点选重建）。
 * 自 MapView.tsx 拆分。
 *
 * 配色（统一深蓝系）：面 = 蓝色半透明填充 + 深蓝粗框线；线 = 深蓝粗线；点 = 蓝色圆点。
 *
 * 可见性要点（踩过的坑）：
 * - 每次点选都把这几层 `moveLayer` 到最顶：高亮层创建得早、之后新增数据层/切底图重建都会盖在它上面，
 *   不置顶就会出现「面点选看不出高亮」。
 * - 描边用「半透明粗光晕 + 深蓝主线」双层：单层细线压在道路/边界上对比不足，看着很淡。
 * - 圆点层必须按几何类型过滤（只画 Point/MultiPoint）。否则 maplibre 会在面（质心）上也画圆点，
 *   点选面/线时满屏顶点小圆点 —— 这是之前出现过的回归。
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { EMPTY_COLLECTION } from './map-style.js'

export const SEL_SRC = 'gis-sel'
/** 高亮配色：深蓝主线 + 蓝色填充（与底图对比强，且不会被误认成数据本身的配色）。 */
const SEL_LINE = '#1e3a8a'
const SEL_FILL = '#3b82f6'
const SEL_DOT = '#2563eb'

/** 四层自下而上：填充 → 光晕描边 → 主线 → 点圆点。 */
const SEL_LAYERS: Array<{
  id: string
  type: 'fill' | 'line' | 'circle'
  paint: Record<string, unknown>
  filter?: unknown
}> = [
  {
    id: `${SEL_SRC}-fill`,
    type: 'fill',
    paint: { 'fill-color': SEL_FILL, 'fill-opacity': 0.5 },
    // 只对面填充（线要素 fill 层不绘制，但显式过滤更明确）
    filter: ['==', ['geometry-type'], 'Polygon'],
  },
  { id: `${SEL_SRC}-halo`, type: 'line', paint: { 'line-color': SEL_LINE, 'line-width': 7, 'line-opacity': 0.3 } },
  { id: `${SEL_SRC}-line`, type: 'line', paint: { 'line-color': SEL_LINE, 'line-width': 3.5 } },
  {
    id: `${SEL_SRC}-dot`,
    type: 'circle',
    paint: {
      'circle-color': SEL_DOT,
      'circle-radius': 7,
      'circle-opacity': 0.85,
      'circle-stroke-width': 2.5,
      'circle-stroke-color': SEL_LINE,
    },
    // 关键：只对点几何生效，线/面点选不出现顶点小圆点
    filter: ['==', ['geometry-type'], 'Point'],
  },
]

/**
 * 是否为「点击高亮自身」的图层。
 *
 * ⚠️ 高亮层是**参与渲染但不该被拾取**的：它们被主动置顶（否则会被数据层盖住），
 * 而 `queryRenderedFeatures` 返回的第一条就是最上层 —— 于是上一次点击的高亮图形
 * 会抢走下一次点击的 `topPayload`。它的 properties 是空的（只是个几何壳），
 * 结果就是「同一个图斑点第二次显示无属性字段」。
 * 所有拾取入口都要用它过滤。
 */
export function isSelectionLayerId(id: string | undefined): boolean {
  return typeof id === 'string' && (id === SEL_SRC || id.startsWith(`${SEL_SRC}-`))
}

/** 确保高亮源/层存在（缺哪层补哪层），并把 paint 同步成当前配色（便于热更新/旧图层复用）。 */
export function ensureSelLayers(map: MapLibreMap): void {
  if (!map.getSource(SEL_SRC)) map.addSource(SEL_SRC, { type: 'geojson', data: EMPTY_COLLECTION as never })
  for (const l of SEL_LAYERS) {
    if (map.getLayer(l.id)) {
      // 已存在（热重载 / 本次点选第二个要素）：把配色和过滤刷成最新，避免留着旧琥珀色
      for (const [k, v] of Object.entries(l.paint)) {
        try { map.setPaintProperty(l.id, k, v as never) } catch { /* 属性不存在于该 map 版本：忽略 */ }
      }
      try { map.setFilter(l.id, (l.filter ?? null) as never) } catch { /* 忽略 */ }
      continue
    }
    map.addLayer({
      id: l.id,
      type: l.type,
      source: SEL_SRC,
      ...(l.filter ? { filter: l.filter } : {}),
      paint: l.paint,
    } as never)
  }
}

/** 把高亮层整体置顶（新增数据层 / 切底图重建后会盖住它们）。供图层同步流程复用。 */
export function bringMapSelectionToTop(map: MapLibreMap): void {
  for (const l of SEL_LAYERS) {
    if (map.getLayer(l.id)) {
      try { map.moveLayer(l.id) } catch { /* 样式未就绪：忽略 */ }
    }
  }
}

/** 清除选中高亮（空源即可，层留着复用）。 */
export function clearMapSelection(map: MapLibreMap): void {
  const src = map.getSource(SEL_SRC) as GeoJSONSource | undefined
  if (src) src.setData(EMPTY_COLLECTION as never)
}

/** 把某要素几何画成高亮（面填充、线/面描边、点圆点；空 geometry 清除）。 */
export function setMapSelection(map: MapLibreMap, geometry: unknown): void {
  ensureSelLayers(map)
  const src = map.getSource(SEL_SRC) as GeoJSONSource | undefined
  src?.setData({
    type: 'FeatureCollection',
    features: geometry
      ? [{ type: 'Feature', properties: {}, geometry: geometry as never }]
      : [],
  } as never)
  bringMapSelectionToTop(map)
}
