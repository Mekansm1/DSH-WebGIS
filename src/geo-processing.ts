/**
 * 矢量地理处理：图层注册表模型 + Turf 操作封装。
 *
 * 纯函数、无 DSH/ctx 依赖，便于 node 单测。
 * 图层注册表是 source-agnostic 的：基础数据集、Turf 结果、（未来的）PostGIS 查询结果
 * 都走同一条「产出 FeatureCollection → 注册 → 上图」管道，这里只定义模型与操作。
 *
 * Turf v7 注意点：
 * - intersect/difference 是单要素成对函数 → 叠加类操作先对每侧 union 成一个要素再算；
 * - centroid(fc) 是整集合一个点 → 质心要逐要素调用；
 * - buffer/convex/union 可能返回 null（空/退化输入）→ 归一化为空 FeatureCollection；
 * - simplify 容差是坐标度数（WGS84），非米；
 * - dissolve 不用 @turf/dissolve（仅面、慢、字段缺失会抛错），手写 groupBy + union。
 */
import type { BBox, Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon } from 'geojson'
import { DECK_EFFECT_MODES, pickRenderer } from './render-policy.js'
import { bbox as turfBbox } from '@turf/bbox'
import { bboxPolygon as turfBboxPolygon } from '@turf/bbox-polygon'
import { buffer as turfBuffer } from '@turf/buffer'
import { centroid as turfCentroid } from '@turf/centroid'
import { convex as turfConvex } from '@turf/convex'
import { difference as turfDifference } from '@turf/difference'
import { flatten as turfFlatten } from '@turf/flatten'
import { feature as makeFeature, featureCollection as fc, type Units } from '@turf/helpers'
import { intersect as turfIntersect } from '@turf/intersect'
import { toMercator, toWgs84 } from '@turf/projection'
import { simplify as turfSimplify } from '@turf/simplify'
import { squareGrid } from '@turf/square-grid'
import { union as turfUnion } from '@turf/union'
import { voronoi } from '@turf/voronoi'
import { booleanContains } from '@turf/boolean-contains'
import { booleanWithin } from '@turf/boolean-within'
import { booleanIntersects } from '@turf/boolean-intersects'
import { distance as turfDistance } from '@turf/distance'

/** 结果图层自动配色（按创建顺序轮转取色）。首个为默认橙红（用户可让 AI 指定任意颜色）。 */
export const RESULT_COLORS = [
  '#f97316', '#ef4444', '#22c55e', '#f59e0b',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
] as const

/**
 * 图层的展示方式（纯渲染选择，不改动图层数据/几何）。
 * points=原始点；plane=平面热力图；hex=蜂窝热力图（maplibre 原生）；
 * arc=弧线图、trips=轨迹图、wall=围墙图、radial=辐射图（deck.gl 渲染）。
 */
export type DisplayMode = 'points' | 'plane' | 'hex' | 'arc' | 'trips' | 'wall' | 'radial'

/** deck.gl 出图的可选数值参数（radius=辐射半径米、height=围墙高度米、speed/trail=轨迹、width=线宽像素）。 */
export type ModeParams = Record<string, number>

/** 注册表里的一个图层（含全量几何）。source 区分数据来源，未来 PostGIS 结果也用 'postgis'。 */
export interface GisLayer {
  id: string
  name: string
  geojson: FeatureCollection
  featureCount: number
  /** [west, south, east, north]；空图层为 null。 */
  bbox: BBox | null
  visible: boolean
  color: string
  /** 每次变更 +1，客户端据此做变更检测（相同 rev 不重新拉取）。 */
  rev: number
  source: string
  geometryTypes: string[]
  /** 是否用 supercluster 聚合渲染（仅点要素；客户端据此开 GeoJSONSource cluster）。 */
  cluster: boolean
  /** 展示方式；切换不 bump rev（纯展示变更）。 */
  mode: DisplayMode
  /** deck.gl 出图的数值参数（radius/height/speed/trail/width）；缺省客户端按 bbox 自动推算。 */
  modeParams?: ModeParams
  /** 点位大小（像素，maplibre circle-radius），缺省 5。 */
  pointRadius?: number
  /** 外轮廓粗细（像素，点描边 + 面边界线宽），缺省点 1。 */
  pointStrokeWidth?: number
  /** 内填充颜色（覆盖 color 用于填充；点=圆点填充、面=多边形填充），缺省用 color。 */
  fillColor?: string
  /**
   * DuckDB 内存表名（source='csv' 的大文件图层）：建表时写入，供 `webgis_filter_layer` 等
   * 后续筛选工具直接跑 SQL；图层移除 / 清空时对应表被 DROP。仅 host 侧内部使用，不下发客户端。
   */
  duckTable?: string
  /** DuckDB 经纬度列名（与 duckTable 配套；筛选/统计工具据此构造 bbox/半径 SQL）。仅 host 内部，不下发。 */
  duckCoords?: { lon: string; lat: string }
  /** DuckDB 几何列句柄（与 duckTable 配套；几何路径图层才有：WKT/WKB/GEOMETRY 列自动上图）。仅 host 内部，不下发。 */
  duckGeom?: { column: string; format: 'geometry' | 'wkb' | 'wkt'; sourceCrs: string | null }
  /** 真实总行数（duckTable 图层 = 内存表行数；物化图层 = featureCount）。客户端图层面板据此显示抽样标注。 */
  totalCount?: number
  /** 是否已全量物化（false = geojson 只是抽样，真数据在 duckTable/Arrow 路由）。 */
  materialized: boolean
  /** 渲染引擎决策（makeResultLayer 按 pickRenderer 算好；user-choice 存为 maplibre，由工具层 need_confirm 承担询问）。 */
  renderer: 'maplibre' | 'deck'
  /** 数据形态：arrow=有 Arrow 二进制路由（大文件图层）；geojson=只有 GeoJSON。 */
  dataFormat: 'geojson' | 'arrow'
}

