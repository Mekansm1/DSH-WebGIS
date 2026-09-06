import { useEffect, useRef, useState, type ComponentType } from 'react'
import maplibregl from 'maplibre-gl'
import type { ExpressionSpecification, FilterSpecification, GeoJSONSource, LayerSpecification, Map as MapLibreMap, Point, RasterTileSource, StyleSpecification } from 'maplibre-gl'
import styles from './webgis.module.css'
import { LayerPanel } from './LayerPanel.js'
import { AttributeDrawer } from './AttributeDrawer.js'
import type { ExportPrefill } from './ExportMapDialog.js'
import type { WebgisT } from './webgis-i18n.js'
import { ensure } from './chunk-loader.js'
import { sessionUrl } from './sessionUrl.js'
import { BASE_MAPS, baseMapAction, type BaseMapDef } from '../basemaps.js'
import type { OverlayService } from '../webgis-services.js'
import { BasemapSwitcher } from './BasemapSwitcher.js'
import { hexbinFC } from './hex-bins.js'
import type { DeckController, DeckControllerHost } from './deck/controller.js'
import type { DeckChartMode } from './deck-charts.js'
import { geojsonKindOf, rawLineData, rawPointData, rawPolygonData } from './geoarrow-utils.js'
import type { DisplayMode, FeaturePayload, LayerSummary } from './gis-types.js'
import type { FeatureCollection } from 'geojson'

interface StateResponse {
  baseTileUrl: string
  dataset: { name: string; featureCount: number; visible: boolean } | null
  navigate: { id: number; lng: number; lat: number; zoom?: number } | null
  /** host 请求「捕获当前视图」：seq 变化即需要截一次当前地图（中心为关注点）。 */
  capture: { seq: number } | null
  /** host 发起的出图请求（AI 工具 webgis_export_map）：见新 seq → 打开出图弹窗并预填。 */
  exportRequest: {
    seq: number
    params?: { title?: string; layerIds?: string[]; legend?: boolean; north?: boolean; scale?: boolean; note?: string; extent?: 'view' | 'all' }
  } | null
  exportImage: { id: number; width: number; height: number; title?: string } | null
  /** 图层注册表摘要（无 geojson）：rev 变化时按 id 拉全量渲染。 */
  layers: LayerSummary[]
}

/** 提取地图上某像素点命中的要素（点击 / 图框中心捕获共用）。 */
function queryFeatures(map: MapLibreMap, point: Point): FeaturePayload[] {
  return map.queryRenderedFeatures(point)
    .slice(0, 30)
    .map((f) => ({
      id: f.id ?? null,
      layer: f.layer.id,
      source: f.source,
      geometryType: f.geometry?.type ?? null,
      properties: f.properties ?? {},
    }))
}

// ---- 点击属性查询（功能 3：点击 = 属性浮窗，LLM 出环；同时记录 pick 供 AI 引用） ----

/** 属性值是否可直接展示（标量，排除对象/数组/空串）。 */
function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/** 要素属性里可展示的标量键值对（原顺序）。 */
function scalarRows(props: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(props).filter(([k, v]) => k !== '' && isScalar(v) && v !== '')
}

/** 浮窗标题字段优先顺序：名称类 → 地址类 → 类型类。 */
function featureTitle(props: Record<string, unknown>): string | null {
  const prefers = ['name', '名称', '名字', 'title', '地名', '小区名称', 'address', '地址', 'type', '类别', '大类']
  for (const k of prefers) {
    const v = props[k]
    if (isScalar(v) && String(v).trim()) return String(v).trim()
  }
  return null
}

function fmtCell(v: unknown): string {
  const s = String(v)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

/** 属性键值对 → 两列表格元素。 */
function makeAttrTable(rows: Array<[string, unknown]>): HTMLElement {
  const table = document.createElement('table')
  table.className = styles.popupTable!
  for (const [k, v] of rows) {
    const tr = document.createElement('tr')
    const th = document.createElement('th')
    th.textContent = k
    th.title = k
    const td = document.createElement('td')
    td.textContent = fmtCell(v)
    td.title = td.textContent
    tr.append(th, td)
    table.appendChild(tr)
  }
  return table
}

/** 浮窗 DOM：标题 + 图层/几何元信息 + 关键字段表 +（字段多时）「查看全部属性」展开。
 *  `onToggle`：展开后内容变高，需通知 popup 重新定位（maplibre 不自动重排）。
 *  `t` 在调用点传入（map 监听一次性绑定，从 tRef 取当前语言，避免语言切换后 stale）。 */
function buildPopupContent(feature: FeaturePayload, t: WebgisT, onToggle?: () => void): HTMLElement {
  const root = document.createElement('div')
  root.className = styles.popupRoot!
  const title = featureTitle(feature.properties)
  if (title) {
    const h = document.createElement('div')
    h.className = styles.popupTitle!
    h.textContent = title
    root.appendChild(h)
  }
  const meta = document.createElement('div')
  meta.className = styles.popupMeta!
  meta.textContent = `${feature.layer}${feature.id != null ? ` · #${feature.id}` : ''}${feature.geometryType ? ` · ${feature.geometryType}` : ''}`
  root.appendChild(meta)

  const rows = scalarRows(feature.properties)
  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = styles.popupEmpty!
    empty.textContent = t('popup.empty')
    root.appendChild(empty)
    return root
  }
  const KEY_FIELDS = 4
  const table = makeAttrTable(rows.slice(0, KEY_FIELDS))
  root.appendChild(table)
  if (rows.length > KEY_FIELDS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = styles.popupToggle!
    btn.textContent = t('popup.viewAll', { n: rows.length })
    btn.addEventListener('click', () => {
      table.remove()
      btn.remove()
      root.appendChild(makeAttrTable(rows))
      onToggle?.()
    })
    root.appendChild(btn)
  }
  return root
}

/** 右键清除图钉：通知 host 清掉最近一次 pick（坐标/要素/截图），后续 webgis_get_pick 将重新捕获当前视图。 */
function clearPick(sessionId?: string): void {
  fetch(sessionUrl(sessionId, '/webgis/pick'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  }).catch(() => {})
}

/** 记录点击/捕获 pick 并上报 host：截地图模块截图（红点=关注位置）→ POST /webgis/pick。返回截图（可能 null）。 */
function recordPick(
  map: MapLibreMap,
  lng: number,
  lat: number,
  features: FeaturePayload[],
  captureSeq?: number,
  sessionId?: string,
): ScreenshotPayload | null {
  const shot = captureMapScreenshot(map, lng, lat)
  const payload: Record<string, unknown> = { lng, lat, features }
  if (captureSeq !== undefined) payload.captureSeq = captureSeq
  if (shot) payload.screenshot = shot
  fetch(sessionUrl(sessionId, '/webgis/pick'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {})
  return shot
}

const EMPTY_COLLECTION = { type: 'FeatureCollection' as const, features: [] as never[] }

/** 初始化底图样式：栅格底图 + 数据图层。glyphs 供 symbol 文本（如聚合圈数字）渲染字形。 */
function baseStyle(tiles: string[]): StyleSpecification {
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
          'circle-radius': 6,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffffff',
        },
      },
    ],
  }
}

// ---- 底图切换 + 叠加服务 + 样式重建 ----

/** 应用底图切换：光栅换瓦片 / 光栅重载样式 / 矢量样式整替换（顺手把 glyphs 打成 demotiles 保聚合圈数字字形）。 */
async function applyBaseMap(map: MapLibreMap, def: BaseMapDef, defaultTiles: string[]): Promise<void> {
  const url = def.kind === 'raster' && !def.url ? (defaultTiles[0] ?? '') : def.url
  const action = baseMapAction({ ...def, url }, map.getSource('base') != null)
  if (action.kind === 'setTiles') {
    ;(map.getSource('base') as RasterTileSource | undefined)?.setTiles([action.url])
    return
  }
  if (action.kind === 'setStyleRaster') {
    map.setStyle(baseStyle([action.url]))
    return
  }
  // 矢量样式：拉 style.json 把 glyphs 打成 demotiles 字体源（防聚合圈数字缺字形），失败回退原 URL。
  try {
    const res = await fetch(action.url)
    if (!res.ok) throw new Error(`style ${res.status}`)
    const style = (await res.json()) as { glyphs?: unknown }
    if (style && typeof style === 'object') {
      style.glyphs = 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
      map.setStyle(style as StyleSpecification)
      return
    }
    throw new Error('bad style json')
  } catch {
    map.setStyle(action.url)
  }
}

