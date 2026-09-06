/**
 * deck 懒 chunk 入口（首个 deck 渲染图层出现才 load）：deck.gl 特效 + 大图层 arrow 渲染运行时。
 * 这里值 import DeckController → 把 deck.gl / deck-charts / geoarrow-charts / apache-arrow 全部
 * 打进 deck.js；MapView（gis chunk）只经 ensure('deck') 的 createDeckController 工厂拿控制器实例，
 * 不再静态值引用本运行时。
 */
import { registerChunk } from '../chunk-loader.js'
import { DeckController, type DeckControllerHost } from '../deck/controller.js'

/** DeckController 工厂：MapView 经 ensure('deck') 取到后调用（host 回调由 MapView 构造传入）。 */
export const createDeckController = (host: DeckControllerHost): DeckController => new DeckController(host)

const deckApi = { createDeckController }
registerChunk('deck', deckApi)
export default deckApi