/** 下发给客户端的轻量摘要（不含 geojson，避免 1s 轮询传全量数据）。 */
export interface LayerSummary {
  id: string
  name: string
  featureCount: number
  bbox: BBox | null
  visible: boolean
  color: string
  rev: number
  source: string
  geometryTypes: string[]
  cluster: boolean
  mode: DisplayMode
  modeParams?: ModeParams
  pointRadius?: number
  pointStrokeWidth?: number
  fillColor?: string
  totalCount?: number
  materialized: boolean
  renderer: 'maplibre' | 'deck'
  dataFormat: 'geojson' | 'arrow'
}

const EMPTY_FC: FeatureCollection = fc([])

const GEOM_TYPES = new Set([
  'Point', 'MultiPoint', 'LineString', 'MultiLineString',
  'Polygon', 'MultiPolygon', 'GeometryCollection',
])

/** 把任意 GeoJSON 输入归一化为 FeatureCollection；非法输入抛错。 */
export function normalizeFC(input: unknown): FeatureCollection {
  if (input && typeof input === 'object') {
    const g = input as { type?: unknown; features?: unknown; geometry?: unknown }
    if (g.type === 'FeatureCollection' && Array.isArray(g.features)) {
      return { type: 'FeatureCollection', features: g.features as Feature[] }
    }
    if (g.type === 'Feature') {
      return fc([g as unknown as Feature])
    }
    // 裸 Geometry：有 type 且没有 geometry 字段（Geometry 对象自带 type/coordinates）。
    if (typeof g.type === 'string' && GEOM_TYPES.has(g.type)) {
      return fc([makeFeature(g as unknown as Geometry)])
    }
  }
  throw new Error('输入不是合法的 GeoJSON（FeatureCollection / Feature / Geometry）')
}

/** 丢弃 null/缺失几何与非 Feature 的要素。 */
export function cleanFeatureCollection(fcIn: FeatureCollection): FeatureCollection {
  return fc(
    fcIn.features.filter(
      (f) => f != null && f.type === 'Feature' && f.geometry != null && typeof f.geometry.type === 'string',
    ),
  )
}

/** 图层 bbox；空/退化输入返回 null（turf.bbox 对空集合会返回 Infinity）。 */
export function bboxOf(fcIn: FeatureCollection): BBox | null {
  const clean = cleanFeatureCollection(fcIn)
  if (clean.features.length === 0) return null
  const b = turfBbox(clean)
  if (!Number.isFinite(b[0]) || !Number.isFinite(b[1])) return null
  return [b[0], b[1], b[2], b[3]]
}

/** 图层内出现的几何类型（去重）。 */
export function geometryTypesOf(fcIn: FeatureCollection): string[] {
  const set = new Set<string>()
  for (const f of fcIn.features) {
    if (f?.geometry?.type) set.add(f.geometry.type)
  }
  return [...set]
}

