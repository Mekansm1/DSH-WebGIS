/**
 * 底图矢量瓦片的图层目录：把用户的说法（"河流"）映射到 MVT 的 source-layer（`waterway`）。
 *
 * source-layer 名单取自实测：Carto（source id `carto`）与 OpenFreeMap（`openmaptiles`）
 * 都用 OpenMapTiles schema，图层名一致。两家的 `maxzoom` 都是 14。
 *
 * ⚠️ 道路的名字**不在** `transportation` 里 —— OpenMapTiles 把几何与路名拆成两个图层
 * （`transportation` 带 class 无 name，`transportation_name` 带 name）。按名字选路要跨图层匹配；
 * 河流没这个问题（`waterway` 自带 name）。
 */

export interface BasemapLayerSpec {
  /** MVT 的 source-layer 名。 */
  sourceLayer: string
  /** 中文名（工具描述里列给模型看）。 */
  name: string
  /** 用户可能的说法。 */
  aliases: string[]
  /** 常见几何类型。 */
  geometry: 'line' | 'polygon' | 'point' | 'mixed'
  /** 常见 class 取值（供可选过滤）。 */
  classes?: string[]
  /** 该图层是否带 name 属性（决定能否按名字筛选）。 */
  hasName: boolean
  note?: string
}

export const BASEMAP_LAYERS: BasemapLayerSpec[] = [
  {
    sourceLayer: 'waterway',
    name: '河流/水道',
    aliases: ['河流', '河', '水道', '水系', '河道', '运河', '水渠', '干渠', 'river', 'waterway', '溪流'],
    geometry: 'line',
    classes: ['river', 'canal', 'stream', 'drain', 'ditch'],
    hasName: true,
  },
  {
    sourceLayer: 'water',
    name: '水体面',
    aliases: ['水体', '湖', '湖泊', '水库', '水面', '池塘', '海', 'water', 'lake'],
    geometry: 'polygon',
    classes: ['river', 'lake', 'pond', 'ocean', 'reservoir'],
    hasName: true,
    note: '河流的**面状**部分（宽河段）在 water 里，线状中心线在 waterway 里；要完整水系建议两个都取',
  },
  {
    sourceLayer: 'transportation',
    name: '道路',
    aliases: ['道路', '路', '路网', '公路', '街道', '马路', '高速', '铁路', 'road', 'street', 'transportation'],
    geometry: 'line',
    classes: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'path', 'rail', 'transit'],
    hasName: false,
    note: '⚠️ 本图层**不带 name**（路名在 transportation_name 图层）。按路名筛选要另想办法；'
      + '按 class 筛选（如只要 primary）可以直接用。',
  },
  {
    sourceLayer: 'building',
    name: '建筑',
    aliases: ['建筑', '建筑物', '房子', '楼房', '房屋', 'building'],
    geometry: 'polygon',
    hasName: false,
  },
  {
    sourceLayer: 'park',
    name: '公园/绿地',
    aliases: ['公园', '绿地', '园林', 'park', 'green'],
    geometry: 'polygon',
    hasName: true,
  },
  {
    sourceLayer: 'landuse',
    name: '土地利用',
    aliases: ['用地', '土地利用', '地块', 'landuse'],
    geometry: 'polygon',
    hasName: false,
  },
  {
    sourceLayer: 'landcover',
    name: '地表覆盖',
    aliases: ['地表覆盖', '植被', '林地', '农田', 'landcover'],
    geometry: 'polygon',
    hasName: false,
  },
  {
    sourceLayer: 'boundary',
    name: '行政边界',
    aliases: ['边界', '行政边界', '辖区', '区界', 'boundary'],
    geometry: 'line',
    hasName: false,
    note: '按 admin_level 区分层级（中国常见 4=省 5=地级市 6=县区）',
  },
  {
    sourceLayer: 'poi',
    name: '兴趣点',
    aliases: ['兴趣点', 'poi', '设施', '地标', '景点', '医院', '学校', '商场'],
    geometry: 'point',
    hasName: true,
    classes: ['hospital', 'school', 'museum', 'park', 'restaurant', 'shop', 'attraction'],
  },
  {
    sourceLayer: 'aeroway',
    name: '机场/跑道',
    aliases: ['机场', '跑道', 'aeroway', 'airport'],
    geometry: 'line',
    hasName: false,
  },
]

/** 归一化：小写、去空格与常见分隔符。 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_/（）()·]/g, '')
}

/**
 * 按用户说法解析图层。优先精确匹配 source-layer 名，其次别名包含匹配。
 * 返回 null 表示没认出来（由调用方给出可选清单，而不是猜一个）。
 */
export function resolveBasemapLayer(query: string): BasemapLayerSpec | null {
  const q = normalize(query)
  if (!q) return null
  for (const spec of BASEMAP_LAYERS) if (normalize(spec.sourceLayer) === q) return spec
  let best: { spec: BasemapLayerSpec; score: number } | null = null
  for (const spec of BASEMAP_LAYERS) {
    for (const a of spec.aliases) {
      const n = normalize(a)
      if (n === q) return spec
      // 包含匹配：取更长的别名更可信（"河流" 命中而不是 "河"）
      if (q.includes(n) || n.includes(q)) {
        const score = Math.min(n.length, q.length)
        if (!best || score > best.score) best = { spec, score }
      }
    }
  }
  return best?.spec ?? null
}

/** 目录清单（一行一个，写进工具描述/错误提示里）。 */
export function basemapLayerCatalog(): string {
  return BASEMAP_LAYERS.map((s) => `${s.sourceLayer}（${s.name}）`).join('、')
}
