/**
 * deck.gl 运行时控制器（将进入 deck chunk）：把 MapView 里散落的 deck 运行时逻辑抽成单一类。
 *
 * 管理三块状态：
 *  - deck 出图（arc/trips/wall/radial 特效）：MapboxOverlay（interleaved 共享 maplibre WebGL 上下文）
 *    + 注册表 + 图层实例缓存 + trips 轨迹 rAF 动画循环；
 *  - deck 原始数据路径（>10 万点/大文件 arrow / materialized geojson）：zoom 分级密度拉取 / 预取、
 *    arrow 表缓存、rebuild 合并 spec；
 *  - 点选回查（overlay.pickObject proxy + arrow 表暴露给 MapView 做行号/坐标回查）。
 *
 * 边界：本模块值 import deck-charts / geoarrow-charts / @deck.gl / apache-arrow / render-policy /
 * sessionUrl——它就是要进 deck chunk 的那块运行时。MapView（gis chunk）只经本控制器拿结果，
 * 不再直接碰这些重型模块；maplibre 仅以 type import（编译期擦除，不复制运行时）。
 */
import { MapboxOverlay } from '@deck.gl/mapbox'
import type { Layer as DeckLayer } from '@deck.gl/core'
import { makeDeckChartLayers, tripsProgress, type DeckChartSpec } from '../deck-charts.js'
import { makeGeoArrowLayers, makeRawGeojsonLayers, type GeoArrowSpec } from '../geoarrow-charts.js'
import { tableFromIPC, type Table } from 'apache-arrow'
import { arrowCountForZoom, nextArrowCount } from '../../render-policy.js'
import { sessionUrl } from '../sessionUrl.js'
import { bboxContains, bboxStr, COVER_MARGIN_DEG, FETCH_PAD, fromBboxStr, paddedBbox, shouldViewportCull, type Bbox } from './viewport.js'
import type { LayerSummary } from '../gis-types.js'
import type { FeatureCollection } from 'geojson'
import type { Map as MapLibreMap } from 'maplibre-gl'

/** MapView 经构造传入的宿主回调：把 controller 从 React ref 闭包里解耦。 */
export interface DeckControllerHost {
  /** 当前会话 id（MapView 的 sessionRef 快照；随渲染更新，网络回调经它读最新值）。 */
  getSessionId(): string | undefined
  /** 按图层 id 读 MapView 的 geojson 数据缓存（raw geojson rebuild 时复用，避免重复拉取）。 */
  getCachedData?(id: string): FeatureCollection | undefined
  /** arrow 回退成功后把抽样 geojson 写回 MapView 缓存（颜色/可见性 rebuild 也能复用）。 */
  onArrowFallbackGeojson?(id: string, fc: FeatureCollection): void
  /** 错误日志出口（默认 console.warn 语义；MapView 一般不传）。 */
  onError?(msg: string, ...args: unknown[]): void
}

/** deck overlay 点选命中信息（MapView 只消费这三个字段；缺 overlay/异常返回 null）。 */
export interface DeckPickHit {
  picked: boolean
  layer: { id?: string } | null
  index: number
}

/**
 * deck.gl 运行时控制器。
 *
 * 构造只收 host 回调（不含 map）：map 在建图后经 {@link setMap} 注入，保证 controller 不依赖
 * React 渲染顺序，也让「map 引用」只存在于运行时、不进 deck chunk 的静态图。
 */

/** 单层 raw 取数决策（决定后交给 applyRawSync 执行；consume 的 key 恒为 `${tier}|`，由 apply 重建）。 */
type RawSyncDecision =
  | { kind: 'skip' } // 覆盖命中 / 同键去重 / 已在途 → 渲染层不动
  | { kind: 'consume' } // 旧全档位命中预取缓存 → 直接换档
  | { kind: 'fetch'; bbox: string | null } // bbox=null=旧全档位；否则为视口 bbox 参数

/** 失败空闲重试延迟：一次 arrow fetch 失败且无尾随合并/在途/待重试时，延迟这么久补拉一次最新视野（解决「停下不渲染」）。 */
const RAW_RETRY_DELAY_MS = 800
/** 失败空闲重试冷却：距上次自动重试不足此时长则不再自动重试（防死循环；用户手动平移/缩放触发的正常决策不走这里、不受冷却限制）。 */
const RAW_RETRY_MIN_INTERVAL_MS = 1500

