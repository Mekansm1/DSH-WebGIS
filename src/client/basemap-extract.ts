/**
 * 从**底图矢量瓦片**里提取要素（当前视窗、当前 zoom）。
 *
 * 这是「导出地图上的河流」这类需求的实现：数据本来就在内存里 —— maplibre 已经把
 * MVT 解码成了带经纬度的 GeoJSON 要素，只是没人去问它要。
 *
 * 为什么不用像素追踪：
 * - 几何是 OSM 原始几何，**精确**；像素追踪是从颜色反推，受底图对比度限制（实测路面与背景只差 5~8 色阶）。
 * - 河流在瓦片里**本来就是分段但连续的要素**；像素分割会把它切成 15~20 个碎块还要靠方向猜连接。
 * - 道路在瓦片里**本来就是独立要素**；像素层面整个路网是一个连通块，"一条路"根本不存在。
 *
 * 边界（与"我们不是爬虫"一致）：`querySourceFeatures` 只覆盖**已加载的瓦片** = 视口 + buffer。
 * 不主动请求额外瓦片，不跨 zoom 取，所以是零网络请求的（瓦片是渲染当前画面时就已经加载的）。
 */
import type { Map as MapLibreMap, MapGeoJSONFeature } from 'maplibre-gl'
import type { Feature, FeatureCollection, Geometry } from 'geojson'

/** 几何大族：导出时按它分成点/线/面三组。 */
export type GeometryKind = 'point' | 'line' | 'polygon'

export interface ExtractOptions {
  /**
   * MVT 的 source-layer 名（如 'waterway' / 'transportation'）。
   * **不传 = 导出底图全部内容图层**，按几何分成点/线/面三组（"导出当前范围的地图数据"的默认语义）。
   */
  sourceLayer?: string
  /** 只保留 name 属性包含该字符串的要素（如 '白浪河'）。 */
  name?: string
  /** 只保留 class 属性命中的要素（如 ['river','canal']）。 */
  classes?: string[]
  /** 按 (图层, name) 归组：每条河一个 MultiLineString 要素（默认 true）。 */
  group?: boolean
}

/** 一组同几何类型的输出（对应一个结果图层）。 */
export interface ExtractOutput {
  kind: GeometryKind
  geojson: FeatureCollection
  featureCount: number
  /** 这一组包含的底图图层（去重）。 */
  sourceLayers: string[]
}

/** 提取结果：成功给分组输出与统计；失败给可直接展示给用户的说明。 */
export type ExtractResult =
  | {
      ok: true
      /** 最多三组（点/线/面），空组不出现在这里。 */
      outputs: ExtractOutput[]
      /** 实际的矢量源 id。 */
      source: string
      /** 归组前命中的要素数（跨全部图层）。 */
      rawCount: number
      /** 去重后、归组前的要素数。 */
      dedupedCount: number
      /** 实际取到的底图图层名。 */
      usedLayers: string[]
      /** 想要但在当前缩放级别不存在（或被瓦片裁剪掉）的图层 —— 用来提示用户"放大后会更多"。 */
      missingLayers: string[]
      /** 命中的名字清单（去重、最多 40 个）。 */
      names: string[]
      /** 类目分布。 */
      classes: Record<string, number>
      /** 需要提醒用户的话（如数据量偏大）。 */
      note?: string
    }
  | { ok: false; message: string }

/** 几何类型 → 大族。 */
export function geometryKind(type: string | undefined): GeometryKind | null {
  if (!type) return null
  if (type === 'Point' || type === 'MultiPoint') return 'point'
  if (type === 'LineString' || type === 'MultiLineString') return 'line'
  if (type === 'Polygon' || type === 'MultiPolygon') return 'polygon'
  return null
}

/** 默认导出（无指定图层）时遍历的底图内容图层 —— 由 basemap-layers 的目录同步过来。 */
import { defaultExportLayerNames } from '../basemap-layers.js'

/** 几何的稳定指纹：坐标取到 6 位小数后序列化（用于没有 feature.id 时兜底去重）。 */
function geometryKey(g: Geometry | null | undefined): string {
  if (!g) return 'null'
  const round = (coords: unknown): unknown => {
    if (typeof coords === 'number') return Number(coords.toFixed(6))
    return Array.isArray(coords) ? coords.map(round) : coords
  }
  return `${g.type}:${JSON.stringify(round((g as { coordinates?: unknown }).coordinates))}`
}

