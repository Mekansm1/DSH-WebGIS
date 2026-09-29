import type { Context } from '@deepseek-ai/cordis'
// 仅类型副作用，加载三处模块增补（0.1.5 起 ClientContext 已随 dsh-client-runtime 撤销，直接用 cordis 的 Context）：
// - renderer/client：ctx.slots（槽位注册表）
// - session/client：GlobalStandardProps.useSessions（会话列表快照）
// - layout / conversation / settings-plugins：shell.overlay / conversation.* / settings.* 的 SlotMap 槽键
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// 0.1.7 起插件配置面走 settings.plugins.tab，**它的 SlotMap 声明在 ui-settings 里**
// （client/contract/slots.d.ts：kind 'list' / scope 'root'）；ui-settings-plugins 只渲染不声明。
// 官方注释说明该类型放这里的用意正是「让清单插件与配置插件互相不必依赖」——
// 所以本插件依赖 ui-settings 取类型，运行时仍由宿主提供该实例。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { GisSurface } from './GisSurface.js'
import { WebgisConfigCard } from './WebgisConfigCard.js'
import { installWebgisLocale, WEBGIS_NS } from './webgis-i18n.js'

// cordis 服务等待：slots（槽位注册表，由 dsh-client-ui-renderer 提供）与 locale（由
// dsh-client-locale 提供，实测 0.1.7 仍是 `.provide("locale", ...)`，名字没变）。
//
// ⚠️ package.json 的 dsh.client.inject 是「本客户端半区依赖哪些模块」的声明，宿主 loader 会用它
// 解析/排序模块工厂。0.1.7 起**不要再列不存在的包**：那里原有一项 `@deepseek-ai/dsh-client-runtime`
// （该包最后版本 0.1.1-rc.2，0.1.5 起 ClientContext 已从它撤销），旧注释写"多列一个无效名无害"，
// 那是 0.1.5 下的结论，未在 0.1.7 验证过；而 0.1.7 的有效插件（如 dsh-client-ui-settings-plugins）
// 列的**全是真实模块名**。可疑症状：客户端整体不挂载 → 从不拉取 /webgis/state → 工具侧一律超时。
// 现已移除该无效项。
export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  // 引导自述：客户端半区到底有没有跑起来，只有浏览器控制台知道。
  // 排障场景（0.1.7 下工具一律超时、host 侧看到 lastClientPollAt=null）需要区分
  // 「apply 没执行」/「apply 执行了但某个槽位没注册」/「槽位注册了但组件没渲染」——
  // 三行日志就能分辨；缺了任何一行，失败点立刻定位。噪音可忽略（每次加载各一条）。
  console.info('[webgis] client apply: begin')
  // 注册插件词典命名空间 'webgis'（zh/en 成对）；须先于下面两个 slot 入口挂载——
  // 即便后到，LocaleRuntime.register 也会 bump revision 让已渲染入口重渲染。
  // ⚠ 它是 apply 里第一个可能抛错的调用（LocaleRuntime.register 在**重复注册**同一
  // namespace+locale 时抛错），一抛就会带掉下面两个槽位 → 客户端整体不挂载。
  installWebgisLocale(ctx)
  console.info('[webgis] locale registered')

  // WebGIS 插件配置面（启停开关 + 视觉 + 数据库，合并为一张卡）。
  //
  // ⚠ 0.1.7 起 `settings.plugin.item` **已被移除**：那个槽在 0.1.5 里是「设置 → 插件 → 一张卡」，
  // 0.1.7 把该页改成**只读的内置插件清单**，官方 README（dsh-client-ui-settings-plugins）给出的
  // 迁移点是 `settings.plugins.tab`：
  //   「register into settings.plugins.tab with an id, an order, and a localized label;
  //     a lone contribution renders as the page itself.」
  // 所以这里从「注册一张卡」改为「注册一个 tab」。同页还有内置的只读清单 tab，因此实际会显示成
  // 一排 tab（清单 + WebGIS）。
  //
  // label 是**注册方自己本地化好的文本**，不是词典键（ui-settings 的槽注释：
  // "label (registrant-localized tab text)"）。取语言中立的 'WebGIS'，
  // 中英文下都正确；要随语言变化才需要按 locale 重注册（当前不需要）。
  //
  // locale: WEBGIS_NS → DSH 渲染器给该入口注入随语言切换的 `t` prop（卡片内部文案仍走词典）。
  ctx.slots.inject('settings.plugins.tab', () => (console.info('[webgis] settings tab registered'), ctx.slots.register({
    name: 'settings.plugins.tab',
    id: 'webgis',
    order: 30,
    label: 'WebGIS',
    locale: WEBGIS_NS,
  } as { name: 'settings.plugins.tab'; id: string; order: number; label: string; locale: 'webgis' }, WebgisConfigCard)))

  // 全帧地图 + 模式选择器（shell.overlay，root scope）。maplibre css 注入挪到 gis 懒 chunk
  // （进 GIS 模式才拉）；此文件不再静态引 MapView/maplibre。
  ctx.slots.inject('shell.overlay', () => (console.info('[webgis] overlay slot registered (map surface)'), ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-webgis-surface',
    locale: WEBGIS_NS,
  } as { name: 'shell.overlay'; id: string; locale: 'webgis' }, GisSurface)))
}
