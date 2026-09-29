/**
 * host 侧等待/轮询辅助：文本块构造、延时与两类「等客户端回传」的轮询等待器。
 * 拆分自 src/index.ts：模块级无状态工具，仅依赖 dsh-llm/dsh-attachment 类型与 session-state 类型。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { BasemapExportResult, PickState, WebgisState } from './session-state.js'

/** 每类元素在模型侧渲染为一条文本。 */
export function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** 等待截图回传的最长时间 / 轮询步长。 */
export const CAPTURE_WAIT_MS = 10000
export const POLL_STEP_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 「等客户端回传」类超时的**成因诊断**片段。
 *
 * 这类超时原先只有一句"超时"，把三种完全不同的成因混成一句 —— 而它们的处置毫无共同点：
 *   ① 客户端根本没挂载（从未拉过状态）→ 让用户去开 GIS 模式
 *   ② 客户端掉线/关了界面（很久没拉）→ 让用户看界面是否还在
 *   ③ 客户端在正常轮询却没完成这一步 → 问题在它自己，该去查浏览器控制台
 * 现在按心跳（`WebgisState.lastClientPollAt`）如实说出来，用户和模型都不用猜。
 */
function clientLiveness(state: WebgisState, anonPolledAt?: number | null): string {
  const t = state.lastClientPollAt
  if (t == null) {
    // 本会话桶从未被轮询。要区分两种成因，它们的处置完全不同：
    //   ① 客户端根本没连上 → 让用户去开 GIS 模式
    //   ② 客户端已连上、但**没关联到本会话**（落到了 anon 桶）→ 让用户先打开/选中一个对话
    // ②正是 0.1.7 删掉 `SessionListState.current` 时的形态：客户端拿不到会话 id，只能轮询
    // `?session=`（空值），于是 host 把它归入 anon 桶，与本会话桶永不相通。实测踩过。
    if (anonPolledAt != null && Date.now() - anonPolledAt < 5000) {
      return '（客户端已连接但未关联到本会话 → 会话信息尚未就绪；请先打开一个对话，再重试）'
    }
    return '（客户端从未拉取过地图状态 → 地图界面没挂载，或当前不在 GIS 模式）'
  }
  const ago = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (ago > 5) return `（客户端已 ${ago} 秒没拉取地图状态 → 界面可能已关闭或掉线）`
  return `（客户端 ${ago} 秒前仍在正常轮询 → 请求已送达，是它没能完成这一步；请看浏览器控制台的报错）`
}

/**
 * 请求客户端捕获当前地图视图（图框中心）并等待回传：
 * 置 state.capture 让客户端轮询看到 → 等客户端 POST 带 captureSeq 的 pick。
 * 返回成功（pick）或失败原因；任何出口都会清掉 state.capture（幂等）。
 */
/** 供 host 侧单测直接构造测试状态使用（仅此用途；exported for tests）。 */
export async function awaitCurrentViewCapture(
  state: WebgisState,
  seq: number,
  waitMs: number = CAPTURE_WAIT_MS,
  anonPolledAt?: number | null,
): Promise<{ ok: true; pick: PickState } | { ok: false; message: string }> {
  state.capture = { seq }
  state.captureError = null
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(POLL_STEP_MS)
    if (state.captureError) {
      const err = state.captureError
      state.capture = null
      state.captureError = null
      return { ok: false, message: `当前视图截图失败：${err}` }
    }
    if (state.pick?.captureSeq === seq) {
      state.capture = null
      return { ok: true, pick: state.pick }
    }
  }
  state.capture = null
  return { ok: false, message: `当前视图截图超时（请确保地图在 GIS 模式可见，或点击地图后再询问）${clientLiveness(state, anonPolledAt)}` }
}

/** 出图结果等待上限（出图含用户弹窗确认/合成，放宽到 60s）。 */
export const EXPORT_WAIT_MS = 60000

/** 底图要素提取的等待上限（纯内存操作，不该慢；留足客户端慢帧的余量）。 */
export const BASEMAP_WAIT_MS = 15000

/**
 * 等待客户端完成一次「底图矢量要素提取」并回传（配合 webgis_export_basemap 使用）：
 * 工具先把 basemapRequest 置为 { seq, params }，客户端轮询 state 看到后按当前视窗提取，
 * 再 POST /webgis/basemap-extract 带回同 seq。
 *
 * 三个出口：拿到结果 / 客户端报告失败（basemapError，立即返回）/ 超时。
 */
/** 供 host 侧单测直接构造测试状态使用（仅此用途；exported for tests）。 */
export async function awaitBasemapExtraction(
  state: WebgisState,
  seq: number,
  waitMs: number = BASEMAP_WAIT_MS,
  anonPolledAt?: number | null,
): Promise<{ ok: true; result: BasemapExportResult } | { ok: false; message: string }> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(POLL_STEP_MS)
    const r = state.basemapResult
    if (r && r.id === seq) {
      state.basemapRequest = null
      state.basemapError = null
      return { ok: true, result: r }
    }
    if (state.basemapError) {
      const message = state.basemapError
      state.basemapRequest = null
      state.basemapError = null
      return { ok: false, message }
    }
  }
  state.basemapRequest = null
  return { ok: false, message: `等待底图要素提取超时（请确认地图在 GIS 模式可见，且当前底图是矢量底图）${clientLiveness(state, anonPolledAt)}` }
}

export type ExportWaitResult =
  | { ok: true; image: { id: number; ref: ImageAttachmentRef; width: number; height: number; title?: string } }
  | { ok: false; message: string }

/**
 * 等待客户端完成一次出图并回传（配合 webgis_export_map 使用）：
 * 工具先把 exportRequest 置为 { seq, params }（客户端弹窗预填），再调本函数等
 * 客户端 POST /webgis/export-image 带回同 seq。
 *
 * 三个出口：拿到图 / 用户关掉弹窗（state.exportError，立即返回）/ 超时。
 * 中间那个出口是补的：原先只认「拿到图」，用户点了下载并关闭弹窗时 host 只能干等到超时，
 * 表现为工具卡住，模型还会再劝用户点一次按钮。
 */
/** 供 host 侧单测直接构造测试状态使用（仅此用途；exported for tests）。 */
export async function awaitExportCompletion(
  state: WebgisState,
  seq: number,
  waitMs: number = EXPORT_WAIT_MS,
  anonPolledAt?: number | null,
): Promise<ExportWaitResult> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(POLL_STEP_MS)
    const img = state.exportImage
    if (img && img.id === seq) {
      state.exportRequest = null
      state.exportError = null
      return { ok: true, image: img }
    }
    if (state.exportError) {
      const message = state.exportError
      state.exportRequest = null
      state.exportError = null
      return { ok: false, message }
    }
  }
  state.exportRequest = null
  return { ok: false, message: `等待出图超时（用户未在出图弹窗确认）。不要反复重试，先问用户是否要继续出图。${clientLiveness(state, anonPolledAt)}` }
}
