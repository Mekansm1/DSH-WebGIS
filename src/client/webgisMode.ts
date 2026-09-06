/**
 * GIS 对话模式状态：per-session 模式 + 为新对话暂存的 pending。
 * 单 bundle 内的模块级 store（本插件所有组件共享同一模块实例），
 * 用 useSyncExternalStore 订阅。状态为临时内存态，不持久化。
 */
import { useSyncExternalStore } from 'react'

export type WebgisMode = 'traditional' | 'gis'
export type SessionId = string

interface ModeState {
  /** 已定模式的会话 → 模式 */
  modes: Record<SessionId, WebgisMode>
  /** 尚未绑定会话的模式（新对话暂存，作用于下一个会话） */
  pending: WebgisMode | null
}

let state: ModeState = { modes: {}, pending: null }
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

export const webgisModeStore = {
  getSnapshot(): ModeState {
    return state
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
  getMode(sessionId: string | undefined): WebgisMode | null {
    if (sessionId && state.modes[sessionId]) return state.modes[sessionId]
    return state.pending
  },
  setMode(sessionId: string | undefined, mode: WebgisMode): void {
    state = sessionId
      ? { ...state, modes: { ...state.modes, [sessionId]: mode } }
      : { ...state, pending: mode }
    emit()
  },
  /** 清除某会话的模式（离开空白会话时调用，使其下次重新选择）。 */
  clearMode(sessionId: string): void {
    if (!state.modes[sessionId]) return
    const modes = { ...state.modes }
    delete modes[sessionId]
    state = { ...state, modes }
    emit()
  },
}

/** React hook：读某会话（或暂存）的模式。 */
export function useWebgisMode(sessionId: string | undefined): WebgisMode | null {
  return useSyncExternalStore(
    webgisModeStore.subscribe,
    () => webgisModeStore.getMode(sessionId),
  )
}
