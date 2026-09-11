/**
 * 底图矢量要素导出工具（webgis_export_basemap）。
 *
 * 用户说「把当前范围的地图数据导出来 / 导出地图上的河流」→ 本工具从**底图矢量瓦片**里
 * 取出真实要素，落成一个可分析、可链式操作的结果图层。
 *
 * 分工（与插件其他能力一致）：
 * - 模型：把用户的说法映射到 source-layer（"河流"→waterway），以及可选的名字/类目过滤。
 * - 程序：提取、去重、按名字归组、产出图层。几何全部来自瓦片数据，模型不"估"任何坐标。
 *
 * 边界（"我们不是爬虫"）：只覆盖**当前视窗、当前 zoom 已加载的瓦片**，不主动多取、不跨级取。
 * 因此它是"把你在图上看到的变成图层"，不是批量导出；要全量数据请走文件导入
 * （Geofabrik 的 OSM 提取 / Overpass API → webgis_load_dataset）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { FeatureCollection } from 'geojson'
import { BASEMAP_LAYERS, basemapLayerCatalog, resolveBasemapLayer } from './basemap-layers.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

export function registerBasemapTools(ctx: Context, rt: GeoToolRuntime): void {
  const { COMMON, REMINDER, LAYER_RESULT_SCHEMA, text, hooks } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_export_basemap',
    description: COMMON
      + '【导出当前视野的底图数据】把当前地图视野内的**底图矢量要素**取出为新图层，可继续做分析（算长度/面积、做缓冲、空间叠加等）。'
      + `内置图层：${basemapLayerCatalog()}。`
      + 'layer 传用户的说法即可（如"河流""道路""建筑""公园"），会映射到对应的底图图层。'
      + '可选：name 按名字筛选（如只要"白浪河"，河流/公园/POI 带名字）；classes 按类目筛选（如只要 primary 道路）。'
      + '默认把同名要素归并成一个要素（同一条河在瓦片里是分段存储的，归并后"白浪河"=1 个要素）。'
      + '⚠️ 前提：当前底图必须是**矢量底图**（OpenFreeMap Liberty / Carto Positron / Carto Voyager / Carto Dark）；'
      + '光栅底图（默认的 Carto 浅色、Esri 影像）没有矢量数据可提取。'
      + '⚠️ 范围仅限**当前视野**（所见即所得），不用于批量导出大范围数据 —— 那请让用户用 Geofabrik/Overpass 取数据后走 webgis_load_dataset 导入。'
      + '⚠️ 道路图层（transportation）**不带路名**（路名在另一个图层），所以按名字筛路无效，按 classes 筛可以。',
    parameters: {
      layer: { type: 'string', required: true, description: '要导出的底图图层（用户说法或图层名，如 河流 / waterway / 道路 / 建筑 / 公园 / 水系）' },
      name: { type: 'string', description: '只导出名字包含该串的要素（如 白浪河）。河流/公园/POI 支持；道路不支持' },
      classes: { type: 'json', description: '只导出这些类目，字符串数组（如 ["river","canal"] 或 ["primary","secondary"]）。留空=全部' },
      group: { type: 'boolean', description: '是否把同名要素归并成一个要素，默认 true（同一条河归成 1 个）。false=保留瓦片分段' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { pushResult } = rt.sess(exec)
      const spec = resolveBasemapLayer(typeof args.layer === 'string' ? args.layer : '')
      if (!spec) {
        return Promise.resolve({
          ok: false,
          message: `认不出要导出哪个图层：「${String(args.layer)}」。可选：${basemapLayerCatalog()}。`
            + '请换成上面其中一个名字，或先问用户要导出什么。',
        })
      }
      if (!hooks?.exportBasemapFeatures) {
        return Promise.resolve({ ok: false, message: '底图要素导出不可用（插件未接线）' })
      }
      if (typeof args.name === 'string' && args.name && !spec.hasName) {
        return Promise.resolve({
          ok: false,
          message: `「${spec.name}」图层不带名字属性，无法按 name 筛选。`
            + (spec.sourceLayer === 'transportation' ? '路名在另一个图层（transportation_name）。可以用 classes 按道路等级筛选。' : '请去掉 name 参数或换一个带名字的图层。'),
        })
      }
      const classes = Array.isArray(args.classes)
        ? args.classes.filter((c): c is string => typeof c === 'string')
        : undefined
      return hooks.exportBasemapFeatures(exec.agent?.id, {
        sourceLayer: spec.sourceLayer,
        ...(typeof args.name === 'string' && args.name ? { name: args.name } : {}),
        ...(classes && classes.length ? { classes } : {}),
        ...(typeof args.group === 'boolean' ? { group: args.group } : {}),
      }).then((res) => {
        if (!res.ok) return { ok: false, message: res.message }
        const r = res.result
        const geojson = r.geojson as unknown as FeatureCollection
        const out = pushResult(`底图-${spec.name}`, geojson, spec.name)
        const names = r.names.length ? `\n名字：${r.names.join('、')}${r.names.length >= 40 ? '…' : ''}` : ''
        const cls = Object.keys(r.classes).length
          ? `\n类目：${Object.entries(r.classes).map(([k, v]) => `${k} ${v}`).join('、')}`
          : ''
        return {
          ...out,
          message: `${out.message}。从底图图层「${spec.sourceLayer}」按当前视野提取：`
            + `原始 ${r.rawCount} 个 → 去重 ${r.dedupedCount} 个 → ${r.featureCount} 个要素`
            + `${typeof args.group === 'boolean' && !args.group ? '（未归并）' : '（同名已归并）'}。`
            + `${names}${cls}\n这是当前视野的底图数据副本，可直接用 webgis_layer_info / 统计工具 / 缓冲等继续分析。`
            + `${REMINDER}`,
        }
      })
    },
  }))
}