/** 保证 data geojson 源 + data-points 图层存在（换过整套样式后按需补挂）。 */
function ensureDataLayers(map: MapLibreMap): void {
  if (map.getLayer('data-points')) return
  if (!map.getSource('data')) map.addSource('data', { type: 'geojson', data: EMPTY_COLLECTION as never })
  map.addLayer({
    id: 'data-points',
    type: 'circle',
    source: 'data',
    paint: { 'circle-color': '#3b82f6', 'circle-radius': 6, 'circle-stroke-width': 1, 'circle-stroke-color': '#ffffff' },
  })
}

/** 同步叠加地图服务（WMTS/WMS/XYZ 光栅层）：加缺、换 URL、切可见性、移除已删。插在 data-points 之下。 */
function syncOverlays(map: MapLibreMap, services: OverlayService[]): void {
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

/** 收集 GeoJSON 里所有坐标对，用于计算 bbox。 */
function collectCoords(geo: unknown, out: number[][]): void {
  const g = geo as { type?: string; features?: unknown[]; geometry?: unknown; coordinates?: unknown; geometries?: unknown[] } | null | undefined
  if (!g?.type) return
  switch (g.type) {
    case 'FeatureCollection':
      (g.features ?? []).forEach((f) => collectCoords(f, out))
      break
    case 'Feature':
      collectCoords(g.geometry, out)
      break
    case 'Point':
      out.push(g.coordinates as number[])
      break
    case 'MultiPoint':
    case 'LineString':
      ((g.coordinates ?? []) as number[][]).forEach((c) => out.push(c))
      break
    case 'Polygon':
      ((g.coordinates ?? []) as number[][][]).forEach((ring) => ring.forEach((c) => out.push(c)))
      break
    case 'MultiLineString':
      ((g.coordinates ?? []) as number[][][]).forEach((line) => line.forEach((c) => out.push(c)))
      break
    case 'MultiPolygon':
      ((g.coordinates ?? []) as number[][][][]).forEach((poly) => poly.forEach((ring) => ring.forEach((c) => out.push(c))))
      break
    case 'GeometryCollection':
      (g.geometries ?? []).forEach((geom) => collectCoords(geom, out))
      break
  }
}

/** 截图上报 payload：与 host 端 parseScreenshot 约定的结构。 */
interface ScreenshotPayload {
  dataUrl: string
  scale: number
  pin: { x: number; y: number }
  viewport: {
    width: number
    height: number
    zoom: number
    bearing: number
    pitch: number
    centerLng: number
    centerLat: number
  }
}

/**
 * 截取地图模块（仅 WebGL canvas，不含任何 DOM）：把 canvas 画到 2D canvas 上、
 * 在点击位置合成红色图钉、限制最大边长后输出 PNG dataURL。同时记录截图那一刻的
 * 视口与缩放，供 host 做「截图像素 ↔ 经纬度」换算（不依赖之后的 live map）。
 * 失败（无 canvas / 无 2d context）返回 null，调用方降级为仅上报坐标。
 */
function captureMapScreenshot(map: MapLibreMap, lng: number, lat: number): ScreenshotPayload | null {
  const canvas = map.getCanvas()
  const bw = canvas.width
  const bh = canvas.height
  const cssWidth = map.getContainer().clientWidth || bw
  const cssHeight = map.getContainer().clientHeight || bh
  if (!bw || !bh) return null

  const MAX_EDGE = 1024
  const imgScale = Math.min(1, MAX_EDGE / Math.max(bw, bh))
  const w = Math.max(1, Math.round(bw * imgScale))
  const h = Math.max(1, Math.round(bh * imgScale))

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(canvas, 0, 0, w, h)

  // 图钉像素位置：map.project 给 css 像素 → 换算到输出图像像素（scale = 图像px / css px）
  const pinCss = map.project([lng, lat])
  const scale = w / cssWidth
  const pinX = pinCss.x * scale
  const pinY = pinCss.y * scale
  drawPin(ctx, pinX, pinY, Math.max(5, 10 * scale))

  const center = map.getCenter()
  return {
    dataUrl: out.toDataURL('image/png'),
    scale,
    pin: { x: pinX, y: pinY },
    viewport: {
      width: cssWidth,
      height: cssHeight,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      centerLng: center.lng,
      centerLat: center.lat,
    },
  }
}

/** 在截图里画一个实心红点 + 白色描边（等价于 DOM 图钉的视觉）。 */
function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = '#ef4444'
  ctx.fill()
  ctx.lineWidth = Math.max(1.5, r * 0.22)
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
}

function fitToGeoJSON(map: MapLibreMap, geojson: unknown): void {
  const coords: number[][] = []
  collectCoords(geojson, coords)
  if (coords.length === 0) return
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const [lng, lat] of coords) {
    if (typeof lng === 'number' && typeof lat === 'number') {
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
    }
  }
  if (minLng === Infinity) return
  if (minLng === maxLng && minLat === maxLat) {
    map.flyTo({ center: [minLng, minLat], zoom: 8, duration: 800 })
  } else {
    map.fitBounds([[minLng, minLat], [maxLng, maxLat]], { padding: 40, duration: 800 })
  }
}

// ---- 结果图层动态渲染 ----

type RenderKind = 'fill' | 'line' | 'circle'

/** 按几何类型决定该图层渲染哪几类 maplibre layer。 */
function renderKinds(types: string[]): RenderKind[] {
  const k: RenderKind[] = []
  if (types.some((t) => t.includes('Polygon'))) k.push('fill')
  if (types.some((t) => t.includes('LineString'))) k.push('line')
  if (types.some((t) => t.includes('Point'))) k.push('circle')
  return k.length > 0 ? k : ['circle']
}

/** 渲染样式（color 为整体底色；fillColor 覆盖填充、pointRadius/strokeWidth 控制点位大小与描边）。 */
interface RenderStyle {
  color: string
  pointRadius?: number
  pointStrokeWidth?: number
  fillColor?: string
}

/** 渲染一个普通要素层；聚合模式下 circle 层带 filter 排除聚合点（!has point_count）。
 *  fill 层填充=fillColor??color、边界=color；circle 层填充=fillColor??color、描边=color。 */
function makeRenderLayer(id: string, srcId: string, kind: RenderKind, style: RenderStyle, filter?: FilterSpecification): LayerSpecification {
  const base = filter ? { filter } : {}
  if (kind === 'fill') {
    return { ...base, id, type: 'fill', source: srcId, paint: { 'fill-color': style.fillColor ?? style.color, 'fill-opacity': 0.45, 'fill-outline-color': style.color } }
  }
  if (kind === 'line') {
    return { ...base, id, type: 'line', source: srcId, paint: { 'line-color': style.color, 'line-width': 2 } }
  }
  return { ...base, id, type: 'circle', source: srcId, paint: {
    'circle-color': style.fillColor ?? style.color,
    'circle-radius': style.pointRadius ?? 5,
    'circle-stroke-width': style.pointStrokeWidth ?? 1,
    'circle-stroke-color': style.color,
  } }
}

// ---- 热力图展示方式（平面 heatmap / 蜂窝 fill-extrusion，maplibre 原生渲染） ----

/** 扫出要素集里 density 属性的峰值（无 density 属性返回 0）。 */
function maxDensityOf(geo: FeatureCollection): number {
  let max = 0
  for (const f of geo.features) {
    const d = Number(f?.properties?.density)
    if (Number.isFinite(d) && d > max) max = d
  }
  return max
}

/** 蜂窝柱最大高度（米）：按图层 bbox 短边比例钳制 40–200m，避免大尺度失真。 */
function hexHeightFor(bbox: [number, number, number, number] | null): number {
  if (!bbox) return 100
  const [w, s, e, n] = bbox
  const midLat = (s + n) / 2
  const mPerDegLon = 111320 * Math.cos((midLat * Math.PI) / 180)
  const mPerDegLat = 110540
  const short = Math.min((e - w) * mPerDegLon, (n - s) * mPerDegLat)
  return Math.max(40, Math.min(200, short * 0.02))
}