/** 构造一个已计算好汇总字段的图层。geojson 会先过 clean+normalize。 */
export function makeResultLayer(opts: {
  id: string
  name: string
  geojson: unknown
  source: string
  color?: string
  rev?: number
  cluster?: boolean
  mode?: DisplayMode
  modeParams?: ModeParams
  duckTable?: string
  duckCoords?: { lon: string; lat: string }
  duckGeom?: { column: string; format: 'geometry' | 'wkb' | 'wkt'; sourceCrs: string | null }
  totalCount?: number
  materialized?: boolean
  /** duck 表全量几何族（point/line/polygon）。多族时禁 Arrow——Arrow 只能编单族，会静默丢族。 */
  families?: string[]
  /** 全量数据集真实 bbox（[w,s,e,n]，duck 大图层由灌表后全表聚合算得）。
   *  缺省回退 geojson（抽样子集）bbox。duck 大图层的 geojson 只是显示抽样，
   *  其 bbox 必须代表完整数据，viewport 裁剪/工具消息/导出才不至于被抽样误导。 */
  fullBbox?: BBox | null
}): GisLayer {
  const geojson = cleanFeatureCollection(normalizeFC(opts.geojson))
  // 渲染路由：判断依据 = 真实行数（duckTable 图层传 totalCount=内存表行数，geojson 只是抽样），不能只看 featureCount。
  const mode = opts.mode ?? 'points'
  const actualCount = opts.totalCount ?? geojson.features.length
  const materialized = opts.materialized ?? !opts.duckTable
  // 渲染决策一律按 geojson 语义判断（duckTable 图层也有 geojson 兜底，arrow 只是 >10 万点图层的配套传输，
  // 不是硬规则——否则 5~10 万应走 maplibre 聚合的图层也会被 dataFormat=arrow 顶成 deck）。
  const rendered = pickRenderer({ mode, actualCount, materialized, dataFormat: 'geojson', needSupercluster: opts.cluster })
  // user-choice（5万~10万）存为 maplibre（询问由工具层 need_confirm 承担）；deck 原始数据路径支持点/线/面
  // （GeoArrow Scatterplot/Path/PolygonLayer）——几何类型在 deck 可渲染集合内的大图层放行，否则保持 maplibre。
  // deck 特效模式（arc/trips/wall/radial）恒 deck。
  const geomKinds = new Set<string>()
  for (const f of geojson.features) {
    const t = f?.geometry?.type
    if (t) geomKinds.add(t)
  }
  const DECKABLE_GEOM = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'])
  const deckableGeom = geomKinds.size > 0 && [...geomKinds].every((k) => DECKABLE_GEOM.has(k))
  const renderer: 'maplibre' | 'deck' = rendered === 'user-choice'
    ? 'maplibre'
    : rendered === 'deck' && (DECK_EFFECT_MODES.has(mode) || deckableGeom) ? 'deck' : 'maplibre'
  // 数据形态：走 deck 的图层（点/线/面，threads 已用 node 内置 shim 解决 bundle 加载）从 Arrow 路由取数，
  // 海量面按 zoom 分级走 arrow 二进制 + GeoArrowPolygonLayer（worker earcut）。其余一律 geojson。
  // 多几何族（families>1）禁 Arrow：arrow 路由只编码单族会静默丢其它族，回退 geojson 一族一层渲染。
  const multiFamily = !!opts.families && opts.families.length > 1
  const dataFormat: 'geojson' | 'arrow' = renderer === 'deck' && !!opts.duckTable && !multiFamily ? 'arrow' : 'geojson'
  return {
    id: opts.id,
    name: opts.name,
    geojson,
    featureCount: geojson.features.length,
    // 有全量 bbox（duck 大图层）用全量；否则用 geojson bbox（物化图层 geojson=全量，两者一致）。
    bbox: opts.fullBbox ?? bboxOf(geojson),
    visible: true,
    color: opts.color ?? RESULT_COLORS[0] ?? '#3b82f6',
    rev: opts.rev ?? 0,
    source: opts.source,
    geometryTypes: geometryTypesOf(geojson),
    cluster: opts.cluster ?? false,
    mode,
    materialized,
    renderer,
    dataFormat,
    ...(opts.totalCount !== undefined ? { totalCount: opts.totalCount } : {}),
    ...(opts.modeParams ? { modeParams: opts.modeParams } : {}),
    ...(opts.duckTable ? { duckTable: opts.duckTable } : {}),
    ...(opts.duckCoords ? { duckCoords: opts.duckCoords } : {}),
    ...(opts.duckGeom ? { duckGeom: opts.duckGeom } : {}),
  }
}

/** 摘掉 geojson 得到下发给客户端的摘要（duckTable/duckCoords/duckGeom 是 host 内部句柄，不下发）。 */
export function summarize(layer: GisLayer): LayerSummary {
  const { geojson: _geojson, duckTable: _duckTable, duckCoords: _duckCoords, duckGeom: _duckGeom, ...rest } = layer
  return rest
}

export function resolveLayer(layers: GisLayer[], id: string | undefined): GisLayer | undefined {
  if (!id) return undefined
  return layers.find((l) => l.id === id)
}

