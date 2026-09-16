/**
 * 主线程重计算调度器:把长同步 GIS 算法丢进独立 V8 isolate,使其**不冻结事件循环**、且能被硬终止。
 *
 * ## 为什么必须能 terminate
 * Turf 的拓扑计算是同步 CPU 代码,`AbortSignal` 对它无效 —— **`worker.terminate()` 是唯一能真正
 * 停活的手段**。这也是"不做 worker 池"的依据:被终止的 worker 不可复用,池在超时/取消这条路径上
 * 零收益,能省的只有启动成本(待实测,见实施计划第 8 步)。
 *
 * ## 超时与取消:用框架原语,不手搓
 * `@deepseek-ai/dsh-timeout` 的 `deadline(upstream, timeoutMs, code)` 一次解决两件事:
 * 把**上游取消**与**本地超时**融成一个信号,并用 `TimeoutReason` 带上的 code 让 `timeoutOf`
 * 能区分二者 —— 于是"计算超过 N 秒"与"已取消"可以给出不同的话。
 * 框架侧契约(`dsh-tools` 的类型文档):声明了 `timeoutMs` 就等于承诺转发 `exec.signal`。
 *
 * ⚠️ 不用 `using` 语法:`tsconfig` 的 `lib` 是 `ES2022`,`Symbol.dispose` 的类型需要
 * `ESNext.Disposable`。在 `finally` 里显式 `dl[Symbol.dispose]()`。
 */
import { Worker } from 'node:worker_threads'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { decodeResult, encodeJob, type FlatResult } from './geo-job-codec.js'
import type { GeoWorkerJob } from './geo-job-ops.js'
import {
  GEO_JOB_MAX_CONCURRENCY, GEO_JOB_TIMEOUT_CODE, GEO_WORKER_HEAP_MB, GEO_WORKER_YOUNG_MB,
} from './geo-job-policy.js'

/** 计算超时(worker 侧预算耗尽)。文案可直接给用户看。 */
export class GeoJobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`计算超过 ${Math.ceil(timeoutMs / 1000)} 秒，已停止，不会生成结果图层。可缩小范围、简化边界后重试。`)
    this.name = 'GeoJobTimeoutError'
  }
}

/** 上游取消(用户停止 / 会话关闭)。与超时分开,**因为没有产生任何结果图层**。 */
export class GeoJobAbortedError extends Error {
  constructor() {
    super('计算已取消，未生成结果图层。')
    this.name = 'GeoJobAbortedError'
  }
}

/** 一次隔离执行的选项。 */
export interface GeoJobRunOptions {
  /** 上游取消信号(来自 `exec.signal`)。 */
  signal?: AbortSignal
  /** 排障用日志(编码退回、排队等)。缺省静默。 */
  log?: (line: string) => void
}

interface Waiter {
  grant: () => void
  reject: (err: Error) => void
}

export class GeoJobRunner {
  private readonly active = new Set<Worker>()
  /** FIFO 等待队列 —— 并发闸满了就在这里排队。 */
  private readonly waiters: Waiter[] = []
  private running = 0

  /**
   * 跑一个 job。
   *
   * ⚠️ **deadline 从"入队时"起算**,不是"开工时":否则排队时间不计入预算,工具外层的超时
   * 会先到,把"排队太久"错误归因成"计算太慢"。
   */
  async run<T>(job: GeoWorkerJob, timeoutMs: number, opts: GeoJobRunOptions = {}): Promise<T> {
    const dl = deadline(opts.signal, timeoutMs, GEO_JOB_TIMEOUT_CODE)
    let acquired = false
    try {
      await this.acquire(dl.signal)
      acquired = true
      return await this.spawn<T>(job, dl.signal, opts.log)
    } finally {
      if (acquired) this.release()
      dl[Symbol.dispose]() // 清掉定时器(dispose-once)
    }
  }

