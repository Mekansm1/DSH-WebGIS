/**
 * 点击地块高亮：独立的 gis-sel 源 + 填充/描边层（样式重建后被清则下次点选重建）。
 * 自 MapView.tsx 拆分。
 */
import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl'
import { EMPTY_COLLECTION } from './map-style.js'

export const SEL_SRC = 'gis-sel'

export function ensureSelLayers(map: MapLibreMap): void {
  if (map.getSource(SEL_SRC)) return
  map.addSource(SEL_SRC, { type: 'geojson', data: EMPTY_COLLECTION as never })
  // 点选图斑：整块半透明填充 + 围栏描边；不画坐标点/顶点圆点。
  map.addLayer({
    id: `${SEL_SRC}-fill`, type: 'fill', source: SEL_SRC,
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.4, 'fill-outline-color': '#b45309' },
  })
  map.addLayer({
    id: `${SEL_SRC}-line`, type: 'line', source: SEL_SRC,
    paint: { 'line-color': '#b45309', 'line-width': 2 },
  })
}

/** 清除选中高亮（空源即可，层留着复用）。 */
export function clearMapSelection(map: MapLibreMap): void {
  const src = map.getSource(SEL_SRC) as GeoJSONSource | undefined
  if (src) src.setData(EMPTY_COLLECTION as never)
}

/** 把某要素几何画成高亮（fill 画面、line 画线、dot 画点；空 geometry 清除）。 */
export function setMapSelection(map: MapLibreMap, geometry: unknown): void {
  ensureSelLayers(map)
  const src = map.getSource(SEL_SRC) as GeoJSONSource | undefined
  src?.setData({
    type: 'FeatureCollection',
    features: geometry
      ? [{ type: 'Feature', properties: {}, geometry: geometry as never }]
      : [],
  } as never)
}
