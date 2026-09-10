/**
 * 出图结果上传 / 最近一次出图下载：export-image（POST）/ attachment（GET）。
 * 拆分自 src/index.ts 的 HTTP 路由大 handler；行为零变化。
 */
import {
  download, exportName, json, jsonError, MAX_PICK_BODY, notFound, readBody,
} from './http-utils.js'
import { decodeDataUrl } from './screenshot-utils.js'
import type { RouteApi, RouteHandler } from './route-shared.js'

export const handleExportImage: RouteHandler = (req, res, _url, _pathname, _sessionId, state, api) => {
  // 出图结果上传：客户端把合成好的 PNG dataUrl 传回 → 附件持久化 + 存最近一次出图。
  // 带 seq（来自 exportRequest）则通知等待中的 webgis_export_map；不带（GUI 手动导出）也给 AI 用 get_export_map 取。
  return void (async () => {
    try {
      const raw = await readBody(req, MAX_PICK_BODY)
      const data = JSON.parse(raw) as {
        seq?: unknown; title?: unknown; width?: unknown; height?: unknown; dataUrl?: unknown; cancelSeq?: unknown
      }
      // 用户关掉了出图弹窗：解除等待（只在 seq 对得上当前请求时才认，避免误取消后来的请求）。
      const cancelSeq = Number(data.cancelSeq)
      if (Number.isInteger(cancelSeq) && cancelSeq > 0) {
        if (state.exportRequest && state.exportRequest.seq === cancelSeq) {
          state.exportRequest = null
          state.exportError = '用户关闭了出图弹窗，本次出图已取消'
        }
        return void json(res, { ok: true })
      }
      const b64 = typeof data.dataUrl === 'string' ? data.dataUrl : ''
      if (!b64) return void jsonError(res, 400, '缺少 dataUrl')
      const decoded = decodeDataUrl(b64)
      if (!decoded) return void jsonError(res, 400, 'dataUrl 需为 image/png|jpeg|webp')
      const title = typeof data.title === 'string' ? data.title.slice(0, 120) : undefined
      const seqNum = Number(data.seq)
      const seq = Number.isInteger(seqNum) && seqNum > 0 ? seqNum : ++api.seqs.exportSeq
      const ref = await api.ctx.attachments.saveImage({ data: decoded.bytes, mediaType: decoded.mediaType, name: 'webgis-export' })
      const width = Number.isFinite(Number(data.width)) ? Math.max(0, Math.round(Number(data.width))) : 0
      const height = Number.isFinite(Number(data.height)) ? Math.max(0, Math.round(Number(data.height))) : 0
      state.exportImage = { id: seq, ref, width, height, title }
      if (state.exportRequest && state.exportRequest.seq === seq) state.exportRequest = null
      json(res, { ok: true, id: seq })
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '出图上传失败')
    }
  })()
}

export const handleAttachment: RouteHandler = (req, res, _url, _pathname, _sessionId, state, api) => {
  // 最近一次出图 PNG 下载（取字节，走附件存储；给外部/AI 使用）。
  return void (async () => {
    try {
      const img = state.exportImage
      if (!img) return void notFound(res, '还没有出图')
      const stored = await api.ctx.attachments.readImage(img.ref)
      const bytes = stored.data
      const fn = exportName(img.title && img.title.trim() ? img.title.trim() : 'webgis-export', 'png')
      download(res, bytes, fn.ascii, fn.utf8enc, 'image/png')
    } catch (err) {
      return void jsonError(res, 500, err instanceof Error ? err.message : '读取出图失败')
    }
  })()
}
