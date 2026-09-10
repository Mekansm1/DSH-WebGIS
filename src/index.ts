/**
 * dsh-webgis host 侧：注册工具与 HTTP 路由。
 * 维护一个进程内地图状态（数据集 + 导航意图），客户端轮询 /webgis/state 消费。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
// dsh-settings 0.1.2-rc.1 起重构成 SettingsProvider，旧顶层 installSettingsSection/settingsNamespace 已移除。
// 用 namespace 导入(而非具名)+运行时探测兼容新旧——否则任一版本缺该具名导出会直接启动期 SyntaxError。
import * as dshSettingsModule from '@deepseek-ai/dsh-settings'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import { projectLngLatToCss, unprojectCssToLngLat } from './geo.js'
import type { VisionConfig, VisionAnalysisResult } from './vision-chain.js'
import { analyzeScreenshotChain } from './vision-chain.js'
import { makeResultLayer, summarize } from './geo-processing.js'
import { registerGeoTools } from './geo-tools.js'
import { CARTO_LIGHT_TILES } from './basemaps.js'
import type { PostgisConfig } from './postgis.js'
import type { DbManager } from './db-manager.js'
import { createDbManager } from './db-manager.js'
import { registerDbTools } from './db-tools.js'
import {
  ingestBigGeojson,
  loadCsvSourceData,
  loadVectorSourceData,
  registerDuckDbTools,
  VECTOR_SOURCE_EXTS,
  type IngestBigResult,
  type VectorLayerData,
} from './duckdb-tools.js'
import { getDuckDb, type DuckDbOptions } from './duckdb.js'
import { isWebgisRouteBlocked, loadPluginEnabled } from './enabled.js'
import { webgisToolGuardReason } from './tool-guard.js'
import { SessionStateStore } from './session-state.js'
import type { DatasetInfo, GeoJson, WebgisState } from './session-state.js'
import type { FeatureCollection } from 'geojson'
// 声明合并触发器：让 ctx.webServer / 会话类型可见
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-session'
import { awaitCurrentViewCapture, awaitExportCompletion, text } from './wait-utils.js'
export { awaitCurrentViewCapture, awaitExportCompletion } from './wait-utils.js'
import { arrowCacheClearSession, dropLayerResources } from './arrow-cache.js'
export { dropLayerResources } from './arrow-cache.js'
import { headerString, isTrustedLocalRequest, jsonError, notFound } from './http-utils.js'
import {
  modelSupportsImage, screenshotMeta, type ScreenshotMeta,
} from './screenshot-utils.js'
import { loadDataset, resolveSourceLocal } from './dataset-load.js'
export { parseShapefileBuffer, loadShapefile, loadDataset, loadCsv, loadCsvText } from './dataset-load.js'
import type { RouteApi, RouteDef } from './route-shared.js'
import { route } from './route-shared.js'
import { handlePick } from './routes-pick.js'
import {
  handleArrow, handleArrowAttr, handleArrowRid, handleDataset, handleGisResult,
  handleLayerAttrs, handleLayerRender, handleLayerRow, handlePluginConfig, handleState, handleStatus,
} from './routes-state.js'
import { handleExport, handleImport, handleLayerAction } from './routes-layers.js'
import { handleAttachment, handleExportImage } from './routes-export.js'
import {
  handlePostgisAction, handlePostgisConfigGet, handlePostgisConfigPost,
  handleVisionConfigGet, handleVisionConfigPost,
} from './routes-config.js'
import {
  handleEvents, handleServicesGet, handleServicesPost, handleServicesRemove,
  handleServicesVisibility, handleStaticAsset,
} from './routes-misc.js'

export const name = 'webgis'
// cordis 4.0.2+ 对「未在 inject 里声明的服务」有访问护栏。settings = dsh-settings 的 SettingsProvider
// (ctx.settings)，0.1.2-rc.1 起要用 installSection 就必须显式注入；0.1.1 也提供该服务，注入无副作用。
export const inject = ['tools', 'webServer', 'attachments', 'llm', 'credentials', 'settings']

export interface Config {
  /** 底图瓦片模板 URL，支持 {z}/{x}/{y} 占位。 */
  baseTileUrl: string
  /** 默认数据集：插件包内相对路径 / 绝对路径 / http(s) URL。 */
  defaultDataset?: string
  /**
   * 视觉模型（看图委托）：主模型为文本模型、点击截图存在时，`webgis_get_pick`
   * 会委托视觉链路分析地图截图并把文字分析返回给主模型。
   * - `provider`/`model`：走 DSH 原生适配器（需注册过对应 provider 的 adapter）；
   * - `baseURL`/`model`/`apiKeyEnv`：直连 OpenAI 兼容端点（`${baseURL}/chat/completions`），
   *   不依赖 DSH 适配器；`apiKeyEnv` 留空 = 免 Key 直连。
   * 均未配置时仍会走内置 OVH 匿名免费兜底（见 freeFallback）。
   */
  vision?: { provider?: string; model?: string; baseURL?: string; apiKeyEnv?: string }
  /** 所有视觉后端都失败时，是否追加内置 OVH 匿名免费兜底（免 Key）。默认 true。 */
  freeFallback?: boolean
  /** PostgreSQL/PostGIS 连接（AI 只读查询，结果上图）。可在插件设置卡片里配置，或在 cordis.patch.yml 里写。 */
  postgis?: PostgisConfig
  /** DuckDB 本地 CSV 引擎（大文件秒级加载/筛选）。字段说明见 DuckDbOptions。 */
  duckdb?: DuckDbOptions
}
export const Config: z<Config> = z.object({
  baseTileUrl: z.string().default(CARTO_LIGHT_TILES),
  defaultDataset: z.string().default(''),
  vision: z.object({
    provider: z.string().required(false),
    model: z.string().required(false),
    baseURL: z.string().required(false),
    apiKeyEnv: z.string().required(false),
  }).required(false),
  freeFallback: z.boolean().default(true),
  postgis: z.object({
    host: z.string().required(false),
    port: z.number().required(false),
    database: z.string().required(false),
    user: z.string().required(false),
    password: z.string().required(false),
    cluster: z.object({
      askFrom: z.number().required(false),
      autoClusterFrom: z.number().required(false),
      maxLoad: z.number().required(false),
    }).required(false),
  }).required(false),
  duckdb: z.object({
    papaparseThreshold: z.number().required(false),
    maxTotalRows: z.number().required(false),
    memoryLimit: z.string().required(false),
    timeoutMs: z.number().required(false),
  }).required(false),
})

