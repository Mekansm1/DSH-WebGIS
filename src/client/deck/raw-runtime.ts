/**
 * raw arrow 图层的「单层运行时状态 + 纯决策函数」（deck controller 收敛用）。
 *
 * 原先 raw 路径把每层状态散落在 controller 的 9 个按 id 并行 map 里
 * （rawDeckRegistry / rawTableCache / rawTiers / rawFetching / lastViewKey / pendingRaw /
 *   lastAutoRetryAt / rawRetryTimers / windowOf / rawPrefetchCache / rawManaged），
 * 删除/清理要同步删 N 处、漏一处就留残留定时器或残留请求。这里把它们收敛成每层一个
 * {@link RawLayerRuntime} 对象；取数决策（{@link decideRawSync}）与失败空闲重试判定
 * （{@link autoRetryEligible}）抽成纯函数，可在 node 直接单测（不依赖 window/Date/map）。
 *
 * 边界：本模块只 import 类型 + 纯函数，不碰 deck.gl / maplibre / window / fetch——
 * 网络拉取、setTimeout、map.getZoom 等副作用仍留在 controller。
 */
import type { Table } from 'apache-arrow'
import type { GeoArrowSpec } from '../geoarrow-charts.js'
import type { LayerSummary } from '../gis-types.js'
import {
  bboxContains, bboxStr, COVER_MARGIN_DEG, FETCH_PAD, fromBboxStr,
  paddedBbox, shouldViewportCull, type Bbox,
} from './viewport.js'

/** 单层 raw 取数决策（决定后交给 controller 执行；consume 的 key 恒为 `${tier}|`，由执行侧重建）。 */
export type RawSyncDecision =
  | { kind: 'skip' } // 覆盖命中 / 同键去重 / 已在途 → 渲染层不动
  | { kind: 'consume' } // 旧全档位命中预取缓存 → 直接换档
  | { kind: 'fetch'; bbox: string | null } // bbox=null=旧全档位；否则为视口 bbox 参数

/** 失败空闲重试延迟：一次 arrow fetch 失败且无尾随合并/在途/待重试时，延迟这么久补拉一次最新视野。 */
export const RAW_RETRY_DELAY_MS = 800
/** 失败空闲重试冷却：距上次自动重试不足此时长则不再自动重试（防死循环；手动平移/缩放触发的不走这里）。 */
export const RAW_RETRY_MIN_INTERVAL_MS = 1500

/**
 * 单个 raw arrow 图层的运行时状态。只承载「这一层」的取数/缓存/重试状态，不含任何渲染副作用。
 * 创建/写入由 controller 驱动；读取供决策与重试判定。
 */
export class RawLayerRuntime {
  readonly id: string
  /** 已渲染出数据后登记（arrow 成功 / geojson 兜底成功）；供 hasRaw/rebuildRaw/rawVisibleOf 判定「有数据可重建」。 */
  spec: GeoArrowSpec | null = null
  /** 最近一次成功拉到的 Arrow 表（可见性/样式重建免重新拉二进制）。 */
  table: Table | null = null
  /** 当前渲染的分档（zoom 分级密度：max 抽样条数；成功才更新）。 */
  tier = 0
  /** 正在拉取的「视野键」（`${tier}|${bbox}`）；同层同刻至多一个在途。 */
  fetching: string | null = null
  /** 已成功渲染/在途的「视野键」（`${tier}|${bbox}`；bbox 空 = 无视野全量路径）。 */
  lastViewKey: string | null = null
  /** 尾随合并队列：在途期间被「不同键决策」跳过的最新视野键；在途结束后据此补拉。 */
  pending: string | null = null
  /** 上次**实际执行**自动重试的时刻（毫秒时间戳）；距它 < RAW_RETRY_MIN_INTERVAL_MS 不再自动重试。 */
  lastAutoRetryAt = 0
  /** 失败空闲重试的定时器句柄（setTimeout id）；清理时 clearTimeout。 */
  retryTimer: number | null = null
  /** 视口裁剪最近一次**成功拉到**的取数窗口与其 tier（覆盖率跳过：小平移/同档位缩放仍在窗口内不重拉）。 */
  window: { tier: number; bb: Bbox } | null = null
  /** 预取预热缓存：tier → 已提前拉好的表（后台拉下一档，仅无 bbox 路径用）。 */
  prefetch: Record<number, Table> = {}
  /** 「该层当前应被 raw 取数运行时管理」的意图；removeOut/clearRaw/dispose 时置 false。 */
  managed = false

  constructor(id: string) {
    this.id = id
  }

