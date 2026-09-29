/**
 * 客户端 → host 的 JSON 回传，**失败时把原因也送回去**。
 *
 * ## 为什么需要
 *
 * 「等客户端回传」类的工具（`webgis_get_pick` / `webgis_export_basemap` / `webgis_export_map`）
 * 在 host 侧是轮询等待：拿到回传就成功，拿到 `{ok:false}` 就立刻返回一条带原因的错误，都没有就干等到超时。
 *
 * 而回传本身可能失败：
 *   - 体积被拒（截图 base64 可达 MB 级 → 413）
 *   - 路由不对（404）
 *   - 网络中断 / 宿主已退出
 *
 * 原先这些失败有两种坏处理：`recordPick` 是 `fetch(...).catch(() => {})` 完全静默；
 * 底图那条只 `console.warn`。两者都让 host 侧只剩一句「超时」——
 * 排查时无法区分「客户端不在」「回传被拒」「操作本身失败」，实测正是卡在这里。
 *
 * ## 做法
 *
 * 失败后用**一个独立的小请求**把原因送回去（`{ok:false, message}`，正是
 * `routes-pick.ts` / `routes-basemap.ts` 已有的失败分支）。用独立小请求而非重发原请求：
 * 大请求若因体积被拒，小请求仍能送达 —— 这正是我们要区分的那一类失败。
 */
import { sessionUrl } from './sessionUrl.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

/** 把失败原因回传 host（小请求；宿主机已断时静默放弃）。 */
export async function reportFailure(
  path: string,
  sessionId: string | undefined,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(sessionUrl(sessionId, path), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ok: false, message, ...extra }),
    })
  } catch {
    // 连失败上报都发不出去：只能留给 host 侧的轮询心跳诊断（见 wait-utils 的 clientLiveness）。
  }
}

/**
 * POST 一段 JSON；成功即返回，失败则用 {@link reportFailure} 把 HTTP 状态或网络错误送回 host。
 *
 * @param extra 失败上报时额外携带的字段（如底图的 `seq`）。
 */
export async function postJsonReportingFailure(
  path: string,
  sessionId: string | undefined,
  payload: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    const res = await fetch(sessionUrl(sessionId, path), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    })
    if (res.ok) return
    await reportFailure(path, sessionId, `回传失败：HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`, extra)
  } catch (err) {
    await reportFailure(path, sessionId, `回传失败：${err instanceof Error ? err.message : String(err)}`, extra)
  }
}
