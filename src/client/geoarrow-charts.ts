/**
 * deck.gl GeoArrow 图层构造：大文件点/线图层按 Arrow 二进制直吃（@geoarrow/deck.gl-geoarrow）。
 *
 * >10 万图层走「deck 原始数据」渲染路径时，客户端 fetch /webgis/arrow → tableFromIPC 还原 GeoArrow
 * Table（ARROW:extension:name 定位几何列）→ 这里按几何类型构造对应 GeoArrow 图层，挂 MapboxOverlay。
 *
 * - 点 → GeoArrowScatterplotLayer
 * - 线 → GeoArrowPathLayer（无 worker 依赖）
 * - 面 → GeoArrowPolygonLayer（threads 的 node 内置已用 tsdown NODE_SHIMS 垫平，earcut worker 自托管）
 *   —— 三者均可拾取（带 __rid 行号列 → host 按 rowid 回查整行属性）。
 * - host 层：多几何族混合表禁用 Arrow（避免静默只编主族），回退 geojson → 本文件 makeRawGeojsonLayers。
 *
 * 另提供 geojson 兜底渲染（materialized 大层 / 多族混合）：按几何族一族一层 Scatterplot/Path/PolygonLayer。
 *
 * ⚠️ 本模块依赖 @geoarrow/deck.gl-geoarrow（内部无扩展名相对 import，Node ESM 解析不了），
 * 只能经 client bundle（tsdown）验证；纯逻辑在 geoarrow-utils.ts 可 Node 单测。
 */
import { GeoArrowPathLayer, GeoArrowPolygonLayer, GeoArrowScatterplotLayer } from '@geoarrow/deck.gl-geoarrow'
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers'
import type { Layer } from '@deck.gl/core'
import type { Table } from 'apache-arrow'
import type { FeatureCollection } from 'geojson'
import { geojsonFamilies, geometryKindOf, hexToRgb, rawLineData, rawPointData, rawPolygonData } from './geoarrow-utils.js'
import { NO_DATA_COLOR, type ThematicSpec } from './gis-types.js'

export interface GeoArrowSpec {
  id: string
  color: string
  visible: boolean
  /** 点位半径（像素，与 maplibre circle-radius 同语义；缺省 4）。 */
  radius?: number
  /** 面图层 earcut worker URL（自托管 /webgis/earcut-worker.js；缺省 null = 主线程 earcut）。 */
  earcutWorkerUrl?: string | null
  /** 专题配色：设置后每个要素按字段值取色，覆盖 color。 */
  thematic?: ThematicSpec
}

/** #[rgb] / #rrggbb → [r,g,b]（失败回中性灰）。 */
function rgbOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex).trim())
  if (!m) return [156, 163, 175]
  let h = m[1]!
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** 编译一份「属性值 → RGB」的判定器（LUT 与 geojson accessor 共用同一套规则）。 */
export function compileThematic(spec: ThematicSpec): (raw: unknown) => [number, number, number] {
  const rgbList = spec.colors.map(rgbOf)
  const noData = rgbOf(NO_DATA_COLOR)
  const byCat = new Map<string, [number, number, number]>()
  if (spec.categories) spec.categories.forEach((c, i) => byCat.set(c, rgbList[i] ?? noData))
  return (raw: unknown): [number, number, number] => {
    if (raw == null || raw === '') return noData // 缺值单独一色，绝不落进任何一级
    if (spec.categories) return byCat.get(String(raw)) ?? noData
    const x = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(x)) return noData
    let idx = 0
    while (idx < spec.breaks.length && x > spec.breaks[idx]!) idx++
    return rgbList[idx] ?? noData
  }
}

/**
 * 专题配色 → 逐行颜色查找表（Uint8Array，每行 4 字节 RGBA）。
 *
 * 一次性预计算而非在 accessor 里逐帧判断：65 万行的 accessor 每帧都会跑，
 * 在里面查断点/比字符串会拖垮帧率。字段不在 Arrow schema 里 → 返回 null，
 * 调用方退回单色（**不要**静默画成灰，那会让人以为「全是缺值」）。
 */
export function thematicLut(table: Table, spec: ThematicSpec, alpha: number): Uint8Array | null {
  const col = table.getChild(spec.field)
  if (!col) return null
  const n = table.numRows
  const pick = compileThematic(spec)
  const out = new Uint8Array(n * 4)
  for (let i = 0; i < n; i++) {
    const rgb = pick(col.get(i))
    const o = i * 4
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2]; out[o + 3] = alpha
  }
  return out
}

/** 由查表构造 deck accessor。 */
function lutAccessor(lut: Uint8Array): (o: unknown, info: { index: number }) => [number, number, number, number] {
  return (_o, info) => {
    const i = info.index * 4
    return [lut[i]!, lut[i + 1]!, lut[i + 2]!, lut[i + 3]!]
  }
}

