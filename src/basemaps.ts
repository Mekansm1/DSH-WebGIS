/**
 * 底图目录 + 切换决策（纯函数，host 侧编译，客户端经 bundle 边界复用）。
 *
 * 编码策略：内置矢量底图只选「自带 maplibre 兼容 v8 style.json + MVT 瓦片」的图源，
 * 切换时 `map.setStyle(styleUrl)` 让图源自带样式渲染自家瓦片——图层 schema / extent 差异
 * 由图源自洽 + maplibre 读瓦片内 extent 自动适配。影像底图为光栅瓦片，只换瓦片 URL。
 */

export interface BaseMapDef {
  id: string
  name: string
  /** 切换器分组：矢量 = 街道/矢量样式；影像 = 卫星/光栅。 */
  category: '矢量' | '影像'
  /** raster = 光栅瓦片（换 base 源瓦片 URL，或重载光栅样式）；style = 矢量瓦片样式（setStyle URL）。 */
  kind: 'raster' | 'style'
  /** 瓦片模板 URL 或 style.json URL；`default` 条目留空，apply 时用 config.baseTileUrl 填入。 */
  url: string
  tileSize?: number
  attribution?: string
}

export const BASE_MAPS: BaseMapDef[] = [
  // ---- 矢量（街道 / 矢量瓦片样式） ----
  { id: 'default', name: 'Carto 浅色（默认）', category: '矢量', kind: 'raster', url: '' },
  { id: 'carto-positron', name: 'Carto Positron', category: '矢量', kind: 'style', url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' },
  { id: 'carto-dark', name: 'Carto Dark Matter', category: '矢量', kind: 'style', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { id: 'carto-voyager', name: 'Carto Voyager', category: '矢量', kind: 'style', url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json' },
  { id: 'openfreemap-liberty', name: 'OpenFreeMap Liberty', category: '矢量', kind: 'style', url: 'https://tiles.openfreemap.org/styles/liberty' },
  // ---- 影像（光栅卫星） ----
  { id: 'esri-imagery', name: 'Esri 全球影像', category: '影像', kind: 'raster', url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', tileSize: 256 },
]

export type BaseMapAction =
  | { kind: 'setTiles'; url: string }
  | { kind: 'setStyleRaster'; url: string }
  | { kind: 'setStyleUrl'; url: string }

/** 依据底图定义与当前是否已有 `base` 光栅源，决定切换动作。 */
export function baseMapAction(def: BaseMapDef, hasBaseSource: boolean): BaseMapAction {
  if (def.kind === 'style') return { kind: 'setStyleUrl', url: def.url }
  return hasBaseSource
    ? { kind: 'setTiles', url: def.url }
    : { kind: 'setStyleRaster', url: def.url }
}
