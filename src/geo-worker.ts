/**
 * 重 GIS 计算的**隔离执行单元**（每个 V8 isolate 只跑一个 job，跑完即被 terminate）。
 *
 * ## 这里绝不能依赖
 * Cordis、会话状态、DuckDB 连接 —— 否则 worker 起不来。主线程只在 worker 成功返回后才写图层，
 * 因此**终止 worker 不会留下半成品**。
 *
 * ## 数据怎么进来、怎么出去
 * - 进：`workerData` 是**扁平载荷**（typed array），buffer 由主线程 `transferList` 零拷贝移交。
 *   若宿主那边有几何无法扁平化，会退回把裸 job 结构克隆过来 —— 用 `isFlatJob` 分辨。
 * - 出：跑完把结果**同样扁平化**后 `postMessage` 回去，也是零拷贝移交。
 *   **回程与去程一样重要**：只改去程等于只省一半（原先两次 structuredClone 各占一次同量级开销）。
 *
 * ## 为什么要扁平
 * structuredClone 搬 20 万面要"序列化 + 全量复制 + 反序列化"三趟、约 602MB，实测占掉一次
 * simplify 的 16s 里约 11s；而重建成 GeoJSON 这步放在 worker 线程上做，主线程就不必付。
 */
import { parentPort, workerData } from 'node:worker_threads'
import { decodeJob, encodeResult, isFlatJob } from './geo-job-codec.js'
import { runGeoJobLocal, type GeoWorkerJob } from './geo-job-ops.js'

function main(): void {
  const incoming = workerData as unknown
  // 扁平载荷 → 还原成 job；否则是宿主退回克隆的裸 job，直接用。
  const job = (isFlatJob(incoming) ? decodeJob(incoming) : incoming) as unknown as GeoWorkerJob
  const value = runGeoJobLocal(job)
  const { flat, transfer } = encodeResult(value)
  parentPort?.postMessage(flat, transfer)
}

try {
  main()
} catch (error) {
  // 业务异常（如"网格过密"）正常路径下由 op 自己作为返回值给出；能落到这里的是意外异常。
  // 走 `err` 信封而不是抛出去 —— 抛出会触发 worker 的 'error' 事件，宿主那边拿不到可读信息。
  parentPort?.postMessage({ t: 'err', message: error instanceof Error ? error.message : String(error) })
}
