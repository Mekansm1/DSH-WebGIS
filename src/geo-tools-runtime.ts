/**
 * dsh-webgis GIS 工具层运行时：把七个域工具文件（geo-*-tools.ts）注册时「跨域共享但无 ctx
 * 依赖」的部分收敛成 createGeoToolRuntime(stateFor, hooks?)——会话注册表操作闭包 sess、
 * 结果图层产出 pushResult、展示方式/样式切换（applyMode/applyStyle）、共享文案与 schema。
 *
 * geo-tools.ts 只保留系统提示注入 + 组装；域文件各自 register*Tools(ctx, rt)，从 rt 取用本
 * 模块暴露的共享闭包/常量，工具注册属性与执行体行为与拆分前完全一致。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BBox, FeatureCollection } from 'geojson'
import type { DisplayMode, GisLayer, ModeParams } from './geo-processing.js'
import type { ThematicSpec } from './thematic.js'
import { RESULT_COLORS, makeResultLayer, requireLayer } from './geo-processing.js'
import { normalizeColor } from './postgis.js'
import type { BasemapExportParams, BasemapExportResult } from './session-state.js'

/** 工具层所需的注册表状态（index.ts 传入的 state 结构上满足此接口）。 */
export interface GeoRegistryState {
  layers: GisLayer[]
  /** 基础数据集（可能为 null）；工具可置空来移除基础数据集层。 */
  dataset: { name: string } | null
}

/** 一次工具执行解析出的会话注册表操作闭包（全部指向该会话自己的状态）。 */
export interface GeoSession {
  st: GeoRegistryState
  layers: () => GisLayer[]
  resolve: (id: unknown) => GisLayer | string
  pushResult: PushResultFn
}

/** 产出图层的工具返回体。 */
export interface PushResultOutput {
  ok: true
  layerId: string
  name: string
  featureCount: number
  bbox: BBox | null
  message: string
}

/**
 * 结果图层的附加承载属性：结果仍留在 DuckDB 全表时（如全表属性筛选）要把内存表句柄
 * 一并挂到新图层上，否则新图层会退化成"只有上图抽样"、不能继续链式筛选/全量统计。
 */
export type ResultLayerExtra = Pick<
  Parameters<typeof makeResultLayer>[0],
  'duckTable' | 'duckCoords' | 'duckGeom' | 'totalCount' | 'families' | 'fullBbox'
>

/** 对一个会话产出结果图层的函数（opLabel 拼图层名，geojson 归一化后 append 到该会话注册表）。 */
type PushResultFn = (
  opLabel: string,
  geojson: FeatureCollection,
  inputLabel: string,
  mode?: DisplayMode,
  modeParams?: ModeParams,
  extra?: ResultLayerExtra,
) => PushResultOutput

/** 工具 execute 的 exec 形参里本层只依赖 agent.id。 */
export interface ToolExec {
  agent?: { id?: string }
}

/** 图层生命周期钩子（index.ts 接线，用于联动释放图层引用的外部资源，如 DuckDB 内存表）。 */
export interface LayerLifecycleHooks {
  /** 图层被移除/清空时回调（传入被移除的图层；fire-and-forget，异步清理不阻塞工具返回）。 */
  onRemoveLayer?: (layer: GisLayer) => void
  /**
   * host 侧回调：请客户端按当前视窗从底图矢量瓦片导出要素（index.ts 接线到 state + 等待器）。
   * 提取只能在浏览器做 —— 瓦片已经以解码后的形式在 maplibre 内存里，host 拿不到。
   */
  exportBasemapFeatures?: (
    sessionId: string | undefined,
    params: BasemapExportParams,
  ) => Promise<{ ok: true; result: BasemapExportResult } | { ok: false; message: string }>
}

/** 每个产出图层的工具输出 schema（as const 让 defineTool 精确推断输出类型）。 */
export const LAYER_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    layerId: { type: 'string' },
    name: { type: 'string' },
    featureCount: { type: 'integer' },
    bbox: { type: 'json' },
    message: { type: 'string' },
  },
} as const

export const LAYER_PARAM = {
  type: 'string',
  required: true,
  description: '目标图层 id（先调用 webgis_list_layers 查看可用图层；dataset 为基础数据集）',
} as const

/** 不产出图层的统计工具输出 schema（仅返回统计值，不承诺 layerId/featureCount）。 */
export const STAT_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    stat: { type: 'string' },
    value: { type: 'json' },
    message: { type: 'string' },
  },
} as const

export function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

export const COMMON = '作用于当前 GIS 图层。图层 id 一律以 webgis_list_layers 返回为准（配置里的基础数据集=dataset；加载与工具产物形如 ds_<n>、csv_<n>、db_<n>、import_<n>、result_<n>）。'

