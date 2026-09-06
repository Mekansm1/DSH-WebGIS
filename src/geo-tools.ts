/**
 * dsh-webgis GIS 工具层：把 geo-processing 的矢量操作暴露为 DSH 可调工具。
 *
 * 本文件已按功能域拆分（纯重构，行为/注册工具全量零变化）：
 * - `geo-tools-runtime.ts`：createGeoToolRuntime(stateFor, hooks?) —— 注册所需「跨域共享但
 *   无 ctx 依赖」的会话解析/图层产出/展示与样式切换/共享 schema 文案；
 * - `geo-*-tools.ts`（construct/overlay/query/vector/stats/layer/info）：各域的
 *   register*Tools(ctx, rt)；
 * - 本文件只保留：全局系统提示纪律段注入（#6，原样）+ 组装调用七个域的 register 函数。
 *
 * 工具操作一个图层注册表（source-agnostic）：`dataset` 是基础数据集层，结果工具产出
 * `result_<n>` 具名图层。注册表状态按会话隔离（`stateFor(exec.agent?.id)` 解析到
 * 该会话自己的注册表，互不串扰）；变更注册表的工具 `isConcurrencySafe: false`
 * （调度器串行化写），重操作设 `timeoutMs` 兜底。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createGeoToolRuntime } from './geo-tools-runtime.js'
import type { GeoRegistryState, LayerLifecycleHooks } from './geo-tools-runtime.js'
import { registerConstructTools } from './geo-construct-tools.js'
import { registerOverlayTools } from './geo-overlay-tools.js'
import { registerQueryTools } from './geo-query-tools.js'
import { registerVectorTools } from './geo-vector-tools.js'
import { registerStatsTools } from './geo-stats-tools.js'
import { registerLayerTools } from './geo-layer-tools.js'
import { registerInfoTools } from './geo-info-tools.js'

// 拆分后仍从 geo-tools 具名导出原接口（兼容外部 import './geo-tools.js' 的类型引用）。
export type { GeoRegistryState, LayerLifecycleHooks } from './geo-tools-runtime.js'

export function registerGeoTools(
  ctx: Context,
  stateFor: (sessionId: string | undefined) => GeoRegistryState,
  hooks?: LayerLifecycleHooks,
): void {
  // #6 工具约束纪律：注册为全局系统提示段（order 150 ∈ 工具引导 100–199），所有 agent 组装提示词时都带上。
  // 插件级 ctx 作用域 → 全局生效；防 AI 幻觉工具名、假装执行、以及"尝试-失败-再尝试"死循环。
  const discipline = {
    name: 'webgis:tool-discipline',
    order: 150,
    text: [
      '【工具使用纪律】',
      '1. 你只能调用工具列表中已提供的工具，禁止臆造不存在的工具名，禁止"假装调用/假装执行"。',
      '2. 优先尝试最高效方法。如果工具限制导致无法高效完成，请：① 明确说明限制；② 给出最多两个可执行替代方案；③ 问用户选哪个再继续。禁止无限自我推理、反复空试。',
      '3. 工具返回 ok:false 时，先读错误消息修正参数，最多再试 1 次；同一工具同一参数连续失败 ≥2 次必须停下，改按第 2 条收敛（说明限制 + 给替代方案 + 问用户）。',
      '4. 没有合适工具时，不要写伪代码、不要进入自我对话式"自我迭代"，直接向用户说明现有工具无法满足需求，请其换一种问法或把需求登记为插件功能扩展。',
      '5. GIS 操作以工具返回的图层 id / 错误消息为准，不臆造图层、字段名或坐标结果。',
      '6. 回复用户保持简短精炼：先给结论，再补必要细节；不展示冗长推理/自我复盘，不重复确认已确认过的事。',
      '7. 查询数据先判断来源（就近优先）：先调 webgis_list_layers 看已加载图层，有则操作图层；无图层且数据库已配置才用 webgis_db_query 查库；用户明确点名表名则直接查库。',
      '8. 空间分析分流：数据仍在 Duck 大表、需要「全表/全层」的统计或筛选（多少个、落在哪、距某点多远、两层相交）时，'
        + '优先用 webgis_spatial_filter / webgis_spatial_aggregate，不要先随意抽样再 Turf 下结论（抽样会算错全表结论）。'
        + '图层已较小（已筛选/圈选）且需要缓冲、叠加、探索制图时，才用现有 webgis_* Turf 工具。'
        + '结果必须如实带 scope：全表算（full_table）、筛选后全量上图（filtered）、抽样显示（sample_display）要分清，'
        + '禁止把抽样展示说成全量几何。禁止对百万级图层默认执行全量 buffer 并宣称已全部上图。',
      '9. 面向用户的回复用日常 GIS 语言，不暴露内部技术名词：不要把 duckdb / maplibre / deck.gl / GeoArrow / spatial 扩展 / 内存表 / 引擎 / 图层内部 id（如 csv_1、duckdb_2、result_3、ds_0）/ 列名 / __rid 等术语讲给用户。'
        + '只告诉用户结果与动作：命中多少要素、落在哪个区域/距离范围、生成了什么内容的新图层；'
        + '工具返回或错误里出现这些技术词时，用用户能懂的话转述（如把「在 DuckDB 表 csv_1 上命中 1234 行」说成「在你这层数据里找到 1234 个」），不要原样照读技术字眼。',
      '10. 对「含内存表的大图层」（要素远多于地图上已显示的抽样）做全量筛选/统计/空间谓词时，必须用**在 duck 全表上跑的**工具：'
        + '属性等值筛选用 webgis_filter_layer（where）、全量统计用 webgis_layer_stats、空间/范围用 webgis_spatial_filter、复杂用 webgis_sql_layer——shp/geojson 大层与 csv 一样都有完整 duck 表与属性列。'
        + 'Turf/geojson 类工具（select_by_value/buffer/spatial_join 等）只用于已筛小的子集。'
        + '禁止把「地图上显示的抽样/可视部分」当成全量结论向用户汇报，先想清楚用户要的是全量还是当前视野。',
      '11. 语言跟随：回复（包括对用户可见的推理/思考过程）一律使用「用户输入所用的语言」：中文问→中文答；英文问→英文答；除非用户明确要求，不得擅自切换语言或中英混排。',
    ].join('\n'),
  }
  // 宿主 Cordis：服务必须经 ctx.inject 才能读取，直接 ctx.systemPrompt 会抛 "cannot get property ... without inject"。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (scoped) => {
      scoped.systemPrompt.section(discipline)
    })
  } else {
    // 假 ctx / 宿主直接把服务挂在 ctx 上（如单测）：直接调用
    const manual = ctx as { systemPrompt?: { section?: (s: typeof discipline) => void } }
    if (manual.systemPrompt?.section) manual.systemPrompt.section(discipline)
  }

  // 共享运行时：sess/pushResult/applyMode/applyStyle/COMMON/MODE_*/REMINDER/schema/text/RESULT_COLORS/hooks。
  const rt = createGeoToolRuntime(stateFor, hooks)

  // ---- 七个功能域（注册顺序与拆分前 registerGeoTools 大函数内一致）----
  registerConstructTools(ctx, rt)
  registerOverlayTools(ctx, rt)
  registerQueryTools(ctx, rt)
  registerVectorTools(ctx, rt)
  registerStatsTools(ctx, rt)
  registerLayerTools(ctx, rt)
  registerInfoTools(ctx, rt)
}