export class DeckController {
  private readonly host: DeckControllerHost
  /** maplibre map（MapView 建图后 setMap 注入；ensureOverlay/syncRawTiers/upsertRaw 需要）。 */
  private map: MapLibreMap | null = null
  /** deck.gl 出图：MapboxOverlay（interleaved 共享 maplibre WebGL 上下文）+ 出图注册表。 */
  private overlay: MapboxOverlay | null = null
  /** deck 出图注册表：图层 id → 出图 spec（仅 deck 模式图层在此；其余模式走 maplibre 渲染）。 */
  private deckRegistry: Record<string, DeckChartSpec> = {}
  /** deck 图层缓存：图层 id → 已构造的 deck 层实例（同步时整体下发，避免每帧重建）。 */
  private deckLayerCache: Record<string, DeckLayer[]> = {}
  /** deck 原始数据路径注册表：图层 id → raw spec（>10 万点图层走 deck 原始点，非 deck 特效模式）。 */
  private rawDeckRegistry: Record<string, GeoArrowSpec> = {}
  /** deck 原始数据路径的 Arrow 表缓存（可见性切换/样式重建时免重新拉二进制）。 */
  private rawTableCache: Record<string, Table> = {}
  /** raw arrow 图层当前渲染的分档（zoom 分级密度：max 抽样条数；成功才更新）。 */
  private rawTiers: Record<string, number> = {}
  /** 正在拉取的「视野键」（id → `${tier}|${bbox}`；同层同一时刻至多一个在途：同键在途去重，异键在途走 pendingRaw 尾随合并，不并发起第二个请求）。 */
  private rawFetching: Record<string, string> = {}
  /** 已成功渲染/在途的「视野键」（id → `${tier}|${bbox}`；bbox 为空 = 无视野全量路径）。 */
  private lastViewKey: Record<string, string> = {}
  /** 尾随合并队列：id → 在途请求期间被「不同键决策」跳过的最新视野键。在途请求结束（成功/失败）后据此补拉一次最新；
   *  新的不同键决策会覆盖旧 pending，保证同层同一时刻至多一个在途 + 一个待补拉。 */
  private pendingRaw: Record<string, string> = {}
  /** 失败空闲重试冷却：id → 上次**实际执行**自动重试的时刻（setTimeout 回调开头写）；距它 <1500ms 不再自动重试。 */
  private lastAutoRetryAt: Record<string, number> = {}
  /** 失败空闲重试的定时器句柄（id → setTimeout id）；removeOut/clearRaw/dispose 时取清除，防残留定时器回调污染已清理图层。 */
  private rawRetryTimers: Record<string, number> = {}
  /** 最近一次收到的图层摘要列表（refreshRawLayers/syncRawTiers/viewportRefresh/upsertRaw 时更新）。
   *  尾随补拉 / 失败空闲重试据此取「该层最新摘要」重新决策，避免用发起请求时的陈旧闭包。 */
  private lastLayers: LayerSummary[] = []
  /** 视口裁剪各层最近一次**成功拉到**的取数窗口与其 tier（id → 窗口；覆盖率跳过：小平移/同档位缩放仍在窗口内 → 不重拉）。 */
  private windowOf: Record<string, { tier: number; bb: Bbox } | null> = {}
  /** 预取预热缓存：id → tier → 已提前拉好的表（后台拉下一档，跨档位时免等待；仅无 bbox 路径用）。 */
  private rawPrefetchCache: Record<string, Record<number, Table>> = {}
  /** 轨迹动画已流逝时间（秒，**不取模**持续累加——相位在 tripsProgress 里乘 speed 后再取模，
   *  这样相位能真正走到 1、头点到达终点才回绕；若在这里 %1，相位上限会被压成 speed，头点走不到终点）。 */
  private tripsTime = 0
  private tripsRaf: number | null = null

  constructor(host: DeckControllerHost) {
    this.host = host
  }

  /** 注入 maplibre map（MapView 建图后调用；换图时也可重注入）。 */
  setMap(map: MapLibreMap | null): void {
    this.map = map
  }

  /** 错误日志出口：host 有 onError 走它，否则 console.warn（原 MapView 直接 console.warn 的语义）。 */
  private warn(msg: string, ...args: unknown[]): void {
    if (this.host.onError) this.host.onError(msg, ...args)
    else console.warn(msg, ...args)
  }

