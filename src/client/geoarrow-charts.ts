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

export interface GeoArrowSpec {
  id: string
  color: string
  visible: boolean
  /** 点位半径（像素，与 maplibre circle-radius 同语义；缺省 4）。 */
  radius?: number
  /** 面图层 earcut worker URL（自托管 /webgis/earcut-worker.js；缺省 null = 主线程 earcut）。 */
  earcutWorkerUrl?: string | null
}

/** 按几何类型构造 GeoArrow 图层：点 → Scatterplot；线 → Path；面 → Polygon。 */
export function makeGeoArrowLayers(spec: GeoArrowSpec, table: Table): Layer[] {
  const [r, g, b] = hexToRgb(spec.color)
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
    return [new GeoArrowScatterplotLayer({ ...common, getFillColor: [r, g, b, 255], getRadius: spec.radius ?? 4, radiusUnits: 'pixels' })]
  }
  if (kind === 'line') {
    return [new GeoArrowPathLayer({ ...common, getColor: [r, g, b, 255], getWidth: 2, widthUnits: 'pixels' })]
  }
  if (kind === 'polygon') {
    return [new GeoArrowPolygonLayer({
      ...common,
      filled: true,
      stroked: true,
      getFillColor: [r, g, b, 180],
      getLineColor: [r, g, b, 255],
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
  const out: Layer[] = []
  for (const kind of geojsonFamilies(geojson)) {
    const id = `deck-${spec.id}-raw-${kind}`
    if (kind === 'line') {
      out.push(new PathLayer({
        id,
        data: rawLineData(geojson),
        getPath: (f) => f.geometry.coordinates,
        getColor: [r, g, b, 255],
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
        getFillColor: [r, g, b, 180],
        getLineColor: [r, g, b, 255],
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
        getFillColor: [r, g, b, 255],
        getRadius: spec.radius ?? 4,
        radiusUnits: 'pixels',
        visible: spec.visible,
        pickable: true,
      }))
    }
  }
  return out
}