/** 展示方式中文名。points/plane/hex=maplibre 原生；arc/trips/wall/radial=deck.gl 出图。 */
export const MODE_LABEL: Record<DisplayMode, string> = {
  points: '原始点',
  plane: '平面热力图',
  hex: '蜂窝热力图',
  arc: '弧线图',
  trips: '轨迹图',
  wall: '围墙图',
  radial: '辐射图',
}
/** 切换展示方式后要带给模型的提醒——让模型主动告知用户还有其他展示方式可选。 */
export const REMINDER = '请提醒用户：该图层还有其他展示方式（原始点 / 平面热力图 / 蜂窝热力图 / 弧线图 / 轨迹图 / 围墙图 / 辐射图），可随时要求我切换（如"切成轨迹图"）。'

/** 图层展示方式对几何类型的要求：不满足则无法切到该展示方式。 */
export const MODE_GEOMETRY: Record<DisplayMode, string[] | null> = {
  points: null,
  plane: ['Point'],
  hex: ['Point'],
  arc: ['LineString'],
  trips: ['LineString'],
  wall: ['Polygon'],
  radial: ['Point'],
}

/** 共享的展示方式切换：校验几何兼容性后原地改 mode / modeParams，不 bump rev。返回错误消息或 null。 */
export function applyMode(layer: GisLayer, mode: DisplayMode, params?: ModeParams): string | null {
  const required = MODE_GEOMETRY[mode]
  if (required && !required.some((t) => layer.geometryTypes.some((g) => g.includes(t)))) {
    return `图层 ${layer.id} 的几何类型（${layer.geometryTypes.join(' / ')}）不支持「${MODE_LABEL[mode]}」展示`
  }
  // 原地改、不 bump rev：纯展示变更，客户端按 mode 字段重渲染、不重拉数据。
  layer.mode = mode
  if (params && Object.keys(params).length > 0) layer.modeParams = params
  return null
}

/** 共享的图层样式修改：原地改 color / pointRadius / pointStrokeWidth / fillColor，不 bump rev（纯展示变更）。返回错误消息或 null。 */
export function applyStyle(
  layer: GisLayer,
  patch: {
    color?: string
    pointRadius?: number
    pointStrokeWidth?: number
    fillColor?: string
    /** 专题配色：传对象=开启；传 null=关闭。 */
    thematic?: ThematicSpec | null
  },
): string | null {
  const { color, pointRadius, pointStrokeWidth, fillColor, thematic } = patch
  if (color !== undefined) {
    const c = normalizeColor(color)
    if (!c) return '无法识别的颜色，请用十六进制 #rrggbb/#rgb 或颜色名（如 red / orange / 蓝）'
    layer.color = c
    // ⚠ 专题配色会覆盖单色填充：不在这里清掉的话，用户要「改成红色」会看不到任何变化。
    delete layer.thematic
  }
  if (pointRadius !== undefined) {
    if (!Number.isFinite(pointRadius) || pointRadius <= 0 || pointRadius > 100) {
      return 'radius 必须是 1~100 的正数（像素）'
    }
    layer.pointRadius = pointRadius
  }
  if (pointStrokeWidth !== undefined) {
    if (!Number.isFinite(pointStrokeWidth) || pointStrokeWidth < 0 || pointStrokeWidth > 50) {
      return 'strokeWidth 必须是 0~50 的非负数（像素）'
    }
    layer.pointStrokeWidth = pointStrokeWidth
  }
  if (fillColor !== undefined) {
    const c = normalizeColor(fillColor)
    if (!c) return '无法识别的填充颜色，请用十六进制 #rrggbb/#rgb 或颜色名'
    layer.fillColor = c
    delete layer.thematic
  }
  if (thematic !== undefined) {
    if (thematic === null) delete layer.thematic
    else layer.thematic = thematic
  }
  return null
}

/** 结果图层 id 递增计数器（进程内，跨会话全局唯一即可）。 */
let resultSeq = 0

/** 底层图层产出：append 一个 result_<n> 图层到 st.layers（++resultSeq 决定 id 与轮换色）。 */
function pushResultTo(
  st: GeoRegistryState,
  getLayers: () => GisLayer[],
  opLabel: string,
  geojson: FeatureCollection,
  inputLabel: string,
  mode?: DisplayMode,
  modeParams?: ModeParams,
  extra?: ResultLayerExtra,
): PushResultOutput {
  const id = `result_${++resultSeq}`
  const layer = makeResultLayer({
    id,
    name: `${opLabel} - ${inputLabel}`,
    geojson,
    source: 'gis-result',
    color: RESULT_COLORS[resultSeq % RESULT_COLORS.length] ?? '#3b82f6',
    ...(mode ? { mode } : {}),
    ...(modeParams && Object.keys(modeParams).length > 0 ? { modeParams } : {}),
    ...extra,
  })
  st.layers = [...getLayers(), layer]
  return {
    ok: true,
    layerId: id,
    name: layer.name,
    featureCount: layer.featureCount,
    bbox: layer.bbox,
    message: `${opLabel}完成：生成图层 ${id}（${layer.featureCount} 个要素）`,
  }
}

/** 全表属性筛选的产出（duckdb 域实现，见 duckdb/attr-filter.ts 的 duckAttrFilter）。 */
export interface FullTableAttrFilterOk {
  ok: true
  /** 全表命中行数。 */
  count: number
  /** 结果内存表名（挂到新图层，可继续链式筛选）。 */
  table: string
  geojson: FeatureCollection
  /** 「命中 N 行，上图 M 行」（与 webgis_filter_layer 同口径文案）。 */
  message: string
  extra: ResultLayerExtra
}

