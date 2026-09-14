/**
 * GIS 客户端共享类型（纯类型模块：无任何运行时 import，编译期整体擦除）。
 *
 * MapView 里需要跨模块标注的类型集中放这里（DisplayMode / LayerSummary / FeaturePayload）。
 * 供 deck 控制器与 MapView 共享，避免把 gis 层类型拉进 deck 层造成循环/重复定义。
 */

/** 与 host 端 geo-processing 的 DisplayMode 一致。points/plane/hex=maplibre；arc/trips/wall/radial=deck.gl。 */
export type DisplayMode = 'points' | 'plane' | 'hex' | 'arc' | 'trips' | 'wall' | 'radial'

/**
 * 与 host 端 thematic.ts 的 ThematicSpec 一致（**手写镜像，两边改一处要改两处**）。
 *
 * 不 import host 模块：那会把 thematic → geo-stats → turf 整条链拖进 gis chunk。
 * 客户端只做「值 → 颜色」的查表，断点与颜色全部由 host 算好。
 */
export interface ThematicSpec {
  field: string
  method: 'jenks' | 'quantile' | 'equal' | 'category'
  /** 长度 = breaks.length + 1（数值）或 = categories.length（分类）。 */
  colors: string[]
  /** 数值型：升序内部分界点。 */
  breaks: number[]
  /** 分类型：与 colors 一一对应的取值。 */
  categories?: string[]
  /** 该字段没有值的要素数（单独用中性灰画）。 */
  missing: number
  /** 断点基于抽样的有效值数（仅 jenks 大图层会出现）。 */
  sampledFrom?: number
  ramp: string
}

/** 与 host 端 thematic.ts 的 NO_DATA_COLOR 一致：缺值专用中性灰，永不参与色带。 */
export const NO_DATA_COLOR = '#9ca3af'

/** 与 host 端 geo-processing 的 LayerSummary 一致。 */
export interface LayerSummary {
  id: string
  name: string
  featureCount: number
  bbox: [number, number, number, number] | null
  visible: boolean
  color: string
  rev: number
  source: string
  geometryTypes: string[]
  /** 是否用 supercluster 聚合渲染（仅点要素）。 */
  cluster: boolean
  /** 展示方式；切换不 bump rev（纯展示变更）。 */
  mode: DisplayMode
  /** deck.gl 出图数值参数（radius/height/width/speed/trail）。 */
  modeParams?: Record<string, number>
  /** 点位大小（像素，circle-radius）。 */
  pointRadius?: number
  /** 外轮廓粗细（像素，点描边 + 面边界线宽）。 */
  pointStrokeWidth?: number
  /** 内填充颜色（覆盖 color 用于填充）。 */
  fillColor?: string
  /** 专题配色（按字段上色）；设置时覆盖 color/fillColor 的填充语义。 */
  thematic?: ThematicSpec
  /** 真实总行数（duckTable 图层 = 内存表行数；图层面板据此显示「共 N 行」抽样标注）。 */
  totalCount?: number
  /** 是否已全量物化（false = geojson 只是抽样，真数据在 duckTable/Arrow 路由）。 */
  materialized?: boolean
  /** 渲染引擎决策（host 算好）：deck = 走 deck 原始数据/特效；maplibre = 走 maplibre 聚合/图层。 */
  renderer?: 'maplibre' | 'deck'
  /** 数据形态：arrow = 走 /webgis/arrow 二进制（大文件 deck 点图层）；geojson = 现有 GeoJSON 拉取。 */
  dataFormat?: 'geojson' | 'arrow'
}

/** 与 host 端 PickFeature 约定的要素 payload 结构。 */
export interface FeaturePayload {
  id: number | string | null
  layer: string
  source: string
  geometryType: string | null
  properties: Record<string, unknown>
}