  /** 是否还有未收尾的取数运行时状态（在途 / 待尾随合并 / 待重试定时器 / 冷却记录）。 */
  hasRuntime(): boolean {
    return this.fetching != null || this.pending != null || this.retryTimer != null || this.lastAutoRetryAt !== 0
  }

  /** 清掉重试定时器（返回是否确有定时器被清除）；供清理路径复用，保证不残留回调。
   *  用全局 clearTimeout（浏览器与 node 都有），保持本模块可被 node 单测直接加载。 */
  clearRetryTimer(): boolean {
    if (this.retryTimer == null) return false
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    return true
  }
}

/** LayerSummary.bbox（[w,s,e,n] 元组）转 Bbox；缺失 / 非有限返回 null（按「无 bbox」处理）。 */
export function layerBboxOf(s: LayerSummary): Bbox | null {
  const b = s.bbox
  if (!b || b.length !== 4) return null
  const [west, south, east, north] = b
  if (![west, south, east, north].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
  return { west, south, east, north }
}

/** 收益门控：true = 本层值得走视口裁剪；false = 走旧全档位（bbox=null，与 v1 之前一致）。 */
export function shouldCull(s: LayerSummary, view: Bbox, zoom: number): boolean {
  return shouldViewportCull(view, layerBboxOf(s), zoom)
}

/**
 * 统一取数决策（幂等，纯函数）：先判「视口裁剪 vs 旧全档位」门控，再在各自路径内做去重 / 覆盖率跳过。
 * force=true 时忽略覆盖/同键去重（仅首拉/数据变更用；fetchRawArrow 内在途同键仍去重）。
 * 副作用仅体现在「旧全档位路径清 window」——由调用方按返回结果落回 rt。
 */
export function decideRawSync(
  rt: RawLayerRuntime,
  s: LayerSummary,
  tier: number,
  zoom: number,
  view: Bbox | null,
  allowPrefetchConsume: boolean,
  force: boolean,
): RawSyncDecision {
  // 视口门控：view 存在且 shouldCull 才裁剪；否则旧全档位（bbox=null，与 v1 之前行为一致）。
  const gated = view != null && shouldCull(s, view, zoom)
  if (!gated) {
    if (rt.window != null) rt.window = null
    const key = `${tier}|`
    if (!force && (rt.lastViewKey === key || rt.fetching === key)) return { kind: 'skip' }
    if (!force && allowPrefetchConsume && rt.prefetch[tier]) return { kind: 'consume' }
    return { kind: 'fetch', bbox: null }
  }
  // 视口裁剪路径：取数窗口 = 当前视野按 FETCH_PAD 外扩（减少后续平移重拉）。
  const need = paddedBbox(view, FETCH_PAD)
  const w = rt.window
  // 覆盖率跳过：同 tier 且当前视野仍在上次成功拉到的窗口内 → 本层跳过（渲染层不动，零请求零替换）。
  if (!force && w && w.tier === tier && bboxContains(w.bb, view, COVER_MARGIN_DEG)) return { kind: 'skip' }
  const bbox = bboxStr(need)
  const key = `${tier}|${bbox}`
  if (!force && (rt.lastViewKey === key || rt.fetching === key)) return { kind: 'skip' }
  return { kind: 'fetch', bbox }
}

/**
 * 失败空闲重试的「运行时侧」判定（纯函数，不查 lastLayers/摘要——那些由 controller 先行判掉）。
 * nowMs 为当前毫秒时间戳（由 controller 传 Date.now()，保持纯函数可测）。
 * 关键：**不要求 rt.spec 已存在**——首拉失败（尚无任何成功数据）也要允许排重试。
 */
export function autoRetryEligible(rt: RawLayerRuntime, nowMs: number): boolean {
  if (rt.fetching != null) return false // 已有在途
  if (rt.pending != null) return false // 已有待尾随合并的键
  if (rt.retryTimer != null) return false // 已有一个未触发的重试定时器
  // 冷却：0 = 从未重试过（不参与冷却，否则时钟起点附近会被误判）；有记录才比时间差。
  if (rt.lastAutoRetryAt !== 0 && nowMs - rt.lastAutoRetryAt < RAW_RETRY_MIN_INTERVAL_MS) return false
  return rt.managed // 仍是 active raw 层即可（无需已出过数据）
}

/** 从 bbox 串解析出取数窗口（供成功路径记录 rt.window；bbox 即 need 的 3 位小数序列化）。 */
export function windowFromBbox(bbox: string, tier: number): { tier: number; bb: Bbox } {
  return { tier, bb: fromBboxStr(bbox) }
}
