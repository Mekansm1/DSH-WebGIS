/**
 * /webgis/basemap-extract 路由（POST）：客户端回传「按当前视窗从底图矢量瓦片提取的要素」。
 *
 * 与 /webgis/export-image 同构：host 工具置请求 → 客户端执行 → 回传同 seq 的结果。
 * 提取本身在浏览器完成（maplibre 已把瓦片解码成带经纬度的 GeoJSON，零网络请求），
 * host 只接收结果并落成图层。
 */
import { json, jsonError, MAX_PICK_BODY, readBody } from './http-utils.js'
import type { RouteApi, RouteHandler } from './route-shared.js'

export const handleBasemapExtract: RouteHandler = (req, res, _url, _pathname, _sessionId, state, _api) => {
  return void (async () => {
    try {
      const raw = await readBody(req, MAX_PICK_BODY)
      const data = JSON.parse(raw) as {
        seq?: unknown; ok?: unknown; message?: unknown
        geojson?: unknown; source?: unknown; rawCount?: unknown
        dedupedCount?: unknown; featureCount?: unknown; names?: unknown; classes?: unknown
      }
      const seq = Number(data.seq)
      if (!Number.isInteger(seq) || seq <= 0) return void jsonError(res, 400, 'seq 参数非法')

      // 客户端报告失败（栅格底图 / 视野内无该图层 / 筛选后为空）→ 立刻解除等待，不必干等超时。
      if (data.ok === false) {
        state.basemapError = typeof data.message === 'string' && data.message
          ? data.message.slice(0, 400)
          : '底图要素提取失败'
        state.basemapRequest = null
        return void json(res, { ok: true })
      }

      const geojson = data.geojson as { type?: string; features?: unknown } | undefined
      if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
        return void jsonError(res, 400, 'geojson 需为 FeatureCollection')
      }
      state.basemapResult = {
        id: seq,
        geojson: geojson as never,
        source: typeof data.source === 'string' ? data.source : '',
        rawCount: Number.isFinite(Number(data.rawCount)) ? Number(data.rawCount) : 0,
        dedupedCount: Number.isFinite(Number(data.dedupedCount)) ? Number(data.dedupedCount) : 0,
        featureCount: Number.isFinite(Number(data.featureCount)) ? Number(data.featureCount) : geojson.features.length,
        names: Array.isArray(data.names) ? (data.names as unknown[]).filter((n): n is string => typeof n === 'string') : [],
        classes: (data.classes && typeof data.classes === 'object' ? data.classes : {}) as Record<string, number>,
      }
      json(res, { ok: true, id: seq, featureCount: state.basemapResult.featureCount })
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '底图要素回传失败')
    }
  })()
}

export type { RouteApi }
