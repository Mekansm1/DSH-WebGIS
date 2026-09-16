/**
 * 隔离执行器（src/geo-jobs.ts）测试 —— **真跑 worker**，全仓唯一一处。
 *
 * 刻意只有几个用例：真 worker 有启动成本（模块图加载 + 冷 isolate），而且
 * `--test-concurrency=1` 是串行的。其余 14 条 worker 分支由 geo-tools 测试用
 * **stub runner** 覆盖（毫秒级、零启动）。
 *
 * 这里要钉住的是"只有真 worker 才能验证"的三件事：
 * ① 往返结果与主线程直算**逐字段相等**（隔离不改变算出来的东西）；
 * ② 超时真的能停（同步 turf 代码无法被 AbortSignal 抢占，terminate 是唯一手段）；
 * ③ 取消真的能停，且**不残留线程**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GeoJobAbortedError, GeoJobRunner, GeoJobTimeoutError } from '../lib/geo-jobs.js'
import { decodeJob, encodeJob, isFlatJob } from '../lib/geo-job-codec.js'
import { runGeoJobLocal } from '../lib/geo-job-ops.js'
import { opBuffer } from '../lib/geo-processing.js'

/** 造 n 个方块多边形（面积不大，但足够让 worker 真跑起来）。 */
function squaresFC(n) {
  const features = []
  for (let i = 0; i < n; i++) {
    const x = 113 + i * 0.01
    const y = 23 + i * 0.01
    features.push({
      type: 'Feature',
      properties: { id: i, name: `sq-${i}` },
      geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.005, y], [x + 0.005, y + 0.005], [x, y + 0.005], [x, y]]] },
    })
  }
  return { type: 'FeatureCollection', features }
}

test('往返正确性：worker 里的结果与主线程直算逐字段相等', async () => {
  const runner = new GeoJobRunner()
  try {
    const layer = { geojson: squaresFC(50) }
    const job = { kind: 'buffer', layer, distance: 100, unit: 'meters' }
    const viaWorker = await runner.run(job, 30_000)
    const viaMainThread = opBuffer(layer, 100, 'meters')
    assert.deepStrictEqual(viaWorker, viaMainThread, '隔离执行不得改变结果')
    assert.equal(runner.activeCount, 0, '跑完就该 terminate,不残留线程')
  } finally {
    await runner.dispose()
  }
})

test('超时：能硬终止并抛 GeoJobTimeoutError，且不残留线程', async () => {
  const runner = new GeoJobRunner()
  try {
    const job = { kind: 'buffer', layer: { geojson: squaresFC(2000) }, distance: 100, unit: 'meters' }
    await assert.rejects(
      () => runner.run(job, 1), // 1ms 预算：worker 还没起完就该被掐
      (err) => {
        assert.ok(err instanceof GeoJobTimeoutError, `应为 GeoJobTimeoutError，实际 ${err?.name}`)
        assert.match(err.message, /计算超过/, '文案要给用户看')
        assert.match(err.message, /不会生成结果图层/, '要明确说明没产生半成品')
        return true
      },
    )
    assert.equal(runner.activeCount, 0, '超时后必须已 terminate')
  } finally {
    await runner.dispose()
  }
})

test('取消：上游 abort 抛 GeoJobAbortedError，与超时可区分，且不残留线程', async () => {
  const runner = new GeoJobRunner()
  try {
    const ac = new AbortController()
    const job = { kind: 'buffer', layer: { geojson: squaresFC(2000) }, distance: 100, unit: 'meters' }
    const p = runner.run(job, 60_000, { signal: ac.signal })
    // 等一小会让 worker 真的起来，再取消 —— 避免只是"还没开始就取消"这条平凡路径
    await new Promise((r) => setTimeout(r, 50))
    ac.abort()
    await assert.rejects(p, (err) => {
      assert.ok(err instanceof GeoJobAbortedError, `应为 GeoJobAbortedError，实际 ${err?.name}`)
      assert.match(err.message, /已取消/)
      return true
    })
    assert.equal(runner.activeCount, 0, '取消后必须已 terminate')
  } finally {
    await runner.dispose()
  }
})

