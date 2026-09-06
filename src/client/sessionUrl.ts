/**
 * /webgis/* 请求附加会话 id 的辅助函数：host 按 `?session=<会话 id>` 把状态路由到
 * 该会话自己的地图状态（工具侧 exec.agent?.id 与客户端会话 id 是同一个键）。
 */
export function sessionUrl(sessionId: string | undefined, path: string): string {
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}session=${encodeURIComponent(sessionId ?? '')}`
}
