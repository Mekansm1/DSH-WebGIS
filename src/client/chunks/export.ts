/**
 * export 懒 chunk 入口（打开出图弹窗才 load）：ExportMapDialog + 浏览器合成。
 * registerChunk 与具名导出双通道（loader require 取回的是具名导出模块；自注册兜底）。
 */
import { registerChunk } from '../chunk-loader.js'
import { ExportMapDialog } from '../ExportMapDialog.js'

const exportApi = { ExportMapDialog }
registerChunk('export', exportApi)
export { ExportMapDialog }
export default exportApi
