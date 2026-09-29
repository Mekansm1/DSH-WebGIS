/**
 * DuckDB 工具层公共件（从 duckdb-tools.ts 拆出）：渲染片段、幂等重试、加载错误文案、
 * 图层几何源摘要、围栏 WKT 解析、点化源判定。与工具注册无关，可被各 tools/*.ts 复用。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BBox, FeatureCollection } from 'geojson'
import type { Context } from '@deepseek-ai/cordis'
import type { GisLayer } from '../geo-processing.js'
import { makeResultLayer, requireLayer } from '../geo-processing.js'
import { duckGeomFamiliesOf } from './sampling.js'
import { geojsonToWkt } from './filters.js'
import { duckTableFullBBox, pointLonLatExprOf } from './geometry.js'
import { friendlyDuckError } from './geometry.js'
import type { DuckGeomSource, DuckGeomSpec } from './types.js'
import type { DuckDbOptions } from './types.js'
import type { GeomFamily } from './sampling.js'
import type { DuckDbEngine } from './engine.js'

type ResolveLayer = (id: unknown) => GisLayer | string

export function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** 幂等读查询带 1 次短退避重试：layer_stats 这类轻 SQL 在低资源/全量测试下偶发 native 抖动，
 *  重试一次即稳定（纯读无副作用）。 */
