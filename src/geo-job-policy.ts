/**
 * 隔离执行的**策略层**:超时预算、是否值得隔离、worker 资源上限。
 *
 * 纯函数,不碰 worker / Cordis / DuckDB —— 所以可以脱离执行器单测,也是 14 个调用点
 * 唯一该读策略的地方(调用点只负责把 `scale` 报上来)。
 *
 * ## 为什么需要"该不该隔离"这一层
 * worker 隔离换来"不冻结事件循环",但要付固定成本:**冷启动往返 ≈ 169ms**(实测中位,
 * 含新建 worker + 重载整棵 @turf 依赖树 + 冷 isolate 无 JIT 预热),外加跨线程搬运数据。
 *
 * 实测 20 万面 simplify(修复编解码的 O(n²) 之后):
 * ```
 * 主线程直算 706ms  |  走 worker 2.26s(encode 249 + decode 184 + 计算 769 + encode 211 + decode 160 + 冷启动 169)
 * ```
 * 即 worker 慢约 3×,但**不冻结事件循环**。而在中小规模上同步耗时远低于 169ms,
 * 隔离纯属凭空加延迟 —— 这才是"该不该隔离"这一层存在的理由。
 *
 * ## 阈值的性质(已实测标定)
 * `GEO_JOB_GATE` 的数字由 `bench-geo-jobs.mjs` / `bench-gate-calibrate.mjs` 量出,
 * 判据是"主线程耗时首次越过 169ms 的规模"。它们决定**快慢**,不决定**对错** ——
 * 调错了只会亏性能,不会算错。换机器/换数据形态后需要重新标定。
 */
import { cpus } from 'node:os'
import type { GeoJobKind, GeoWorkerJob } from './geo-job-ops.js'
import { regularGridCellCount } from './geo-processing.js'

// ---------------------------------------------------------------------------
// 超时预算:工具声明 与 worker 预算必须同源
// ---------------------------------------------------------------------------

/**
 * 工具声明的超时预算(`defineTool({ timeoutMs })` 唯一该取的值)。
 *
 * 原先 14 个调用点直接写 `28_000` / `58_000` / `118_000`,恰好等于各自 `timeoutMs − 2000`,
 * 但**没有任何机制维系这个关系** —— 改大 timeoutMs 却忘了改字面量,内层就会先超时并报
 * "计算超过 28 秒",而宿主其实批了更大的预算。现在两者同源,关系由构造保证。
 */
export const GEO_TOOL_TIMEOUTS = {
  /** 几何变换类(buffer/simplify/dissolve/overlay/join)。 */
  op: 30_000,
  /** 空间统计类(核密度/最近邻/全局莫兰/Getis-Ord)。 */
  stat: 60_000,
  /** 带置换检验的局部莫兰(最贵)。 */
  local: 120_000,
} as const

/** 工具预算与 worker 预算之间留的余量(ms)。 */
export const GEO_JOB_HEADROOM_MS = 2000

/**
 * worker 预算 = 工具预算 − 余量。
 * 让 **worker 先超时、工具层后超时**:前者能给出可读的中文归因,后者是框架兜底。
 */
export function workerBudget(toolTimeoutMs: number): number {
  return Math.max(1, toolTimeoutMs - GEO_JOB_HEADROOM_MS)
}

/** 超时原因的错误码(传给 `dsh-timeout` 的 `deadline`/`timeoutOf`,用于区分"我们的超时"与"上游取消")。 */
export const GEO_JOB_TIMEOUT_CODE = 'WEBGIS_GEO_JOB'

// ---------------------------------------------------------------------------
// worker 资源上限
// ---------------------------------------------------------------------------

/**
 * worker 的 V8 老生代上限(MB)。
 *
 * ⚠️ **这是被实测证伪过一次的值**:曾经设 1024,而宿主约 4288MB —— 于是 worker 侧的实际
 * 可用堆只有 1120MB,20 万面(插件自己 PostGIS 上限量级)在**任何 turf 代码跑起来之前**
 * 就 `ERR_WORKER_OUT_OF_MEMORY`,而改动前主线程是能算完的。这是回归,不是新边界。
 *
 * 现在取接近宿主默认。**但这只是止血**:若那 602MB 是图层本身而非克隆副本,提高上限只是
 * 把 OOM 推远。真正的解法是扁平转移(去掉"两侧各存一份"的 2× 峰值),待实测确认。
 */
export const GEO_WORKER_HEAP_MB = Number(process.env.WEBGIS_GEO_WORKER_HEAP_MB) || 4096

