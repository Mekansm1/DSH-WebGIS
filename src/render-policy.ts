/**
 * 渲染路由策略（借鉴开源方案 §八：什么时候用 deck.gl、什么时候用 maplibre）。
 *
 * 硬规则（优先级最高）：
 * - 数据已是 Arrow → 只能 deck（maplibre-native 吃不了）；
 * - deck 特效模式（arc/trips/wall/radial）→ 恒 deck；
 * - supercluster 计数气泡 UI → 绑定 maplibre GeoJSON source（恒 maplibre）。
 * 其余按真实行数分档：>10 万强制 deck 原始点（GPU instancing 到 10^6~10^7 才吃力）；
 * 5万~10万交用户选择（默认存 maplibre，由工具层的 need_confirm 承担询问）；≤5 万 maplibre。
 */
import type { DisplayMode } from './geo-processing.js'

export type Renderer = 'maplibre' | 'deck' | 'user-choice'

export interface RenderSpec {
  /** 展示方式（DisplayMode）。 */
  mode: DisplayMode
  /** 真实行数（duckTable 总行数；不是 geojson.featureCount——未物化图层 geojson 只是抽样）。 */
  actualCount: number
  /** 是否已全量物化（有 duckTable → false：geojson 是抽样，真数据在内存表/Arrow 路由）。 */
  materialized: boolean
  /** 数据形态：arrow=有 Arrow 二进制路由（大文件图层）；geojson=只有 GeoJSON。 */
  dataFormat: 'geojson' | 'arrow'
  /** 是否必须 supercluster 聚合（用户显式 cluster:'on' 等）。 */
  needSupercluster?: boolean
}

/** 缩放分级密度阈值表：zoom ≤ 各档 → 对应抽样条数；高于最后一档 → 全量。
 *  低缩放只渲染少量点（省 GPU/内存），随 zoom 放大逐级加密度，高缩放拉全量。可在此调档位。
 *  用户定档：初始 5 万 → 15 级 20 万 → 16 级 60 万 → 17 级以后全量。 */
const ZOOM_ARROW_TIERS: Array<[maxZoom: number, count: number]> = [
  [14, 50_000],
  [15, 200_000],
  [16, 600_000],
]

/** arrow 点图层按 zoom 的目标条数（min 收敛：小图层自然返回全量）。 */
export function arrowCountForZoom(zoom: number, totalCount: number): number {
  for (const [maxZoom, count] of ZOOM_ARROW_TIERS) {
    if (zoom <= maxZoom) return Math.min(count, totalCount)
  }
  return totalCount
}

/** 当前分档的下一档（用于预取预热）；当前已是全量返回 null。 */
export function nextArrowCount(current: number, totalCount: number): number | null {
  if (current >= totalCount) return null
  for (const [, count] of ZOOM_ARROW_TIERS) {
    if (count > current && count < totalCount) return count
  }
  return totalCount
}

/** 超过此真实行数强制 deck 原始点。 */
export const DECK_FROM = 100_000
/** 超过此真实行数进入「用户选择」灰色地带（默认存 maplibre）。 */
export const CHOICE_FROM = 50_000

/** deck.gl 专属特效模式（maplibre 做不了），恒走 deck。 */
export const DECK_EFFECT_MODES: ReadonlySet<DisplayMode> = new Set(['arc', 'trips', 'wall', 'radial'])

export function pickRenderer(spec: RenderSpec): Renderer {
  if (spec.dataFormat === 'arrow') return 'deck' // 硬规则：Arrow 只能 deck
  if (DECK_EFFECT_MODES.has(spec.mode)) return 'deck' // 硬规则：deck 专属效果
  if (spec.needSupercluster) return 'maplibre' // 硬规则：supercluster 绑定 maplibre GeoJSON source
  if (spec.actualCount > DECK_FROM) return 'deck' // >10 万 强制 deck 原始点
  if (spec.actualCount > CHOICE_FROM) return 'user-choice' // 5万~10万 交用户
  return 'maplibre' // 默认
}
