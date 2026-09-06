/**
 * gis 懒 chunk 入口（进 GIS 模式才 load）：地图核心 = maplibre + MapView 及地图 UI 全家。
 * 首次执行时注入 maplibre 样式表（此前在 shell index.tsx 无条件注入，现在挪到这——
 * 不进 GIS 就不拉 maplibre css）。host 白名单路由提供 /webgis/maplibre-gl.css。
 */
import { registerChunk } from '../chunk-loader.js'
import { MapView } from '../MapView.js'

/** 注入 maplibre 样式表（host 白名单路由提供；幂等去重）。 */
function ensureMaplibreStyles(): void {
  if (document.querySelector('link[data-webgis-css]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = '/webgis/maplibre-gl.css'
  link.dataset.webgisCss = ''
  document.head.appendChild(link)
}
ensureMaplibreStyles()

const gisApi = { MapView }
registerChunk('gis', gisApi)
export { MapView }
export default gisApi
