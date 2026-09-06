/**
 * 地图出图「浏览器侧」：截图（原样/2× 临时放大容器重渲）、PNG 合成（标题/图例/指北针/比例尺/注记）。
 * 版式与几何来自 export-layout（纯函数）。本模块依赖 DOM canvas，仅在浏览器运行，不做 node 单测。
 */
import {
  layoutBoxes,
  northArrowPath,
  scalebarBar,
  type LegendItem,
  type LayoutRect,
  type LegendRowLayout,
} from './export-layout.js'
import type { Map as MapLibreMap } from 'maplibre-gl'

export interface ExportComposeOpts {
  /** 标题（空不画）。 */
  title?: string
  legend?: boolean
  north?: boolean
  scale?: boolean
  /** 底图注记（版权等，空不画）。 */
  note?: string
  /** 当前地图每像素对应米数（比例尺用）。 */
  metersPerPixel?: number
}

export interface ExportImageInput {
  raster: HTMLCanvasElement
  /** 输出画布宽高（等比 contain 放置地图，留白边）。 */
  outW: number
  outH: number
  items: LegendItem[]
  opts: ExportComposeOpts
}

function createCanvas(w: number, h: number): HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') {
    const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
    return c as unknown as HTMLCanvasElement
  }
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function hexToRgbArr(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const n = parseInt(full, 16)
  if (!Number.isFinite(n) || full.length !== 6) return [249, 115, 22]
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function cssColor(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgbArr(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

function strokeText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.strokeStyle = 'rgba(10,18,28,0.85)'
  ctx.lineWidth = Math.max(2, ctx.font.replace(/\D/g, '').length ? 3 : 3) * 0.8
  ctx.lineJoin = 'round'
  ctx.strokeText(text, x, y)
  ctx.fillText(text, x, y)
}

function centerText(ctx: CanvasRenderingContext2D, text: string, rect: LayoutRect): void {
  const w = ctx.measureText(text).width
  const x = rect.x + (rect.w - w) / 2
  const y = rect.y + rect.h * 0.72
  strokeText(ctx, text, x, y)
}

function drawLegendRow(ctx: CanvasRenderingContext2D, row: LegendRowLayout, item: LegendItem, textH: number): void {
  const chipX = row.x
  const chipY = row.y + row.h * 0.2
  const chipH = row.h * 0.6
  const chipW = Math.max(6, chipH)
  if (item.kind === 'circle') {
    ctx.beginPath()
    ctx.arc(chipX + chipW / 2, row.y + row.h / 2, chipH / 2 - 1, 0, Math.PI * 2)
    ctx.fillStyle = item.fill
    ctx.fill()
    ctx.lineWidth = 1.5
    ctx.strokeStyle = item.stroke
    ctx.stroke()
  } else if (item.kind === 'line') {
    ctx.beginPath()
    ctx.moveTo(chipX, row.y + row.h / 2)
    ctx.lineTo(chipX + chipW, row.y + row.h / 2)
    ctx.lineWidth = Math.max(2, chipH / 3)
    ctx.strokeStyle = item.stroke
    ctx.stroke()
  } else {
    ctx.fillStyle = item.fill
    ctx.fillRect(chipX, chipY, chipW, chipH)
    ctx.strokeStyle = item.stroke
    ctx.lineWidth = 1
    ctx.strokeRect(chipX + 0.5, chipY + 0.5, chipW - 1, chipH - 1)
  }
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'middle'
  ctx.fillText(item.name + (item.note ? ` ${item.note}` : ''), row.x + chipW + textH * 0.8, row.y + row.h / 2)
}

function drawLayout(
  ctx: CanvasRenderingContext2D,
  layout: ReturnType<typeof layoutBoxes>,
  items: LegendItem[],
  opts: ExportComposeOpts,
  fontSize: number,
): void {
  ctx.font = `600 ${fontSize}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
  ctx.textBaseline = 'alphabetic'
  if (layout.title && opts.title) {
    ctx.fillStyle = '#fff'
    centerText(ctx, opts.title, layout.title)
  }
  const rows = layout.legend?.rows ?? []
  if (rows.length) {
    // 半透明深色卡
    ctx.fillStyle = 'rgba(13,22,32,0.82)'
    const box = layout.legend!.box
    ctx.beginPath()
    ctx.roundRect(box.x, box.y, box.w, box.h, Math.max(4, fontSize * 0.4))
    ctx.fill()
    rows.forEach((row, i) => drawLegendRow(ctx, row, items[i] ?? { name: '', fill: '#ccc', stroke: '#ccc', kind: 'fill', note: '' }, fontSize))
  }
  if (layout.north) {
    const cx = layout.north.x + layout.north.w / 2
    const cy = layout.north.y + layout.north.h / 2
    const path = northArrowPath(cx, cy, layout.north.w * 0.3)
    const first = path[0]!
    ctx.beginPath()
    ctx.moveTo(first[0], first[1])
    for (const [x, y] of path.slice(1)) ctx.lineTo(x, y)
    ctx.closePath()
    ctx.fillStyle = 'rgba(13,22,32,0.82)'
    ctx.fill()
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.stroke()
    // N 字
    ctx.fillStyle = '#fff'
    ctx.font = `700 ${fontSize}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', cx, cy - layout.north.w * 0.42)
    ctx.textAlign = 'start'
    ctx.textBaseline = 'alphabetic'
  }
  if (layout.scale && opts.metersPerPixel && opts.metersPerPixel > 0) {
    const bar = scalebarBar(opts.metersPerPixel, layout.scale.w)
    const padY = layout.scale.y + layout.scale.h * 0.5
    // 底色暗卡
    ctx.fillStyle = 'rgba(13,22,32,0.82)'
    ctx.fillRect(layout.scale.x - 4, layout.scale.y - 2, bar.pixels + 8, layout.scale.h + 4)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 2
    ctx.strokeRect(layout.scale.x, padY, bar.pixels, 0)
    // 等分两段白/黑交替
    const seg = bar.pixels / 2
    for (let i = 0; i < 2; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#fff' : '#000'
      ctx.fillRect(layout.scale.x + i * seg, padY, seg, 4)
    }
    ctx.fillStyle = '#fff'
    ctx.font = `600 ${fontSize * 0.85}px sans-serif`
    ctx.fillText(bar.label, layout.scale.x, layout.scale.y - fontSize * 0.3)
  }
  if (layout.note && opts.note) {
    ctx.fillStyle = '#fff'
    ctx.font = `500 ${fontSize * 0.8}px sans-serif`
    const y = layout.note.y + layout.note.h * 0.72
    ctx.textBaseline = 'alphabetic'
    strokeText(ctx, opts.note, layout.note.x, y)
  }
}

/** 等 map 空闲（含 3s 兜底超时）。 */
export function waitMapIdle(map: MapLibreMap, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs)
    function done(): void {
      clearTimeout(timer)
      resolve()
    }
    map.once('idle', done)
  })
}

