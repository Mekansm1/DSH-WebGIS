/**
 * 杂项路由：services 清单（GET/POST/remove/visibility）、白名单静态资源、SSE /events 推送订阅。
 * 拆分自 src/index.ts 的 HTTP 路由大 handler；行为零变化。
 */
import { json, jsonError, notFound, readBody, serveAsset } from './http-utils.js'
import { readServices, writeServices } from './webgis-services-io.js'
import { removeService, setServiceVisibility, upsertService, validateService } from './webgis-services.js'
import type { RouteApi, RouteHandler } from './route-shared.js'

export const handleServicesGet: RouteHandler = async (_req, res, _url, _pathname, _sessionId, _state, api) => {
  // 叠加地图服务清单（全局，无 session）。
  json(res, { services: await readServices(api.servicesFile) })
}

export const handleServicesPost: RouteHandler = (req, res, _url, _pathname, _sessionId, _state, api) => {
  // 新增/更新一条叠加服务。
  return void (async () => {
    try {
      const raw = await readBody(req, 16 * 1024)
      const data = JSON.parse(raw) as Record<string, unknown>
      const v = validateService(data)
      if (!v.ok) return void jsonError(res, 400, v.message)
      const list = await readServices(api.servicesFile)
      await writeServices(upsertService(list, v.svc), api.servicesFile)
      json(res, { ok: true, services: await readServices(api.servicesFile) })
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}

export const handleServicesRemove: RouteHandler = (req, res, _url, _pathname, _sessionId, _state, api) => {
  return void (async () => {
    try {
      const raw = await readBody(req, 4 * 1024)
      const data = JSON.parse(raw) as { id?: unknown }
      const id = typeof data.id === 'string' ? data.id : ''
      if (!id) return void jsonError(res, 400, '缺少服务 id')
      await writeServices(removeService(await readServices(api.servicesFile), id), api.servicesFile)
      json(res, { ok: true, services: await readServices(api.servicesFile) })
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}

export const handleServicesVisibility: RouteHandler = (req, res, _url, _pathname, _sessionId, _state, api) => {
  return void (async () => {
    try {
      const raw = await readBody(req, 4 * 1024)
      const data = JSON.parse(raw) as { id?: unknown; visible?: unknown }
      const id = typeof data.id === 'string' ? data.id : ''
      if (!id) return void jsonError(res, 400, '缺少服务 id')
      await writeServices(setServiceVisibility(await readServices(api.servicesFile), id, data.visible === true), api.servicesFile)
      json(res, { ok: true, services: await readServices(api.servicesFile) })
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}

export const handleStaticAsset: RouteHandler = async (req, res, _url, pathname, _sessionId, _state) => {
  // 白名单静态资源：文件名固定，路径剥离防穿越（earcut-worker.js → earcut-worker.min.js 实际文件）
  const file = pathname.split('/').pop()!
  await serveAsset(req, res, file === 'earcut-worker.js' ? 'earcut-worker.min.js' : file)
}

export const handleEvents: RouteHandler = (req, res, _url, _pathname, sessionId, _state, api) => {
  // SSE：状态变更即时推送（MapView 订阅；收到 `sync` 即拉 /webgis/state）。连接保持，close/会话销毁清理。
  const sKey = sessionId ?? 'anon'
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  let subs = api.sseClients.get(sKey)
  if (!subs) {
    subs = new Set()
    api.sseClients.set(sKey, subs)
  }
  subs.add(res)
  // 以当前状态作指纹基线：之后的变更才会触发推送（避免订阅瞬间把旧状态当“变更”再推一次）。
  api.sseStateHash.set(sKey, api.stateFingerprint(api.stateFor(sKey)))
  req.on('close', () => {
    subs.delete(res)
    if (subs.size === 0) {
      api.sseClients.delete(sKey)
      api.sseStateHash.delete(sKey)
    }
  })
}
