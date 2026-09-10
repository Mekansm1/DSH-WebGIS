/**
 * host 侧地图截图相关：模型图像能力探测、截图元信息换算、前端上报截图的解析。
 * 拆分自 src/index.ts：依赖 ctx.attachments / ctx.llm、geo.js 的像素↔经纬度换算与 session-state 类型。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { GeoViewport } from './geo.js'
import { unprojectCssToLngLat } from './geo.js'
import type { PickScreenshot } from './session-state.js'
import type { GisLayer } from './geo-processing.js'

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

/** 一个可见图层在「当前画面」里的摘要。 */
export interface LayerDigest {
  id: string
  name: string
  geometryTypes: string[]
  featureCount: number
  /** 画面上这一层的颜色（填充色优先）——**视觉模型靠它把图上的色块对应到具体图层**，所以必须给当前值。 */
  color: string
  /** 当前展示方式（points/plane/hex/arc/trips/wall/radial）。 */
  mode: string
  bbox: number[] | null
  /** 是否与当前视野相交（false = 图层可见但此刻不在画面内）。 */
  inView: boolean
  /** 大文件抽样展示时的真实总行数。 */
  totalCount?: number
}

export interface LayerDigestResult {
  /** 可见图层（视野内的排在前面）。隐藏图层不在图上，不列入。 */
  items: LayerDigest[]
  /** 可见但不在当前视野内的图层数。 */
  offView: number
  /** 已隐藏（不在图上）的图层数。 */
  hidden: number
}

/** 两个 [w,s,e,n] 包围盒是否相交；任一侧缺 bbox 视为无法判断 → 交给调用方按 true 处理。 */
function bboxOverlaps(a: number[], b: number[]): boolean {
  return !(a[2]! < b[0]! || a[0]! > b[2]! || a[3]! < b[1]! || a[1]! > b[3]!)
}

/**
 * 「当前图上有什么」的图层摘要：只列**可见**图层，按「视野内 → 要素多」排序，
 * 并诚实地报出视野外与已隐藏的数量（不过滤掉、也不假装它们不存在）。
 * bbox 缺任一（视野未知 / 空图层）时按 inView=true 处理 —— 宁可不说，也不误报"不在画面里"。
 */
export function layerDigest(layers: GisLayer[], view: number[] | null): LayerDigestResult {
  const items: LayerDigest[] = []
  let hidden = 0
  let offView = 0
  for (const l of layers) {
    if (!l.visible) { hidden++; continue }
    const bbox = l.bbox as number[] | null
    const inView = !view || !bbox ? true : bboxOverlaps(bbox, view)
    if (!inView) offView++
    items.push({
      id: l.id,
      name: l.name,
      geometryTypes: l.geometryTypes ?? [],
      featureCount: l.featureCount,
      // 填充色优先：面上看到的色块就是 fillColor（缺省才回落到整体色）
      color: l.fillColor ?? l.color,
      mode: l.mode,
      bbox,
      inView,
      ...(l.materialized === false && l.totalCount != null ? { totalCount: l.totalCount } : {}),
    })
  }
  items.sort((a, b) => (a.inView === b.inView ? b.featureCount - a.featureCount : a.inView ? -1 : 1))
  return { items, offView, hidden }
}

/** 图层摘要 → 给模型看的一行（文本模型/视觉模型都要靠它把色块对上图层）。 */
export function digestLine(d: LayerDigest): string {
  const kind = d.geometryTypes.length ? d.geometryTypes.join('/') : '无几何'
  const sampled = d.totalCount != null ? `（抽样显示，共 ${d.totalCount} 行）` : ''
  return `${d.name}（id=${d.id}，${kind}，${d.featureCount} 个要素${sampled}，颜色 ${d.color}，展示 ${d.mode}）`
    + (d.inView ? '' : '【不在当前视野内】')
}

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