/** worker 的新生代上限(MB)。扁平解码是分配密集型的,64 会让 scavenge 过于频繁。 */
export const GEO_WORKER_YOUNG_MB = 128

/** 同时运行的 worker 上限。原先无限制:N 个会话同时跑 20 万面 = N × 数 GB。 */
export const GEO_JOB_MAX_CONCURRENCY = Math.max(1, Math.min(4, (cpus().length || 2) - 1))

// ---------------------------------------------------------------------------
// 规模门控
// ---------------------------------------------------------------------------

/**
 * 门控判据的含义(阈值数字都指这个量):
 * - `features`:单图层的要素数。二次方/超线性算子(统计类、拓扑类)按它判。
 * - `pairs`:`a 的要素数 × b 的要素数`。双图层算子按它判 —— 它们的成本随两个输入一起涨,
 *   只看其中一层会严重低估。⚠️ 注意 `opODMatrix` 的 `maxPairs` **只钳输出对数、不钳内层
 *   打分循环**,所以那里也不能看 maxPairs。
 * - `cells`:规则格网的格子数。它**与图层无关**,由 bbox + cellSize 直接决定。
 */
export type GateMetric = 'features' | 'pairs' | 'cells'

export interface GateRule {
  metric: GateMetric
  /** 达到或超过此值就走 worker(隔离)。低于它主线程直算更快。 */
  min: number
}

/**
 * 每个 job kind 的门控阈值。
 *
 * ## 这些数字是**实测**标定的,不是估的
 * 判据:隔离一次的固定成本 = worker 冷启动往返 ≈ **169ms**(实测中位)。
 * 主线程耗时越过它,冻结就比隔离更贵,该隔离;低于它,隔离纯粹是加延迟。
 * 各 op 的耗时由 `bench-gate-calibrate.mjs` / `bench-geo-jobs.mjs` 在合成数据上量出。
 *
 * ## ⚠️ 首版全猜错了,两个方向都有(记录在此以免重蹈)
 * | kind | 实测越线 | 首版设定 | 错向 |
 * |---|---|---|---|
 * | buffer | ~600 面 | 20,000 | **高 33×** |
 * | dissolve | ~160,000 面 | 2,000 | **低 80×** |
 * | simplify | ~65,000 面 | 20,000 | 低 3× |
 * | spatialJoin | 900 万 pairs 仅 67ms | 200,000 | **低 45×** |
 * | selectByLocation | ~300 万 pairs | 200,000 | 低 15× |
 * | voronoi | >20,000 点仅 55ms | 2,000 | 低 10× |
 * | regularGrid | 20,000 格仅 2ms | 2,000 | **低 500×** |
 * | localMoran | 500 点就要 3.51s | 2,000 | 低 ≥4× |
 * 根因:**同一"规模"下各算子的成本能差 3 个数量级** —— `buffer` 1000 面 272ms,
 * 而 `dissolve` 20000 面只要 9.9ms、`regularGrid` 20000 格只要 2ms。
 * 凭"线性/二次方"的印象分档必然错。
 *
 * ## 仍未标定的
 * `clip` 借用 union 的量级(同族实现);`getisOrd` 按 moran(knn) 同档。
 * 换机器/换数据形态后这些数会变 —— 阈值调错只影响快慢,不影响对错。
 */
