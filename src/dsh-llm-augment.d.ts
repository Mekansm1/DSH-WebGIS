/**
 * 给 `@deepseek-ai/dsh-llm` 增补**本插件自己的**消息来源 kind。
 *
 * ## 为什么需要
 *
 * 0.1.5 的 `MessageSourceMap` 有一个通用兜底项：
 * ```ts
 * plugin: { kind: 'plugin'; plugin: string } & ContextFormed
 * ```
 * **0.1.7 删掉了它**，并在 `dsh-llm` 注释里写明替代方式：
 *
 * > Merge-extensible sum type — each producer declares its own `kind` in its own module;
 * > there is no shared catch-all `plugin` kind.
 *
 * 0.1.7 内置只剩 `user | model | tool | system-prompt`，其余 kind 全部由各生产包自行增补
 * （`dsh-tools` 的 `'tool-registry'`/`'ptc-mode'`、`dsh-agent` 的 `'model-selection'`、
 * `dsh-user-approval` 等）。本文件就是照 `dsh-tools/lib/types/index.d.ts` 的写法。
 *
 * ## 为什么不退回 `kind: 'user'`
 *
 * `user` 的语义是「这条消息由用户产生」。视觉委托链是**插件自己发起**的调用，用 `user`
 * 会谎报来源 —— `MessageSource` 供持久化与转录渲染消费，谎报会污染这两处。
 * 按官方扩展点自声明 kind 才是对的，且与宿主内置生产者同权限。
 *
 * ## 两个必须照做的细节（否则增补静默不生效）
 *
 * 1. 增补目标写**包根** `'@deepseek-ai/dsh-llm'`，不写 `/message` 子路径 —— 后者指向
 *    声明 `MessageSourceMap` 的文件，但 TS 的合并走的是 import 说明符解析到的模块入口，
 *    指向子路径时合并不进去（实测：改回子路径后 tsc 立刻报 `"webgis"` 不可赋值）。
 * 2. 本文件必须 `import` 该包，使它进入 program；否则 `declare module` 会被当成**环境模块
 *    声明**而非增补，同样不合并。下面那行 type-only 空导入就是干这个的。
 */
import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** WebGIS 插件自身发起的 LLM 调用（视觉委托链，见 `vision-chain.ts`）。 */
    webgis: { kind: 'webgis' }
  }
}