/** 守卫：找到图层返回 GisLayer，否则返回错误消息字符串。 */
export function requireLayer(layers: GisLayer[], id: string | undefined): GisLayer | string {
  const layer = resolveLayer(layers, id)
  if (!layer) return `找不到图层 ${id}（先用 webgis_list_layers 查看可用图层 id）`
  return layer
}

/** 守卫：图层有要素则返回 null，否则返回错误消息。 */
export function requireFeatures(layer: GisLayer): string | null {
  if (layer.featureCount === 0) return `图层 ${layer.id} 没有可处理的要素`
  return null
}

/** 守卫：仅面要素才允许（叠加/溶解类操作）。返回错误消息或 null。 */
export function requirePolygonOnly(layer: GisLayer, opName: string): string | null {
  const types = layer.geometryTypes
  if (types.length === 0) return null
  if (types.some((t) => t !== 'Polygon' && t !== 'MultiPolygon')) {
    return `${opName} 仅支持面要素（Polygon/MultiPolygon），当前图层含 ${types.join('/')}`
  }
  return null
}

/** 守卫：仅点要素才允许（OD 矩阵/辐射类操作）。返回错误消息或 null。 */
export function requirePointsOnly(layer: GisLayer, opName: string): string | null {
  const types = layer.geometryTypes
  if (types.length === 0) return null
  if (types.some((t) => t !== 'Point' && t !== 'MultiPoint')) {
    return `${opName} 仅支持点要素（Point/MultiPoint），当前图层含 ${types.join('/')}`
  }
  return null
}

/** 守卫：图层已全量物化（geojson 即全部数据）才允许逐要素空间分析；DuckDB 大图层是抽样子集，逐要素结果会失真。 */
export function requireMaterialized(layer: GisLayer, opName: string): string | null {
  if (layer.materialized === false) {
    return `${opName} 时图层 ${layer.id} 是抽样子集（共 ${layer.totalCount ?? '?'} 行，上图 ${layer.featureCount} 行），`
      + '逐要素分析结果会失真；请先用 webgis_filter_layer 筛出全量再分析。'
  }
  return null
}

/** 守卫：字段存在于图层任一要素的属性里。返回错误消息或 null。 */
export function requireField(layer: GisLayer, field: string): string | null {
  const has = layer.geojson.features.some((f) => f?.properties != null && field in f.properties)
  if (!has) return `图层 ${layer.id} 没有字段 ${field}（用 webgis_layer_info 查看字段）`
  return null
}

function unionFC(fcIn: FeatureCollection): Feature<Polygon | MultiPolygon> | null {
  const clean = cleanFeatureCollection(fcIn)
  if (clean.features.length === 0) return null
  // turf v7 的 union 要求 ≥2 个几何；单要素直接返回该要素本身。
  if (clean.features.length === 1) {
    const f = clean.features[0]
    return f?.geometry != null
      && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon')
      ? (f as Feature<Polygon | MultiPolygon>)
      : null
  }
  try {
    return turfUnion(clean as FeatureCollection<Polygon | MultiPolygon>) ?? null
  } catch {
    return null
  }
}

// ---- 构造类操作 ----

/** 缓冲区。unit 取 turf 支持的 units（miles/kilometers/meters/feet/yards/degrees）。 */
export function opBuffer(layer: GisLayer, distance: number, unit: string): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  if (clean.features.length === 0) return EMPTY_FC
  const r = turfBuffer(clean, distance, { units: unit as Units })
  return r ? normalizeFC(r) : EMPTY_FC
}

/** 逐要素质心（turf.centroid(fc) 是整集合一个点，必须逐要素调用）。 */
export function opCentroids(layer: GisLayer): FeatureCollection {
  return fc(
    layer.geojson.features
      .filter((f) => f?.geometry)
      .map((f) => turfCentroid(f)),
  )
}

/** 全要素最小凸包；退化输入返回空集合。 */
export function opConvexHull(layer: GisLayer): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  if (clean.features.length === 0) return EMPTY_FC
  const r = turfConvex(clean)
  return r ? fc([r]) : EMPTY_FC
}

/** 全要素外接矩形面。 */
export function opBBoxPolygon(layer: GisLayer): FeatureCollection {
  const b = bboxOf(layer.geojson)
  if (!b) return EMPTY_FC
  return fc([turfBboxPolygon(b)])
}

/**
 * 溶解：按 field 分组后每组 union 为一个要素；不传 field 则全部合并为一个要素。
 * 手写实现（groupBy + union），不用 @turf/dissolve（仅面、慢、字段缺失抛错）。
 */
