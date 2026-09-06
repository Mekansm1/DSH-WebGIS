/**
 * WebGIS 工具的启停 guard 谓词（供 `ctx.tools.guard()` 使用）。
 *
 * 插件关闭时，所有 `webgis_*` 工具调用在分发前被拒绝（deny），返回中文提示；
 * 其他插件的工具不受影响。guard 只按工具名前缀过滤，不需要改 37 个工具定义。
 */

import { isPluginEnabled } from './enabled.js'

export const WEBGIS_TOOL_DISABLED_MESSAGE =
  'WebGIS 插件已关闭：请到 设置→插件→WebGIS 插件配置 里开启后再使用'

/** tools.guard 谓词：插件关闭且目标是 webgis_* 工具 → 返回拒绝原因（否则 undefined）。 */
export function webgisToolGuardReason(exec: { name: string }): string | undefined {
  if (isPluginEnabled()) return undefined
  return exec.name.startsWith('webgis_') ? WEBGIS_TOOL_DISABLED_MESSAGE : undefined
}
