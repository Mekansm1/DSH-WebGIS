/**
 * draw 懒 chunk 入口（面板「创建」展开才 load）：Terra Draw 绘图工具条。
 * registerChunk 与具名导出双通道（loader require 取回的是具名导出模块；自注册兜底）。
 */
import { registerChunk } from '../chunk-loader.js'
import { DrawToolbar } from '../DrawToolbar.js'

const drawApi = { DrawToolbar }
registerChunk('draw', drawApi)
export { DrawToolbar }
export default drawApi