export function opDissolve(layer: GisLayer, field: string | undefined): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  if (clean.features.length === 0) return EMPTY_FC
  if (!field) {
    const r = unionFC(clean)
    return r ? fc([r]) : EMPTY_FC
  }
  const groups = new Map<string, Feature[]>()
  for (const f of clean.features) {
    const v = f.properties?.[field]
    const key = v == null || v === '' ? '<无>' : String(v)
    const arr = groups.get(key)
    if (arr) arr.push(f)
    else groups.set(key, [f])
  }
  const out: Feature[] = []
  for (const [key, feats] of groups) {
    const r = unionFC(fc(feats))
    if (r) out.push({ ...r, properties: { ...(r.properties ?? {}), [field]: key } })
  }
  return fc(out)
}

/** 简化（Douglas-Peucker）。tolerance 单位 = 坐标度数（WGS84），非米。 */
export function opSimplify(layer: GisLayer, tolerance: number, highQuality: boolean): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  if (clean.features.length === 0) return EMPTY_FC
  const r = turfSimplify(clean, { tolerance, highQuality })
  return r ? normalizeFC(r) : EMPTY_FC
}

/** 拆分多部件要素为单部件（MultiPolygon→Polygon 等）。 */
export function opExplode(layer: GisLayer): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  if (clean.features.length === 0) return EMPTY_FC
  const r = turfFlatten(clean)
  return r ? normalizeFC(r) : EMPTY_FC
}

// ---- 叠加类操作（仅面；每侧先 union 成一个要素，再把两侧放进同一集合交给 turf） ----
// turf v7 的 intersect/difference/union 都收 FeatureCollection：intersect=公共交、difference=
// 第一个减其余、union=全部合并。所以先每侧 union 成单要素，再把 [ua, ub] 放进一个集合。

/** 交集：保留两图层重叠部分。 */
export function opIntersect(a: GisLayer, b: GisLayer): FeatureCollection {
  return overlayFC(a.geojson, b.geojson, (ua, ub) => {
    try {
      return turfIntersect(fc([ua, ub])) ?? null
    } catch {
      return null
    }
  })
}

/** 裁剪：保留 layer 在 overlay 范围内的部分（属性取 layer）。 */
export function opClip(layer: GisLayer, overlay: GisLayer): FeatureCollection {
  return opIntersect(layer, overlay)
}

/** 差集：从 layer 减去 overlay 覆盖的区域。 */
export function opDifference(layer: GisLayer, overlay: GisLayer): FeatureCollection {
  const ua = unionFC(layer.geojson)
  if (!ua) return EMPTY_FC
  const ub = unionFC(overlay.geojson)
  if (!ub) return layer.geojson
  try {
    const r = turfDifference(fc([ua, ub]))
    return r ? fc([r]) : EMPTY_FC
  } catch {
    return EMPTY_FC
  }
}

/** 并集：两图层全部要素合并为一个（面）。 */
export function opUnion(a: GisLayer, b: GisLayer): FeatureCollection {
  const combined = fc([...a.geojson.features, ...b.geojson.features])
  const r = unionFC(combined)
  return r ? fc([r]) : EMPTY_FC
}

function overlayFC(
  a: FeatureCollection,
  b: FeatureCollection,
  combine: (ua: Feature<Polygon | MultiPolygon>, ub: Feature<Polygon | MultiPolygon>) => Feature | null,
): FeatureCollection {
  const ua = unionFC(a)
  const ub = unionFC(b)
  if (!ua || !ub) return EMPTY_FC
  const r = combine(ua, ub)
  return r ? fc([r]) : EMPTY_FC
}

// ---- 查询类操作 ----

export type SelectOperator =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'starts_with' | 'ends_with' | 'in' | 'is_null' | 'not_null'

/** 按属性字段值筛选要素。value 对 is_null/not_null 忽略；in 用逗号分隔多个值。 */
export function opSelectByValue(
  layer: GisLayer,
  field: string,
  operator: SelectOperator,
  value: string | undefined,
): FeatureCollection {
  const out: Feature[] = []
  for (const f of layer.geojson.features) {
    if (matchSelect(f?.properties?.[field], operator, value)) out.push(f)
  }
  return fc(out)
}

export function matchSelect(actual: unknown, operator: SelectOperator, value: string | undefined): boolean {
  const isNull = actual == null || actual === ''
  switch (operator) {
    case 'is_null': return isNull
    case 'not_null': return !isNull
    case 'in': {
      if (!value) return false
      return value.split(',').map((s) => s.trim()).some((v) => normEq(actual, v))
    }
  }
  if (isNull) return false
  // 数值比较：两边都可解析为数字时按数值比较，否则按字符串。
  const an = typeof actual === 'number' ? actual : Number(actual)
  const vn = value === undefined || value === '' ? NaN : Number(value)
  if (Number.isFinite(an) && Number.isFinite(vn)) {
    switch (operator) {
      case 'eq': return an === vn
      case 'neq': return an !== vn
      case 'gt': return an > vn
      case 'gte': return an >= vn
      case 'lt': return an < vn
      case 'lte': return an <= vn
      default: break
    }
  }
  const s = String(actual)
  switch (operator) {
    case 'eq': return s === value
    case 'neq': return s !== value
    case 'contains': return value !== undefined && s.includes(value)
    case 'starts_with': return value !== undefined && s.startsWith(value)
    case 'ends_with': return value !== undefined && s.endsWith(value)
    default: return false
  }
}