  // ---- deck 出图（arc/trips/wall/radial 特效） ----

  /** 构造单个图层的 deck 出图层（缓存到 deckLayerCache）。traps 进度按 speed（默认 0.1，与工具文档一致）推进。 */
  private buildLayer(spec: DeckChartSpec): void {
    const progress = spec.mode === 'trips' ? tripsProgress(this.tripsTime, spec.params?.speed ?? 0.1) : 0
    this.deckLayerCache[spec.id] = makeDeckChartLayers(spec, progress)
  }

  /** 确保 deck overlay 存在：map 已加载则即时创建（interleaved 需 WebGL painter 就绪），否则交给 map load 回调。 */
  ensureOverlay(): MapboxOverlay | null {
    if (this.overlay) return this.overlay
    const map = this.map
    if (!map || !map.loaded()) return null
    try {
      const overlay = new MapboxOverlay({
        interleaved: true,
        // deck 出图渲染错误（如个别要素坐标非法）默认会让 interleaved 帧中断、整图停画，
        // 只有刷新网页才恢复——挂 onError 把错误拦截为日志，其余图层继续渲染。
        onError: (error) => { this.warn('[MapView] deck.gl 渲染错误（已拦截，避免整帧中断）', error) },
      })
      map.addControl(overlay)
      this.overlay = overlay
      return overlay
    } catch (err) {
      this.warn('[MapView] deck.gl overlay 初始化失败', err)
      return null
    }
  }

  /** 把注册表里的全部 deck 图层一次性下发到 MapboxOverlay（缺 overlay 则尝试惰性创建，避免注册早于 load 被丢）。 */
  syncLayers(): void {
    const overlay = this.ensureOverlay()
    if (!overlay) return
    overlay.setProps({ layers: Object.values(this.deckLayerCache).flat() })
  }

  /** 注册/更新一个 deck 出图层：登记 spec + 重建缓存 + 下发；轨迹层则启动动画循环。 */
  upsertOut(spec: DeckChartSpec): void {
    this.deckRegistry[spec.id] = spec
    this.buildLayer(spec)
    this.syncLayers()
    this.startTripsLoop()
  }

  /** 移除一个 deck 出图层（模式切回 maplibre / 图层删除）。同时清掉 raw 三件套与 raw 运行期取数状态
   *  （尾随合并 / 失败重试定时器 / 在途），语义与原 removeDeckLayer 一致。 */
  removeOut(id: string): void {
    const hasRawRuntime = this.rawFetching[id] != null || this.pendingRaw[id] != null
      || this.rawRetryTimers[id] != null || this.lastAutoRetryAt[id] != null
    if (!this.deckRegistry[id] && !this.deckLayerCache[id] && !this.rawDeckRegistry[id] && !hasRawRuntime) return
    delete this.deckRegistry[id]
    delete this.deckLayerCache[id]
    delete this.rawDeckRegistry[id]
    delete this.rawTableCache[id]
    delete this.rawPrefetchCache[id]
    delete this.rawTiers[id]
    delete this.rawFetching[id]
    delete this.lastViewKey[id]
    delete this.windowOf[id]
    this.clearRawRuntime(id)
    this.syncLayers()
  }

  /** 清掉某 id 的「deck 原始数据路径」（arrow/geojson）注册表与表缓存：切到 deck 出图 / maplibre 形态前调用，
   *  避免 syncRawTiers/rebuild 把旧形态画回去。 */
  clearRaw(id: string): void {
    delete this.rawDeckRegistry[id]
    delete this.rawTableCache[id]
    delete this.rawPrefetchCache[id]
    delete this.rawTiers[id]
    delete this.rawFetching[id]
    delete this.lastViewKey[id]
    delete this.windowOf[id]
    this.clearRawRuntime(id)
  }

  /** 清掉某 id 的「deck 出图」注册表（arc/trips/wall/radial）：切到 raw / maplibre 形态前调用，
   *  防止 trips 动画/同步循环每帧把旧出图层覆盖回 deckLayerCache（把新 raw 层顶掉）。 */
  clearOut(id: string): void {
    delete this.deckRegistry[id]
  }

  // ---- deck 原始数据路径（>10 万点图层 / arrow 大文件） ----