export const GEO_JOB_GATE: Record<GeoJobKind, GateRule> = {
  // turf buffer 极贵:1000 面就 272ms、20k 面 3.05s。这是最该隔离的一个。
  buffer: { metric: 'features', min: 500 },
  // dissolve 出乎意料地便宜:20k 面 9.9ms、100k 面 104ms → 到十几万才值得隔离
  dissolve: { metric: 'features', min: 100_000 },
  simplify: { metric: 'features', min: 50_000 },
  // 双图层拓扑实测交叉点 9 万~12 万 pairs(union 90k=150ms / 1M=363ms)
  union: { metric: 'pairs', min: 100_000 },
  intersect: { metric: 'pairs', min: 80_000 },
  difference: { metric: 'pairs', min: 100_000 },
  clip: { metric: 'pairs', min: 100_000 }, // 同族实现，借 union 的量级
  // spatialJoin 有 bbox 预过滤:900 万 pairs 也只要 67ms → 现实数据下几乎不该隔离。
  // 设成很大是**有意**的:让它实际处于关闭状态,而不是凭空制造延迟。
  spatialJoin: { metric: 'pairs', min: 20_000_000 },
  selectByLocation: { metric: 'pairs', min: 2_000_000 },
  // 输出型:voronoi 20k 点 55ms;规则格网生成近乎免费(20k 格 2ms)，
  // 它的硬上限(MAX_REGULAR_GRID_CELLS)才是防线，门控几乎不需要介入。
  voronoi: { metric: 'features', min: 20_000 },
  regularGrid: { metric: 'cells', min: 1_000_000 },
  // 核密度:点数 × 格数,格数上限 40000,所以点数阈值要压低(2000 点 109ms)
  kernelDensity: { metric: 'features', min: 3_000 },
  // 二次方统计(权重矩阵 O(n²)):ann 500=32ms / 2000=496ms;moran(knn) 500=45ms / 1500=429ms
  ann: { metric: 'features', min: 1_000 },
  moran: { metric: 'features', min: 1_000 },
  getisOrd: { metric: 'features', min: 1_000 },
  // ⚠️ localMoran 异常昂贵:500 点就要 3.51 秒(同规模 moran 只要 45ms,差 78×)。
  // 这个量级不是门控能解决的,而是该算子自身的性能问题(见待办)。门控只能尽量把它推走。
  localMoran: { metric: 'features', min: 200 },
}

/**
 * 图层的**真实**规模。
 *
 * ⚠️ 必须用 `totalCount ?? featureCount`,**不能用 featureCount**:抽样层(大 DuckDB 图层)
 * 的 `featureCount` 只是上图子集(≤5 万),`totalCount` 才是真实行数。用错会把最大的图层
 * 判成小的、**恰好跳过隔离** —— 与意图正好相反。
 *
 * (统计类工具对抽样层是"警告而非拒绝",所以抽样层确实会走到这里。)
 */
export function layerScale(layer: { featureCount: number; totalCount?: number }): number {
  return layer.totalCount ?? layer.featureCount
}

/**
 * 兜底估算:job 自身能看到的规模。
 *
 * ⚠️ **只用于没有图层元数据的场合**(单测、`geojson` 型 job)。图层型 job 请由调用点传
 * 真实规模(`layerScale`),否则抽样层会被低估 —— 这就是本函数不能单独承担门控的原因。
 */
export function estimateScale(job: GeoWorkerJob): number {
  const n = (g: { geojson: GeoJSON.FeatureCollection }): number => g.geojson.features.length
  const fc = (g: GeoJSON.FeatureCollection): number => g.features.length
  switch (job.kind) {
    case 'clip':
    case 'intersect':
    case 'difference':
    case 'union':
      return n(job.a) * n(job.b)
    case 'spatialJoin':
      return n(job.target) * n(job.join)
    case 'selectByLocation':
      return job.overlay ? n(job.layer) * n(job.overlay) : n(job.layer)
    case 'buffer':
    case 'dissolve':
    case 'simplify':
    case 'voronoi':
      return n(job.layer)
    case 'regularGrid':
      // 与算子用**同一条公式**（同一个 `regularGridCellCount`），不可能分叉
      return regularGridCellCount(job.bbox, job.cellSize, job.unit)
    default:
      return fc(job.geojson)
  }
}

/** 门控决策结果(带理由,便于测试与排障时看清"为什么走了这条路")。 */
export interface IsolationDecision {
  isolate: boolean
  /** 实际用于比较的规模值。 */
  scale: number
  /** 该 kind 的门控规则。 */
  rule: GateRule
  reason: string
}

/**
 * 判断一个 job 该不该丢进 worker。
 *
 * @param job 任务
 * @param scale 调用点报上来的**真实**规模(见 `layerScale`)。缺省时退回 `estimateScale(job)`,
 *   那在抽样层上会低估 —— 所以生产路径必须传。
 * @param overrideMin 测试用:覆盖该 kind 的阈值(避免为了覆盖隔离路径去造几十万要素的真数据)。
 */
export function shouldIsolate(job: GeoWorkerJob, scale?: number, overrideMin?: number): IsolationDecision {
  const rule = GEO_JOB_GATE[job.kind]
  const min = overrideMin ?? rule.min
  const effective = scale ?? estimateScale(job)
  const isolate = effective >= min
  return {
    isolate,
    scale: effective,
    rule,
    reason: isolate
      ? `${job.kind} 规模 ${effective} ≥ 阈值 ${min}(${rule.metric})→ 隔离执行`
      : `${job.kind} 规模 ${effective} < 阈值 ${min}(${rule.metric})→ 主线程直算`,
  }
}
