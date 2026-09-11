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
      + '**用户没指定具体图层时（如"导出当前范围的地图数据"）不要传 layer** —— 会导出全部内容图层并**按几何分成点/线/面三个结果图层**，这才是该需求的默认语义。'
      + '用户指定了某一类时才传 layer（如"河流""道路""建筑"），会映射到对应的底图图层，只出一个图层。'
      + '可选：name 按名字筛选（如只要"白浪河"，河流/公园/POI 带名字）；classes 按类目筛选（如只要 primary 道路）。'
      + '默认把同名要素归并成一个要素（同一条河在瓦片里是分段存储的，归并后"白浪河"=1 个要素）。'
      + '⚠️ 前提：当前底图必须是**矢量底图**（OpenFreeMap Liberty / Carto Positron / Carto Voyager / Carto Dark）；'
      + '光栅底图（默认的 Carto 浅色、Esri 影像）没有矢量数据可提取。'
      + '⚠️ 范围仅限**当前视野**（所见即所得），不用于批量导出大范围数据 —— 那请让用户用 Geofabrik/Overpass 取数据后走 webgis_load_dataset 导入。'
      + '⚠️ 道路图层（transportation）**不带路名**，按名字筛路无效；想要带路名的路请点名 transportation_name，或按 classes 筛等级。'
      + '⚠️ **底图瓦片按缩放级别裁剪**：级别越低图层越少（省级只有水系/主要道路/保护区/地名；'
      + 'POI、建筑、门牌号要放大到城市/街区级才有）。所以视野很广时点要素会很少，'
      + '这不是漏导 —— 结果里会提示哪些图层在该级别不存在，请把这点转告用户并建议放大后再导出。',
    parameters: {
      layer: { type: 'string', description: '要导出的底图图层（用户说法或图层名，如 河流 / waterway / 道路）。**用户没指定具体类别时省略** → 导出全部并分成点/线/面三个图层' },
      name: { type: 'string', description: '只导出名字包含该串的要素（如 白浪河）。河流/公园/POI 支持；道路不支持' },
      classes: { type: 'json', description: '只导出这些类目，字符串数组（如 ["river","canal"] 或 ["primary","secondary"]）。留空=全部' },
      group: { type: 'boolean', description: '是否把同名要素归并成一个要素，默认 true（同一条河归成 1 个）。false=保留瓦片分段' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { pushResult } = rt.sess(exec)
      const asked = typeof args.layer === 'string' ? args.layer.trim() : ''
      const spec = asked ? resolveBasemapLayer(asked) : null
      if (asked && !spec) {
        return Promise.resolve({
          ok: false,
          message: `认不出要导出哪个图层：「${asked}」。可选：${basemapLayerCatalog()}。`
            + '请换成上面其中一个名字；若用户没指定具体类别，省略 layer 参数即可导出全部（分点/线/面三个图层）。',
        })
      }
      if (!hooks?.exportBasemapFeatures) {
        return Promise.resolve({ ok: false, message: '底图要素导出不可用（插件未接线）' })
      }
      if (typeof args.name === 'string' && args.name && spec && !spec.hasName) {
        return Promise.resolve({
          ok: false,
          message: `「${spec.name}」图层不带名字属性，无法按 name 筛选。`
            + (spec.sourceLayer === 'transportation' ? '路名在 transportation_name 图层（点名它可导出带路名的道路）。可以用 classes 按道路等级筛选。' : '请去掉 name 参数或换一个带名字的图层。'),
        })
      }
      const classes = Array.isArray(args.classes)
        ? args.classes.filter((c): c is string => typeof c === 'string')
        : undefined
      return hooks.exportBasemapFeatures(exec.agent?.id, {
        ...(spec ? { sourceLayer: spec.sourceLayer } : {}),
        ...(typeof args.name === 'string' && args.name ? { name: args.name } : {}),
        ...(classes && classes.length ? { classes } : {}),
        ...(typeof args.group === 'boolean' ? { group: args.group } : {}),
      }).then((res) => {
        if (!res.ok) return { ok: false, message: res.message }
        const r = res.result
        const KIND_LABEL = { point: '点', line: '线', polygon: '面' } as const
        // 指定了图层 → 一个结果图层；未指定 → 按几何分成点/线/面（最多三个）
        const outs = r.groups.map((g) => ({
          kind: g.kind,
          out: pushResult(
            spec ? `底图-${spec.name}` : `底图-${KIND_LABEL[g.kind]}`,
            g.geojson as unknown as FeatureCollection,
            spec ? spec.name : `底图${KIND_LABEL[g.kind]}要素`,
          ),
        }))
        const first = outs[0]
        if (!first) return { ok: false as const, message: '底图要素提取结果为空（未生成任何图层）' }
        const total = r.groups.reduce((a, g) => a + g.featureCount, 0)
        const segments = r.groups.map((g) => `${KIND_LABEL[g.kind]} ${g.featureCount}`).join('、')
        const merged = typeof args.group === 'boolean' && !args.group ? '（未归并）' : '（同名已归并）'
        const names = r.names.length ? `\n名字：${r.names.join('、')}${r.names.length >= 40 ? '…' : ''}` : ''
        const cls = Object.keys(r.classes).length
          ? `\n类目：${Object.entries(r.classes).map(([k, v]) => `${k} ${v}`).join('、')}`
          : ''
        const head = spec
          ? `从底图图层「${spec.sourceLayer}」按当前视野导出：`
          : `按当前视野导出底图全部内容图层（取到 ${r.usedLayers.join('、')}），按几何分成 ${r.groups.length} 个图层：`
        // 底图瓦片按缩放级别裁剪：级别低时 POI / 建筑 等图层根本不存在。
        // 这会让"点"图层出奇地少 —— 不说明的话用户会以为是漏导了。
        const missing = r.missingLayers.filter((n) => ['poi', 'building', 'housenumber', 'aeroway'].includes(n))
        const zoomHint = !spec && missing.length
          ? `\nℹ 当前缩放级别较低，底图瓦片在该级别不含这些图层：${missing.join('、')}。`
            + '放大到城市/街区级别再导出，点要素会多很多。'
          : ''
        return {
          ...first.out,
          message: `${head}原始 ${r.rawCount} 个 → 去重 ${r.dedupedCount} 个 → ${total} 个要素${merged}。`
            + `\n生成图层：${outs.map((o) => `${o.out.layerId}（${KIND_LABEL[o.kind]} ${o.out.featureCount}）`).join('、')}`
            + (spec ? `（${segments}）` : '')
            + `${names}${cls}${zoomHint}${r.note ? `\n⚠ ${r.note}` : ''}`
            + '\n这是当前视野的底图数据副本，可直接用 webgis_layer_info / 统计工具 / 缓冲等继续分析。'
            + `${REMINDER}`,
        }
      })
    },
  }))
}