/**
 * 去重：优先按 `feature.id`（实测瓦片要素 100% 带 id），没有 id 时按几何指纹。
 * 瓦片有 buffer，跨边界的要素会在相邻两块瓦片里各出现一次 —— 但实测重复率极低（约 1%）。
 */
export function dedupeFeatures(features: MapGeoJSONFeature[]): MapGeoJSONFeature[] {
  const seenId = new Set<string | number>()
  const seenGeom = new Set<string>()
  const out: MapGeoJSONFeature[] = []
  for (const f of features) {
    if (f.id != null) {
      const k = typeof f.id === 'number' ? `n${f.id}` : `s${f.id}`
      if (seenId.has(k)) continue
      seenId.add(k)
      out.push(f)
    } else {
      const k = geometryKey(f.geometry as Geometry)
      if (seenGeom.has(k)) continue
      seenGeom.add(k)
      out.push(f)
    }
  }
  return out
}

/** 要素的 name 属性（去空白）。 */
function nameOf(f: MapGeoJSONFeature): string {
  const n = (f.properties as Record<string, unknown> | null)?.name
  return typeof n === 'string' ? n.trim() : ''
}

/**
 * 按 name 归组：同名要素合并成一个 MultiLineString（或 MultiPolygon / MultiPoint）。
 * 瓦片按 z/x/y 切分，同一条河在视窗内天然是十几段 —— 用户说「导出白浪河」时想要的是一条河，
 * 不是 16 个线段。无名字的要素各自独立成要素（不强行合并）。
 *
 * 归组键含 `source_layer`：全量导出时，"人民公园"这个公园面和一个同名 POI 不该被合并。
 */
export function groupFeaturesByName(features: MapGeoJSONFeature[]): Feature[] {
  const groups = new Map<string, MapGeoJSONFeature[]>()
  const unnamed: MapGeoJSONFeature[] = []
  for (const f of features) {
    const n = nameOf(f)
    if (!n) { unnamed.push(f); continue }
    const layer = (f as unknown as { sourceLayer?: string }).sourceLayer ?? ''
    const key = `${layer}\u0000${n}`
    const g = groups.get(key)
    if (g) g.push(f)
    else groups.set(key, [f])
  }
  const out: Feature[] = []
  for (const feats of groups.values()) {
    const parts = feats.map((f) => f.geometry).filter((g): g is Geometry => !!g)
    if (parts.length === 0) continue
    const single = parts.length === 1 ? parts[0]! : multiOf(parts)
    out.push({
      type: 'Feature',
      // 归组后保留第一段的属性（同一 name 的 class 通常一致），另加段数便于核对
      properties: { ...(feats[0]!.properties ?? {}), __segments: parts.length },
      geometry: single,
    } as Feature)
  }
  for (const f of unnamed) out.push(f as unknown as Feature)
  return out
}

/** 把多个同类型几何并成一个 Multi*；类型不一致时退回 GeometryCollection。 */
function multiOf(parts: Geometry[]): Geometry {
  const t = parts[0]!.type
  const same = parts.every((p) => p.type === t)
  if (same && (t === 'LineString' || t === 'Polygon' || t === 'Point')) {
    const multi = `Multi${t}` as 'MultiLineString' | 'MultiPolygon' | 'MultiPoint'
    return { type: multi, coordinates: parts.map((p) => (p as { coordinates: unknown }).coordinates) } as Geometry
  }
  return { type: 'GeometryCollection', geometries: parts } as Geometry
}

/**
 * 从当前底图的矢量瓦片里提取要素。
 *
 * 源 id 因底图而异（Carto → 'carto'、OpenFreeMap → 'openmaptiles'），所以遍历当前样式里的
 * 矢量源逐个尝试，谁有该 source-layer 就用谁。
 *
 * 两种模式：
 * - 指定 `sourceLayer` → 只取那一层（一次只查一个源，快）。
 * - 不指定 → 取底图全部**内容图层**，按几何分成点/线/面三组（"导出当前范围的地图数据"的默认语义）。
 *   不含 `*_name` / `place` / `housenumber` 这些**标注图层** —— 那是渲染用的文字，不是地物。
 */