  /** 在跑的 worker 数（诊断/测试用 —— 断言取消与超时之后确实没有线程残留）。 */
  get activeCount(): number {
    return this.active.size
  }

  /** 排队等待中的任务数（诊断/测试用）。 */
  get queuedCount(): number {
    return this.waiters.length
  }

  /** 关闭:终止所有在跑的 worker,并**清空队列**(不清会留下永不 settle 的 Promise)。 */
  async dispose(): Promise<void> {
    const waiters = this.waiters.splice(0)
    for (const w of waiters) w.reject(new GeoJobAbortedError())
    const workers = [...this.active]
    this.active.clear()
    await Promise.allSettled(workers.map((w) => w.terminate()))
  }

  // ---- 并发闸 --------------------------------------------------------------

  private acquire(signal: AbortSignal): Promise<void> {
    if (this.running < GEO_JOB_MAX_CONCURRENCY) {
      this.running++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort)
          this.running++
          resolve()
        },
        reject,
      }
      const onAbort = (): void => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1)
        reject(abortErrorOf(signal))
      }
      if (signal.aborted) {
        reject(abortErrorOf(signal))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private release(): void {
    this.running--
    const next = this.waiters.shift()
    if (next) next.grant()
  }

  // ---- 真正的派发 ----------------------------------------------------------

  private spawn<T>(job: GeoWorkerJob, signal: AbortSignal, log?: (line: string) => void): Promise<T> {
    // 编码成扁平载荷;任一处几何无法无损扁平化 → 退回把裸 job 克隆过去(structuredClone 仍然正确,
    // 只是慢)。编码失败绝不静默:理由打到 log 里,便于回答"这一层为什么特别慢"。
    const enc = encodeJob(job as unknown as { kind: string } & Record<string, unknown>)
    if (!enc.ok) log?.(`[webgis] geo job ${job.kind} 退回结构化克隆:${enc.reasons.join('; ')}`)
    else if (enc.notes.length > 0) log?.(`[webgis] geo job ${job.kind}:${enc.notes.join('; ')}`)

    const worker = new Worker(new URL('./geo-worker.js', import.meta.url), {
      workerData: enc.ok ? enc.flat : job,
      transferList: enc.ok ? enc.transfer : [],
      resourceLimits: { maxOldGenerationSizeMb: GEO_WORKER_HEAP_MB, maxYoungGenerationSizeMb: GEO_WORKER_YOUNG_MB },
    })
    // 漏掉 terminate 的任何路径都不该吊住进程退出;正常收尾照样 terminate。
    worker.unref()
    this.active.add(worker)

    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        this.active.delete(worker)
        // 成功也 terminate:算完的 20 万面 worker 挂着会一直占内存。
        void worker.terminate()
        fn()
      }
      const onAbort = (): void => finish(() => reject(abortErrorOf(signal)))

      if (signal.aborted) {
        finish(() => reject(abortErrorOf(signal)))
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      worker.once('message', (message: FlatResult) =>
        finish(() => {
          try {
            resolve(decodeResult(message) as T)
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          }
        }))
      worker.once('error', (error) => finish(() => reject(error)))
      worker.once('exit', (code) => {
        // 正常完成已由 message 分支 settle;这里只兜"没给结果就退了"。
        if (!settled && code !== 0) finish(() => reject(new Error(`GIS 计算进程异常退出（code ${code}）`)))
      })
    })
  }
}

/**
 * 把 abort 归类成「超时」还是「上游取消」—— 两者文案不同,且都不产生结果图层。
 * 必须给 `timeoutOf` 传 code:否则嵌套的上游 deadline 会被误判成本次超时。
 */
function abortErrorOf(signal: AbortSignal): Error {
  const reason = timeoutOf(signal, GEO_JOB_TIMEOUT_CODE)
  return reason ? new GeoJobTimeoutError(reason.timeoutMs) : new GeoJobAbortedError()
}
