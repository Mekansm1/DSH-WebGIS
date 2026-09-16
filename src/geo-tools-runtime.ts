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
import type { GeoWorkerJob } from './geo-job-ops.js'
import { shouldIsolate } from './geo-job-policy.js'
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

/**
 * 工具 execute 的 exec 形参里本层依赖的部分。
 *
 * `signal` 对应框架 `ToolRunContext.signal`(`dsh-tools` 类型文档:声明了 `timeoutMs` 就等于
 * 承诺把这个信号转发给"能在 abort 时收敛"的实现)。声明为**可选**是为了让测试里的假 exec
 * (`{ agent: ... }`)继续可用。
 */
export interface ToolExec {
  agent?: { id?: string }
  signal?: AbortSignal
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

/**
 * 「会隔离执行的重计算工具」共用的描述后缀。
 *
 * 为什么必须写进描述(而不只是代码里):这些工具现在**大图层走独立任务、超时会被停止**,
 * 而模型需要知道这件事才能如实告诉用户"这个可能要等一会儿 / 可以停" ——
 * 否则它只能自己臆测耗时,或者把中止说成失败。ARCHITECTURE 有硬规定:改工具行为必须同步改描述。
 */
export const ISOLATED_NOTE = '计算在独立任务中执行：大图层不会卡住对话；超时会自动停止且不产生半成品图层。'

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
  /**
   * 重 Turf/统计运算的隔离执行器。未注入时（旧宿主/单测）保持同步兼容。
   * `timeoutMs` 应取自 `workerBudget(GEO_TOOL_TIMEOUTS.x)` —— 见 `runGeoOp`。
   */
  runGeoJob?: <T>(job: GeoWorkerJob, timeoutMs: number, opts?: { signal?: AbortSignal }) => Promise<T>
}

/** 一次重计算的派发请求（`runGeoOp` 的入参）。 */
export interface GeoOpRequest<T> {
  exec: ToolExec
  job: GeoWorkerJob
  /** 隔离执行的预算，用 `workerBudget(GEO_TOOL_TIMEOUTS.x)` 得到（与工具的 timeoutMs 同源）。 */
  budgetMs: number
  /**
   * 主线程直算的闭包，**必须与 job 同语义**。两者的一致性由 `geo-job-ops.ts` 的同一个
   * `runGeoJobLocal` switch 保证 —— 调用点不要在这里写"另一套"实现。
   */
  sync: () => T
  /**
   * 调用点报上来的**真实**规模（见 `layerScale`）。缺省时退回 `estimateScale(job)`，
   * 那在抽样层上会低估 → 可能漏掉本该隔离的大任务。生产路径请显式传。
   */
  scale?: number
}

/** 派发结果。判别式信封 —— 不能直接返回 `T`，因为 4 个统计 op 的正常返回值本身就是 `{ok:false,message}`。 */
export type GeoOpResult<T> = { ok: true; value: T } | { ok: false; message: string }

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
  runGeoJob?: <T>(job: GeoWorkerJob, timeoutMs: number, opts?: { signal?: AbortSignal }) => Promise<T>
  /**
   * 重计算的**唯一派发漏斗**：门控（该不该隔离）+ 转发 `exec.signal` + 超时预算 + 统一错误形态。
   *
   * 为什么收敛成一个方法而不是 14 个调用点各写：
   * ① 这三件事天然同源，各写就是 14 次写错的机会；
   * ② 门控与错误形态能被**一个**测试覆盖；
   * ③ `runGeoJob` 的签名改动只需落在这一处。
   *
   * 调用点用法：
   * ```ts
   * const r = await rt.runGeoOp({ exec, job: {...}, budgetMs: workerBudget(GEO_TOOL_TIMEOUTS.op),
   *                               sync: () => opBuffer(layer, distance, unit), scale: layerScale(layer) })
   * if (!r.ok) return r                      // 已经是统一的中文 { ok:false, message }
   * return pushResult('缓冲', r.value, layer.name)
   * ```
   */
  runGeoOp: <T>(req: GeoOpRequest<T>) => Promise<GeoOpResult<T>>
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

  /**
   * 唯一派发漏斗。见 `GeoToolRuntime.runGeoOp` 的说明。
   *
   * 注意这里**不知道也不 import 任何 op** —— 主线程直算走调用点给的 `sync` 闭包。
   * 若在这里 switch(kind) 就会退化成第二个 dispatch 表(worker 里已经有一个),两边迟早分叉。
   */
  const runGeoOp = async <T>(req: GeoOpRequest<T>): Promise<GeoOpResult<T>> => {
    const job = req.job
    const decision = shouldIsolate(job, req.scale)
    // 没注入执行器(旧宿主/单测)时保持同步兼容 —— 与改动前的 `runGeoJob ? ... : opX(...)` 一致。
    const isolate = decision.isolate && typeof deps?.runGeoJob === 'function'
    if (!isolate) {
      // ⚠️ 同步路径同样要 catch:原先 14 个调用点里有 7 个没包 try/catch，
      // 于是同样的失败在不同工具表现为 isError / {ok:false} / 异常逃逸三种形态。
      try {
        return { ok: true, value: req.sync() }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
    try {
      const value = await deps!.runGeoJob!<T>(job, req.budgetMs, req.exec.signal ? { signal: req.exec.signal } : {})
      return { ok: true, value }
    } catch (err) {
      // 超时/取消/worker 异常都在这里收成统一形态。取消时**不会**走到 pushResult ——
      // 调用点是 `if (!r.ok) return r`，所以不会留下"模型认为不存在的图层"。
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    sess,
    pushResult,
    runGeoOp,
    ...(deps?.attrFilterFullTable ? { attrFilterFullTable: deps.attrFilterFullTable } : {}),
    ...(deps?.runGeoJob ? { runGeoJob: deps.runGeoJob } : {}),
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