function normEq(a: unknown, v: string): boolean {
  if (String(a) === v) return true
  const an = typeof a === 'number' ? a : Number(a)
  const vn = Number(v)
  return Number.isFinite(an) && Number.isFinite(vn) ? an === vn : false
}

export type JoinRelation = 'contains' | 'within' | 'intersects'

/**
 * 空间连接：对 target 每个要素统计与 join 中满足 relation 的要素数，写入 _joinCount
 * （并复制首个匹配要素的 name 到 _joinName）。用 bbox 预过滤避免全量布尔计算。
 */
export function opSpatialJoin(
  target: GisLayer,
  join: GisLayer,
  relation: JoinRelation,
): FeatureCollection {
  const joinFeatures = join.geojson.features
  const joinBboxes: BBox[] = joinFeatures.map((f) => {
    try {
      return turfBbox(f)
    } catch {
      return [Infinity, Infinity, -Infinity, -Infinity]
    }
  })
  const out: Feature[] = []
  for (const tf of target.geojson.features) {
    if (!tf?.geometry) continue
    let tb: BBox
    try {
      tb = turfBbox(tf)
    } catch {
      continue
    }
    let count = 0
    let firstName: unknown = null
    for (let i = 0; i < joinFeatures.length; i++) {
      const jf = joinFeatures[i]
      const jb = joinBboxes[i]
      if (!jf || !jb || !bboxOverlap(tb, jb)) continue
      let m = false
      try {
        m = relation === 'contains'
          ? booleanContains(tf, jf)
          : relation === 'within'
            ? booleanWithin(tf, jf)
            : booleanIntersects(tf, jf)
      } catch {
        m = false
      }
      if (m) {
        count++
        if (firstName == null) firstName = jf.properties?.name ?? null
      }
    }
    const props: Record<string, unknown> = { ...(tf.properties ?? {}), _joinCount: count }
    if (firstName != null) props._joinName = firstName
    out.push({ ...tf, properties: props })
  }
  return fc(out)
}

function bboxOverlap(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

// ---- 矢量扩展（功能 4）----

/**
 * Chaikin 平滑（角切）：每段取 0.75/0.25 两个点，线保端点、环保闭合。iterations 1–5。
 * 仅处理线/面（Point/MultiPoint 原样返回），只保留 x/y。
 */
export function opSmooth(layer: GisLayer, iterations: number): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  if (clean.features.length === 0) return EMPTY_FC
  const it = Math.max(1, Math.min(5, Math.floor(iterations) || 1))
  const out = clean.features.map((f) => {
    const g = f.geometry
    if (!g) return f
    return { ...f, geometry: smoothGeometry(g, it) }
  })
  return fc(out)
}

function smoothGeometry(g: Geometry, iterations: number): Geometry {
  switch (g.type) {
    case 'LineString':
      return { type: 'LineString', coordinates: chaikin(g.coordinates, false, iterations) }
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: g.coordinates.map((l) => chaikin(l, false, iterations)) }
    case 'Polygon':
      return { type: 'Polygon', coordinates: g.coordinates.map((ring) => chaikin(ring, true, iterations)) }
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: g.coordinates.map((poly) => poly.map((ring) => chaikin(ring, true, iterations))) }
    default:
      return g
  }
}

function chaikin(pts: number[][], closed: boolean, iterations: number): number[][] {
  const strip = closed && pts.length > 1 && pts[0]?.[0] === pts[pts.length - 1]?.[0] && pts[0]?.[1] === pts[pts.length - 1]?.[1]
  let cur = (strip ? pts.slice(0, -1) : pts).map((p) => [p[0] ?? 0, p[1] ?? 0])
  for (let k = 0; k < iterations; k++) {
    const m = cur.length
    if (m < 3) break
    const out: number[][] = []
    if (closed) {
      for (let i = 0; i < m; i++) {
        const a = cur[i]!
        const b = cur[(i + 1) % m]!
        out.push([0.75 * a[0]! + 0.25 * b[0]!, 0.75 * a[1]! + 0.25 * b[1]!])
        out.push([0.25 * a[0]! + 0.75 * b[0]!, 0.25 * a[1]! + 0.75 * b[1]!])
      }
      out.push([out[0]![0]!, out[0]![1]!])
    } else {
      for (let i = 0; i < m - 1; i++) {
        const a = cur[i]!
        const b = cur[i + 1]!
        out.push([0.75 * a[0]! + 0.25 * b[0]!, 0.75 * a[1]! + 0.25 * b[1]!])
        out.push([0.25 * a[0]! + 0.75 * b[0]!, 0.25 * a[1]! + 0.75 * b[1]!])
      }
      out[0] = cur[0]!
      out[out.length - 1] = cur[m - 1]!
    }
    cur = out
  }
  return cur
}

