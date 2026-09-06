/**
 * 地图出图「版式/图例」纯逻辑：无 DOM，可 node 单测。
 * 实际 canvas 绘制在 ExportMapDialog / MapView 里按这里算出的几何/色块/刻度进行。
 * 本模块不得运行时 import 任何 i18n/locale 值（node 单测直接 import）；本地化文案以
 * 可选 `t` 函数参数注入，缺省保持中文原样（tests 锁定该默认值）。
 */
import type { WebgisT } from './webgis-i18n.js'

/** 出图图例的来源图层（结构兼容 MapView 的 LayerSummary，只取需要的字段）。 */
export interface LegendSource {
  id: string
  name: string
  visible?: boolean
  color?: string
  fillColor?: string
  geometryTypes?: string[]
  materialized?: boolean
  featureCount?: number
  totalCount?: number
}

export type LegendKind = 'fill' | 'line' | 'circle'

export interface LegendItem {
  name: string
  /** 主色块（面=填充、点=圆填充、线=线色）。 */
  fill: string
  /** 描边/线色（面/点的边界；线图例即线色）。 */
  stroke: string
  kind: LegendKind
  /** 抽样注记（如“共 130176，抽样”），无则空。 */
  note: string
}

/** 图层几何 → 图例形态：面优先，其次线，最后点。 */
function kindOf(geometryTypes: string[] | undefined): LegendKind {
  if (geometryTypes?.some((t) => t === 'Polygon' || t === 'MultiPolygon')) return 'fill'
  if (geometryTypes?.some((t) => t === 'LineString' || t === 'MultiLineString')) return 'line'
  return 'circle'
}

/**
 * 从图层摘要生成图层级图例项（保持图层顺序）。
 * opts.ids：仅列指定 id 的层；缺省列全部。仅列可见层（visible!==false）。
 */
export function legendItemsFromLayers(
  layers: readonly LegendSource[],
  opts: { ids?: readonly string[]; t?: WebgisT } = {},
): LegendItem[] {
  const selected = opts.ids ? new Set(opts.ids) : null
  const items: LegendItem[] = []
  for (const layer of layers) {
    if (layer.visible === false) continue
    if (selected && !selected.has(layer.id)) continue
    const kind = kindOf(layer.geometryTypes)
    const fill = layer.fillColor ?? layer.color ?? '#f97316'
    const stroke = layer.color ?? fill
    const sampled = layer.materialized === false && layer.totalCount != null && layer.featureCount != null
      && layer.totalCount > layer.featureCount
    items.push({
      name: layer.name,
      fill,
      stroke,
      kind,
      // 有 t 走本地化注记；无 t（node 单测/旧调用）保持中文原样。
      note: sampled
        ? (opts.t
            ? opts.t('legend.sampled', { total: layer.totalCount, count: layer.featureCount })
            : `（共 ${layer.totalCount}，抽样 ${layer.featureCount}）`)
        : '',
    })
  }
  return items
}

/** 指北针外轮廓点集（中心 cx,cy；size=总高度一半），画 fill 后即得箭头。 */
export function northArrowPath(cx: number, cy: number, size: number): Array<[number, number]> {
  const s = size
  return [
    [cx, cy - s],
    [cx + s * 0.34, cy - s * 0.2],
    [cx + s * 0.24, cy + s * 0.08],
    [cx + s * 0.46, cy + s * 0.6],
    [cx, cy + s * 0.32],
    [cx - s * 0.46, cy + s * 0.6],
    [cx - s * 0.24, cy + s * 0.08],
    [cx - s * 0.34, cy - s * 0.2],
  ]
}

/** 米数 → 刻度标签（<1000 m 用 m，否则 km）。 */
export function formatMeters(meters: number): string {
  if (meters >= 1000) {
    const km = meters / 1000
    return `${km % 1 === 0 ? String(km) : km.toFixed(1)} km`
  }
  return `${Math.round(meters)} m`
}

/**
 * 比例尺单段：挑一个「刚好装得下、又接近 35% 带宽」的圆整米数（1/2/5×10^k）。
 * 返回 meters 及换算像素，供绘制与标签。
 */
