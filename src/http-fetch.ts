/**
 * SSRF 防护的数据抓取层：供 `webgis_load_dataset` 加载 http(s) 数据集时使用。
 *
 * 修复「任意 http(s) 地址可被读取」的 SSRF 面：
 * - 解析主机名并对**每个**解析出的 IP 做内网/回环/链路本地/保留地址黑名单，
 *   命中任一即拒绝（防止读取云元数据 169.254.169.254、内网服务、自身宿主等）；
 * - 手动控制重定向（最多 MAX_REDIRECTS 跳，每跳重新做一次 IP 检查——防跟随
 *   重定向逃逸到内网）；拒绝 `location` 指向被禁地址的跳转；
 * - 拒绝 HTML 内容类型（登录页/错误页/门户页常以 text/html 返回，是内网探测的
 *   典型信号）；
 * - 大小上限 + 超时（与既有 32MB 上限一致）。
 *
 * 纯函数 `isBlockedIp` 导出供单测。
 */
import dns from 'node:dns/promises'
import { isIP } from 'node:net'

/** 重定向最大跳数（0 = 不跟随）。 */
export const MAX_REDIRECTS = 3

/**
 * 某 IP 地址是否属于不可访问范围（内网/回环/链路本地/保留/组播）。
 * 支持 IPv4、IPv6、IPv4-mapped IPv6（::ffff:a.b.c.d）。
 */
export function isBlockedIp(ip: string): boolean {
  // IPv4-mapped IPv6：解包后按 IPv4 规则判断
  if (ip.startsWith('::ffff:')) return isBlockedIp(ip.slice(7))
  if (ip === '::1' || ip === '::') return true // 回环 / 未指定
  if (ip.startsWith('fe80:') || ip.startsWith('fe9:') || ip.startsWith('fea:') || ip.startsWith('feb:')) return true // 链路本地
  if (/^f[cd][0-9a-f]/i.test(ip)) return true // fc00::/7 ULA
  if (ip.includes('.')) {
    // IPv4 点分；IPv6 未命中上述范围（公网）放行
  } else {
    return false
  }
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const a = parts[0] ?? 0
  const b = parts[1] ?? 0
  if (a === 0) return true // 0.0.0.0/8
  if (a === 10) return true // 10/8 私网
  if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 运营商级 NAT
  if (a === 127) return true // 127/8 回环
  if (a === 169 && b === 254) return true // 169.254/16 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 私网
  if (a === 192 && b === 168) return true // 192.168/16 私网
  if (a === 198 && (b === 18 || b === 19)) return true // 198.18/15 基准测试
  if (a >= 224) return true // 224/4 组播 + 240/4 保留 + 广播
  return false
}

/** 校验目标主机可访问：IP 字面量直接判黑名单；主机名解析后逐 IP 判黑名单。 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const ipKind = isIP(hostname)
  if (ipKind !== 0) {
    if (isBlockedIp(hostname)) throw new Error(`目标地址被拒绝（内网/回环地址 ${hostname}）`)
    return
  }
  let addrs: Array<{ address: string }>
  try {
    addrs = await dns.lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new Error(`域名解析失败: ${hostname}`)
  }
  if (addrs.length === 0) throw new Error(`域名解析失败: ${hostname}`)
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error(`目标地址被拒绝（内网/回环地址 ${address}）`)
  }
}

export interface FetchDataOptions {
  /** 响应体大小上限（字节）。 */
  maxBytes: number
  /** 单请求超时（毫秒），默认 15000。 */
  timeoutMs?: number
  /** 是否拒绝 HTML 内容类型，默认 true。 */
  rejectHtml?: boolean
}

export interface FetchDataResult {
  buffer: Buffer
  /** 响应 Content-Type（去除参数、小写）；缺失为空串。 */
  contentType: string
  /** 最终 URL（跟随重定向后）。 */
  finalUrl: string
}

/** 需要按 data URL 后缀检查的格式；只放行数据类 Content-Type，HTML 一律拒绝。 */
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])

/**
 * SSRF 安全地抓取 http(s) URL 为字节流：逐跳 IP 检查 + 手动重定向 + 内容类型过滤。
 */
export async function fetchData(url: string, opts: FetchDataOptions): Promise<FetchDataResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http(s) URL')
  const rejectHtml = opts.rejectHtml !== false
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL
    try {
      u = new URL(current)
    } catch {
      throw new Error('URL 不合法')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('仅支持 http(s) URL')
    await assertPublicHost(u.hostname)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15000)
    let res: Response
    try {
      res = await fetch(current, { redirect: 'manual', signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      await res.body?.cancel().catch(() => {})
      if (!loc) throw new Error('重定向缺少 Location 头')
      current = new URL(loc, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} 获取失败`)
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (rejectHtml && HTML_TYPES.has(contentType)) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`拒绝 HTML 响应（可能被重定向到登录页/错误页）: ${contentType}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength > opts.maxBytes) throw new Error(`数据超过 ${Math.round(opts.maxBytes / 1024 / 1024)}MB 上限`)
    return { buffer: buf, contentType, finalUrl: current }
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 跳`)
}
