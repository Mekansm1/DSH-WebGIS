/**
 * Arrow 分档 IPC 缓存 + 图层外部资源释放。
 * 拆分自 src/index.ts：
 *  - 键层级：sessionId -> layerId -> tier（0=全量）。不用分隔符拼接（session/layer id 可能含任意字符）。
 *  - 同一档位免重复抽样/编码（重请求秒回），且抽样稳定（同一档始终同一子集，zoom 往返不换一批点）；
 *  - 会话维度：不同会话的同名图层（如基础层 id='dataset'）互不串字节；
 *  - 字节上限：超限按 lastUsed 逐出最老（LRU），不只等图层删除时才清；
 *  - 图层移除（dropLayerResources）按 layerId 全清；会话销毁（arrowCacheClearSession）按 session 清。
 */
import type { GisLayer } from './geo-processing.js'
import { getDuckDb } from './duckdb.js'

type ArrowCacheEntry = { bytes: Uint8Array; lastUsed: number }
/** 键层级：sessionId -> layerId -> tier(0=全量)。不用分隔符拼接（session/layer id 可能含任意字符）。 */
const arrowIpcCache = new Map<string, Map<string, Map<number, ArrowCacheEntry>>>()
const ARROW_CACHE_MAX_BYTES = 256 * 1024 * 1024
let arrowCacheBytes = 0
export function arrowCacheGet(sessionId: string, layerId: string, tier: number): Uint8Array | undefined {
  const e = arrowIpcCache.get(sessionId)?.get(layerId)?.get(tier)
  if (!e) return undefined
  e.lastUsed = Date.now()
  return e.bytes
}
export function arrowCacheSet(sessionId: string, layerId: string, tier: number, bytes: Uint8Array): void {
  let bySession = arrowIpcCache.get(sessionId)
  if (!bySession) {
    bySession = new Map()
    arrowIpcCache.set(sessionId, bySession)
  }
  let byLayer = bySession.get(layerId)
  if (!byLayer) {
    byLayer = new Map()
    bySession.set(layerId, byLayer)
  }
  const prev = byLayer.get(tier)
  if (prev) arrowCacheBytes -= prev.bytes.byteLength
  byLayer.set(tier, { bytes, lastUsed: Date.now() })
  arrowCacheBytes += bytes.byteLength
  // 字节上限 LRU：逐出最久未用的一条，直到达标。
  while (arrowCacheBytes > ARROW_CACHE_MAX_BYTES) {
    let oldestKey: [string, string, number] | null = null
    let oldest = Infinity
    for (const [s, bySession] of arrowIpcCache) {
      for (const [l, byLayer] of bySession) {
        for (const [t, e] of byLayer) {
          if (e.lastUsed < oldest) {
            oldest = e.lastUsed
            oldestKey = [s, l, t]
          }
        }
      }
    }
    if (!oldestKey) break
    const [os, ol, ot] = oldestKey
    const layerMap = arrowIpcCache.get(os)!.get(ol)!
    const ev = layerMap.get(ot)!
    arrowCacheBytes -= ev.bytes.byteLength
    layerMap.delete(ot)
    if (layerMap.size === 0) {
      arrowIpcCache.get(os)!.delete(ol)
      if (arrowIpcCache.get(os)!.size === 0) arrowIpcCache.delete(os)
    }
  }
}
/** 图层移除：清掉该 layerId 在所有会话里的 Arrow 缓存（跨会话一删为净，宁可多清不可串数据）。 */
function arrowCacheDropLayer(layerId: string): void {
  for (const [s, bySession] of arrowIpcCache) {
    const byLayer = bySession.get(layerId)
    if (!byLayer) continue
    for (const e of byLayer.values()) arrowCacheBytes -= e.bytes.byteLength
    bySession.delete(layerId)
    if (bySession.size === 0) arrowIpcCache.delete(s)
  }
}
/** 会话销毁：清掉该会话的全部 Arrow 缓存（其 duckTable 已 drop，残余字节无引用）。 */
export function arrowCacheClearSession(sessionId: string): void {
  const bySession = arrowIpcCache.get(sessionId)
  if (!bySession) return
  for (const byLayer of bySession.values()) {
    for (const e of byLayer.values()) arrowCacheBytes -= e.bytes.byteLength
  }
  arrowIpcCache.delete(sessionId)
}

/** 图层移除联动：释放 DuckDB 内存表 + 清 Arrow 缓存。跨文件复用（session 销毁 / 右键删除 / import 覆盖）。 */
export function dropLayerResources(layer: GisLayer): void {
  if (layer.duckTable) void getDuckDb().dropTable(layer.duckTable)
  arrowCacheDropLayer(layer.id)
}