test('取消：已经 abort 的信号不会真的启动 worker（acquire 阶段就出队）', async () => {
  const runner = new GeoJobRunner()
  try {
    const ac = new AbortController()
    ac.abort()
    const job = { kind: 'buffer', layer: { geojson: squaresFC(5) }, distance: 1, unit: 'meters' }
    await assert.rejects(() => runner.run(job, 30_000, { signal: ac.signal }), GeoJobAbortedError)
    assert.equal(runner.activeCount, 0)
  } finally {
    await runner.dispose()
  }
})

test('dispose：清空队列并 reject 排队者（不留永不 settle 的 Promise）', async () => {
  const runner = new GeoJobRunner()
  const job = { kind: 'buffer', layer: { geojson: squaresFC(5) }, distance: 1, unit: 'meters' }
  // 并发闸内的任务先占住槽位（用大超时让它一直跑）
  const running = Array.from({ length: 8 }, () => runner.run({ ...job, distance: 50 }, 60_000).catch((e) => e))
  await new Promise((r) => setTimeout(r, 50))
  const disposed = runner.dispose()
  const results = await Promise.all(running)
  await disposed
  // 排队的那些必须被 reject 掉（是 GeoJobAbortedError），而不是永远挂着
  for (const r of results) {
    assert.ok(r === undefined || r instanceof Error, '每个调用都必须 settle')
  }
  assert.equal(runner.queuedCount, 0, 'dispose 后队列必须清空')
  assert.equal(runner.activeCount, 0)
})

// ---------------------------------------------------------------------------
// job 级编解码：扁平传输层对算子透明
// ---------------------------------------------------------------------------

test('encodeJob/decodeJob：job 往返等价（图层类与 geojson 类都要还原成原形状）', () => {
  const layer = { geojson: squaresFC(3) }
  const cases = [
    { kind: 'buffer', layer, distance: 100, unit: 'meters' },
    { kind: 'dissolve', layer, field: 'name' },
    { kind: 'simplify', layer, tolerance: 0.001, highQuality: true },
    { kind: 'union', a: layer, b: { geojson: squaresFC(2) } },
    { kind: 'spatialJoin', target: layer, join: { geojson: squaresFC(2) }, relation: 'intersects' },
    { kind: 'selectByLocation', layer, relation: 'within' },
    { kind: 'moran', geojson: squaresFC(4), field: 'id', options: { type: 'queen' } },
  ]
  for (const job of cases) {
    const enc = encodeJob(job)
    assert.equal(enc.ok, true, `${job.kind} 本应可扁平化`)
    const flat = structuredClone(enc.flat, { transfer: enc.transfer })
    assert.ok(isFlatJob(flat))
    assert.deepStrictEqual(decodeJob(flat), job, `${job.kind} job 往返不等价`)
  }
})

test('encodeJob：未登记的 kind 明确拒绝（而不是静默当标量克隆）', () => {
  const r = encodeJob({ kind: 'no-such-kind', layer: { geojson: squaresFC(1) } })
  assert.equal(r.ok, false)
  assert.match(r.reasons[0], /未知 job kind/)
})

test('runGeoJobLocal：扁平 job 与裸 job 走同一个函数（两条路必然同语义）', () => {
  const layer = { geojson: squaresFC(3) }
  const job = { kind: 'buffer', layer, distance: 100, unit: 'meters' }
  const enc = encodeJob(job)
  assert.equal(enc.ok, true)
  const viaFlat = runGeoJobLocal(decodeJob(structuredClone(enc.flat, { transfer: enc.transfer })))
  assert.deepStrictEqual(viaFlat, runGeoJobLocal(job), '扁平路径与裸路径结果必须一致')
})
