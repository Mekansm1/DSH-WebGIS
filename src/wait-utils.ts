/**
 * host 侧等待/轮询辅助：文本块构造、延时与两类「等客户端回传」的轮询等待器。
 * 拆分自 src/index.ts：模块级无状态工具，仅依赖 dsh-llm/dsh-attachment 类型与 session-state 类型。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PickState, WebgisState } from './session-state.js'

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
 * 请求客户端捕获当前地图视图（图框中心）并等待回传：
 * 置 state.capture 让客户端轮询看到 → 等客户端 POST 带 captureSeq 的 pick。
 * 返回成功（pick）或失败原因；任何出口都会清掉 state.capture（幂等）。
 */
/** 供 host 侧单测直接构造测试状态使用（仅此用途；exported for tests）。 */
export async function awaitCurrentViewCapture(
  state: WebgisState,
  seq: number,
  waitMs: number = CAPTURE_WAIT_MS,
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
  return { ok: false, message: '当前视图截图超时（请确保地图在 GIS 模式可见，或点击地图后再询问）' }
}

/** 出图结果等待上限（出图含用户弹窗确认/合成，放宽到 60s）。 */
export const EXPORT_WAIT_MS = 60000

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
  return { ok: false, message: '等待出图超时（用户未在出图弹窗确认）。不要反复重试，先问用户是否要继续出图。' }
}