  /** deck 出图注册表里某 id 的当前可见性（无注册返回 undefined；供 MapView 判断「只有变化才重建」）。 */
  outVisibleOf(id: string): boolean | undefined {
    return this.deckRegistry[id]?.visible
  }

  /** deck 原始数据路径注册表里某 id 的当前可见性（无注册返回 undefined；供 MapView 判断「只有变化才重建」）。 */
  rawVisibleOf(id: string): boolean | undefined {
    return this.rawDeckRegistry[id]?.visible
  }

  /** 该 id 是否已注册 raw 原始数据路径（MapView 据此决定 rebuild vs upsert）。 */
  hasRaw(id: string): boolean {
    return !!this.rawDeckRegistry[id]
  }

  /** raw arrow 图层当前缓存表（点选属性回查用；无表返回 null）。 */
  arrowTableFor(id: string): Table | null {
    return this.rawTableCache[id] ?? null
  }

  /** 后台预取下一档（zoom 放大临近阈值时数据提前备好，跨档免等待；失败忽略）。仅无 bbox 全量路径使用。 */
  private prefetchRawNext(id: string, totalCount: number, tier: number): void {
    const next = nextArrowCount(tier, totalCount)
    if (next == null || this.rawPrefetchCache[id]?.[next]) return
    void (async () => {
      try {
        const res = await fetch(sessionUrl(this.host.getSessionId(), `/webgis/arrow?id=${encodeURIComponent(id)}&max=${next}`), { cache: 'no-store' })
        if (res.ok) {
          const t = tableFromIPC(new Uint8Array(await res.arrayBuffer()))
          ;(this.rawPrefetchCache[id] ??= {})[next] = t
        }
      } catch {
        // 预取失败忽略（下次跨档再拉）
      }
    })()
  }