export type FullTableAttrFilter = (
  layer: GisLayer,
  field: string,
  operator: string,
  value: string | undefined,
) => Promise<FullTableAttrFilterOk | { ok: false; message: string }>

/** 域工具注册所需的 host 注入依赖（可选；缺省时相关能力自动退回原路线）。 */
export interface GeoToolDeps {
  /** 大图层属性筛选下推到 DuckDB 全表。 */
  attrFilterFullTable?: FullTableAttrFilter
}

/** 域工具注册函数共享的运行时面（见 createGeoToolRuntime）。 */
export interface GeoToolRuntime {
  /** 按本次执行的会话 id 解析其图层注册表操作闭包（read/write 都落在该会话自己的 state 上）。 */
  sess: (exec: ToolExec) => GeoSession
  /** 直接对一次执行产出结果图层（按 exec 重解析会话状态；sess(exec).pushResult 的底层实现）。 */
  pushResult: (
    exec: ToolExec,
    opLabel: string,
    geojson: FeatureCollection,
    inputLabel: string,
    mode?: DisplayMode,
    modeParams?: ModeParams,
    extra?: ResultLayerExtra,
  ) => PushResultOutput
  /**
   * 大图层属性筛选下推（host 注入；turf 域拿不到 DuckDB 引擎）。存在且图层有内存表时，
   * 按属性筛选类工具应改道到这里跑全表，而不是在 geojson 抽样上静默算错。
   * 未注入（单测/裁剪部署）时返回 undefined，调用方退回原 Turf 路线。
   */
  attrFilterFullTable?: FullTableAttrFilter
  /** host 侧钩子（图层生命周期 + 底图要素导出请求转发）。 */
  hooks: LayerLifecycleHooks | undefined
  /** 展示方式切换：校验几何兼容性后原地改 mode/modeParams，不 bump rev。 */
  applyMode: (layer: GisLayer, mode: DisplayMode, params?: ModeParams) => string | null
  /** 图层样式修改：原地改 color/pointRadius/pointStrokeWidth/fillColor/thematic，不 bump rev。 */
  applyStyle: (
    layer: GisLayer,
    patch: {
      color?: string
      pointRadius?: number
      pointStrokeWidth?: number
      fillColor?: string
      thematic?: ThematicSpec | null
    },
  ) => string | null
  COMMON: string
  MODE_LABEL: Record<DisplayMode, string>
  MODE_GEOMETRY: Record<DisplayMode, string[] | null>
  REMINDER: string
  LAYER_RESULT_SCHEMA: typeof LAYER_RESULT_SCHEMA
  LAYER_PARAM: typeof LAYER_PARAM
  STAT_RESULT_SCHEMA: typeof STAT_RESULT_SCHEMA
  text: (content: string) => ContentBlock[]
  RESULT_COLORS: readonly string[]
}

/**
 * 构造域工具注册所需的共享运行时。`stateFor`/`hooks` 由 host 注入（index.ts 接线）；
 * 返回对象里的 sess/applyMode/applyStyle 等即拆分前 registerGeoTools 大闭包内的同名共享件。
 */
export function createGeoToolRuntime(
  stateFor: (sessionId: string | undefined) => GeoRegistryState,
  hooks?: LayerLifecycleHooks,
  deps?: GeoToolDeps,
): GeoToolRuntime {
  const sess = (exec: ToolExec): GeoSession => {
    const st = stateFor(exec.agent?.id)
    const layers = (): GisLayer[] => st.layers
    const resolve = (id: unknown): GisLayer | string => {
      const s = typeof id === 'string' ? id : ''
      return requireLayer(layers(), s)
    }
    const pushResult: PushResultFn = (opLabel, geojson, inputLabel, mode?, modeParams?, extra?) =>
      pushResultTo(st, layers, opLabel, geojson, inputLabel, mode, modeParams, extra)
    return { st, layers, resolve, pushResult }
  }

  const pushResult = (
    exec: ToolExec,
    opLabel: string,
    geojson: FeatureCollection,
    inputLabel: string,
    mode?: DisplayMode,
    modeParams?: ModeParams,
    extra?: ResultLayerExtra,
  ): PushResultOutput => {
    const st = stateFor(exec.agent?.id)
    return pushResultTo(st, () => st.layers, opLabel, geojson, inputLabel, mode, modeParams, extra)
  }

  return {
    sess,
    pushResult,
    ...(deps?.attrFilterFullTable ? { attrFilterFullTable: deps.attrFilterFullTable } : {}),
    hooks,
    applyMode,
    applyStyle,
    COMMON,
    MODE_LABEL,
    MODE_GEOMETRY,
    REMINDER,
    LAYER_RESULT_SCHEMA,
    LAYER_PARAM,
    STAT_RESULT_SCHEMA,
    text,
    RESULT_COLORS,
  }
}