export async function runDuckRetry(engine: DuckDbEngine, sql: string, tries = 2): Promise<Awaited<ReturnType<DuckDbEngine['run']>>> {
  for (let i = 0; i < tries; i++) {
    try {
      return await engine.run(sql)
    } catch (err) {
      if (i === tries - 1) throw err
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  throw new Error('unreachable')
}

/** 图层源形状摘要。 */
export function duckGeomSourceOf(layer: GisLayer): DuckGeomSource {
  return { coords: layer.duckCoords, geom: layer.duckGeom }
}

/** 从 polygon GeoJSON / polygonLayer 解析出围栏 WKT（复用 geojsonToWkt；非面抛错）。 */
export function fenceWktText(args: Record<string, unknown>, resolve: (id: unknown) => GisLayer | string): string {
  let geom: unknown
  const raw = args.polygon
  if (raw && typeof raw === 'object') geom = raw
  const layerId = typeof args.polygonLayer === 'string' && args.polygonLayer ? args.polygonLayer : ''
  if (layerId) {
    const layer = resolve(layerId)
    if (typeof layer === 'string') throw new Error(layer)
    const g = layer.geojson.features
      .find((f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon')?.geometry
    if (!g) throw new Error(`图层 ${layerId} 没有面要素可作围栏`)
    geom = g
  }
  if (geom === undefined) throw new Error('within_polygon 模式需提供 polygon（GeoJSON 面）或 polygonLayer（面图层 id）')
  const wkt = geojsonToWkt(geom)
  if (!wkt) throw new Error('polygon 需要是 GeoJSON 的 Polygon / MultiPolygon 几何')
  return wkt
}

/** 判定并返回「点化源」的经纬度表达式。非点状几何 → 抛可行动中文错误。 */
export async function requirePointableLonLat(
  engine: DuckDbEngine,
  layer: GisLayer,
): Promise<{ lon: string; lat: string }> {
  const src = duckGeomSourceOf(layer)
  if (src.coords) return pointLonLatExprOf(src)
  if (src.geom) {
    if (!layer.duckTable) throw new Error(`图层 ${layer.id} 无内存表，无法判定几何族`)
    const fams = await duckGeomFamiliesOf(engine, layer.duckTable, src.geom)
    if (fams.length === 0) {
      throw new Error(`图层 ${layer.id} 的几何族无法确认（需 DuckDB spatial 扩展读取几何列）。`
        + '可改用 webgis_load_dataset 传经纬度列，或先 webgis_spatial_filter 的 intersects_layer/within_polygon 筛出子集。')
    }
    if (!fams.every((f) => f === 'point')) {
      throw new Error(`此操作仅支持点状源：图层 ${layer.id} 几何族为 ${fams.join('/')}（线/面/混合几何无单一中心点）。`
        + '建议：先用 webgis_spatial_filter 的 within_polygon / intersects_layer 筛出子集，'
        + '或图层已较小时用 Turf 工具处理。')
    }
    return pointLonLatExprOf(src)
  }
  throw new Error(`图层 ${layer.id} 没有可用几何（需 duckTable 且含 duckCoords 或 duckGeom）`)
}

// ---- 工具层会话上下文（从 duckdb-tools.ts 拆出） ----

/** 工具层所需的图层注册表状态（index.ts 传入的 state 结构上满足此接口）。 */
export interface DuckToolsState {
  layers: GisLayer[]
}

export interface DuckDbToolsOptions {
  duckdb?: DuckDbOptions
  engine?: DuckDbEngine
}

/** CSV 来源图层默认颜色（绿色；区别于 postgis 橙 / gis-result 蓝）。 */
const CSV_COLOR = '#10b981'

/** 结果图层 id 递增计数器（进程内）。 */
let csvSeq = 0

/** pushResult 的额外句柄（duck 表/坐标列/几何列/真实行数/几何族）。 */
export interface PushExtra {
  source?: GisLayer['source']
  cluster?: boolean
  duckTable?: string
  duckCoords?: { lon: string; lat: string }
  duckGeom?: DuckGeomSpec
  totalCount?: number
  families?: GeomFamily[]
  /**
   * geojson 是否装着**全部数据**。缺省按 `fc.features.length >= totalCount` 推。
   *
   * ⚠ 绝不能再用 `!duckTable` 反推（那是旧行为，已修）：**"留了内存表"与"geojson 只是抽样"是两件事**——
   * 筛选结果既留表（供链式筛选）又把**全部命中行**都放进了 geojson。用 !duckTable 推会把这类图层
   * 误判成抽样，于是 16 个 `requireMaterialized` 守卫点全部拒绝，而错误消息让模型"先用
   * webgis_filter_layer 筛出全量再分析"——那正是它刚做的事，`load → filter → buffer` 成为死路。
   */
  materialized?: boolean
  /** 全量真实 bbox（ingestion 灌表后已算过）。传了就复用，省掉 pushResult 里第二次全表聚合。 */
  fullBbox?: BBox | null
}

/** pushResult 的返回值（工具成功输出的公共形状）。 */
export interface PushResult {
  ok: true
  layerId: string
  name: string
  featureCount: number
  bbox: BBox | null
  message: string
}

/** 单次工具执行解析出的会话 API（图层读 + 结果图层入栈）。 */
export interface SessionApi {
  st: DuckToolsState
  layers: () => GisLayer[]
  resolve: (id: unknown) => GisLayer | string
  pushResult: (name: string, fc: FeatureCollection, extra?: PushExtra) => Promise<PushResult>
}

/** 会话解析器：按 exec.agent.id 取该会话的图层注册表操作闭包。 */
export type SessionResolver = (exec: { agent?: { id?: string } }) => SessionApi

/** 工具注册函数统一签名：ctx（注册工具）+ engine/sess（运行时依赖）。 */
export interface DuckToolDeps {
  ctx: Context
  engine: DuckDbEngine
  sess: SessionResolver
}

/** 构造会话解析器（结果是 source=csv 的新图层，id 前缀 csv_<n>）。 */
export function makeSessionResolver(engine: DuckDbEngine, stateFor: (sessionId: string | undefined) => DuckToolsState): SessionResolver {
  return (exec) => {
    const st = stateFor(exec.agent?.id)
    const layers = (): GisLayer[] => st.layers
    const resolve = (id: unknown): GisLayer | string => requireLayer(layers(), typeof id === 'string' ? id : '')
    const pushResult = async (name: string, fc: FeatureCollection, extra: PushExtra = {}): Promise<PushResult> => {
      const id = `${extra.source === 'dataset' ? 'ds' : 'csv'}_${++csvSeq}`
      // duck 大图层：geojson 只是抽样，全量 bbox 必须由留表的 duck 全表聚合（抽样 bbox 会把视口裁剪/工具消息带偏）。
      // ingestion 灌表时已算过一次，调用方传了就复用 —— 否则这里会重跑一遍同一条全表聚合。
      let fullBbox: BBox | null | undefined = extra.fullBbox
      if (fullBbox === undefined && extra.duckTable) {
        const src: DuckGeomSource = { coords: extra.duckCoords, geom: extra.duckGeom }
        if (src.coords || src.geom) fullBbox = await duckTableFullBBox(engine, extra.duckTable, src)
      }
      // materialized = 「geojson 是否装着全部数据」，**不是**「有没有留内存表」（见 PushExtra.materialized 注释）。
      const total = extra.totalCount ?? fc.features.length
      const layer = makeResultLayer({
        id,
        name,
        geojson: fc,
        source: extra.source ?? 'csv',
        color: CSV_COLOR,
        cluster: extra.cluster ?? false,
        duckTable: extra.duckTable,
        duckCoords: extra.duckCoords,
        duckGeom: extra.duckGeom,
        totalCount: extra.totalCount,
        families: extra.families,
        materialized: extra.materialized ?? fc.features.length >= total,
        fullBbox,
      })
      st.layers = [...layers(), layer]
      return {
        ok: true,
        layerId: id,
        name: layer.name,
        featureCount: layer.featureCount,
        bbox: layer.bbox,
        message: `生成图层 ${id}（${layer.featureCount} 个要素）`,
      }
    }
    return { st, layers, resolve, pushResult }
  }
}