/** 平面热力图：maplibre 原生 heatmap 层。weight 按 density 归一化到 [0,1]；无 density 则按点数计数（weight=1）。 */
function makeHeatLayer(id: string, srcId: string, maxDensity: number): LayerSpecification {
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
function makeHexLayer(id: string, srcId: string, maxDensity: number, maxHeight: number): LayerSpecification {
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

// ---- supercluster 聚合圈：单层 circle + circle-blur 羽化边缘（内发光） ----
// maplibre 官方 paint 属性 circle-blur 直接生成"实心核心 + 高斯羽化边缘"，单层即内发光效果，
// 比多同心圆叠加省约 20 倍绘制、无环纹、增删/点击管理更简单。
// 数量越大：圈越大、颜色越深（在图层基色上加深，支持用户指定任意颜色）。

/** 聚合圈最大半径（px），随数量增长。 */
const CLUSTER_BASE_RADIUS: Array<[number, number]> = [
  [0, 34], [100, 46], [1000, 60], [10000, 74], [100000, 92],
]

/** 把 #rrggbb 往白色（percent>0）或黑色（percent<0）方向调亮/调暗，用于生成加深色阶。 */
function shadeColor(hex: string, percent: number): string {
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
function clusterColorFor(base: string): ExpressionSpecification {
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
function clusterRadius(): ExpressionSpecification {
  return ['interpolate', ['linear'], ['get', 'point_count'], ...CLUSTER_BASE_RADIUS.flat()] as ExpressionSpecification
}

/** supercluster 聚合圈：单层 circle + circle-blur 羽化边缘（内发光），点击放大（见 click handler）。 */
function makeClusterLayer(id: string, srcId: string, color: string): LayerSpecification {
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
function makeClusterCountLayer(id: string, srcId: string): LayerSpecification {
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

const LAYER_KINDS: RenderKind[] = ['fill', 'line', 'circle']
/** 一个图层的全部可能渲染层后缀（普通 fill/line/circle + 聚合 + 平面热力 heat + 蜂窝 hex + 面描边 outline）。 */
const ALL_RENDER_SUFFIXES: string[] = [...LAYER_KINDS, 'cluster', 'cluster-count', 'heat', 'hex', 'outline']
/** deck.gl 出图的展示方式（弧线/轨迹/围墙/辐射）；这些模式走 deck 注册表渲染，不建 maplibre 层。 */
const DECK_MODES: ReadonlySet<DisplayMode> = new Set(['arc', 'trips', 'wall', 'radial'])
const SRC = (id: string) => `gis-${id}`
const RID = (id: string, kind: string) => `gis-${id}-${kind}`
/** 蜂窝归并结果专用 source（与原图层 source 分开，避免污染 points 数据）。 */
const SRC_HEX = (id: string) => `gis-${id}-hex`

/** 图层“内容形态”签名：rev 之外的渲染关键属性变化也驱动重建（同 id 换数据集/几何形态/渲染器时兜底）。
 *  若不比较这些，换 dataset 时 rev 都归 0、颜色样式又恰好相同 → 变更判定 miss、旧层残留新数据不拉。 */
function layerShapeKey(s: {
  geometryTypes?: string[]; renderer?: string; dataFormat?: string; name?: string; source?: string
}): string {
  return JSON.stringify({ gt: s.geometryTypes, ren: s.renderer, df: s.dataFormat, name: s.name, src: s.source })
}

/** ExportMapDialog（export 懒 chunk）的 props（镜像自 ExportMapDialog.tsx 实际签名）。 */
interface ExportDialogProps {
  open: boolean
  onClose: () => void
  layers: LayerSummary[]
  mapRef: { current: MapLibreMap | null }
  t: WebgisT
  prefill?: ExportPrefill | null
  onExportToAi?: (dataUrl: string, width: number, height: number, title: string) => void
}

/** 全帧 WebGIS 地图（GIS 模式下填满对话页主区域）。 */
export function MapView({ sessionId, t }: { sessionId?: string; t: WebgisT }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  /** 当前会话 id（随渲染更新；异步轮询/事件回调经 ref 读取最新值）。 */
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  /** 当前翻译函数（随语言切换更新；一次性绑定的事件回调经此读取最新 t，避免 stale）。 */
  const tRef = useRef(t)
  tRef.current = t
  /** 点击属性浮窗（maplibre Popup）：同一时刻最多一个，新点击/空点击/捕获会先关闭旧的。 */
  const popupRef = useRef<maplibregl.Popup | null>(null)
  /** 关闭属性浮窗（新点击/空点击/视图捕获/卸载时复用；只依赖 ref，可在组件各处调用）。 */
  const closePopup = (): void => {
    popupRef.current?.remove()
    popupRef.current = null
  }
  /** 出图结果上传 host（「导出并给 AI 看」；带 AI 请求的 seq 回传供等待中的 webgis_export_map 收）。失败静默（本地下载仍可用）。 */
  const postExportImage = async (dataUrl: string, width: number, height: number, title: string): Promise<void> => {
    try {
      await fetch(sessionUrl(sessionRef.current, '/webgis/export-image'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seq: lastExportSeq.current > 0 ? lastExportSeq.current : undefined,
          title: title || undefined,
          width,
          height,
          dataUrl,
        }),
      })
    } catch {
      // 网络失败忽略：用户已能本地下载
    }
  }

  const lastNavigateId = useRef(0)
  /** 最近一轮 /webgis/state 的指纹：轮询时状态没变就整轮跳过（空转零开销）。 */
  const pollFpRef = useRef('')
  const lastCaptureSeq = useRef(0)
  const datasetSeen = useRef('')
  /** 结果图层变更检测：每层记录 rev + visible + mode（+modeParams + 内容形态签名），相同则不重拉。 */
  const gisSeen = useRef<Record<string, {
    rev: number; visible: boolean; mode: DisplayMode; color?: string; params?: string; style?: string; shape?: string
  }>>({})
  /** 客户端已拉取的图层全量数据缓存（切换展示方式时免重新请求）。 */
  const dataCache = useRef<Record<string, FeatureCollection>>({})
  /** 当前激活的聚合层 id（点击放大用；syncLayers 维护）。 */
  const clusterLayerIds = useRef<Set<string>>(new Set())
  /** 图层面板数据（轮询 /webgis/state 回填）与当前打开属性的图层。 */
  const [layers, setLayers] = useState<LayerSummary[]>([])
  const [attrLayer, setAttrLayer] = useState<LayerSummary | null>(null)
  /** 出图弹窗开关。 */
  const [exportOpen, setExportOpen] = useState(false)
  /** AI 出图请求预填（webgis_export_map）。 */
  const [exportPrefill, setExportPrefill] = useState<ExportPrefill | null>(null)
  const lastExportSeq = useRef(0)
  /** export 懒 chunk 加载完成的出图弹窗组件（点「出图」/AI 请求时才拉导出相关代码）。 */
  const [ExportDialogComp, setExportDialogComp] = useState<ComponentType<ExportDialogProps> | null>(null)
  /** 打开出图弹窗（手点「出图」与 AI webgis_export_map 同一入口）：先确保 export chunk 已加载，再开弹窗。 */
  const openExport = (prefill: ExportPrefill | null): void => {
    setExportPrefill(prefill)
    setExportOpen(true)
    void ensure('export')
      .then((m) => {
        const C = m.ExportMapDialog as ComponentType<ExportDialogProps> | undefined
        if (C) setExportDialogComp(() => C)
      })
      .catch((err: unknown) => console.warn('[webgis] export chunk 加载失败', err))
  }
  /** 当前底图（左下角切换器）；默认条目（default）url 为空，apply 时用 /webgis/state 的 baseTileUrl 填。 */
  const [baseMap, setBaseMap] = useState<BaseMapDef>(() => BASE_MAPS.find((d) => d.id === 'default') ?? BASE_MAPS[0]!)
  const baseMapRef = useRef(baseMap)
  baseMapRef.current = baseMap
  /** 最新 /webgis/state 的图层摘要与 baseTileUrl（样式重建 / 底图切换用）。 */
  const lastLayersRef = useRef<LayerSummary[]>([])
  const stBaseTileUrlRef = useRef('')
  /** 最新叠加服务清单（/webgis/services 轮询回填）。 */
  const overlaysRef = useRef<OverlayService[]>([])
  /** 绘图工具条激活时置 true：MapView 点击逻辑（属性弹窗/图钉/pick）让位给 terradraw。 */
  const drawingActiveRef = useRef(false)
  /** 样式重建去重（style.load 可能重复触发）。 */
  const styleRebuildPending = useRef(false)
  const lastServicesFetch = useRef(0)
  /** deck.gl 运行时控制器（出图 overlay / raw 分级拉取 / 点选回查 / trips 动画；实现见 ./deck/controller.ts）。
   *  不再建图时 eager 构造：首个「需 deck 渲染」的图层出现时经 {@link ensureDeckForMap} 懒建。 */
  const deckRef = useRef<DeckController | null>(null)
  /** deck 懒 chunk 加载进行中 Promise（并发去重；失败清空便于后续重试）。 */
  const deckPromiseRef = useRef<Promise<DeckController> | null>(null)
  /** 拉 deck.js chunk → 懒建 controller（host 绑定 session / dataCache / arrow 回退写缓存）。 */
  const getDeck = (): Promise<DeckController> => {
    if (deckRef.current) return Promise.resolve(deckRef.current)
    if (deckPromiseRef.current) return deckPromiseRef.current
    const p = ensure('deck').then((m) => {
      const factory = m.createDeckController as ((host: DeckControllerHost) => DeckController) | undefined
      if (typeof factory !== 'function') throw new Error('deck chunk 未导出 createDeckController')
      deckRef.current = factory({
        getSessionId: () => sessionRef.current,
        getCachedData: (id) => dataCache.current[id],
        onArrowFallbackGeojson: (id, fc) => { dataCache.current[id] = fc },
      })
      return deckRef.current
    })
    deckPromiseRef.current = p
    // 失败清空占位：允许下次重试（成功后 deckRef.current 已置位，走顶部短路）。
    p.catch(() => { if (deckPromiseRef.current === p) deckPromiseRef.current = null })
    return p
  }
  /** 首个需 deck 渲染的图层出现时调用：懒建 controller + 挂 map + 建 overlay。失败返回 null。 */
  const ensureDeckForMap = async (map: MapLibreMap): Promise<DeckController | null> => {
    if (deckRef.current) return deckRef.current
    try {
      const deck = await getDeck()
      deck.setMap(map)
      // interleaved overlay 需 map load 后 WebGL painter 就绪：已 load 则即时建，否则交给 load once（首个
      // deck 层晚于 map load 出现时 map.loaded() 已 true → 即时可用，无旧 once('load') 竞态）。
      if (map.loaded()) deck.ensureOverlay()
      else map.once('load', () => { deckRef.current?.ensureOverlay(); deckRef.current?.syncLayers() })
      return deck
    } catch (err) {
      console.warn('[MapView] deck chunk 加载失败，本轮跳过该图层（下轮图层状态变更时重试）', err)
      return null
    }
  }

  // 创建地图
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    maplibregl.setWorkerUrl('/webgis/maplibre-gl-csp-worker.js')
    const map = new maplibregl.Map({
      container,
      style: baseStyle(['https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png']),
      center: [104, 35],
      zoom: 3,
      attributionControl: false,
      // 必须保留绘制缓冲区：否则浏览器合成后清空 WebGL buffer，
      // getCanvas().toDataURL() 截图是空白（点击截图就只剩合成上去的图钉）。
      preserveDrawingBuffer: true,
    })
    mapRef.current = map
    ;(window as unknown as Record<string, unknown>).__webgisMap = map
    map.addControl(new maplibregl.NavigationControl(), 'top-left')
    // deck.gl 出图 overlay 不再建图时 eager 构造：首个「需 deck 渲染」的图层出现时才经 ensureDeckForMap
    // 懒拉 deck.js chunk → 建 controller → setMap → ensureOverlay（interleaved 需 map load 后 WebGL painter
    // 就绪；ensureDeckForMap 内对 map.loaded() 与 'load' once 已做兼容，首个 deck 层晚于 load 出现时即时建）。
    map.on('load', () => map.resize())

    // 属性浮窗：复用组件级 closePopup（同一时刻最多一个，新点击先关旧的）。
    const showFeaturePopup = (feature: FeaturePayload, lngLat: { lng: number; lat: number }): void => {
      closePopup()
      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: '340px',
        offset: 12,
      })
      popupRef.current = popup
      // 展开「全部属性」后内容变高，setLngLat(同值) 触发 _update 重排。
      const reposition = (): void => { popup.setLngLat(popup.getLngLat()) }
      popup.setLngLat([lngLat.lng, lngLat.lat])
        .setDOMContent(buildPopupContent(feature, tRef.current, reposition))
        .addTo(map)
    }

    // zoom 分级密度：缩放结束 → 大图层 arrow 原始点跨档位时拉新分档（低缩放稀疏、放大逐渐加密、高缩放全量）。
    map.on('zoomend', () => { deckRef.current?.syncRawTiers(lastLayersRef.current) })
    // 视口裁剪：平移/缩放结束（moveend 都触发）→ ~350ms 尾随防抖后按新视野刷新 arrow 大层（只拉视野内）。
    // zoomend 已驱动的 syncRawTiers 保留；两者都汇聚到 lastViewKey（档位|bbox）去重，同键不再重复拉。
    const viewRefreshTimer = { id: 0 }
    const scheduleViewportRefresh = (): void => {
      if (viewRefreshTimer.id) window.clearTimeout(viewRefreshTimer.id)
      viewRefreshTimer.id = window.setTimeout(() => {
        viewRefreshTimer.id = 0
        deckRef.current?.viewportRefresh(lastLayersRef.current)
      }, 350)
    }
    map.on('moveend', scheduleViewportRefresh)

    // 点击联动（GIS 交互重构：点击 = 属性查询，LLM 出环，全部路径都上报 pick 供 webgis_get_pick 消费）：
    //   聚合圈 → 放大一级（导航手势，不弹属性）
    //   命中要素 → 弹属性浮窗（maplibre Popup，显示最上层要素）+ 记录 pick（供 AI 引用被点要素），不落图钉
    //   空点击   → 落图钉标记关注点 + 记录 pick（供 AI 引用坐标）
    // 截图红点 = 关注位置（点击处或图框中心），始终合成在截图里（与 DOM 图钉无关）。
    map.on('click', (e) => {
      // 绘图工具条激活时（点/线/面/贝塞尔/选择）：点击让位给 terradraw，不做属性查询/落图钉/pick。
      if (drawingActiveRef.current) return
      const clusterHits = map.queryRenderedFeatures(e.point, { layers: [...clusterLayerIds.current] })
      const cluster = clusterHits[0]
      if (cluster?.properties?.cluster_id != null) {
        closePopup()
        const src = map.getSource(cluster.source) as GeoJSONSource | undefined
        src?.getClusterExpansionZoom(cluster.properties.cluster_id)
          .then((z) => {
            if (typeof z === 'number') {
              const center = (cluster.geometry as { coordinates: number[] }).coordinates as [number, number]
              map.easeTo({ center, zoom: Math.max(map.getZoom() + 1, z) })
            }
          })
          .catch(() => {})
        return
      }

      const lng = e.lngLat.lng
      const lat = e.lngLat.lat
      // deck 原始数据图层（>10 万 arrow / 大 geojson 点层）：maplibre queryRenderedFeatures 查不到 deck 层，
      // 用 controller.pickObject（proxy overlay.pickObject）同步判中；命中则按坐标查 host duck 表属性
      // （arrow 只传坐标，属性点击时才查）。缺 overlay/异常已由 controller 内拦截为日志并返回 null。
      const deckHit = deckRef.current?.pickObject(e.point.x, e.point.y)
      // deck 命中解析：arrow 层 id `deck-<id>-raw`；geojson 分族子层 `deck-<id>-raw-{point|line|polygon}`。
      const deckRawMatch = deckHit?.picked && deckHit.layer?.id
        ? /^deck-(.+?)-raw(-(?:point|line|polygon))?$/.exec(deckHit.layer.id)
        : null
      const deckRawId = deckRawMatch?.[1] ?? null
      const deckRawKind = (deckRawMatch?.[2]?.slice(1) as 'point' | 'line' | 'polygon' | undefined) ?? null
      if (deckRawId && deckHit) {
        const arrowTable = deckRef.current?.arrowTableFor(deckRawId)
        if (arrowTable) {
          // Arrow 几何列图层（点/线/面，duckGeom）带稳定行号列 __rid：命中行 → host 按 rowid 回查整行属性。
          // 跨 zoom 分档稳定（抽样子集/行索引都会变，rowid 不变）；坐标像素反投影有误差、polygon 无中心点可投。
          const ridChild = arrowTable.getChild('__rid')
          const rid = ridChild == null ? null : Number(ridChild.get(deckHit.index))
          if (ridChild != null && Number.isFinite(rid)) {
            closePopup()
            const url = sessionUrl(sessionRef.current, `/webgis/arrow-rid?id=${encodeURIComponent(deckRawId)}&rid=${rid}`)
            void fetch(url, { cache: 'no-store' })
              .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; name?: string; message?: string; attrs?: Record<string, unknown> }>) : null))
              .then((d) => {
                if (!d?.ok || !d.attrs) {
                  if (d?.message) console.warn('[MapView] Arrow 行号属性未命中', deckRawId, 'index', deckHit.index, 'rid', rid, '|', d.message)
                  return
                }
                const feature: FeaturePayload = {
                  id: null,
                  layer: d.name ?? deckRawId,
                  source: 'duckdb',
                  geometryType: null,
                  properties: d.attrs,
                }
                showFeaturePopup(feature, { lng, lat })
                recordPick(map, lng, lat, [feature], undefined, sessionRef.current)
              })
              .catch((err) => console.warn('[MapView] Arrow 行号属性查询失败', deckRawId, err))
            return
          }
          // 旧 duckCoords 点表（无 __rid）：info.coordinate 是「点击像素反投影」（有半像素误差）→
          // 按 pick 的 index 从 arrow 表几何列取精确坐标 → host 坐标属性查询。
          // ⚠️ FixedSizeList.get(i) 返回的是 apache-arrow 的 Vector（iterable），必须 Array.from 展开。
          let p: number[] | undefined
          const v = arrowTable.getChild('__geometry')?.get(deckHit.index)
          if (v != null && typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
            const arr = Array.from(v as ArrayLike<number>)
            if (arr.length >= 2 && Number.isFinite(arr[0]) && Number.isFinite(arr[1])) p = [Number(arr[0]), Number(arr[1])]
          }
          const dlon = p?.[0] ?? lng
          const dlat = p?.[1] ?? lat
          closePopup()
          const url = sessionUrl(sessionRef.current, `/webgis/arrow-attr?id=${encodeURIComponent(deckRawId)}&lon=${dlon}&lat=${dlat}`)
          void fetch(url, { cache: 'no-store' })
            .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; name?: string; message?: string; attrs?: Record<string, unknown> }>) : null))
            .then((d) => {
              if (!d?.ok || !d.attrs) {
                if (d?.message) console.warn('[MapView] Arrow 属性未命中', deckRawId, 'index', deckHit.index, '坐标', dlon, dlat, '|', d.message)
                return
              }
              const feature: FeaturePayload = {
                id: null,
                layer: d.name ?? deckRawId,
                source: 'duckdb',
                geometryType: 'Point',
                properties: d.attrs,
              }
              showFeaturePopup(feature, { lng: dlon, lat: dlat })
              recordPick(map, dlon, dlat, [feature], undefined, sessionRef.current)
            })
            .catch((err) => console.warn('[MapView] Arrow 属性查询失败', deckRawId, err))
          return
        }
        // geojson 原始层（materialized 大层 / 多族混合 / 面）：分族子层 id 带 kind 后缀，pickObject 的 index
        // 对齐对应族（rawPolygonData/rawLineData/rawPointData）过滤数组；旧单族层无后缀时按首族兜底。
        const cachedFC = dataCache.current[deckRawId]
        if (cachedFC) {
          const kind = deckRawKind ?? (geojsonKindOf(cachedFC) as 'point' | 'line' | 'polygon')
          const f =
            kind === 'polygon' ? rawPolygonData(cachedFC)[deckHit.index]
            : kind === 'line' ? rawLineData(cachedFC)[deckHit.index]
            : rawPointData(cachedFC)[deckHit.index]
          if (f?.properties) {
            const feature: FeaturePayload = {
              id: null,
              layer: deckRawId,
              source: 'geojson',
              geometryType: f.geometry.type,
              properties: f.properties,
            }
            closePopup()
            showFeaturePopup(feature, { lng, lat })
            recordPick(map, lng, lat, [feature], undefined, sessionRef.current)
          }
          return
        }
      }
      // 排除聚合圈自身（聚合层已在上面单独处理，这里兜底过滤掉混入的 cluster 要素）。
      const hits = queryFeatures(map, e.point).filter((f) => f.properties?.cluster_id == null)

      if (hits.length > 0) {
        // 点中要素：弹属性浮窗（最上层要素），不落图钉；清掉此前空点击留下的 DOM 图钉（避免误导）。
        markerRef.current?.remove()
        markerRef.current = null
        showFeaturePopup(hits[0]!, e.lngLat)
        recordPick(map, lng, lat, hits, undefined, sessionRef.current)
        return
      }

      // 空点击：落图钉标记关注点，供用户/AI 引用坐标。
      closePopup()
      if (markerRef.current) {
        markerRef.current.setLngLat([lng, lat])
      } else {
        markerRef.current = new maplibregl.Marker({ color: '#ef4444' }).setLngLat([lng, lat]).addTo(map)
      }
      recordPick(map, lng, lat, [], undefined, sessionRef.current)
    })

    // 右键清除图钉：移除 DOM 图钉、关闭属性浮窗，并通知 host 清掉最近一次 pick。
    map.on('contextmenu', (e) => {
      e.originalEvent?.preventDefault()
      closePopup()
      if (markerRef.current) {
        markerRef.current.remove()
        markerRef.current = null
      }
      clearPick(sessionRef.current)
    })

    const onResize = () => map.resize()
    window.addEventListener('resize', onResize)
    // 容器尺寸变化（地图层 left 被推进到会话列表之后、GIS 布局切换等）时同步地图大小，
    // 保证 canvas/图框中心与可见区域一致。map.resize() 只改 canvas 不改容器，不会死循环。
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => map.resize())
      resizeObserver.observe(container)
    }
    return () => {
      window.removeEventListener('resize', onResize)
      resizeObserver?.disconnect()
      if (viewRefreshTimer.id) window.clearTimeout(viewRefreshTimer.id)
      deckRef.current?.dispose()
      deckRef.current = null
      markerRef.current?.remove()
      markerRef.current = null
      popupRef.current?.remove()
      popupRef.current = null
      delete (window as unknown as Record<string, unknown>).__webgisMap
      map.remove()
      mapRef.current = null
    }
  }, [])

  // 轮询状态：数据集 + 导航意图
  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const loadDataset = async (map: MapLibreMap, fit = true): Promise<void> => {
      const res = await fetch(sessionUrl(sessionRef.current, '/webgis/dataset'), { cache: 'no-store' })
      if (!res.ok) throw new Error('dataset fetch failed')
      const geojson = await res.json()
      // 缓存进 dataCache：dataset 切 plane/hex 时走普通点图层路径，若无缓存且 rev 未变会直接 continue 跳过渲染
      dataCache.current.dataset = geojson
      const source = map.getSource('data') as GeoJSONSource | undefined
      if (source) source.setData(geojson)
      if (fit) fitToGeoJSON(map, geojson)
    }

    // 同步图层注册表：移除消失的层、按 rev 变更拉全量并 addSource/addLayer、
    // 纯可见性切换走 setLayoutProperty（不重拉数据）。dataset 层由现有 data-points 处理。
    const syncLayers = async (map: MapLibreMap, summaries: LayerSummary[], force = false): Promise<void> => {
      const seen = gisSeen.current
      const current = new Set(summaries.map((s) => s.id))
      try {
        // 1) 移除已从注册表消失的层（含聚合层 / 热力层 / 蜂窝层 / deck 出图层）
        for (const id of Object.keys(seen)) {
          if (id === 'dataset' || current.has(id)) continue
          for (const suffix of ALL_RENDER_SUFFIXES) {
            const r = RID(id, suffix)
            if (map.getLayer(r)) map.removeLayer(r)
          }
          if (map.getSource(SRC(id))) map.removeSource(SRC(id))
          if (map.getSource(SRC_HEX(id))) map.removeSource(SRC_HEX(id))
          clusterLayerIds.current.delete(RID(id, 'cluster'))
          deckRef.current?.removeOut(id)
          delete dataCache.current[id]
          delete seen[id]
        }
        // 2) upsert / 变更 / 可见性
        // ⚠️ 每个图层独立 try/catch：切底图（setStyle）后重建期间某个图层失败不应中断其余图层
        // （此前整体 try/catch 会因一个图层异常静默吞掉整轮，导致 OpenFreeMap 等矢量样式切完后图层全部消失）。
        for (const s of summaries) {
          try {
          const prev = seen[s.id]
          // 内容形态签名：rev 之外还要能感知「同 id 换了数据集/几何/渲染形态」，否则替换 dataset 时常漏变更。
          const shape = layerShapeKey(s)
          if (s.id === 'dataset') {
            // 数据集展示方式：points 且点数据集走 data-points 圆点；线/面数据集不走 data-points——
            // maplibre circle 层会给 LineString/Polygon 的每个顶点画圆（表现为散点），必须按几何渲染。
            // 注意：切底图 setStyle 后 data-points 层可能尚未重建，所有 setLayout/setPaint 调用先判存在，避免抛错中断整轮。
            const dmode: DisplayMode = s.mode ?? 'points'
            const dstyle = JSON.stringify({ r: s.pointRadius, sw: s.pointStrokeWidth, fc: s.fillColor })
            const isPointData = (s.geometryTypes ?? []).length > 0
              && (s.geometryTypes ?? []).every((t) => t === 'Point' || t === 'MultiPoint')
            // data-points 圆点只服务「maplibre 渲染的点数据集」；renderer=deck（>10 万，走 arrow 大数据）的点/线/面
            // 数据集 → 落到下方普通路径走 raw deck / /webgis/arrow（避免 data-points 只画抽样 + 无法分级）。
            if (dmode === 'points' && isPointData && s.renderer !== 'deck') {
              if (map.getLayer('data-points')) {
                // 恒按 visible 设可见性：从线/面数据集切回点数据集时要恢复显示（此前可能被隐藏）
                map.setLayoutProperty('data-points', 'visibility', s.visible ? 'visible' : 'none')
                // 数据集点样式跟随图层（颜色 + 点位大小 + 描边），此前 data-points 写死蓝色、半径 5
                if (prev?.color !== s.color || prev?.style !== dstyle) {
                  map.setPaintProperty('data-points', 'circle-color', s.fillColor ?? s.color)
                  map.setPaintProperty('data-points', 'circle-radius', s.pointRadius ?? 5)
                  map.setPaintProperty('data-points', 'circle-stroke-width', s.pointStrokeWidth ?? 1)
                  map.setPaintProperty('data-points', 'circle-stroke-color', s.color)
                }
              }
              // 清理 plane/hex/deck 模式残留的渲染层（gis-dataset-heat / gis-dataset-hex / deck）
              for (const suffix of ALL_RENDER_SUFFIXES) {
                const r = RID('dataset', suffix)
                if (map.getLayer(r)) map.removeLayer(r)
              }
              if (map.getSource(SRC('dataset'))) map.removeSource(SRC('dataset'))
              if (map.getSource(SRC_HEX('dataset'))) map.removeSource(SRC_HEX('dataset'))
              deckRef.current?.removeOut('dataset')
              seen[s.id] = { rev: s.rev, visible: s.visible, mode: s.mode, color: s.color, style: dstyle, shape }
              continue
            }
            // 线/面数据集 或 plane/hex：隐藏 data-points（避免线/面顶点被画成圆点），
            // 渲染交给下方普通路径按几何/模式处理（线 → gis-dataset-line、面 → gis-dataset-fill、plane/hex 热力照常）。
            if (map.getLayer('data-points')) {
              map.setLayoutProperty('data-points', 'visibility', 'none')
              if (prev?.color !== s.color || prev?.style !== dstyle) {
                map.setPaintProperty('data-points', 'circle-color', s.fillColor ?? s.color)
                map.setPaintProperty('data-points', 'circle-radius', s.pointRadius ?? 5)
                map.setPaintProperty('data-points', 'circle-stroke-width', s.pointStrokeWidth ?? 1)
                map.setPaintProperty('data-points', 'circle-stroke-color', s.color)
              }
            }
          }
          const kinds = renderKinds(s.geometryTypes)
          const isPointLayer = kinds.includes('circle')
          // 展示方式：非点图层也可走 deck 出图（弧线/轨迹需线、围墙需面）；plane/hex 仍仅点图层有意义。
          const mode: DisplayMode = (s.mode && (DECK_MODES.has(s.mode) || isPointLayer)) ? s.mode : 'points'
          const isDeckMode = DECK_MODES.has(mode)
          // 仅点要素、且为原始点模式时走 supercluster 聚合。
          const clustered = isPointLayer && s.cluster && mode === 'points'
          // force（换底图/样式重建）：全部当作数据+模式变更重建，但跳过镜头 fit
          const dataChanged = force || !prev || prev.rev !== s.rev || (prev.shape !== undefined && prev.shape !== shape)
          const modeChanged = force || (!!prev && prev.mode !== s.mode)
          const paramsChanged = force || (!!prev && prev.params !== (s.modeParams ? JSON.stringify(s.modeParams) : ''))
          const colorChanged = force || (!!prev && prev.color !== s.color)
          // 样式（点位大小/描边/填充色）变更也要触发重建
          const styleKey = JSON.stringify({ r: s.pointRadius, sw: s.pointStrokeWidth, fc: s.fillColor })
          const styleChanged = force || (!!prev && prev.style !== styleKey)
          const style: RenderStyle = { color: s.color, pointRadius: s.pointRadius, pointStrokeWidth: s.pointStrokeWidth, fillColor: s.fillColor }
          // >10 万点图层走「deck 原始数据」路径（host renderer=deck；mode 为原始点时适用，plane/hex 仍走 maplibre）。
          const isRawDeck = s.renderer === 'deck' && mode === 'points'
          // deck 懒加载：首个「需 deck 渲染」的图层（deck 出图 / raw 原始数据路径）出现时才拉 deck.js 建 controller。
          // 放单图层 try 内：加载失败只跳本图层、不中断其余图层；记 seen 防每轮 poll 反复尝试，下轮由图层状态变更驱动重试。
          if ((isDeckMode || isRawDeck) && !deckRef.current) {
            const d = await ensureDeckForMap(map)
            if (!d) {
              seen[s.id] = prev ?? {
                rev: s.rev,
                visible: s.visible,
                mode: s.mode,
                color: s.color,
                params: s.modeParams ? JSON.stringify(s.modeParams) : '',
                style: styleKey,
                shape,
              }
              continue
            }
          }
          if (dataChanged || modeChanged || paramsChanged || colorChanged || styleChanged) {
            // 数据优先取客户端缓存（切换展示方式免重新请求）；首次出现才拉全量。
            // Arrow 原始数据路径不拉 geojson 抽样，直接走 /webgis/arrow 二进制。
            let geojson: FeatureCollection | null = null
            const useArrow = isRawDeck && s.dataFormat === 'arrow'
            const cached = dataCache.current[s.id]
            if (!useArrow) {
              if (cached) {
                geojson = cached
              } else {
                if (!dataChanged) {
                  // mode 变了但还没缓存过数据（理论上不会发生）→ 等下一轮再拉
                  continue
                }
                const res = await fetch(sessionUrl(sessionRef.current, `/webgis/gis-result?id=${encodeURIComponent(s.id)}`), { cache: 'no-store' })
                if (!res.ok) continue
                geojson = await res.json()
                dataCache.current[s.id] = geojson as FeatureCollection
              }
            }
            // 结构/选项变更（含 cluster 开关 / 展示方式 / 出图参数）→ 整组重建（maplibre 层或 deck 出图层）
            if (isDeckMode) {
              // deck 出图：切形态前清掉同 id 的 raw（arrow/geojson）状态，防止 syncRawTiers 把 raw 层画回 deck 出图之上
              deckRef.current?.clearRaw(s.id)
              // deck 出图：清掉 maplibre 残留层后注册进 deck 注册表
              for (const suffix of ALL_RENDER_SUFFIXES) {
                const r = RID(s.id, suffix)
                if (map.getLayer(r)) map.removeLayer(r)
              }
              if (map.getSource(SRC(s.id))) map.removeSource(SRC(s.id))
              if (map.getSource(SRC_HEX(s.id))) map.removeSource(SRC_HEX(s.id))
              clusterLayerIds.current.delete(RID(s.id, 'cluster'))
              deckRef.current?.upsertOut({
                id: s.id,
                mode: mode as DeckChartMode,
                geojson: geojson as FeatureCollection,
                bbox: s.bbox,
                color: s.fillColor ?? s.color,
                visible: s.visible,
                params: s.modeParams,
              })
            } else if (isRawDeck) {
              // deck 原始数据路径：清掉 maplibre 残留层后注册进 raw deck（Arrow 或 geojson 原始点）。
              // 非数据变更（颜色/样式）用缓存重建，避免重新拉 Arrow；数据变更/首次才拉。
              // ⚠️ 不调 removeOut（controller 里会清掉 raw 表缓存，导致 rebuildRaw 拿不到表）。
              // 切形态前清掉同 id 的 deck 出图注册表（trips 动画等不会把旧形态画回去）。
              deckRef.current?.clearOut(s.id)
              for (const suffix of ALL_RENDER_SUFFIXES) {
                const r = RID(s.id, suffix)
                if (map.getLayer(r)) map.removeLayer(r)
              }
              if (map.getSource(SRC(s.id))) map.removeSource(SRC(s.id))
              if (map.getSource(SRC_HEX(s.id))) map.removeSource(SRC_HEX(s.id))
              clusterLayerIds.current.delete(RID(s.id, 'cluster'))
              // 仅当该 id 已有 raw 注册表且本轮只是样式/可见性变化时才用缓存重建；
              // 否则一律 upsert（新增/换数据时旧形态没有 raw 表，rebuild 会空转 → 新层不显示）。
              if (deckRef.current?.hasRaw(s.id) && !dataChanged) {
                deckRef.current.rebuildRaw(s)
              } else {
                await deckRef.current?.upsertRaw(s, geojson)
              }
            } else {
              // maplibre 渲染：清掉 deck 出图层残留后重建 source + layers
              if (!geojson) continue // 非 Arrow 路径下 geojson 必然已取到（上面 useArrow=false 分支）
              deckRef.current?.removeOut(s.id)
              for (const suffix of ALL_RENDER_SUFFIXES) {
                const r = RID(s.id, suffix)
                if (map.getLayer(r)) map.removeLayer(r)
              }
              if (map.getSource(SRC(s.id))) map.removeSource(SRC(s.id))
              if (map.getSource(SRC_HEX(s.id))) map.removeSource(SRC_HEX(s.id))
              clusterLayerIds.current.delete(RID(s.id, 'cluster'))
              if (mode === 'points') {
                if (clustered) {
                  map.addSource(SRC(s.id), { type: 'geojson', data: geojson, cluster: true, clusterRadius: 50, clusterMaxZoom: 16 })
                  map.addLayer(makeClusterLayer(RID(s.id, 'cluster'), SRC(s.id), s.color))
                  map.addLayer(makeClusterCountLayer(RID(s.id, 'cluster-count'), SRC(s.id)))
                  clusterLayerIds.current.add(RID(s.id, 'cluster'))
                  map.addLayer(makeRenderLayer(RID(s.id, 'circle'), SRC(s.id), 'circle', style, ['!', ['has', 'point_count']]))
                } else {
                  map.addSource(SRC(s.id), { type: 'geojson', data: geojson })
                  for (const kind of kinds) {
                    map.addLayer(makeRenderLayer(RID(s.id, kind), SRC(s.id), kind, style))
                  }
                  // 面描边宽度：fill 层自身边界只有 1px，粗描边需叠一个 line 层
                  if (s.pointStrokeWidth !== undefined && kinds.includes('fill')) {
                    map.addLayer({ id: RID(s.id, 'outline'), type: 'line', source: SRC(s.id), paint: { 'line-color': s.color, 'line-width': s.pointStrokeWidth } })
                  }
                }
              } else if (mode === 'plane') {
                // 平面热力图：maplibre 原生 heatmap 层（GPU 平滑热色，缩放零重算、流畅）
                map.addSource(SRC(s.id), { type: 'geojson', data: geojson })
                map.addLayer(makeHeatLayer(RID(s.id, 'heat'), SRC(s.id), maxDensityOf(geojson)))
                // 立即套用可见性：新层默认可见，若图层处于隐藏态需同步（后续可见性块可能不触发）
                map.setLayoutProperty(RID(s.id, 'heat'), 'visibility', s.visible ? 'visible' : 'none')
              } else {
                // 蜂窝热力图：客户端把点归并成六边形（hexbinFC），fill-extrusion 柱渲染
                const hex = hexbinFC(geojson)
                map.addSource(SRC_HEX(s.id), { type: 'geojson', data: hex })
                map.addLayer(makeHexLayer(RID(s.id, 'hex'), SRC_HEX(s.id), maxDensityOf(hex), hexHeightFor(s.bbox)))
                map.setLayoutProperty(RID(s.id, 'hex'), 'visibility', s.visible ? 'visible' : 'none')
              }
            }
            if (!prev && !force) {
              // 首次出现 fit 到图层范围：Arrow 图层没有 geojson，用摘要 bbox。
              if (geojson) await fitToGeoJSON(map, geojson)
              else if (s.bbox) map.fitBounds(s.bbox, { padding: 60, maxZoom: 16 })
            }
          }
          if (isDeckMode) {
            // deck 出图可见性：更新注册表里的 spec 可见性（deck 层 visible 由图层实例控制）；
            // spec 从当前摘要 + dataCache 重建（与上次 upsert 内容等价，只有变化才重建）。
            const ex = deckRef.current?.outVisibleOf(s.id)
            if (ex !== undefined && ex !== s.visible) {
              deckRef.current?.upsertOut({
                id: s.id,
                mode: mode as DeckChartMode,
                geojson: dataCache.current[s.id] as FeatureCollection,
                bbox: s.bbox,
                color: s.fillColor ?? s.color,
                visible: s.visible,
                params: s.modeParams,
              })
            }
          } else if (isRawDeck) {
            // deck 原始数据路径可见性：更新 raw spec + 用缓存数据重建
            const rv = deckRef.current?.rawVisibleOf(s.id)
            if (rv !== undefined && rv !== s.visible) {
              deckRef.current?.rebuildRaw(s)
            }
          } else {
            const renderIds = mode === 'points'
              ? (clustered ? [RID(s.id, 'cluster'), RID(s.id, 'cluster-count'), RID(s.id, 'circle')] : kinds.map((k) => RID(s.id, k)))
              : mode === 'plane'
                ? [RID(s.id, 'heat')]
                : [RID(s.id, 'hex')]
            if (!prev || prev.visible !== s.visible) {
              for (const r of renderIds) {
                if (map.getLayer(r)) map.setLayoutProperty(r, 'visibility', s.visible ? 'visible' : 'none')
              }
            }
          }
          seen[s.id] = { rev: s.rev, visible: s.visible, mode: s.mode, color: s.color, params: s.modeParams ? JSON.stringify(s.modeParams) : '', style: styleKey, shape }
          } catch (err) {
            // 单图层失败不中断其余图层；记录错误便于排查（本轮跳过，下轮 poll 会重试）。
            console.warn('[MapView] syncLayers 图层处理失败，跳过', s.id, err)
          }
        }
      } catch (err) {
        // 样式未就绪 / 网络抖动：本轮跳过，下一轮重试
        console.warn('[MapView] syncLayers 整轮失败', err)
      }
    }

    // 换底图（setStyle）后：样式 load 时把数据图层补挂回来——data-points、叠加服务、结果图层。
    // 复用 dataCache 不重拉数据、跳过 fit 不跳镜头。styleRebuildPending 去重。
    const rebuildAfterStyleLoad = async (map: MapLibreMap): Promise<void> => {
      if (styleRebuildPending.current) return
      styleRebuildPending.current = true
      try {
        ensureDataLayers(map)
        gisSeen.current = {}
        clusterLayerIds.current = new Set()
        syncOverlays(map, overlaysRef.current)
        if (datasetSeen.current) {
          try { await loadDataset(map, false) } catch { /* 数据集加载失败忽略，下一轮 poll 补齐 */ }
        }
        await syncLayers(map, lastLayersRef.current, true)
        // setStyle 后 deck 出图需重新注入（deck 在 styledata 自动重注入，但注册表里的图层要主动推回，
        // 防止矢量底图切换后弧线/轨迹/围墙/辐射等 deck 出图丢失）。
        deckRef.current?.syncLayers()
      } catch (err) {
        // 样式未就绪等：忽略，下一轮 poll 补齐
        console.warn('[MapView] rebuildAfterStyleLoad 失败', err)
      } finally {
        styleRebuildPending.current = false
      }
    }
    const mountMap = mapRef.current
    if (mountMap) mountMap.on('style.load', () => { void rebuildAfterStyleLoad(mountMap) })
    // ⚠️ setStyle 对「已存在样式」走 maplibre diff 路径（_diffStyle）：会移除我们加的自定义层/源，
    // 但不触发 style.load → rebuildAfterStyleLoad 不会跑，图层永久消失（OpenFreeMap 等矢量底图切换即此 bug）。
    // 兜底：styledata 触发时若我们的 data-points 层被清掉且本地还有图层记录，强制重建。
    if (mountMap) mountMap.on('styledata', () => {
      if (mountMap.getLayer('data-points') == null && Object.keys(gisSeen.current).length > 0) {
        void rebuildAfterStyleLoad(mountMap)
      }
    })

    const poll = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(sessionUrl(sessionRef.current, '/webgis/state'), { cache: 'no-store' })
        if (!res.ok) return
        const st = (await res.json()) as StateResponse
        if (cancelled) return
        const map = mapRef.current
        if (!map) return

        // AI 出图请求（webgis_export_map）：见新 seq → 预填出图弹窗并打开（用户确认后导出回传）。
        if (st.exportRequest && st.exportRequest.seq !== lastExportSeq.current) {
          lastExportSeq.current = st.exportRequest.seq
          const p = st.exportRequest.params
          openExport(p
            ? { title: p.title, layerIds: p.layerIds, legend: p.legend, north: p.north, scale: p.scale, note: p.note, extent: p.extent }
            : {})
        }

        stBaseTileUrlRef.current = st.baseTileUrl
        // 状态没变 → 整轮跳过（图层同步/导航/捕获全由状态驱动，相同就没有可做的工作）。
        // 长时间挂机时每 1s 轮询只做一次 JSON 序列化比较，不再触发 syncLayers/重渲染/重复请求处理，
        // 内存与 CPU 几乎零开销；SSE `sync` 消息只在状态真变化时才推，那时 fp 才会变。
        const fp = JSON.stringify({ b: st.baseTileUrl, ds: st.dataset, nav: st.navigate, cap: st.capture, ls: st.layers })
        if (fp === pollFpRef.current) return
        pollFpRef.current = fp
        // 仅默认底图才跟随 host 的 baseTileUrl 换瓦片；用户选了别的底图（Esri 影像/矢量样式）不被顶掉。
        if (baseMapRef.current.id === 'default') {
          const baseSource = map.getSource('base') as RasterTileSource | undefined
          const tiles = baseSource?.tiles ?? []
          if (tiles.length > 0 && tiles[0] !== st.baseTileUrl) {
            baseSource?.setTiles([st.baseTileUrl])
          }
        }

        if (st.dataset && st.dataset.name !== datasetSeen.current) {
          datasetSeen.current = st.dataset.name
          try {
            await loadDataset(map)
          } catch {
            // 数据集加载失败忽略，下一轮重试
          }
        } else if (!st.dataset && datasetSeen.current) {
          // 数据集被移除（layer-action remove）：清空 data-points 的要素，地图不再显示。
          datasetSeen.current = ''
          delete dataCache.current.dataset
          const source = map.getSource('data') as GeoJSONSource | undefined
          if (source) source.setData(EMPTY_COLLECTION)
          // 清理 dataset 平面/蜂窝模式下残留的渲染层/源
          for (const suffix of ALL_RENDER_SUFFIXES) {
            const r = RID('dataset', suffix)
            if (map.getLayer(r)) map.removeLayer(r)
          }
          if (map.getSource(SRC('dataset'))) map.removeSource(SRC('dataset'))
          if (map.getSource(SRC_HEX('dataset'))) map.removeSource(SRC_HEX('dataset'))
          deckRef.current?.removeOut('dataset')
        }

        // 结果图层注册表同步（dataset 层由 data-points 处理；此处只渲染 result_* 层）
        // ⚠️ 底图样式整体替换兜底：setStyle 对已存在样式走 maplibre diff（不触发 style.load，也不一定触发 styledata），
        // 我们的自定义层/源会被清掉。只要「本地还有图层记录但 data-points 层已消失」即强制重建（每 1s poll 检查）。
        // 线/面数据集走 gis-dataset-* 层（非 data-points）——diff 后 data-points 可能仍在但 gis-dataset-line/fill 已丢，
        // 单独判缺失强制重建（deck 渲染走 raw 层不在此列，由 controller.syncLayers 恢复）。
        const dsSummary = (st.layers ?? []).find((l) => l.id === 'dataset')
        const dsKinds = dsSummary ? renderKinds(dsSummary.geometryTypes ?? []).filter((k) => k !== 'circle') : []
        const dsMissing = !!dsSummary && dsKinds.length > 0
          && dsSummary.renderer !== 'deck'
          && dsKinds.some((k) => !map.getLayer(RID('dataset', k)))
        if ((Object.keys(gisSeen.current).length > 0 && !map.getLayer('data-points')) || dsMissing) {
          await rebuildAfterStyleLoad(map)
        }
        if (st.layers) {
          await syncLayers(map, st.layers)
          lastLayersRef.current = st.layers
          setLayers(st.layers)
        }

        // 叠加地图服务轮询（~3s 节流）：变化时同步光栅叠加层。
        if (!lastServicesFetch.current || Date.now() - lastServicesFetch.current > 3000) {
          lastServicesFetch.current = Date.now()
          fetch(sessionUrl(sessionRef.current, '/webgis/services'), { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((data: { services?: OverlayService[] } | null) => {
              if (!data?.services) return
              overlaysRef.current = data.services
              syncOverlays(map, data.services)
            })
            .catch(() => {})
        }

        // 蜂窝热力图需俯视才见柱高：有可见蜂窝层 → 自动俯仰 60°；全关后恢复平视。
        // 用 map.isMoving() 守卫，不打断 navigate / fitBounds 等飞行。
        const anyHexVisible = st.layers.some(
          (l) => l.visible && (l.mode ?? 'points') === 'hex' && l.geometryTypes.some((t) => t.includes('Point')),
        )
        if (!map.isMoving()) {
          const pitch = map.getPitch()
          if (anyHexVisible && pitch !== 60) map.setPitch(60, { duration: 500 })
          else if (!anyHexVisible && pitch !== 0) map.setPitch(0, { duration: 500 })
        }

        if (st.navigate && st.navigate.id !== lastNavigateId.current) {
          lastNavigateId.current = st.navigate.id
          const zoom = st.navigate.zoom ?? Math.max(map.getZoom(), 5)
          map.flyTo({ center: [st.navigate.lng, st.navigate.lat], zoom, duration: 1200 })
        }

        // host 请求「捕获当前视图」（用户没点击、直接问"这里是什么地方"）：截当前地图中心，
        // 落中心图钉 + 提取中心要素 + 关联 captureSeq 上报，供等待中的 webgis_get_pick 消费。
        if (st.capture && st.capture.seq !== lastCaptureSeq.current) {
          lastCaptureSeq.current = st.capture.seq
          // 若上一条 navigate 的飞行还没落定，先等地图 idle，避免截到飞行中间帧（中心坐标偏）。
          if (map.isMoving()) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 3000)
              map.once('idle', () => { clearTimeout(timer); resolve() })
            })
          }
          const center = map.getCenter()
          const lng = center.lng
          const lat = center.lat
          closePopup()
          if (markerRef.current) {
            markerRef.current.setLngLat([lng, lat])
          } else {
            markerRef.current = new maplibregl.Marker({ color: '#ef4444' }).setLngLat([lng, lat]).addTo(map)
          }
          const features = queryFeatures(map, map.project(center))
          recordPick(map, lng, lat, features, st.capture.seq, sessionRef.current)
        }
      } catch {
        // 网络/解析错误忽略，下一轮重试
      } finally {
        inFlight = false
      }
    }

    // SSE 状态推送订阅：host 写状态 → 即时触发一轮 poll（交互秒达，主通道）。
    // 3s 心跳轮询只作掉线/SSE 不可用/配置项(baseTileUrl)变更的兜底（EventSource 断线自动重连；
    // 指纹短路让空转心跳几乎零成本）。切回前台立即补一轮，避免隐藏期被浏览器节流的更新滞后。
    let eventSource: EventSource | null = null
    if (typeof EventSource !== 'undefined') {
      try {
        eventSource = new EventSource(sessionUrl(sessionRef.current, '/webgis/events'))
        eventSource.addEventListener('message', () => { void poll() })
      } catch {
        eventSource = null
      }
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(poll, 3000)
    poll()
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      eventSource?.close()
    }
  }, [])

  return (
    <div className={styles.mapView}>
      <div ref={containerRef} className={styles.mapViewCanvas} />
      <div className={styles.mapBottomLeft}>
        <BasemapSwitcher
          baseMap={baseMap}
          onSwitch={async (def) => {
            setBaseMap(def)
            const map = mapRef.current
            if (map) await applyBaseMap(map, def, [stBaseTileUrlRef.current])
          }}
          t={t}
        />
      </div>
      <LayerPanel
        layers={layers}
        sessionId={sessionId}
        t={t}
        onShowAttributes={setAttrLayer}
        mapRef={mapRef}
        onDrawingActive={(active) => { drawingActiveRef.current = active }}
        onExportMap={() => openExport(null)}
      />
      {attrLayer && <AttributeDrawer layer={attrLayer} sessionId={sessionId} t={t} onClose={() => setAttrLayer(null)} />}
      {ExportDialogComp && (
        <ExportDialogComp
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          layers={layers}
          mapRef={mapRef}
          t={t}
          prefill={exportPrefill}
          onExportToAi={(dataUrl, width, height, title) => void postExportImage(dataUrl, width, height, title)}
        />
      )}
    </div>
  )
}
