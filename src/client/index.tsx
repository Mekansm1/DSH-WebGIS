import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// 加载 SlotMap 增强：shell.overlay / conversation.* / settings.* 等 slot 键的类型声明
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { GisSurface } from './GisSurface.js'
import { WebgisConfigCard } from './WebgisConfigCard.js'
import { installWebgisLocale, WEBGIS_NS } from './webgis-i18n.js'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // 注册插件词典命名空间 'webgis'（zh/en 成对）；须先于下面两个 slot 入口挂载——
  // 即便后到，LocaleRuntime.register 也会 bump revision 让已渲染入口重渲染。
  installWebgisLocale(ctx)

  // WebGIS 插件配置卡片（DSH 设置 → 插件 → WebGIS）：启停开关 + 视觉 + 数据库，合并为一张卡。
  // 同时传 id 与 key：不同 DSH 版本把 settings.plugin.item 声明为 list（要 id）或
  // keyed（要 key）——register 运行时按声明的 kind 取对应字段，二者兼容。
  // locale:'webgis'：声明后 DSH 渲染器注入随语言切换的 `t` prop。
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    id: 'webgis',
    key: 'webgis',
    order: 30,
    locale: WEBGIS_NS,
  } as { name: 'settings.plugin.item'; id: string; key: string; order?: number; locale: 'webgis' }, WebgisConfigCard))

  // 全帧地图 + 模式选择器（shell.overlay，root scope）。maplibre css 注入挪到 gis 懒 chunk
  // （进 GIS 模式才拉）；此文件不再静态引 MapView/maplibre。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-webgis-surface',
    locale: WEBGIS_NS,
  } as { name: 'shell.overlay'; id: string; locale: 'webgis' }, GisSurface))
}
