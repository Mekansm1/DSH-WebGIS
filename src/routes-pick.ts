/**
 * /webgis/pick 路由（POST）：前端上报点击地图 / 响应 state.capture 的「捕获当前视图」。
 * 拆分自 src/index.ts 的 HTTP 路由大 handler；行为零变化。
 */
import type { PickFeature } from './session-state.js'
import { json, jsonError, MAX_PICK_BODY, readBody } from './http-utils.js'
import { parseScreenshot } from './screenshot-utils.js'
import type { RouteApi, RouteHandler } from './route-shared.js'

export const handlePick: RouteHandler = (req, res, _url, _pathname, _sessionId, state, api) => {
  return void (async () => {
    try {
      const raw = await readBody(req, MAX_PICK_BODY)
      const data = JSON.parse(raw) as {
        lng?: unknown; lat?: unknown; features?: unknown; screenshot?: unknown
        captureSeq?: unknown; ok?: unknown; message?: unknown; clear?: unknown
      }
      // 客户端主动报告捕获失败（截图不可用），不写 pick，供等待中的工具读取。
      if (data.ok === false) {
        state.captureError = typeof data.message === 'string' && data.message
          ? data.message.slice(0, 200)
          : 'capture failed'
        state.capture = null
        return json(res, { ok: true })
      }
      // 右键清除图钉：清掉最近一次 pick（坐标/要素/截图），后续 webgis_get_pick 将重新捕获当前视图。
      if (data.clear === true) {
        state.pick = null
        state.capture = null
        return json(res, { ok: true })
      }
      const lng = typeof data.lng === 'number' && Number.isFinite(data.lng) ? data.lng : NaN
      const lat = typeof data.lat === 'number' && Number.isFinite(data.lat) ? data.lat : NaN
      if (!Number.isFinite(lng) || lng < -180 || lng > 180
        || !Number.isFinite(lat) || lat < -90 || lat > 90) {
        return jsonError(res, 400, '坐标不合法')
      }
      const features = Array.isArray(data.features) ? data.features as PickFeature[] : []
      const screenshot = await parseScreenshot(api.ctx, data.screenshot)
      if (data.screenshot !== undefined && data.screenshot !== null && !screenshot) {
        api.ctx.logger.warn('[webgis] 截图解析/保存失败，仅记录坐标与要素')
      }
      const captureSeq = typeof data.captureSeq === 'number' && Number.isFinite(data.captureSeq)
        ? data.captureSeq
        : undefined
      // 捕获成功即视为该请求已被消费；等待中的工具靠 pick.captureSeq 识别本次结果。
      if (captureSeq !== undefined) state.capture = null
      state.pick = { id: ++api.seqs.pickSeq, lng, lat, features, screenshot, ...(captureSeq !== undefined ? { captureSeq } : {}) }
      json(res, { ok: true, id: state.pick.id })
    } catch (err) {
      jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}