/** 面图层填充色 accessor：180 透明度的专题查表（无该字段则退回单色）。 */
function polygonFillAccessor(table: Table, spec: ThematicSpec): unknown {
  const lut = thematicLut(table, spec, 180)
  return lut ? lutAccessor(lut) : null
}

/** 按几何类型构造 GeoArrow 图层：点 → Scatterplot；线 → Path；面 → Polygon。 */
export function makeGeoArrowLayers(spec: GeoArrowSpec, table: Table): Layer[] {
  const [r, g, b] = hexToRgb(spec.color)
  // 专题配色：预算逐行 RGBA 查表（见 thematicLut）。字段不在 Arrow schema 里 → 退回单色。
  const lut = spec.thematic ? thematicLut(table, spec.thematic, 255) : null
  const fillAccessor = lut ? lutAccessor(lut) : [r, g, b, 255]
  const kind = geometryKindOf(table)
  const common = {
    id: `deck-${spec.id}-raw`,
    // @geoarrow/deck.gl-geoarrow 的 data 声明为 RecordBatch；Table 与其有同构 schema/getChildAt，运行时可用（参考项目同法）。
    data: table as never,
    visible: spec.visible,
    // 全几何可拾取：命中行带 __rid（duckGeom 路径 rowid()）→ MapView 调 /webgis/arrow-rid 回查整行属性。
    pickable: true,
  }
  if (kind === 'point') {
    return [new GeoArrowScatterplotLayer({ ...common, getFillColor: fillAccessor as never, getRadius: spec.radius ?? 4, radiusUnits: 'pixels' })]
  }
  if (kind === 'line') {
    return [new GeoArrowPathLayer({ ...common, getColor: fillAccessor as never, getWidth: 2, widthUnits: 'pixels' })]
  }
  if (kind === 'polygon') {
    return [new GeoArrowPolygonLayer({
      ...common,
      filled: true,
      stroked: true,
      // 填充单独算一张 180 透明度的查表（面不透明会盖住底图）；只算这一次，不重复。
      getFillColor: (spec.thematic ? polygonFillAccessor(table, spec.thematic) : [r, g, b, 180]) as never,
      getLineColor: fillAccessor as never,
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      // 自托管 earcut worker（worker 线程池并行剖分，百万面可用）；拿不到则主线程 earcut 兜底。
      earcutWorkerUrl: spec.earcutWorkerUrl ?? null,
    })]
  }
  return []
}

/** 全量物化/混合几何的 geojson → deck 原始层：按几何族**一族一层**（点/线/面各自子层），
 *  混合数据不再只画第一种几何；子层 id 带 `-raw-<kind>` 后缀供点击按族定位过滤数组。 */
export function makeRawGeojsonLayers(spec: GeoArrowSpec, geojson: FeatureCollection): Layer[] {
  const [r, g, b] = hexToRgb(spec.color)
  // 专题配色：逐要素按属性取值（这条路径的数据量在阈值以内，直接逐帧查表可接受）。
  const pick = spec.thematic ? compileThematic(spec.thematic) : null
  const field = spec.thematic?.field
  const colorOf = (f: { properties?: Record<string, unknown> | null }): [number, number, number] =>
    (pick && field ? pick(f.properties?.[field]) : [r, g, b])
  const alphaOf = (base: [number, number, number], a: number): [number, number, number, number] => [base[0], base[1], base[2], a]
  const out: Layer[] = []
  for (const kind of geojsonFamilies(geojson)) {
    const id = `deck-${spec.id}-raw-${kind}`
    if (kind === 'line') {
      out.push(new PathLayer({
        id,
        data: rawLineData(geojson),
        getPath: (f) => f.geometry.coordinates,
        getColor: (f) => alphaOf(colorOf(f), 255) as never,
        getWidth: 2,
        widthUnits: 'pixels',
        visible: spec.visible,
        pickable: true,
      }))
    } else if (kind === 'polygon') {
      out.push(new PolygonLayer({
        id,
        data: rawPolygonData(geojson),
        getPolygon: (f) => f.geometry.coordinates,
        getFillColor: (f) => alphaOf(colorOf(f), 180) as never,
        getLineColor: (f) => alphaOf(colorOf(f), 255) as never,
        getLineWidth: 1,
        lineWidthUnits: 'pixels',
        visible: spec.visible,
        pickable: true,
      }))
    } else {
      out.push(new ScatterplotLayer({
        id,
        data: rawPointData(geojson),
        getPosition: (f) => f.geometry.coordinates as [number, number],
        getFillColor: (f) => alphaOf(colorOf(f), 255) as never,
        getRadius: spec.radius ?? 4,
        radiusUnits: 'pixels',
        visible: spec.visible,
        pickable: true,
      }))
    }
  }
  return out
}
