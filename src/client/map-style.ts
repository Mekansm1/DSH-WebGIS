/**
 * 应用底图切换：光栅换瓦片 / 光栅重载样式 / 矢量样式整替换。
 * 所有 setStyle 一律 { diff: false } 强制整样式重建：
 * maplibre 对「已存在样式」默认走 smart-diff(_diffStyle)，从自定义小光栅样式 diff 成 Carto/OpenFreeMap
 * 这类大型异构矢量样式时，矢量源被建但**层不重绘**（瓦片拉取解析正常却不显示，只剩背景灰底；
 * 复现页 B 组「新建地图」正常即 diff:false = _updateStyle 全量重建 = 同一路径）。
 * 矢量样式按 **URL 字符串** setStyle（不经页面 fetch/style 对象）：与「新建地图」同款，由 maplibre 内部拉取，
 * 规避 DSH 页面 CSP 对跨域 fetch 的限制；不覆写 glyphs——矢量底图自带 Carto/OpenFreeMap 字体端点
 * （demotiles 字体并不含数据层聚合圈要用的 Noto Sans Regular，原覆写反而有缺字形风险）。
 */
export async function applyBaseMap(map: MapLibreMap, def: BaseMapDef, defaultTiles: string[]): Promise<void> {
  const url = def.kind === 'raster' && !def.url ? (defaultTiles[0] ?? '') : def.url
  const action = baseMapAction({ ...def, url }, map.getSource('base') != null)
  if (action.kind === 'setTiles') {
    ;(map.getSource('base') as RasterTileSource | undefined)?.setTiles([action.url])
    return
  }
  if (action.kind === 'setStyleRaster') {
    map.setStyle(baseStyle([action.url]), { diff: false })
    return
  }
  map.setStyle(action.url, { diff: false })
}

/**
 * 地图样式与常驻源/层：初始底图样式、data/测量层补齐、底图服务（WMTS/WMS/XYZ）同步。
 * 自 MapView.tsx 拆分。
 */
import type { LayerSpecification, Map as MapLibreMap, RasterTileSource, StyleSpecification } from 'maplibre-gl'
import { baseMapAction, type BaseMapDef } from '../basemaps.js'
import type { OverlayService } from '../webgis-services.js'

export const EMPTY_COLLECTION = { type: 'FeatureCollection' as const, features: [] as never[] }

/** 初始化底图样式：栅格底图 + 数据图层。glyphs 供 symbol 文本（如聚合圈数字）渲染字形。 */
export function baseStyle(tiles: string[]): StyleSpecification {
  return {
    version: 8,
    glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
    sources: {
      base: { type: 'raster', tiles, tileSize: 256 },
      data: { type: 'geojson', data: EMPTY_COLLECTION as never },
    },
    layers: [
      { id: 'base', type: 'raster', source: 'base' },
      {
        id: 'data-points',
        type: 'circle',
        source: 'data',
        paint: {
          'circle-color': '#3b82f6',
          'circle-radius': 2,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      },
    ],
  }
}

/** 视窗范围坐标小数位随 zoom 自适应：低倍省字符，高倍保精度（≥12 → 4 位，9+ → 3 位，6+ → 2 位，否则 1 位）。 */
export function fmtCoord(v: number, zoom: number): string {
  const d = zoom >= 12 ? 4 : zoom >= 9 ? 3 : zoom >= 6 ? 2 : 1
  const f = Math.round(v * 10 ** d) / 10 ** d
  return Object.is(f, -0) ? '0' : String(f)
}

/** 保证 data geojson 源 + data-points 图层存在（换过整套样式后按需补挂）。 */
export function ensureDataLayers(map: MapLibreMap): void {
  if (map.getLayer('data-points')) return
  if (!map.getSource('data')) map.addSource('data', { type: 'geojson', data: EMPTY_COLLECTION as never })
  map.addLayer({
    id: 'data-points',
    type: 'circle',
    source: 'data',
    paint: { 'circle-color': '#3b82f6', 'circle-radius': 2, 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
  })
}

/** 测量渲染层：闭合面填充 / 线 / 顶点 / 预览（常驻；data 为空则不可见）。style 整重建后由 ensure 重新补齐。 */
export function ensureMeasureLayers(map: MapLibreMap): void {
  if (map.getSource('measure')) return
  map.addSource('measure', { type: 'geojson', data: EMPTY_COLLECTION as never })
  map.addSource('measure-hover', { type: 'geojson', data: EMPTY_COLLECTION as never })
  // 闭合为面时的半透明填充（放最底下，line 描边叠在上）
  const fill: LayerSpecification = {
    id: 'measure-fill', type: 'fill', source: 'measure',
    paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.18 },
  }
  map.addLayer(fill)
  const line: LayerSpecification = {
    id: 'measure-line', type: 'line', source: 'measure',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f59e0b', 'line-width': 2.5 },
  }
  map.addLayer(line)
  const vertex: LayerSpecification = {
    id: 'measure-vertex', type: 'circle', source: 'measure',
    paint: { 'circle-radius': 4, 'circle-color': '#ffffff', 'circle-stroke-width': 2, 'circle-stroke-color': '#f59e0b' },
  }
  map.addLayer(vertex)
  const hover: LayerSpecification = {
    id: 'measure-hover-line', type: 'line', source: 'measure-hover',
    paint: { 'line-color': '#f59e0b', 'line-width': 1.5, 'line-dasharray': [2, 2] },
  }
  map.addLayer(hover)
  // 吸附目标高亮圆环（measure-hover 源里的 Point 特征，吸附时可见）
  const hoverVertex: LayerSpecification = {
    id: 'measure-hover-vertex', type: 'circle', source: 'measure-hover',
    paint: { 'circle-radius': 7, 'circle-color': 'rgba(255,255,255,0.4)', 'circle-stroke-width': 3, 'circle-stroke-color': '#f97316' },
  }
  map.addLayer(hoverVertex)
}

/** 同步叠加地图服务（WMTS/WMS/XYZ 光栅层）：加缺、换 URL、切可见性、移除已删。插在 data-points 之下。 */
export function syncOverlays(map: MapLibreMap, services: OverlayService[]): void {
  const seen = new Set<string>()
  for (const svc of services) {
    seen.add(svc.id)
    const srcId = `overlay-src-${svc.id}`
    const layerId = `overlay-${svc.id}`
    const src = map.getSource(srcId) as RasterTileSource | undefined
    if (!src) map.addSource(srcId, { type: 'raster', tiles: [svc.url], tileSize: svc.tileSize ?? 256 })
    else if (src.tiles && src.tiles[0] !== svc.url) src.setTiles([svc.url])
    if (!map.getLayer(layerId)) {
      if (map.getLayer('data-points')) map.addLayer({ id: layerId, type: 'raster', source: srcId }, 'data-points')
      else map.addLayer({ id: layerId, type: 'raster', source: srcId })
    }
    map.setLayoutProperty(layerId, 'visibility', svc.visible ? 'visible' : 'none')
  }
  // 移除已不存在的叠加层
  for (const l of [...(map.getStyle()?.layers ?? [])]) {
    if (!l.id.startsWith('overlay-')) continue
    const id = l.id.slice('overlay-'.length)
    if (seen.has(id)) continue
    if (map.getLayer(l.id)) map.removeLayer(l.id)
    if (map.getSource(`overlay-src-${id}`)) map.removeSource(`overlay-src-${id}`)
  }
}