/** WGS84 ↔ Web Mercator 重投影（非变异）。mercator 为米制，供链式量算（直接上图会偏离视野）。 */
export function opReproject(layer: GisLayer, to: 'mercator' | 'wgs84'): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  if (clean.features.length === 0) return EMPTY_FC
  const r = to === 'mercator' ? toMercator(clean) : toWgs84(clean)
  return r ? normalizeFC(r) : EMPTY_FC
}

/** 规则方格网（@turf/square-grid）。bbox 校验 + cellSize>0。 */
export function opRegularGrid(bbox: BBox, cellSize: number, unit: string): FeatureCollection {
  const [w, s, e, n] = bbox
  if (![w, s, e, n].every((v) => Number.isFinite(v)) || w >= e || s >= n) {
    throw new Error('bbox 非法：需为 [west, south, east, north] 且 w<e、s<n')
  }
  if (!(cellSize > 0)) throw new Error('cellSize 必须为正数')
  const grid = squareGrid(bbox, cellSize, { units: unit as Units })
  return grid ? normalizeFC(grid) : EMPTY_FC
}

/** 泰森多边形（@turf/voronoi）。仅点，≥3 点；bbox 默认图层范围外扩 10%。 */
export function opVoronoi(layer: GisLayer, bbox?: BBox): FeatureCollection {
  const clean = cleanFeatureCollection(layer.geojson)
  const points = clean.features.filter((f) => f?.geometry?.type === 'Point')
  if (points.length < 3) throw new Error('泰森多边形至少需要 3 个点要素')
  const b = bbox ?? expandBBox(bboxOf(layer.geojson), 0.1)
  if (!b) throw new Error('无法确定计算范围，请传 bbox')
  const r = voronoi(fc(points as Feature<Point>[]), { bbox: b })
  return r ? normalizeFC(r) : EMPTY_FC
}

function expandBBox(b: BBox | null, ratio: number): BBox | null {
  if (!b) return null
  const [w, s, e, n] = b
  const dx = (e - w) * ratio
  const dy = (n - s) * ratio
  return [w - dx, s - dy, e + dx, n + dy]
}

/** 属性键连接（inner join）：target 要素按 targetField 匹配 join 图层 joinField（默认同名），
 *  命中首条时并入其属性（target 属性优先），无命中丢弃，null/空键跳过。 */
export function opAttributeJoin(
  target: GisLayer,
  join: GisLayer,
  targetField: string,
  joinField: string | undefined,
): FeatureCollection {
  const jf = joinField ?? targetField
  const hasField = (l: GisLayer, f: string): boolean => l.geojson.features.some((x) => f in (x.properties ?? {}))
  if (!hasField(target, targetField)) throw new Error(`目标图层没有字段 ${targetField}`)
  if (!hasField(join, jf)) throw new Error(`连接图层没有字段 ${jf}`)
  const index = new Map<string, Record<string, unknown>>()
  for (const j of join.geojson.features) {
    const k = j.properties?.[jf]
    if (k == null || k === '') continue
    const key = String(k)
    if (!index.has(key)) index.set(key, j.properties ?? {})
  }
  const out: Feature[] = []
  for (const t of target.geojson.features) {
    const tk = t.properties?.[targetField]
    if (tk == null || tk === '') continue
    const jp = index.get(String(tk))
    if (!jp) continue
    out.push({ ...t, properties: { ...jp, ...(t.properties ?? {}) } })
  }
  return fc(out)
}