/** 把当前 canvas 复制成独立离屏 canvas（原样分辨率）。 */
function rasterCopy(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(canvas.width, canvas.height)
  const ctx = out.getContext('2d')
  if (ctx) ctx.drawImage(canvas, 0, 0)
  return out
}

const MAX_CANVAS_PX = 8192

/**
 * 截图：scale=1 直接复制当前画布；scale=2 临时把容器放大 2× → resize → 等 idle → 截 → 恢复。
 * 超浏览器画布上限自动回退 1×。返回独立 canvas。
 */
export async function captureMapRaster(map: MapLibreMap, scale = 1): Promise<HTMLCanvasElement | null> {
  const container = map.getContainer()
  const cssW = container.clientWidth
  const cssH = container.clientHeight
  const doubled = scale >= 2 && cssW * 2 * (window.devicePixelRatio || 1) <= MAX_CANVAS_PX && cssH * 2 * (window.devicePixelRatio || 1) <= MAX_CANVAS_PX
  if (!doubled) return rasterCopy(map.getCanvas())
  container.style.width = `${Math.round(cssW * 2)}px`
  container.style.height = `${Math.round(cssH * 2)}px`
  try {
    map.resize()
    await waitMapIdle(map)
    return rasterCopy(map.getCanvas())
  } finally {
    container.style.width = ''
    container.style.height = ''
    map.resize()
  }
}

/**
 * 合成出图：把地图光栅 contain 放进 outW×outH（白边），再叠 标题/图例/指北针/比例尺/注记。
 * 返回新 canvas；导出下载/上传由调用方处理。
 */
export function composeExportImage(input: ExportImageInput): HTMLCanvasElement {
  const { raster, outW, outH, items, opts } = input
  const out = createCanvas(outW, outH)
  const ctx = out.getContext('2d')
  if (!ctx) return out
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, outW, outH)
  // 地图 contain（保持纵横比）
  const s = Math.min(outW / raster.width, outH / raster.height)
  const dw = raster.width * s
  const dh = raster.height * s
  const dx = (outW - dw) / 2
  const dy = (outH - dh) / 2
  ctx.drawImage(raster, dx, dy, dw, dh)
  // 细边框框住地图区
  ctx.strokeStyle = 'rgba(60,70,80,0.6)'
  ctx.lineWidth = 1
  ctx.strokeRect(dx + 0.5, dy + 0.5, dw - 1, dh - 1)
  // 版式（用整幅画布摆放，字号随宽度缩放）
  const fontSize = Math.max(10, Math.round(outW * 0.018))
  const layout = layoutBoxes(outW, outH, items, {
    title: opts.title,
    legend: opts.legend,
    north: opts.north,
    scale: opts.scale,
    note: opts.note,
  })
  drawLayout(ctx, layout, items, opts, fontSize)
  return out
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, type = 'image/png'): string {
  return canvas.toDataURL(type)
}