  /** 当前视野 bbox（map 存在且 loaded → getBounds 直接算；**不再外扩**，外扩只在覆盖判定时按需做）。
   *  map 未就绪 / 取界失败返回 null = 走旧全档位路径（bbox=null）。 */
  private currentViewBbox(): Bbox | null {
    const map = this.map
    if (!map || !map.loaded()) return null
    try {
      const b = map.getBounds()
      return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() }
    } catch {
      return null
    }
  }

  /** LayerSummary.bbox（[w,s,e,n] 元组）转 Bbox；缺失 / 非有限返回 null（按「无 bbox」处理）。 */
  private layerBboxOf(s: LayerSummary): Bbox | null {
    const b = s.bbox
    if (!b || b.length !== 4) return null
    const [west, south, east, north] = b
    if (![west, south, east, north].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
    return { west, south, east, north }
  }

  /** 收益门控：true = 本层值得走视口裁剪；false = 走旧全档位（bbox=null，与 v1 之前一致）。
   *  有层 bbox 时看 view/layer 面积比 < 0.55；无 bbox（极少数）且 zoom ≥ 15 才裁剪，否则保守全档位。 */
  private shouldCull(s: LayerSummary, view: Bbox, zoom: number): boolean {
    return shouldViewportCull(view, this.layerBboxOf(s), zoom)
  }

  /** 按「档位 + 当前视野」拉取 arrow 表并下发（zoom 分级密度 + 视口裁剪）：成功替换图层缓存并 sync，返回 true；
   *  失败不动旧图层，返回 false。同层**串行**：同键在途去重直接返回；异键在途不再并发起第二个请求，把新键记入
   *  pendingRaw 做**尾随合并**（本请求结束后的 finally 里补拉最新一次），调用方照旧视为「当前未就绪」即可。
   *  陈旧结果丢弃（已被清理/取代时不再写入），`windowOf/lastViewKey` 只在成功时写入。带视野（bbox）路径不预取
   *  下一档（视野会变，预取价值低）；无 bbox 全量路径保留预取。 */
  private async fetchRawArrow(s: LayerSummary, spec: GeoArrowSpec, tier: number, bbox: string | null): Promise<boolean> {
    const id = s.id
    const key = `${tier}|${bbox ?? ''}`
    const inFlight = this.rawFetching[id]
    if (inFlight != null) {
      // 同层已有在途请求（同键去重 / 异键尾随合并）：都不新起第二个请求。
      if (inFlight === key) return false // 同键在途去重（保持既有）
      this.pendingRaw[id] = key // 异键在途 → 只记入尾随合并队列，等当前请求结束再补拉最新
      return false
    }
    this.rawFetching[id] = key
    let failed = false
    try {
      const q = bbox ? `&bbox=${bbox}` : ''
      const res = await fetch(sessionUrl(this.host.getSessionId(), `/webgis/arrow?id=${encodeURIComponent(id)}&max=${tier}${q}`), { cache: 'no-store' })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const table = tableFromIPC(new Uint8Array(await res.arrayBuffer()))
      if (this.rawFetching[id] !== key) return false // 已被清理/取代，丢弃陈旧结果
      this.rawTableCache[id] = table
      this.rawTiers[id] = tier
      this.lastViewKey[id] = key
      this.deckLayerCache[id] = makeGeoArrowLayers(spec, table)
      this.rawDeckRegistry[id] = spec
      this.syncLayers()
      if (!bbox) this.prefetchRawNext(id, s.totalCount ?? 0, tier)
      return true
    } catch (err) {
      failed = true
      if (this.rawFetching[id] === key) this.warn('[MapView] Arrow 分档拉取失败', id, tier, err)
      return false
    } finally {
      // 收尾只属于「本请求仍是该层当前在途（owner）」的请求；已被取代/清理的陈旧请求在此静默退出，
      // 由取代它的请求（或 removeOut/clearRaw 的清理）统一负责后续，避免在串行之外再堆叠。
      const wasOwner = this.rawFetching[id] === key
      if (wasOwner) delete this.rawFetching[id]
      if (wasOwner) {
        const pendingKey = this.pendingRaw[id]
        if (pendingKey != null) {
          delete this.pendingRaw[id]
          // 尾随合并：pending 与「当前已渲染键」不同才补拉（用 lastLayers 最新摘要重算，不走陈旧闭包）；
          // pending 与同键在途已被入口短路，故此处只需跟 lastViewKey 比。有 pending 即视为本次已由补拉接管，
          // 即使本请求失败也不再额外安排空闲重试（补拉若再失败，由补拉自己的 finally 处理）。
          if (pendingKey !== this.lastViewKey[id]) this.pullLatestRawLayer(id)
        } else if (failed) {
          // 失败且无 pending / 无在途 → 空闲单次重试（内部再做 raw arrow 层校验与冷却），解决「停下不渲染」。
          this.scheduleRawAutoRetry(id)
        }
      }
    }
  }

  /** raw deck 图层的统一 spec 构造（颜色/可见性/半径 + 面图层的自托管 earcut worker URL）。 */
  private rawArrowSpec(s: LayerSummary): GeoArrowSpec {
    return {
      id: s.id,
      color: s.fillColor ?? s.color,
      visible: s.visible,
      radius: s.pointRadius,
      earcutWorkerUrl: sessionUrl(this.host.getSessionId(), '/webgis/earcut-worker.js'),
    }
  }

  /** deck 原始数据路径（>10 万点图层）：按 Arrow（/webgis/arrow 二进制）或 geojson（materialized 大层）直接吃 deck 原始点。
   *  首次/数据变更经 {@link syncRawLayer} force=true 走同一「zoom 档 + 视野门控」核心（忽略覆盖/同键去重，必拉一次）；
   *  Arrow 拉取失败回退 geojson 原始点（arrow 图层此前不拉 geojson，失败时补拉抽样兜底）；图层实例缓存进 deckLayerCache。 */
  async upsertRaw(s: LayerSummary, geojson: FeatureCollection | null): Promise<void> {
    this.rememberLayer(s) // 记录该层最新摘要：后续尾随补拉/失败空闲重试据此找该层（而非陈旧闭包）
    const spec = this.rawArrowSpec(s)
    let fc = geojson
    if (s.dataFormat === 'arrow') {
      const zoom = this.map?.getZoom() ?? 0
      if (!(await this.syncRawLayer(s, zoom, false, true))) {
        // 兜底渲染的是全量抽样 geojson（不再是某视野窗口的 arrow），清掉窗口避免后续覆盖跳过误判
        this.windowOf[s.id] = null
        // Arrow 失败兜底：补拉抽样 geojson（进 MapView dataCache，颜色/可见性 rebuild 也能复用）
        if (!fc) {
          try {
            const gres = await fetch(sessionUrl(this.host.getSessionId(), `/webgis/gis-result?id=${encodeURIComponent(s.id)}`), { cache: 'no-store' })
            if (gres.ok) {
              fc = (await gres.json()) as FeatureCollection
              this.host.onArrowFallbackGeojson?.(s.id, fc)
            }
          } catch (err) {
            this.warn('[MapView] Arrow 回退 geojson 也失败', s.id, err)
          }
        }
      }
    }
    if (fc) {
      this.deckLayerCache[s.id] = makeRawGeojsonLayers(spec, fc)
      this.rawDeckRegistry[s.id] = spec
      this.syncLayers()
    }
  }

  /** 统一取数决策（幂等）：先判「视口裁剪 vs 旧全档位」门控，再在各自路径内做去重 / 覆盖率跳过。
   *  force=true 时忽略覆盖/同键去重（仅首拉/数据变更用；fetchRawArrow 内在途同键仍去重）。
   *  副作用：旧全档位路径会把该层 windowOf 清掉（回到全局抽样/缓存模型）。 */
  private decideRawSync(
    s: LayerSummary,
    tier: number,
    zoom: number,
    view: Bbox | null,
    allowPrefetchConsume: boolean,
    force: boolean,
  ): RawSyncDecision {
    const id = s.id
    // 视口门控：view 存在且 shouldCull 才裁剪；否则旧全档位（bbox=null，与 v1 之前行为一致）。
    const gated = view != null && this.shouldCull(s, view, zoom)
    if (!gated) {
      if (this.windowOf[id] != null) this.windowOf[id] = null
      const key = `${tier}|`
      if (!force && (this.lastViewKey[id] === key || this.rawFetching[id] === key)) return { kind: 'skip' }
      if (!force && allowPrefetchConsume && this.rawPrefetchCache[id]?.[tier]) return { kind: 'consume' }
      return { kind: 'fetch', bbox: null }
    }
    // 视口裁剪路径：取数窗口 = 当前视野按 FETCH_PAD 外扩（减少后续平移重拉）。
    const need = paddedBbox(view, FETCH_PAD)
    const w = this.windowOf[id]
    // 覆盖率跳过：同 tier 且当前视野仍在上次成功拉到的窗口内 → 本层跳过（渲染层不动，零请求零替换）。
    // ⚠️ 与草案差异：比较的是**当前视野 view**而非再外扩的 need——若比较 need（与窗口等宽），任何平移都必然越界、永远跳不过；
    //    窗口本身已比 view 大 25%，view 在窗口内即代表可视区数据已就绪（平移 ≤25% 屏宽不重拉）。
    if (!force && w && w.tier === tier && bboxContains(w.bb, view, COVER_MARGIN_DEG)) return { kind: 'skip' }
    const bbox = bboxStr(need)
    const key = `${tier}|${bbox}`
    if (!force && (this.lastViewKey[id] === key || this.rawFetching[id] === key)) return { kind: 'skip' }
    return { kind: 'fetch', bbox }
  }

  /** 依决策执行（fetch / 预取换档 / skip）；返回是否已具备有效渲染数据。
   *  fetch 失败保持旧渲染层与 windowOf 不变并返回 false（由调用方决定兜底）。 */
  private async applyRawSync(s: LayerSummary, spec: GeoArrowSpec, tier: number, d: RawSyncDecision): Promise<boolean> {
    if (d.kind === 'skip') return true
    if (d.kind === 'consume') {
      const prefetched = this.rawPrefetchCache[s.id]?.[tier]
      if (!prefetched) return true
      delete this.rawPrefetchCache[s.id]?.[tier]
      this.rawTableCache[s.id] = prefetched
      this.rawTiers[s.id] = tier
      this.lastViewKey[s.id] = `${tier}|`
      this.deckLayerCache[s.id] = makeGeoArrowLayers(spec, prefetched)
      this.rawDeckRegistry[s.id] = spec
      this.syncLayers()
      this.prefetchRawNext(s.id, s.totalCount ?? 0, tier)
      return true
    }
    const ok = await this.fetchRawArrow(s, spec, tier, d.bbox)
    if (ok && d.bbox != null) {
      // 记录本次成功拉到的取数窗口（bbox 即 need 的 3 位小数序列化；覆盖判定带 COVER_MARGIN_DEG 补偿舍入）
      this.windowOf[s.id] = { tier, bb: fromBboxStr(d.bbox) }
    }
    return ok
  }

  /** 单层统一取数核心（zoomend / moveend 防抖 / 首拉都汇到这；各自幂等）。
   *  force=true：忽略覆盖/同键去重强制拉（首拉、数据变更），但门控仍决定带不带 bbox。 */
  private async syncRawLayer(s: LayerSummary, zoom: number, allowPrefetchConsume: boolean, force = false): Promise<boolean> {
    if (s.dataFormat !== 'arrow' || s.renderer !== 'deck') return true
    const spec = this.rawArrowSpec(s)
    const tier = arrowCountForZoom(zoom, s.totalCount ?? 0)
    const view = this.currentViewBbox()
    const d = this.decideRawSync(s, tier, zoom, view, allowPrefetchConsume, force)
    return this.applyRawSync(s, spec, tier, d)
  }

  /** 记录某层最新摘要（upsertRaw 单层场景）：已存在则原位替换，否则追加（refreshRawLayers 走整表替换）。 */
  private rememberLayer(s: LayerSummary): void {
    const i = this.lastLayers.findIndex((l) => l.id === s.id)
    if (i >= 0) this.lastLayers[i] = s
    else this.lastLayers.push(s)
  }

  /** 用 lastLayers 里该层**最新**摘要重走一次统一取数核心（不强制、不走预取换档）：尾随合并补拉 / 失败空闲重试共用入口。
   *  图层已不在 lastLayers / 已非 raw arrow / 已不在 rawDeckRegistry（图层被删/切形态）→ 忽略。 */
  private pullLatestRawLayer(id: string): boolean {
    if (this.rawFetching[id]) return false // 已有在途（含刚被其它路径启动的），避免在串行之外再堆叠
    const s = this.lastLayers.find((l) => l.id === id)
    if (!s || s.dataFormat !== 'arrow' || s.renderer !== 'deck') return false
    if (!this.rawDeckRegistry[id]) return false
    const zoom = this.map?.getZoom() ?? 0
    void this.syncRawLayer(s, zoom, false)
    return true
  }

  /** 失败空闲重试：一次 fetch 失败且无尾随合并接管时，延迟 ~800ms 用最新摘要补拉一次（解决「停下不渲染直至再平移」）。
   *  冷却：距上次**实际执行**的自动重试 <1500ms 不再自动重试；用户手动平移/缩放触发的正常决策不走这里、不受冷却限制。 */
  private scheduleRawAutoRetry(id: string): void {
    if (this.rawFetching[id]) return // 已有在途（含刚被尾随补拉启动的），无需再排
    if (this.pendingRaw[id] != null) return // 已有待尾随合并的键
    if (this.rawRetryTimers[id] != null) return // 已有一个未触发的重试定时器
    if (Date.now() - (this.lastAutoRetryAt[id] ?? 0) < RAW_RETRY_MIN_INTERVAL_MS) return
    const s = this.lastLayers.find((l) => l.id === id)
    if (!s || s.dataFormat !== 'arrow' || s.renderer !== 'deck') return
    if (!this.rawDeckRegistry[id]) return
    this.rawRetryTimers[id] = window.setTimeout(() => {
      if (this.rawRetryTimers[id] != null) delete this.rawRetryTimers[id]
      this.lastAutoRetryAt[id] = Date.now() // 实际执行时刻计入冷却，慢失败也不会死循环
      this.pullLatestRawLayer(id)
    }, RAW_RETRY_DELAY_MS)
  }

  /** 清掉某 id 的 raw 运行期取数状态（尾随合并 / 冷却 / 未触发定时器），供 removeOut / clearRaw / dispose 复用。 */
  private clearRawRuntime(id: string): void {
    delete this.pendingRaw[id]
    delete this.lastAutoRetryAt[id]
    const t = this.rawRetryTimers[id]
    if (t != null) {
      window.clearTimeout(t)
      delete this.rawRetryTimers[id]
    }
  }

  /** 统一刷新入口：遍历 raw arrow 层按「当前 zoom 档 + 视野」逐层取数。
   *  zoomend 驱动的 syncRawTiers 与 moveend 防抖驱动的 viewportRefresh 都汇到这里；去重由
   *  decideRawSync 的 lastViewKey / rawFetching / windowOf 覆盖判定兜底，同键/窗口内不再重复拉。 */
  private refreshRawLayers(layers: LayerSummary[], allowPrefetchConsume: boolean): void {
    this.lastLayers = layers // 记录最新摘要：尾随补拉 / 失败空闲重试按它找该层最新摘要（而非陈旧闭包）
    const map = this.map
    if (!map) return
    const zoom = map.getZoom()
    for (const id of Object.keys(this.rawDeckRegistry)) {
      const s = layers.find((l) => l.id === id)
      if (!s || s.dataFormat !== 'arrow' || s.renderer !== 'deck') continue
      void this.syncRawLayer(s, zoom, allowPrefetchConsume)
    }
  }

  /** zoom 分级密度：缩放结束 → 汇入统一取数核心（跨档/跨窗口才重拉；同档且在窗口内由覆盖判定跳过）。 */
  syncRawTiers(layers: LayerSummary[]): void {
    this.refreshRawLayers(layers, true)
  }

  /** 视野变化（pan/zoom moveend，外部已做 ~350ms 尾随防抖）：汇入统一取数核心。
   *  小平移仍在已加载窗口内 → 覆盖判定跳过（零请求零替换）；跨出窗口才拉新窗口并替换该层。 */
  viewportRefresh(layers: LayerSummary[]): void {
    this.refreshRawLayers(layers, false)
  }

  /** 重建 raw deck 图层（可见性/颜色变更时用缓存数据，避免重新拉取）。geojson 从 host.getCachedData 读（与 dataCache 同一份）。 */
  rebuildRaw(s: LayerSummary): void {
    const existing = this.rawDeckRegistry[s.id]
    if (!existing) return
    const spec = { ...existing, ...this.rawArrowSpec(s) }
    const table = this.rawTableCache[s.id]
    const geojson = this.host.getCachedData?.(s.id)
    if (table) this.deckLayerCache[s.id] = makeGeoArrowLayers(spec, table)
    else if (geojson) this.deckLayerCache[s.id] = makeRawGeojsonLayers(spec, geojson)
    this.rawDeckRegistry[s.id] = spec
    this.syncLayers()
  }

  // ---- 点选回查 + 轨迹动画 ----

  /** proxy overlay.pickObject：deck 层在 maplibre queryRenderedFeatures 里查不到，需同步像素拾取。
   *  缺 overlay 返回 null；pick 异常拦截为日志（避免中断点击处理）。 */
  pickObject(x: number, y: number): DeckPickHit | null {
    if (!this.overlay) return null
    try {
      const hit = this.overlay.pickObject({ x, y, radius: 3 })
      if (hit) return { picked: hit.picked, layer: hit.layer, index: hit.index }
      return null
    } catch (err) {
      this.warn('[MapView] deck pick 失败', err)
      return null
    }
  }

  /** 是否还有可见的轨迹图层（驱动动画循环）。 */
  private hasVisibleTrips(): boolean {
    return Object.values(this.deckRegistry).some((s) => s.mode === 'trips' && s.visible)
  }

  /** 轨迹动画循环：rAF 推进 tripsTime → 重建轨迹层 → 下发；无可见轨迹时自停。 */
  private startTripsLoop(): void {
    if (this.tripsRaf != null) return
    if (!this.hasVisibleTrips()) return
    let last = performance.now()
    const step = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      // 只累加、不取模：相位换算在 tripsProgress（乘 speed 再 %1）。取模会截断相位到 speed，头点走不到终点。
      this.tripsTime += dt
      for (const [id, spec] of Object.entries(this.deckRegistry)) {
        if (spec.mode !== 'trips') continue
        this.buildLayer(spec)
      }
      this.syncLayers()
      if (this.hasVisibleTrips()) this.tripsRaf = requestAnimationFrame(step)
      else this.tripsRaf = null
    }
    this.tripsRaf = requestAnimationFrame(step)
  }

  /** 卸载清理：取消轨迹动画循环与全部失败空闲重试定时器、清空 raw 运行期取数状态、置空 overlay/map 引用
   *  （不做 map.remove——地图生命周期归 MapView）。 */
  dispose(): void {
    if (this.tripsRaf != null) cancelAnimationFrame(this.tripsRaf)
    this.tripsRaf = null
    for (const id of Object.keys(this.rawRetryTimers)) this.clearRawRuntime(id)
    this.pendingRaw = {}
    this.lastAutoRetryAt = {}
    this.lastLayers = []
    this.overlay = null
    this.map = null
  }
}
