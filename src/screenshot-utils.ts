/**
 * host 侧地图截图相关：模型图像能力探测、截图元信息换算、前端上报截图的解析。
 * 拆分自 src/index.ts：依赖 ctx.attachments / ctx.llm、geo.js 的像素↔经纬度换算与 session-state 类型。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { GeoViewport } from './geo.js'
import { unprojectCssToLngLat } from './geo.js'
import type { PickScreenshot } from './session-state.js'

/** 工具输出 canonical 值里携带的截图元信息（render 用它构造图片块与换算提示文本）。 */
export interface ScreenshotMeta {
  width: number
  height: number
  scale: number
  pin: { x: number; y: number }
  /** 截图四角换算出的地理覆盖范围（文本模型不真看图也能据此推断区域）。 */
  extent: { west: number; south: number; east: number; north: number }
  ref: ImageAttachmentRef
}

/** (provider:model) → 是否支持图像输入的缓存，避免每次工具调用都解析模型。 */
const imageCapabilityCache = new Map<string, boolean>()

/** 查询当前 agent 所用模型是否支持图像输入；未知/解析失败保守返回 false（不附截图，避免文本模型炸对话）。 */
export async function modelSupportsImage(ctx: Context, exec: { agent?: { options?: { provider?: string; model?: string } } }): Promise<boolean> {
  const provider = exec.agent?.options?.provider
  const model = exec.agent?.options?.model
  if (!provider || !model) return false
  const key = `${provider}:${model}`
  const cached = imageCapabilityCache.get(key)
  if (cached !== undefined) return cached
  let supported = false
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model)
    supported = info.inputModalities?.includes('image') ?? false
  } catch {
    supported = false
  }
  imageCapabilityCache.set(key, supported)
  return supported
}

/** 把 PickScreenshot 投影为工具输出可携带的元信息（attachmentId 可 JSON 化，render 再还原成 ImageBlock）。 */
export function screenshotMeta(shot: PickScreenshot): ScreenshotMeta {
  const w = shot.ref.width
  const h = shot.ref.height
  const cssW = w / shot.scale
  const cssH = h / shot.scale
  const corners = [
    unprojectCssToLngLat(shot.viewport, 0, 0),
    unprojectCssToLngLat(shot.viewport, cssW, 0),
    unprojectCssToLngLat(shot.viewport, 0, cssH),
    unprojectCssToLngLat(shot.viewport, cssW, cssH),
  ]
  const lngs = corners.map((c) => c.lng)
  const lats = corners.map((c) => c.lat)
  return {
    width: w,
    height: h,
    scale: shot.scale,
    pin: shot.pin,
    extent: {
      west: Math.min(...lngs),
      east: Math.max(...lngs),
      south: Math.min(...lats),
      north: Math.max(...lats),
    },
    ref: {
      attachmentId: shot.ref.attachmentId,
      mediaType: shot.ref.mediaType,
      bytes: shot.ref.bytes,
      width: w,
      height: h,
      name: shot.ref.name,
    },
  }
}

/** 解析前端上报的截图：base64 dataURL → 附件服务持久化 → PickScreenshot。解析失败返回 null。 */
export async function parseScreenshot(ctx: Context, raw: unknown): Promise<PickScreenshot | null> {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const dataUrl = typeof s.dataUrl === 'string' ? s.dataUrl : ''
  const decoded = decodeDataUrl(dataUrl)
  const viewport = parseViewport(s.viewport)
  if (!decoded || !viewport) return null
  const scale = toFiniteNum(s.scale, 1) > 0 ? toFiniteNum(s.scale, 1) : 1
  const p = s.pin as Record<string, unknown> | null
  const pin = p && typeof p === 'object'
    ? { x: toFiniteNum(p.x, 0), y: toFiniteNum(p.y, 0) }
    : { x: 0, y: 0 }
  const ref = await ctx.attachments.saveImage({ data: decoded.bytes, mediaType: decoded.mediaType, name: 'webgis-map' })
  return { ref, scale, pin, viewport }
}

/** 解析并校验截图视口（中心为 [lng, lat] 数组），缺失/非法返回 null。 */
export function parseViewport(raw: unknown): GeoViewport | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const width = toFiniteNum(v.width, NaN)
  const height = toFiniteNum(v.height, NaN)
  const zoom = toFiniteNum(v.zoom, NaN)
  const bearing = toFiniteNum(v.bearing, 0)
  const pitch = toFiniteNum(v.pitch, 0)
  const centerLng = toFiniteNum(v.centerLng, NaN)
  const centerLat = toFiniteNum(v.centerLat, NaN)
  if (!(width > 0) || !(height > 0) || !(zoom >= 0) || !(zoom <= 30)
    || !Number.isFinite(centerLng) || !Number.isFinite(centerLat)) {
    return null
  }
  return { width, height, zoom, bearing, pitch, centerLng, centerLat }
}

function toFiniteNum(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** 解析 base64 dataURL 图片为字节 + 媒体类型；非法返回 null。 */
export function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mediaType: ImageMediaType } | null {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl)
  if (!m) return null
  const buf = Buffer.from(m[2] ?? '', 'base64')
  if (!buf.length) return null
  return {
    bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
    mediaType: m[1]!.toLowerCase() as ImageMediaType,
  }
}