/** 视觉模型配置段（settings 命名空间 `webgis`）。字段可留空；GUI 卡片数据仍走 HTTP 文件。 */
const VisionSettingsSchema = z.object({
  provider: z.string().required(false),
  model: z.string().required(false),
  baseURL: z.string().required(false),
  apiKeyEnv: z.string().required(false),
})

export function apply(ctx: Context, config: Config): void {
  // ---- 会话状态存储：所有地图状态（dataset/navigate/pick/图层）按 session id 隔离 ----
  // 工具侧 exec.agent?.id 与客户端 ?session=<会话 id> 共用同一键，互不串扰、销毁即回收。
  let defaultDataset: DatasetInfo | null = null
  const states = new SessionStateStore(() => {
    const st: WebgisState = {
      dataset: null, navigate: null, pick: null, capture: null, captureError: null,
      exportRequest: null, exportImage: null,
      layers: [],
    }
    // 已配置默认数据集时，新会话各自带上独立副本（后续加载别的数据不影响其他会话）。
    if (defaultDataset) seedDataset(st, defaultDataset)
    return st
  })
  /** 按会话 id 解析该会话的地图状态（工具执行 / HTTP 路由共用）。 */
  const stateFor = (sessionId: string | undefined): WebgisState => states.get(sessionId)

  // ---- SSE 状态推送（方案：远期规划「1s 轮询 → 推送」）----
  // 不为几十个写点逐桩埋通知：对「有订阅会话」每 250ms 比对一次状态摘要指纹，变了才推 `sync` 事件，
  // 客户端收到即拉 /webgis/state → 交互延迟从 ~1s 降到 ~推送粒度。1s 轮询保留当掉线兜底。
  // 指纹只用摘要（summarize 无 geojson），每会话几千字节以内，开销可忽略。
  const sseClients = new Map<string, Set<import('node:http').ServerResponse>>()
  const sseStateHash = new Map<string, string>()
  const stateFingerprint = (st: WebgisState): string => JSON.stringify({
    ds: st.dataset
      ? { n: st.dataset.name, c: st.dataset.featureCount, v: st.layers.find((l) => l.id === 'dataset')?.visible ?? true }
      : null,
    nav: st.navigate,
    capture: st.capture?.seq ?? null,
    // 出图请求（含 seq/params）：工具置请求时要能立刻推给客户端开弹窗
    er: st.exportRequest,
    layers: st.layers.map(summarize),
  })
  const pushSseIfChanged = (): void => {
    for (const key of sseClients.keys()) {
      if (!states.has(key)) {
        // 会话已不存在（罕见）：清订阅与指纹，防泄漏
        sseClients.delete(key)
        sseStateHash.delete(key)
        continue
      }
      const fp = stateFingerprint(stateFor(key))
      if (sseStateHash.get(key) === fp) continue
      sseStateHash.set(key, fp)
      const subs = sseClients.get(key)
      if (!subs) continue
      for (const res of subs) {
        try {
          res.write('data: sync\n\n')
        } catch {
          // 连接已断：close 事件会从集合移除，这里只跳过本轮
        }
      }
    }
  }
  ctx.effect(() => {
    const timer = setInterval(pushSseIfChanged, 250)
    return () => clearInterval(timer)
  }, 'webgis: sse push')

  /** 会话销毁：先释放该会话图层引用的外部资源（DuckDB 内存表 DROP + Arrow IPC 缓存），再回收状态。
   *  此前只 dispose() 删 Map，duckTable/arrow 字节会泄漏到进程级；大图层多会话时内存只涨不还。 */
  ctx.on('session/disposed', (session: { id: string }) => {
    const st = states.has(session.id) ? stateFor(session.id) : null
    if (st) for (const layer of st.layers) dropLayerResources(layer)
    arrowCacheClearSession(session.id)
    // 关掉该会话挂着的 SSE 长连接（session 没了，客户端该重开或走 1s 轮询）
    const subs = sseClients.get(session.id)
    if (subs) {
      for (const res of subs) {
        try { res.end() } catch { /* 已断 */ }
      }
      sseClients.delete(session.id)
      sseStateHash.delete(session.id)
    }
    states.dispose(session.id)
  })

  /** 默认数据集（config.defaultDataset）播种：与其它图层**叠加共存**（不再整组清空注册表）。
   *  替换同 id 的 dataset 时先释放旧表并 bump rev（客户端靠 rev/shape 变更检测重建，避免旧层残留）。
   *  注意：webgis_load_dataset 已改走 additive（追加 ds_N），不再调用本函数播种基础层。 */
  function seedDataset(st: WebgisState, ds: DatasetInfo, big: IngestBigResult | null = null): void {
    const oldDs = st.layers.find((l) => l.id === 'dataset')
    if (oldDs) dropLayerResources(oldDs) // 换 dataset 先释放旧基础层的 DuckDB 内存表/arrow 缓存
    const geojson = (big?.geojson ?? ds.geojson) as GeoJson
    st.dataset = { name: ds.name, geojson, featureCount: big?.totalCount ?? ds.featureCount }
    const layer = makeResultLayer({
      id: 'dataset',
      name: ds.name,
      geojson,
      source: 'dataset',
      // 同 id 重播种（默认数据集刷新）也要 bump，否则客户端 dataChanged 判定不到内容变化。
      rev: oldDs ? oldDs.rev + 1 : 0,
      ...(big ? { duckTable: big.duckTable, duckGeom: big.duckGeom, totalCount: big.totalCount, fullBbox: big.fullBbox } : {}),
    })
    st.layers = [layer, ...st.layers.filter((l) => l.id !== 'dataset')]
  }
  const seqs = { navigateSeq: 0, captureSeq: 0, pickSeq: 0, importSeq: 0, datasetSeq: 0, exportSeq: 0 }

  // ---- 启停开关：启动时读一次持久化开关（默认启用；失败静默，与视觉/PostGIS 配置读取同模式）----
  loadPluginEnabled()

  // 插件关闭时统一拒绝所有 webgis_* 工具（guard 是平台原生机制，单点覆盖 37 个工具，返回 disposer 便于 HMR 清理）。
  ctx.effect(() => ctx.tools.guard(webgisToolGuardReason), 'webgis: enabled guard')

  // 视觉模型配置：GUI 卡片通过 HTTP 路由读写，存到 ~/.dsh/webgis-vision.json。
  // GUI 设置优先，其次 settings 命名空间，再其次插件配置 config.vision。
  const visionFile = join(homedir(), '.dsh', 'webgis-vision.json')
  let visionCfg: VisionConfig | null = null

  // 叠加地图服务（WMTS/WMS/XYZ）：设置卡片读写 ~/.dsh/webgis-services.json。
  const servicesFile = join(homedir(), '.dsh', 'webgis-services.json')

  // 注册 settings 命名空间 `webgis`：让 DSH 按命名空间分发插件配置卡片、vision 也能走配置文件。
  // 数据仍走 GUI 的 HTTP 文件；此命名空间只保证卡片可分发。dsh-settings 0.1.2-rc.1 后 API 从顶层
  // installSettingsSection 迁到 ctx.settings.installSection——这里运行时探测，两版都兼容。
  let configVisionSource: () => VisionConfig = () => ({})
  const visionHooks = {
    setSource: (read: () => VisionConfig): void => {
      configVisionSource = read
    },
    onChange: (): void => {},
  }
  const dsSettings = dshSettingsModule as unknown as {
    installSettingsSection?: (owner: Context, ns: string, schema: unknown, entry: unknown, hooks: unknown) => void
    settingsNamespace?: (value: string) => string
  }
  const provider = (ctx as unknown as {
    settings?: { installSection?: (owner: Context, ns: string, schema: unknown, entry: unknown, hooks: unknown) => void }
  }).settings
  try {
    if (typeof dsSettings.installSettingsSection === 'function') {
      const ns = typeof dsSettings.settingsNamespace === 'function' ? dsSettings.settingsNamespace('webgis') : 'webgis'
      dsSettings.installSettingsSection(ctx, ns, VisionSettingsSchema, config.vision ?? {}, visionHooks)
    } else if (provider && typeof provider.installSection === 'function') {
      provider.installSection(ctx, 'webgis', VisionSettingsSchema, config.vision ?? {}, visionHooks)
    }
  } catch (err) {
    // settings 未就绪/注册失败只影响卡片分发，不阻断插件启动。
    ctx.logger.warn('[webgis] settings 命名空间注册跳过: %s', err instanceof Error ? err.message : String(err))
  }

  // 启动时读一次持久化的 GUI 配置（失败静默，不影响插件启动）
  readFile(visionFile, 'utf8').then((raw) => {
    const parsed = JSON.parse(raw) as VisionConfig
    if (parsed?.provider && parsed.model) visionCfg = parsed
  }).catch(() => {})

  // ---- PostgreSQL/PostGIS 连接配置：GUI 卡片读写 ~/.dsh/webgis-postgis.json ----
  // 优先级：GUI 设置 > settings 命名空间/插件配置 config.postgis。
  // 安全：密码不落盘——文件只保存凭据引用 passwordRef，真实值存 DSH 凭据存储/环境变量
  // （ctx.credentials），内存里才持有解析后的明文（每次连接实时读取）。
  const postgisFile = join(homedir(), '.dsh', 'webgis-postgis.json')
  /** PostGIS 密码的凭据引用名（POSIX 标识符；可用同名环境变量直接提供密码）。 */
  const POSTGIS_PASSWORD_REF = 'WEBGIS_POSTGIS_PASSWORD'
  let postgisCfg: PostgisConfig | null = null
  let configPostgisSource: () => PostgisConfig = () => ({})
  // （webgis-postgis 命名空间已随设置卡片合并移除：PostGIS 配置仍走 GUI HTTP 文件 + config.postgis。）
  readFile(postgisFile, 'utf8').then(async (raw) => {
    const parsed = JSON.parse(raw) as PostgisConfig & { passwordRef?: string }
    if (!parsed || typeof parsed !== 'object') return
    if (typeof parsed.password === 'string' && parsed.password) {
      // 旧版文件把密码明文存 password 字段：一次性迁移到凭据存储，文件只留引用。
      await ctx.credentials.set(credentialRef(POSTGIS_PASSWORD_REF), parsed.password).catch((err: unknown) => {
        ctx.logger.warn('[webgis] PostGIS 密码迁移到凭据存储失败: %s', err instanceof Error ? err.message : String(err))
      })
      parsed.passwordRef = POSTGIS_PASSWORD_REF
      const toFile = { ...parsed }
      delete toFile.password
      await writeFile(postgisFile, JSON.stringify(toFile), 'utf8').catch(() => {})
      // 内存保留本次解析值（迁移写凭据存储即使失败，本进程仍可用旧明文连接）。
    } else if (parsed.passwordRef && isCredentialRefName(parsed.passwordRef)) {
      // 新格式：按引用解析真实密码（环境变量 / 凭据存储），仅驻留内存。
      const resolved = await ctx.credentials.resolve(credentialRef(parsed.passwordRef))
      if (resolved) parsed.password = resolved.value
    }
    postgisCfg = parsed
  }).catch(() => {})

  /** 取生效的 PostGIS 连接配置：GUI 设置优先，其次 settings 命名空间/插件配置。 */
  function effectivePostgis(): PostgisConfig {
    const base = { ...(config.postgis ?? {}), ...configPostgisSource() }
    if (!postgisCfg) return base
    const out: PostgisConfig = { ...base }
    if (postgisCfg.host) out.host = postgisCfg.host
    if (postgisCfg.port) out.port = postgisCfg.port
    if (postgisCfg.database) out.database = postgisCfg.database
    if (postgisCfg.user) out.user = postgisCfg.user
    if (postgisCfg.password !== undefined) out.password = postgisCfg.password
    if (postgisCfg.cluster) out.cluster = { ...(out.cluster ?? {}), ...postgisCfg.cluster }
    return out
  }

  /** PostgreSQL/PostGIS 连接池 + 库结构缓存（懒建、配置变更自动重建）。 */
  const db: DbManager = createDbManager({
    getConfig: effectivePostgis,
    schemaFile: join(homedir(), '.dsh', 'webgis-dbschema.json'),
    logger: ctx.logger,
  })

  /** 取视觉模型配置：GUI 设置优先，其次 settings 命名空间/插件配置 config.vision；均未配置返回 null。 */
  function effectiveVision(): VisionConfig | null {
    if (visionCfg?.provider && visionCfg.model) return visionCfg
    const fromSection = configVisionSource()
    if (fromSection.provider && fromSection.model) return fromSection
    if (config.vision?.provider && config.vision.model) return config.vision
    return null
  }

  // 默认数据集：可选加载（配置里给了路径才加载，失败仅告警不阻塞插件）。
  // 每个会话各自持有默认数据集的独立副本；已存在的会话状态也补发一份（尚未自加载的）。
  if (config.defaultDataset) {
    loadDataset(config.defaultDataset)
      .then((ds) => {
        defaultDataset = ds
        for (const st of states.all()) {
          if (!st.dataset) seedDataset(st, ds)
        }
      })
      .catch((err: unknown) => {
        ctx.logger.warn('[webgis] 默认数据集加载失败: %s', err instanceof Error ? err.message : String(err))
      })
  }

  // ---- HTTP 路由：表驱动分发（各路由 handler 见 routes-*.ts；index.ts 只组装分发表） ----
  const routeApi: RouteApi = {
    ctx,
    config,
    stateFor,
    seqs,
    db,
    effectivePostgis,
    effectiveVision,
    dropLayerResources,
    visionCfg: { get: () => visionCfg, set: (v) => { visionCfg = v } },
    postgisCfg: { get: () => postgisCfg, set: (v) => { postgisCfg = v } },
    visionFile,
    postgisFile,
    servicesFile,
    postgisPasswordRef: POSTGIS_PASSWORD_REF,
    sseClients,
    sseStateHash,
    stateFingerprint,
  }
  const routeDefs: RouteDef[] = [
    route('POST', '/webgis/pick', handlePick),
    route(null, '/webgis/state', handleState),
    route(null, '/webgis/status', handleStatus),
    route('POST', '/webgis/plugin-config', handlePluginConfig),
    route(null, '/webgis/dataset', handleDataset),
    route(null, '/webgis/gis-result', handleGisResult),
    route(null, '/webgis/layer-attrs', handleLayerAttrs),
    route(null, '/webgis/layer-render', handleLayerRender),
    route(null, '/webgis/layer-row', handleLayerRow),
    route(null, '/webgis/arrow', handleArrow),
    route(null, '/webgis/arrow-attr', handleArrowAttr),
    route(null, '/webgis/arrow-rid', handleArrowRid),
    route('POST', '/webgis/layer-action', handleLayerAction),
    route('POST', '/webgis/import', handleImport),
    route(null, '/webgis/export', handleExport),
    route('POST', '/webgis/export-image', handleExportImage),
    route('GET', '/webgis/attachment', handleAttachment),
    route('GET', '/webgis/vision-config', handleVisionConfigGet),
    route('POST', '/webgis/vision-config', handleVisionConfigPost),
    route('GET', '/webgis/postgis-config', handlePostgisConfigGet),
    route('POST', '/webgis/postgis-config', handlePostgisConfigPost),
    route('POST', '/webgis/postgis-action', handlePostgisAction),
    route('GET', '/webgis/services', handleServicesGet),
    route('POST', '/webgis/services', handleServicesPost),
    route('POST', '/webgis/services/remove', handleServicesRemove),
    route('POST', '/webgis/services/visibility', handleServicesVisibility),
    { match: (p) => p === '/webgis/maplibre-gl.css' || p === '/webgis/maplibre-gl-csp-worker.js' || p === '/webgis/earcut-worker.js'
      || p === '/webgis/gis.js' || p === '/webgis/deck.js' || p === '/webgis/draw.js' || p === '/webgis/export.js', h: handleStaticAsset },
    route(null, '/webgis/events', handleEvents),
  ]

  // ---- HTTP 路由 ----
  const web = ctx.webServer
  if (web.host === '0.0.0.0') {
    ctx.logger.warn('[webgis] webServer 监听 0.0.0.0（全接口）——/webgis/* 信任围栏仅放行 loopback Host，'
      + '远程来源请求将被 403；如确需局域网访问请改用其他鉴权方式。')
  }
  ctx.effect(() => web.register({
    kind: 'prefix',
    path: '/webgis',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname.replace(/\/+$/, '')
      // ---- 访问边界（信任围栏）：参照 DSH /api 的浏览器信任围栏 ----
      // Host 必须 loopback（防 DNS rebinding）；sec-fetch-site 非 cross-site；Origin 若存在必须等于请求主机（防 CSRF）。
      if (!isTrustedLocalRequest(req)) {
        return void jsonError(res, 403, 'forbidden')
      }
      // 会话 id：客户端带 ?session=<会话 id>（或 X-Webgis-Session 头），路由解析到该会话自己的地图状态。
      const sessionId = (url.searchParams.get('session') ?? headerString(req, 'x-webgis-session'))?.slice(0, 200)
      const state = stateFor(sessionId)
      // 插件关闭：除配置/状态/静态资源白名单外全部 503（卡片仍可打开以重新开启）。
      if (isWebgisRouteBlocked(pathname)) {
        return void jsonError(res, 503, 'WebGIS 插件已关闭')
      }
      // 表驱动分发：每个 pathname 只命中一个 handler（else-if 链语义）；未命中 404 兜底。
      for (const r of routeDefs) {
        if (r.match(pathname, req.method ?? 'GET')) {
          return r.h(req, res, url, pathname, sessionId, state, routeApi)
        }
      }
      notFound(res, 'unknown webgis route')
    },
  }), 'webgis: routes')


  // ---- 工具：地图出图（合成 PNG 附件；AI 交互给参数 → 客户端弹窗确认导出） ----
  const renderExportMap = (_args: unknown, value: unknown): ContentBlock[] => {
    const v = value as {
      ok?: boolean; message?: string; width?: number; height?: number; title?: string
      attachImage?: boolean; image?: { ref?: unknown } | null
    }
    if (!v.ok || !v.image?.ref) return text(JSON.stringify(value))
    const size = v.width && v.height ? `（${v.width}×${v.height}px）` : ''
    const title = v.title ? `「${v.title}」` : ''
    const body = `出图完成${size}${title}。${v.message ?? ''}`
    if (!v.attachImage) {
      return text(`${body} 当前模型不支持图像输入，出图已保存（可直接下载）；接入视觉模型后即可直接看图。`)
    }
    return [{ type: 'image', attachment: v.image.ref } as ContentBlock, ...text(body)]
  }
  ctx.tools.register(defineTool({
    name: 'webgis_export_map',
    description:
      '把当前地图导出成一张带版式的图片（可带标题/图例/指北针/比例尺）。'
      + '会在用户的出图弹窗里预填这些参数并等待用户确认导出（用户点「导出并给 AI 看」），'
      + '完成后本工具把出图 PNG 作为图片返回（能看图模型直接看到；文本模型返回文字说明）。'
      + '图例为「图层级」：每个被勾选的可见图层一条色块。'
      + '当用户想「把这几层出张图 / 导出一张带图例的地图」时调用；纯想下载文件可让用户在出图弹窗点「导出 PNG」。',
    parameters: {
      title: { type: 'string', description: '图片标题（留空则不画标题）' },
      layers: { type: 'json', description: '要包含的图层 id 数组（缺省=全部可见图层）' },
      legend: { type: 'boolean', description: '是否带图例，缺省 true' },
      north: { type: 'boolean', description: '是否带指北针，缺省 true' },
      scale: { type: 'boolean', description: '是否带比例尺，缺省 true' },
      note: { type: 'string', description: '底部注记/版权文字（缺省用 © OpenStreetMap）' },
      extent: { type: 'string', description: "'view'=当前视野（缺省）；'all'=覆盖全部所选图层范围" },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          title: { type: 'string' },
          attachImage: { type: 'boolean' },
          image: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: renderExportMap,
    },
    timeoutMs: 90000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const st = stateFor(exec.agent?.id)
      const layers = Array.isArray(args.layers)
        ? args.layers.filter((x: unknown): x is string => typeof x === 'string')
        : undefined
      const seq = ++seqs.exportSeq
      st.exportRequest = {
        seq,
        params: {
          title: typeof args.title === 'string' && args.title ? args.title : undefined,
          layerIds: layers && layers.length ? layers : undefined,
          legend: args.legend !== false,
          north: args.north !== false,
          scale: args.scale !== false,
          note: typeof args.note === 'string' && args.note ? args.note : undefined,
          extent: args.extent === 'all' ? 'all' : 'view',
        },
      }
      const img = await awaitExportCompletion(st, seq)
      if (!img) return { ok: false, message: '等待出图超时（请在地图出图弹窗点「导出并给 AI 看」）' }
      const supports = await modelSupportsImage(ctx, exec)
      return {
        ok: true,
        width: img.width,
        height: img.height,
        title: img.title,
        attachImage: supports,
        image: { ref: img.ref } as unknown as JsonValue,
        message: '已在出图弹窗完成导出。',
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'webgis_get_export_map',
    description:
      '获取本会话最近一次地图出图（用户在出图弹窗导出，或 webgis_export_map 生成的那张）。'
      + '把出图 PNG 作为图片返回。用户手动出图后问「刚才出的那张图/看看效果」时调用；还没有出图返回错误。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          width: { type: 'integer' },
          height: { type: 'integer' },
          title: { type: 'string' },
          attachImage: { type: 'boolean' },
          image: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: renderExportMap,
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const st = stateFor(exec.agent?.id)
      const img = st.exportImage
      if (!img) return { ok: false, message: '还没有出图（先在出图弹窗导出，或让 AI 调 webgis_export_map 出一张）' }
      const supports = await modelSupportsImage(ctx, exec)
      return {
        ok: true,
        width: img.width,
        height: img.height,
        title: img.title,
        attachImage: supports,
        image: { ref: img.ref } as unknown as JsonValue,
        message: '最近一次出图。',
      }
    },
  }))

  // ---- 工具：加载数据集 ----
  ctx.tools.register(defineTool({
    name: 'webgis_load_dataset',
    description:
      '把数据文件加载为一个新图层显示。支持：GeoJSON（.geojson/.json）、shapefile 的 .zip 包'
      + '（推荐，内含 .shp/.dbf/.prj 一组）或单个 .shp 文件、以及 CSV（自动识别经纬度/WKT 几何列，大文件经 DuckDB 抽样防内存爆）。'
      + '本地矢量文件 .shp/.gdb/.gpkg/.kml/.tab/.mif 走 DuckDB spatial 的 GDAL 直读（ST_Read）直接灌表：'
      + '超大 .shp 不再先经 shpjs 把全量要素物化成 JS GeoJSON，大文件留内存表抽样上图、可继续筛选。'
      + '.shp/.tab 需要同目录的 .dbf/.shx/.prj 等配套文件（GDAL 整份读取）；.gdb 是文件夹需指到目录本身。'
      + '多图层源（GDB/GPKG）可用 layer 参数指定 GDAL 图层名，缺省读第一层；坐标系默认按 WGS84，投影数据可传 sourceCrs'
      + '（如 EPSG:3857，自动转 4326 上图）。.shp 直读失败（如缺配套/离线无 spatial）会自动回退旧 shpjs 路径。'
      + '——后端会自动把这些格式转成 GeoJSON/Arrow，无需自己转换。url 必须用绝对路径'
      + '（如 D:\\xxx\\yyy.csv；相对路径以插件包目录为基准，通常找不到用户文件）或 http(s) 地址。'
      + 'http(s) 地址需为公网可达——内网/回环/保留 IP 会被安全策略拒绝（防 SSRF）。'
      + '当用户提到 shapefile / .shp / .zip 数据包 / CSV / 矢量数据文件（.gdb/.gpkg/.kml/.tab/.mif）并希望在地图上查看时，'
      + '直接调用本工具并传入文件绝对路径或 URL，不要自己用脚本/库去转换、去 BOM、改文件。'
      + '注意：**每次调用都新增一个独立图层（id ds_<n>）叠加到地图上**，不会清掉地图上已有的图层/数据集；'
      + '>10 万的大文件走 DuckDB arrow + 缩放分级。多次加载希望只保留最后一个时，先 webgis_remove_layer 移除旧图层。'
      + '加载成功后地图会缩放到新图层范围。',
    parameters: {
      url: {
        type: 'string', required: true,
        description: '数据集绝对路径或 http(s) URL（支持 GeoJSON / shapefile 的 .zip/.shp / CSV / 矢量 .shp/.gdb/.gpkg/.kml/.tab/.mif；相对路径会解析到插件包目录，可能找不到）',
      },
      layer: {
        type: 'string',
        description: '多图层矢量源（GDB/GPKG）的 GDAL 图层名；缺省读第一层（仅本地矢量 DuckDB 直读路径使用）',
      },
      sourceCrs: {
        type: 'string',
        description: '矢量源坐标系（如 EPSG:3857，自动转 4326 上图；缺省按 WGS84 解释；仅本地矢量 DuckDB 直读路径使用）',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string' },
          featureCount: { type: 'integer' },
          layerId: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    async execute(args, exec) {
      try {
        // 加载策略分三类（都只针对「本地文件」；HTTP/远程与其它走原有 loadDataset 逻辑避免回退）：
        // 1) 本地 CSV → DuckDB read_csv 建表抽样（几何/经纬度列自动识别），防 JS 整表物化 OOM；
        // 2) 本地矢量 .shp/.gdb/.gpkg/.kml/.tab/.mif → DuckDB spatial ST_Read/GDAL 直读灌表（超大 .shp 不再经 shpjs 全量物化）；
        //    .shp 新路径失败（缺配套/离线无 spatial）回退原 shpjs + ingestBigGeojson；
        // 3) 其余（shp/zip/geojson/csv URL）仍走 loadDataset 解析 → 灌表/物化判定。
        const st = stateFor(exec.agent?.id)
        // 数据集加载后地图会缩放到其范围：旧点击/捕获记录失效，避免下次查询返回旧位置。
        st.pick = null
        const cleanSource = String(args.url).split(/[?#]/)[0] ?? ''
        const isLocal = !/^https?:\/\//i.test(String(args.url))
        const isLocalCsv = isLocal && /\.csv$/i.test(cleanSource)
        const ext = cleanSource.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
        const isLocalVector = isLocal && VECTOR_SOURCE_EXTS.includes(ext)
        const layerArg = typeof args.layer === 'string' && args.layer ? args.layer : undefined
        const sourceCrsArg = typeof args.sourceCrs === 'string' && args.sourceCrs ? args.sourceCrs : undefined
        type BigLoad = Omit<IngestBigResult, 'duckGeom'> & { duckGeom?: IngestBigResult['duckGeom']; duckCoords?: { lon: string; lat: string } }
        let ds: { name: string; geojson: GeoJson; featureCount: number }
        let big: BigLoad | null = null
        if (isLocalCsv) {
          const csv = await loadCsvSourceData(getDuckDb(), resolveSourceLocal(String(args.url)))
          const baseName = cleanSource.split(/[\\/]/).pop() ?? 'csv'
          ds = { name: baseName, geojson: csv.geojson as unknown as GeoJson, featureCount: csv.geojson.features.length }
          if (!csv.small) {
            big = {
              duckTable: csv.duckTable!,
              totalCount: csv.totalCount,
              geojson: csv.geojson,
              duckCoords: csv.duckCoords,
              duckGeom: csv.duckGeom,
              families: csv.families,
              fullBbox: csv.fullBbox,
            }
          }
        } else if (isLocalVector) {
          try {
            const vec: VectorLayerData = await loadVectorSourceData(getDuckDb(), resolveSourceLocal(cleanSource), {
              layer: layerArg,
              sourceCrs: sourceCrsArg,
            })
            const baseName = cleanSource.split(/[\\/]/).pop() ?? 'vector'
            ds = { name: baseName, geojson: vec.geojson as unknown as GeoJson, featureCount: vec.geojson.features.length }
            if (!vec.small) {
              big = {
                duckTable: vec.duckTable!,
                totalCount: vec.totalCount,
                geojson: vec.geojson,
                ...(vec.duckGeom ? { duckGeom: vec.duckGeom } : {}),
                families: vec.families,
                fullBbox: vec.fullBbox,
              }
            }
          } catch (err) {
            if (ext === 'shp') {
              // 新路径失败（如缺 .dbf/.shx/.prj 兄弟文件、spatial 离线装不上）→ 回退原 shpjs 解析 → 灌表/物化判定，避免破坏现状。
              ds = await loadDataset(args.url)
              try {
                big = await ingestBigGeojson(ds.geojson as unknown as FeatureCollection)
              } catch {
                big = null // 灌表失败（如 spatial 不可用）→ 保持纯 geojson
              }
            } else {
              throw err
            }
          }
        } else {
          ds = await loadDataset(args.url)
          try {
            big = await ingestBigGeojson(ds.geojson as unknown as FeatureCollection)
          } catch {
            big = null // 灌表失败（如 spatial 不可用）→ 保持纯 geojson
          }
        }
        // 叠加语义：新数据集作为独立图层追加（旧图层/旧数据集保留，各自可显隐/移除）。
        const layer = makeResultLayer({
          id: `ds_${++seqs.datasetSeq}`,
          name: ds.name,
          geojson: big?.geojson ?? ds.geojson,
          source: 'dataset',
          ...(big
            ? {
                duckTable: big.duckTable,
                totalCount: big.totalCount,
                ...(big.duckGeom ? { duckGeom: big.duckGeom } : {}),
                ...(big.duckCoords ? { duckCoords: big.duckCoords } : {}),
                ...(big.fullBbox ? { fullBbox: big.fullBbox } : {}),
                ...(big.families && big.families.length > 1 ? { families: big.families } : {}),
              }
            : {}),
        })
        st.layers = [...st.layers, layer]
        const bigNote = big
          ? (big.families && big.families.length > 1
            ? `（${big.totalCount} 行，多几何族走抽样渲染）`
            : `（${big.totalCount} 行走 DuckDB arrow + zoom 分级）`)
          : ''
        return {
          ok: true,
          name: ds.name,
          featureCount: ds.featureCount,
          layerId: layer.id,
          message: `数据集 ${ds.name} 已加载为图层 ${layer.id}${bigNote}；已有图层保留，可叠加`,
        }
      } catch (err) {
        return {
          ok: false,
          message: `数据集加载失败: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    },
  }))

  // ---- 工具：导航 ----
  ctx.tools.register(defineTool({
    name: 'webgis_navigate',
    description:
      '驱动地图飞到指定位置。提供经度 longitude（-180~180）、纬度 latitude（-90~90），'
      + '可选 zoom（地图缩放级别 0~22）。地图会平滑飞行到该坐标。',
    parameters: {
      longitude: { type: 'number', required: true, description: '目标经度' },
      latitude: { type: 'number', required: true, description: '目标纬度' },
      zoom: { type: 'number', description: '目标缩放级别，0~22' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          longitude: { type: 'number' },
          latitude: { type: 'number' },
          zoom: { type: 'number' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    execute(args, exec) {
      if (args.longitude < -180 || args.longitude > 180 || args.latitude < -90 || args.latitude > 90) {
        return Promise.resolve({ ok: false, message: '坐标越界' })
      }
      const st = stateFor(exec.agent?.id)
      st.navigate = {
        id: ++seqs.navigateSeq,
        lng: args.longitude,
        lat: args.latitude,
        zoom: args.zoom,
      }
      // 视图要移动了：上次点击/捕获的位置记录随之失效。否则导航后模型再问
      // 「这里是什么地方」会拿到旧的点击坐标（如北京）而不是新视图（如淄博）。
      st.pick = null
      return Promise.resolve({
        ok: true,
        longitude: args.longitude,
        latitude: args.latitude,
        zoom: args.zoom,
        message: `已导航到 (${args.longitude}, ${args.latitude})`,
      })
    },
  }))

  // ---- 工具：获取地图当前位置（最近一次点击，或当前视图中心；附截图/视觉分析） ----
  ctx.tools.register(defineTool({
    name: 'webgis_get_pick',
    description:
      '获取地图上当前被关注的位置/要素。两种来源：'
      + '1) 用户最近一次点击地图：点击命中要素时客户端已即时弹出该要素属性浮窗（不经过本工具），'
      + '本工具返回该次点击经纬度 longitude/latitude、命中要素 features（含其全部属性）、'
      + '当前视图范围 bbox（[west,south,east,north]）与截图（图中红点为点击位置）；'
      + '点击空白处则标记该点位置，features 为空。'
      + '2) 若尚无点击记录，则捕获当前地图视图（图框中心），返回中心坐标、中心命中要素、bbox 与截图。'
      + '用户点击要素后问「刚才点的是什么/这个要素的属性」或「这里是什么地方/图框中心在哪/当前位置是什么」时调用本工具；'
      + '已有 features 时直接读其属性回答（如名称/面积/地址），无需重查数据库。'
      + 'webgis_navigate / webgis_load_dataset 会自动使上次点击记录失效，因此导航后再调用'
      + '会捕获导航后的新视图，无需额外参数；仅当用户手动拖动/缩放地图后（无 navigate 调用）才需要传 refresh: true；'
      + '与地图当前位置无关的问题不要调用。',
    parameters: {
      refresh: { type: 'boolean', description: 'true = 忽略上次点击/捕获记录，重新捕获当前地图视图' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'integer' },
          longitude: { type: 'number' },
          latitude: { type: 'number' },
          bbox: { type: 'json' },
          features: { type: 'json' },
          screenshot: { type: 'json' },
          attachImage: { type: 'boolean' },
          vision: { type: 'string' },
          visionNote: { type: 'string' },
          message: { type: 'string' },
        },
      },
      // 模型侧内容：支持图像的模型拿到「图片块 + 文本」，文本模型只拿文本（不炸对话）
      render: (_args, value) => {
        const v = value as {
          ok?: boolean
          longitude?: number
          latitude?: number
          features?: unknown
          screenshot?: ScreenshotMeta | null
          attachImage?: boolean
          vision?: string
          visionNote?: string
        }
        if (!v.ok || !v.screenshot) return text(JSON.stringify(value))
        const shot = v.screenshot
        const pin = `(${Math.round(shot.pin.x)}, ${Math.round(shot.pin.y)})`
        const ll = `(经度 ${Number(v.longitude).toFixed(5)}, 纬度 ${Number(v.latitude).toFixed(5)})`
        const feat = Array.isArray(v.features) && v.features.length > 0
          ? `，命中要素: ${JSON.stringify(v.features).slice(0, 500)}`
          : '，无命中要素'
        const ext = shot.extent
        const range = `截图覆盖范围：经度 ${ext.west.toFixed(4)}~${ext.east.toFixed(4)}，纬度 ${ext.south.toFixed(4)}~${ext.north.toFixed(4)}。`
        const head = `地图截图已生成（${shot.width}×${shot.height}px）。红点即关注位置（点击处或图框中心），位于截图像素 ${pin}，对应 ${ll}。${range}${feat}。`
        const conv = '如需把截图里任意像素换算为经纬度，调用 webgis_unproject({ x, y })；经纬度→截图像素用 webgis_project({ longitude, latitude })（原点均为截图左上角，x 向右 y 向下）。'
        if (!v.attachImage) {
          const visionText = v.vision
            ? `\n视觉模型分析：${v.vision}`
            : v.visionNote
              ? `\n${v.visionNote}`
              : ' 当前模型不支持图像输入，截图未附上；接入视觉模型后即可直接看图。'
          return text(head + visionText + conv)
        }
        return [{ type: 'image', attachment: shot.ref } as ContentBlock, ...text(head + conv)]
      },
    },
    async execute(args, exec) {
      const st = stateFor(exec.agent?.id)
      // 无点击记录或显式 refresh → 请求客户端捕获当前地图视图（图框中心），等回传。
      let fromCapture = false
      let pick = st.pick
      if (!pick || args.refresh === true) {
        const result = await awaitCurrentViewCapture(st, ++seqs.captureSeq)
        if (!result.ok) return { ok: false, message: result.message }
        pick = result.pick
        fromCapture = true
      }
      const shot = pick.screenshot ? screenshotMeta(pick.screenshot) : null
      const shotRef = pick.screenshot?.ref ?? null
      // 视图范围 bbox：截图那一刻的地图覆盖范围（截图缺失时为 null）。
      const bbox = shot ? [shot.extent.west, shot.extent.south, shot.extent.east, shot.extent.north] : null
      const mainSupportsImage = shot ? await modelSupportsImage(ctx, exec) : false
      // 主模型文本、有截图 → 走视觉委托链看图并返回文字分析。即便没配置视觉模型，
      // 也走内置 OVH 免费兜底（freeFallback 默认开）；全部失败给结构化原因（不让模型重试）。
      let vision = ''
      let visionNote = ''
      if (shot && shotRef && !mainSupportsImage) {
        const result: VisionAnalysisResult = await analyzeScreenshotChain(
          ctx, effectiveVision(), pick, shotRef, shot, config.freeFallback !== false)
        if (result.ok && result.text) {
          vision = result.text
        } else if (result.attempted.length > 0) {
          visionNote = `（视觉分析失败：${result.reason ?? result.code ?? '未知错误'}，本回合勿再重试）`
        }
      }
      return {
        ok: true,
        id: pick.id,
        longitude: pick.lng,
        latitude: pick.lat,
        bbox: bbox as unknown as JsonValue,
        features: pick.features as unknown as JsonValue,
        screenshot: shot as unknown as JsonValue,
        attachImage: mainSupportsImage,
        vision,
        visionNote,
        message: (() => {
          const base = fromCapture
            ? '已捕获当前地图视图（图框中心）'
            : '已获取最近一次地图点击位置'
          if (!shot) return `${base}（截图缺失）`
          if (mainSupportsImage) return `${base}与截图`
          if (vision) return `${base}（已委托视觉模型分析）`
          if (visionNote) return `${base}${visionNote}`
          return `${base}（当前模型不支持图像，未附截图）`
        })(),
      }
    },
  }))

  // ---- 工具：经纬度 → 截图像素 ----
  ctx.tools.register(defineTool({
    name: 'webgis_project',
    description:
      '将经纬度坐标转换为最近一次地图截图图像中的像素位置。截图是用户点击时截取的地图模块图像，'
      + '像素原点在图像左上角，x 向右、y 向下（0 ≤ x < width，0 ≤ y < height）。'
      + '当需要把某个地理坐标定位/标注到截图图像上时调用；需先存在地图点击截图（见 webgis_get_pick）。',
    parameters: {
      longitude: { type: 'number', required: true, description: '经度，-180~180' },
      latitude: { type: 'number', required: true, description: '纬度，-90~90' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    execute(args, exec) {
      const shot = stateFor(exec.agent?.id).pick?.screenshot
      if (!shot) {
        return Promise.resolve({ ok: false, message: '尚无地图截图（需先在地图上点击一次）' })
      }
      if (args.longitude < -180 || args.longitude > 180 || args.latitude < -90 || args.latitude > 90) {
        return Promise.resolve({ ok: false, message: '坐标越界' })
      }
      const p = projectLngLatToCss(shot.viewport, args.longitude, args.latitude)
      return Promise.resolve({
        ok: true,
        x: p.x * shot.scale,
        y: p.y * shot.scale,
        width: shot.ref.width,
        height: shot.ref.height,
        message: `已换算: (${args.longitude}, ${args.latitude}) → 截图像素 (${p.x * shot.scale}, ${p.y * shot.scale})`,
      })
    },
  }))

  // ---- 工具：截图像素 → 经纬度 ----
  ctx.tools.register(defineTool({
    name: 'webgis_unproject',
    description:
      '将最近一次地图截图图像中的像素坐标换算为经纬度。截图是用户点击时截取的地图模块图像，'
      + '像素原点在图像左上角，x 向右、y 向下。'
      + '当需要确定截图里某个像素/区域对应的地理位置时调用；需先存在地图点击截图（见 webgis_get_pick）。',
    parameters: {
      x: { type: 'number', required: true, description: '截图像素 x，0 ≤ x < width' },
      y: { type: 'number', required: true, description: '截图像素 y，0 ≤ y < height' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          longitude: { type: 'number' },
          latitude: { type: 'number' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    execute(args, exec) {
      const shot = stateFor(exec.agent?.id).pick?.screenshot
      if (!shot) {
        return Promise.resolve({ ok: false, message: '尚无地图截图（需先在地图上点击一次）' })
      }
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
        return Promise.resolve({ ok: false, message: '像素坐标不合法' })
      }
      const ll = unprojectCssToLngLat(shot.viewport, args.x / shot.scale, args.y / shot.scale)
      return Promise.resolve({
        ok: true,
        longitude: ll.lng,
        latitude: ll.lat,
        message: `已换算: 截图像素 (${args.x}, ${args.y}) → (${ll.lng.toFixed(6)}, ${ll.lat.toFixed(6)})`,
      })
    },
  }))

  // ---- GIS 矢量处理工具（Turf）：作用于图层注册表，AI 可直接调用并链式操作 ----
  // 状态按会话隔离：工具 execute 内以 exec.agent?.id 解析到该会话自己的注册表。
  // onRemoveLayer 联动释放图层引用的外部资源（DuckDB 内存表 DROP，见 src/duckdb.ts）。
  registerGeoTools(ctx, stateFor, {
    onRemoveLayer: dropLayerResources,
  })

  // ---- PostgreSQL/PostGIS 工具：库结构读取 + 只读查询 → 图层（source: 'postgis'） ----
  registerDbTools(ctx, stateFor, db)

  // ---- DuckDB 本地 CSV 工具：大文件建表 → 上图（source: 'csv'），小文件常规加载 ----
  registerDuckDbTools(ctx, stateFor, { duckdb: config.duckdb })
}