/** 按位置筛选：overlay（图层，任一满足即保留）或 bbox（构造 bbox 面）二选一。 */
export function opSelectByLocation(
  layer: GisLayer,
  relation: JoinRelation,
  overlay?: GisLayer,
  bbox?: BBox,
): FeatureCollection {
  if (Boolean(overlay) === Boolean(bbox)) throw new Error('overlay 与 bbox 必须且只能提供一个')
  let targets: Feature[]
  if (overlay) {
    targets = overlay.geojson.features
  } else {
    const [w, s, e, n] = bbox ?? [NaN, NaN, NaN, NaN]
    if (![w, s, e, n].every((v) => Number.isFinite(v)) || w >= e || s >= n) throw new Error('bbox 非法')
    targets = [turfBboxPolygon(bbox as BBox)]
  }
  const out: Feature[] = []
  for (const f of layer.geojson.features) {
    if (!f?.geometry) continue
    let hit = false
    for (const t of targets) {
      if (!t?.geometry) continue
      try {
        // 语义：保留「要素 f 与目标 t 满足 relation」——within/contains 以 f 为被测对象。
        const m = relation === 'contains'
          ? booleanContains(f, t)
          : relation === 'within'
            ? booleanWithin(f, t)
            : booleanIntersects(f, t)
        if (m) {
          hit = true
          break
        }
      } catch {
        // 几何异常跳过
      }
    }
    if (hit) out.push(f)
  }
  return fc(out)
}

// ---- 属性编辑（原地改要素属性，调用方负责 bump rev） ----

/** 给图层属性写字段：全部要素，或仅匹配 filter（复用 select 的字段算子）。返回改动数。 */
export function opSetAttribute(
  layer: GisLayer,
  field: string,
  value: number | string | boolean,
  filter?: { field: string; operator: SelectOperator; value?: string },
): number {
  let count = 0
  for (const f of layer.geojson.features) {
    if (filter && !matchSelect(f?.properties?.[filter.field], filter.operator, filter.value)) continue
    f.properties = { ...(f.properties ?? {}), [field]: value }
    count++
  }
  return count
}

/** 给全部要素赋顺序号字段（start..start+n-1，缺省 0 基）。返回要素数。 */
export function opAddSequence(layer: GisLayer, field: string, start = 0): number {
  layer.geojson.features.forEach((f, i) => {
    f.properties = { ...(f.properties ?? {}), [field]: start + i }
  })
  return layer.geojson.features.length
}

/** 给全部要素新增一列空字段（值 null）；已存在该字段的要素跳过。返回实际新增的要素数。 */
export function opAddColumn(layer: GisLayer, field: string): number {
  let count = 0
  layer.geojson.features.forEach((f) => {
    if (field in (f.properties ?? {})) return
    f.properties = { ...(f.properties ?? {}), [field]: null }
    count++
  })
  return count
}

// ---- OD 矩阵 ----

/** 提取图层里的点坐标（Point 单点、MultiPoint 展开多点）。 */
function pointsOf(layer: GisLayer): Array<{ coord: [number, number]; props: Record<string, unknown> }> {
  const out: Array<{ coord: [number, number]; props: Record<string, unknown> }> = []
  for (const f of layer.geojson.features) {
    const g = f.geometry
    if (!g) continue
    if (g.type === 'Point') {
      out.push({ coord: [g.coordinates[0] ?? NaN, g.coordinates[1] ?? NaN], props: f.properties ?? {} })
    } else if (g.type === 'MultiPoint') {
      for (const c of g.coordinates) {
        out.push({ coord: [c[0] ?? NaN, c[1] ?? NaN], props: f.properties ?? {} })
      }
    }
  }
  return out
}

/**
 * OD 矩阵：origin 图层每个点连到 destination 图层最近的 topN 个点，生成有向线要素
 * （properties 携带 flow：缺省=起点→终点大圆距离米；传 flowField 时取起点图层的该数值字段）。
 * 同图层配对时跳过坐标完全相同的自环；总对数受 maxPairs 硬上限钳制（nearest 优先）。
 */
export function opODMatrix(
  origin: GisLayer,
  destination: GisLayer,
  topN: number,
  maxPairs: number,
  flowField?: string | null,
): FeatureCollection {
  const origins = pointsOf(origin)
  const dests = pointsOf(destination)
  const same = origin.id === destination.id
  const out: Feature[] = []
  let pairs = 0
  for (const o of origins) {
    if (pairs >= maxPairs) break
    const scored: Array<{ d: (typeof dests)[number]; dist: number }> = []
    for (const d of dests) {
      if (same && o.coord[0] === d.coord[0] && o.coord[1] === d.coord[1]) continue // 同图层自环
      scored.push({ d, dist: turfDistance(o.coord, d.coord, { units: 'meters' }) })
    }
    scored.sort((a, b) => a.dist - b.dist)
    for (const s of scored.slice(0, topN)) {
      if (pairs >= maxPairs) break
      const rawFlow = flowField ? o.props[flowField] : undefined
      const flow = flowField && rawFlow != null ? Number(rawFlow) : s.dist
      out.push({
        type: 'Feature',
        properties: { ...s.d.props, flow: Number.isFinite(flow) ? Math.round(flow * 100) / 100 : s.dist },
        geometry: { type: 'LineString', coordinates: [o.coord, s.d.coord] },
      })
      pairs++
    }
  }
  return fc(out)
}
