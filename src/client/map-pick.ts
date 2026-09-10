/**
 * 地图点击/捕获链路：要素拾取、属性浮窗截图（红点=用户点击位置，仅点击时才有）、pick 上报、按范围缩放。
 * 自 MapView.tsx 拆分。
 */
import type { Point, Map as MapLibreMap } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { sessionUrl } from './sessionUrl.js'
import type { FeaturePayload } from './gis-types.js'

/** 提取地图上某像素点命中的要素（点击 / 图框中心捕获共用）。 */
export function queryFeatures(map: MapLibreMap, point: Point): FeaturePayload[] {
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

/** 截图上报 payload：与 host 端 parseScreenshot 约定的结构。 */
export interface ScreenshotPayload {
  dataUrl: string
  scale: number
  pin: { x: number; y: number }
  /** 图上是否画了红点。**只有用户手动点击底图才画**；捕获当前视野时没有关注点，不画。
   *  host 据此决定文案里是否提「红点」，避免模型把画面中心当成用户指定的位置。 */
  pinned: boolean
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

/** 收集 GeoJSON 里所有坐标对，用于计算 bbox。 */
export function collectCoords(geo: unknown, out: number[][]): void {
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

/**
 * 截取地图模块（仅 WebGL canvas，不含任何 DOM）：把 canvas 画到 2D canvas 上、
 * 在关注位置合成红色图钉、限制最大边长后输出 PNG dataURL。同时记录截图那一刻的
 * 视口与缩放，供 host 做「截图像素 ↔ 经纬度」换算（不依赖之后的 live map）。
 * 失败（无 canvas / 无 2d context）返回 null，调用方降级为仅上报坐标。
 *
 * @param withPin 是否在 (lng, lat) 画红点。**只有用户手动点击底图才传 true** ——
 *   捕获当前视野时没有"用户指定的位置"，画上去的红点只会让模型把画面中心当成关注点，
 *   还会引它去比对两个不同来源的红点（实测踩过）。
 */
export function captureMapScreenshot(map: MapLibreMap, lng: number, lat: number, withPin = true): ScreenshotPayload | null {
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

  // 关注位置的像素坐标：map.project 给 css 像素 → 换算到输出图像像素（scale = 图像px / css px）
  const pinCss = map.project([lng, lat])
  const scale = w / cssWidth
  const pinX = pinCss.x * scale
  const pinY = pinCss.y * scale
  if (withPin) drawPin(ctx, pinX, pinY, Math.max(5, 10 * scale))

  const center = map.getCenter()
  return {
    dataUrl: out.toDataURL('image/png'),
    scale,
    pin: { x: pinX, y: pinY },
    pinned: withPin,
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
export function drawPin(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = '#ef4444'
  ctx.fill()
  ctx.lineWidth = Math.max(1.5, r * 0.22)
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
}

export function fitToGeoJSON(map: MapLibreMap, geojson: unknown): void {
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

/** 右键清除图钉：通知 host 清掉最近一次 pick（坐标/要素/截图），后续 webgis_get_pick 将重新捕获当前视图。 */
export function clearPick(sessionId?: string): void {
  fetch(sessionUrl(sessionId, '/webgis/pick'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  }).catch(() => {})
}

/**
 * 记录点击/捕获 pick 并上报 host：截地图模块截图 → POST /webgis/pick。返回截图（可能 null）。
 * @param withPin 是否在图上画红点（见 captureMapScreenshot）；捕获当前视野传 false。
 */
export function recordPick(
  map: MapLibreMap,
  lng: number,
  lat: number,
  features: FeaturePayload[],
  captureSeq?: number,
  sessionId?: string,
  withPin = true,
): ScreenshotPayload | null {
  const shot = captureMapScreenshot(map, lng, lat, withPin)
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
