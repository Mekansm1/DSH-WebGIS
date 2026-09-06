/**
 * /webgis/* HTTP 层工具：JSON 响应、请求体读取、附件下载、浏览器信任围栏与静态资源白名单。
 * 拆分自 src/index.ts（原模块级函数与请求体上限常量）。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export function json(res: import('node:http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function jsonError(res: import('node:http').ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, message }))
}

/** pick 上报请求体上限：坐标 + 要素 + base64 截图（1024px PNG 通常 < 2MB，留足余量）。 */
export const MAX_PICK_BODY = 16 * 1024 * 1024

/** 图层面板操作请求体上限。 */
export const MAX_LAYER_ACTION_BODY = 64 * 1024
/** 导入请求体上限：base64 膨胀 4/3，解码后字节数另按 MAX_IMPORT_BYTES 限。 */
export const MAX_IMPORT_BODY = 48 * 1024 * 1024
/** 导入文件解码后的字节上限（与 loadShapefile / readDatasetText 一致）。 */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024

/** 附件下载文件名：Content-Disposition 需要 ASCII 兜底 + UTF-8 编码名。 */
export function exportName(name: string, ext: string): { ascii: string; utf8enc: string; sanitized: string; asciiBase: string } {
  const bad = new Set(['"', '\\', '/', ':', '*', '?', '<', '>', '|'])
  const cleaned = Array.from(name)
    .map((ch) => (bad.has(ch) || ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? '_' : ch))
    .join('')
    .trim()
  const sanitized = cleaned || 'layer'
  const asciiBase = Array.from(sanitized).map((ch) => (ch.charCodeAt(0) > 126 ? '_' : ch)).join('')
  return {
    ascii: `${asciiBase}.${ext}`,
    utf8enc: encodeURIComponent(`${sanitized}.${ext}`),
    sanitized,
    asciiBase,
  }
}

/** 以附件形式下载响应体。 */
export function download(
  res: import('node:http').ServerResponse,
  body: string | Uint8Array,
  asciiName: string,
  utf8enc: string,
  contentType: string,
): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8enc}`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读取请求体为 UTF-8 字符串，超限则拒绝（防止超大 body）。 */
export function readBody(req: import('node:http').IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function notFound(res: import('node:http').ServerResponse, message: string): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(message)
}

/** 读请求头为单字符串（数组/缺失返回 undefined）。 */
export function headerString(req: import('node:http').IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return typeof v === 'string' && v ? v : undefined
}

/** 主机名是否回环（localhost / [::1] / 127.x.x.x）。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  if (parts.length !== 4 || parts[0] !== '127') return false
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * /webgis/* 路由的浏览器信任围栏（对照 DSH /api 的 isTrustedApiRequest）：
 * - Host 头必须解析为回环地址（防 DNS rebinding——rebinding 时 Host 是攻击者域名）；
 * - sec-fetch-site: cross-site 直接拒绝（跨站请求，含跨站 POST 的 CSRF 面）；
 * - Origin 若存在必须等于请求主机（同源）；无 Origin（非浏览器/同源 GET）放行。
 */
export function isTrustedLocalRequest(req: import('node:http').IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || !host) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** 白名单静态资源服务（文件名固定；earcut-worker.js → earcut-worker.min.js 实际文件）。 */
export async function serveAsset(res: import('node:http').ServerResponse, file: string): Promise<void> {
  if (file !== 'maplibre-gl.css' && file !== 'maplibre-gl-csp-worker.js' && file !== 'earcut-worker.min.js'
    && file !== 'gis.js' && file !== 'deck.js' && file !== 'draw.js' && file !== 'export.js') {
    return notFound(res, 'forbidden asset')
  }
  const path = fileURLToPath(new URL(`../assets/${file}`, import.meta.url))
  try {
    const body = await readFile(path)
    const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'public, max-age=3600' })
    res.end(body)
  } catch {
    notFound(res, 'asset not found')
  }
}