export function scalebarBar(
  metersPerPixel: number,
  maxWidthPx: number,
  fraction = 0.35,
): { meters: number; pixels: number; label: string } {
  const safe = Math.max(0.001, metersPerPixel)
  const targetM = Math.max(1, maxWidthPx * fraction * safe)
  const maxM = maxWidthPx * safe
  const e = Math.floor(Math.log10(targetM))
  for (const d of [5, 2, 1]) {
    const cand = d * 10 ** e
    if (cand <= maxM) {
      const pixels = cand / safe
      return { meters: cand, pixels, label: formatMeters(cand) }
    }
  }
  const cand = 10 ** (e - 1)
  return { meters: cand, pixels: cand / safe, label: formatMeters(cand) }
}

/** 导出文件名：清洗非法字符，空标题兜底，追加日期。非法则 ASCII 化处理保留中文。 */
export function exportFilename(title: string | undefined, now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  const base = (title ?? '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  const name = base === '' ? 'webgis-map' : base
  return `${name}-${date}.png`
}

/** 一个排版矩形。 */
export interface LayoutRect { x: number; y: number; w: number; h: number }

/** 图例行（含色块坐标；name 文本由绘制方 measureText 定位）。 */
export interface LegendRowLayout extends LayoutRect {
  fill: string
  stroke: string | null
  kind: LegendKind
}

export interface ExportLayout {
  margin: number
  title?: LayoutRect
  legend?: { box: LayoutRect; rows: LegendRowLayout[] }
  north?: LayoutRect
  scale?: LayoutRect
  note?: LayoutRect
}

/** 把标题/图例/指北针/比例尺/注记摆进画布，返回各矩形（图例含逐行）。确定性、便于单测。 */
export function layoutBoxes(
  w: number,
  h: number,
  items: readonly LegendItem[],
  opts: { title?: string; legend?: boolean; north?: boolean; scale?: boolean; note?: string },
): ExportLayout {
  const out: ExportLayout = { margin: 0 }
  if (w <= 0 || h <= 0) return out
  const m = Math.max(8, Math.round(Math.min(w, h) * 0.02))
  out.margin = m

  const titleH = opts.title ? Math.max(22, Math.round(h * 0.045)) : 0
  if (opts.title && titleH > 0) {
    out.title = { x: m, y: m, w: Math.max(0, w - 2 * m), h: titleH }
  }

  const rowH = Math.max(18, Math.round((w + h) * 0.006))
  const pad = Math.max(6, rowH * 0.5)
  const legendRows = opts.legend
    ? items.map((it) => ({ x: 0, y: 0, w: 0, h: rowH, fill: it.fill, stroke: it.stroke, kind: it.kind }))
    : []
  if (legendRows.length > 0) {
    const rowW = Math.round(w * 0.3)
    const boxH = pad * 2 + legendRows.length * rowH
    const legendX = m
    const legendY = Math.max(0, h - m - boxH - (opts.scale ? Math.max(20, rowH) : 0))
    legendRows.forEach((r, i) => {
      r.x = legendX + pad
      r.y = legendY + pad + i * rowH
      r.w = rowW - pad * 2
    })
    out.legend = { box: { x: legendX, y: legendY, w: rowW, h: boxH }, rows: legendRows }
  }

  if (opts.north) {
    const size = Math.max(16, Math.round(Math.min(w, h) * 0.03))
    const n = size * 1.6
    const top = (out.title ? out.title.y + out.title.h + m : m)
    out.north = { x: Math.max(0, w - m - n), y: top, w: n, h: n }
  }

  if (opts.scale) {
    const barH = Math.max(14, Math.round(rowH * 0.6))
    const y = h - m - barH
    out.scale = { x: m, y, w: Math.min(w * 0.3, 240), h: barH }
  }

  if (opts.note) {
    const nh = Math.max(14, Math.round(rowH * 0.7))
    out.note = {
      x: m,
      y: Math.max(0, (out.scale ? out.scale.y - nh - m * 0.5 : h - m - nh)),
      w: Math.max(0, w - 2 * m),
      h: nh,
    }
  }
  return out
}