export function extractBasemapFeatures(map: MapLibreMap, rawOpts?: ExtractOptions | null): ExtractResult {
  // 参数来自 state 的 JSON 往返，可能是 undefined / null —— 归一成对象再往下走
  const opts: ExtractOptions = rawOpts ?? {}
  const style = map.getStyle()
  const vectorSources = Object.entries(style?.sources ?? {})
    .filter(([, s]) => (s as { type?: string }).type === 'vector')
    .map(([id]) => id)

  if (vectorSources.length === 0) {
    return {
      ok: false,
      message: '当前底图是光栅瓦片，没有可提取的矢量数据。请先切换到矢量底图'
        + '（OpenFreeMap Liberty / Carto Positron / Carto Voyager / Carto Dark），再重新导出。',
    }
  }

  const wanted = opts.sourceLayer ? [opts.sourceLayer] : defaultExportLayerNames()

  let source = ''
  const usedLayers: string[] = []
  let hits: MapGeoJSONFeature[] = []
  for (const layerName of wanted) {
    let found: MapGeoJSONFeature[] = []
    for (const id of vectorSources) {
      if (!map.getSource(id)) continue
      let got: MapGeoJSONFeature[] = []
      try {
        got = map.querySourceFeatures(id, { sourceLayer: layerName })
      } catch {
        continue // 该源没有这个 source-layer：换下一个源
      }
      if (got.length > 0) { source = source || id; found = got; break }
    }
    if (found.length > 0) {
      usedLayers.push(layerName)
      hits = hits.concat(found)
    }
  }

  if (hits.length === 0) {
    return {
      ok: false,
      message: opts.sourceLayer
        ? `当前视野内没有「${opts.sourceLayer}」的矢量要素`
          + '（可能缩放级别太低该图层未生成，或视野内确实没有这类地物）。可以放大地图后再试，或换一个图层名。'
        : '当前视野内没有取到任何底图矢量要素。可能缩放级别太低（底图在该级别未生成对应图层），放大地图后再试。',
    }
  }

  const rawCount = hits.length
  let filtered = dedupeFeatures(hits)
  if (opts.name) {
    const want = opts.name
    filtered = filtered.filter((f) => nameOf(f).includes(want))
  }
  if (opts.classes && opts.classes.length > 0) {
    const want = new Set(opts.classes)
    filtered = filtered.filter((f) => {
      const c = (f.properties as Record<string, unknown> | null)?.class
      return typeof c === 'string' && want.has(c)
    })
  }

  if (filtered.length === 0) {
    const names = [...new Set(hits.map(nameOf).filter(Boolean))].slice(0, 20)
    return {
      ok: false,
      message: `按条件筛选后没有匹配的要素（视野内共 ${rawCount} 个要素`
        + `${names.length ? `，其中有名字的是：${names.join('、')}` : ''}）。`,
    }
  }

  const names = [...new Set(filtered.map(nameOf).filter(Boolean))].slice(0, 40)
  const classes: Record<string, number> = {}
  for (const f of filtered) {
    const c = (f.properties as Record<string, unknown> | null)?.class
    const k = typeof c === 'string' ? c : '未知'
    classes[k] = (classes[k] ?? 0) + 1
  }

  // 按几何分成点/线/面（几何族取自要素本身，不信任图层目录 —— 同一个图层里也可能混类型）
  const buckets: Record<GeometryKind, MapGeoJSONFeature[]> = { point: [], line: [], polygon: [] }
  for (const f of filtered) {
    const k = geometryKind((f.geometry as { type?: string } | null)?.type)
    if (k) buckets[k].push(f)
  }

  const outputs: ExtractOutput[] = []
  for (const kind of ['point', 'line', 'polygon'] as const) {
    const feats = buckets[kind]
    if (feats.length === 0) continue
    const groupedFeats = opts.group !== false ? groupFeaturesByName(feats) : (feats as unknown as Feature[])
    const layers = [...new Set(feats.map((f) => (f as unknown as { sourceLayer?: string }).sourceLayer).filter(Boolean))] as string[]
    outputs.push({
      kind,
      geojson: { type: 'FeatureCollection', features: groupedFeats } as FeatureCollection,
      featureCount: groupedFeats.length,
      sourceLayers: layers,
    })
  }

  const missingLayers = opts.sourceLayer ? [] : wanted.filter((n) => !usedLayers.includes(n))
  const biggest = outputs.reduce((a, o) => Math.max(a, o.featureCount), 0)
  return {
    ok: true,
    outputs,
    source,
    rawCount,
    dedupedCount: filtered.length,
    usedLayers,
    missingLayers,
    names,
    classes,
    ...(biggest > 20000
      ? { note: `单组要素数较大（最大 ${biggest}），图层会比较重；如需精简可指定 layer 只导出某一类。` }
      : {}),
  }
}
