/**
 * 统计指数域工具：通用体检 `webgis_stat_inspect` + 三个指数计算工具（基尼 / 香农熵 / Getis-Ord Gi*）。
 *
 * 工作流（与莫兰指数那条线一致）：
 *   ① `webgis_stat_inspect` 只做数据判定，**不执行任何统计计算**；
 *   ② AI 把结论（能用哪些指数、候选字段、被排除字段及原因、建议参数、缺什么）展示给用户；
 *   ③ 用户确认后才调计算工具。
 *
 * 目录外的指数不是「不支持」：inspect 会走兜底 —— 报告该图层的数据形态（几何族、要素数、可用数值列、
 * 被排除的列），由 AI 用 webgis_sql_layer 按公式计算。**那条路径的公式由模型生成、框架不做校验**，
 * 所以结果必须标注为参考值（目录内的指数才有单测背书）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { GisLayer } from './geo-processing.js'
import { fieldLine, inspectFields } from './geo-stats-tools.js'
import {
  INDEX_SPECS, findIndexSpec, formatVerdict, geometryFamily, judgeIndex, opGetisOrd, opGini, opShannon,
  type LayerShape,
} from './geo-indices.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

const FAMILY_LABEL: Record<string, string> = { point: '点', polygon: '面', line: '线', mixed: '混杂', none: '无几何' }

/** 图层 → 判定用的数据形态（只读摘要 + 字段体检，不重拉数据、不计算）。 */
function shapeOf(layer: GisLayer): LayerShape {
  const { recommended, excluded } = inspectFields(layer.geojson)
  // BBox 可能是 6 元（带高程），判定只需要前 4 元
  const b = layer.bbox
  const bbox: [number, number, number, number] | null = b && b.length >= 4 ? [b[0]!, b[1]!, b[2]!, b[3]!] : null
  return {
    id: layer.id,
    name: layer.name,
    geometryTypes: layer.geometryTypes ?? [],
    featureCount: layer.featureCount,
    materialized: layer.materialized !== false,
    ...(layer.totalCount != null ? { totalCount: layer.totalCount } : {}),
    bbox,
    recommendedFields: recommended,
    excludedFields: excluded,
  }
}

export function registerIndexTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, COMMON, REMINDER, LAYER_RESULT_SCHEMA, STAT_RESULT_SCHEMA, text } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_stat_inspect',
    description: COMMON
      + '【任何指数/统计计算的第一步·必须先调用】体检工作区数据，判断用户想算的指数能不能做、用什么字段与参数。'
      + '不传 index：扫描当前会话全部图层，逐个列出可算的指数；'
      + '传 index（用用户的说法即可，如「基尼系数」「香农熵」「热点分析」「核密度」「莫兰」）：针对该指数给出'
      + '可用候选字段（含有效值/均值/标准差/唯一值）、被排除字段及原因、建议参数、不可行时的原因与修正建议。'
      + '本工具**不执行任何统计计算**。拿到结果后必须把结论展示给用户并等待确认（用户可改字段、权重、带宽等）；'
      + '未获确认前不得调用任何计算工具，也不得自行替用户选字段。'
      + '若该指数不在已知目录内，本工具会返回图层的数据形态与字段清单（不会只回一句不支持）：'
      + '此时可按公式用 webgis_sql_layer 计算，但必须告知用户公式由模型生成、未经框架校验，结果仅供参考。',
    parameters: {
      index: { type: 'string', description: '指数名（用户说法即可；缺省=扫描所有图层列出各自可算的指数）' },
      layer: { type: 'string', description: '目标图层 id（缺省=当前会话所有图层）' },
    },
    output: { schema: STAT_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { layers, resolve } = sess(exec)
      const targets = typeof args.layer === 'string' && args.layer
        ? (() => { const l = resolve(args.layer); return typeof l === 'string' ? l : [l] })()
        : layers()
      if (typeof targets === 'string') return Promise.resolve({ ok: false, message: targets })
      if (targets.length === 0) {
        return Promise.resolve({
          ok: false,
          stat: 'stat_inspect',
          value: { layers: [] },
          message: '当前会话还没有任何图层：请先加载数据（webgis_load_dataset / webgis_load_csv / 数据库查询上图）再做统计。',
        })
      }

      const query = typeof args.index === 'string' ? args.index.trim() : ''
      const catalogLine = `已知指数：${INDEX_SPECS.map((s) => s.name).join('、')}。`

      // ---- 不传指数：扫全部图层 × 全部指数，列出各自能算什么 ----
      if (!query) {
        const report: Array<Record<string, unknown>> = []
        const lines: string[] = []
        for (const layer of targets) {
          const shape = shapeOf(layer)
          const verdicts = INDEX_SPECS.map((spec) => ({ spec, v: judgeIndex(spec, shape) }))
          const ok = verdicts.filter((x) => x.v.feasible)
          const fam = geometryFamily(shape.geometryTypes)
          report.push({
            layerId: layer.id,
            name: layer.name,
            featureCount: shape.featureCount,
            geometryFamily: fam,
            materialized: shape.materialized,
            available: ok.map((x) => ({ index: x.spec.id, name: x.spec.name, tool: x.spec.tool })),
            blocked: verdicts.filter((x) => !x.v.feasible).map((x) => ({ index: x.spec.id, reasons: x.v.reasons })),
          })
          lines.push(ok.length
            ? `图层「${layer.name}」(${layer.id})：${shape.featureCount} 个要素（${FAMILY_LABEL[fam]}）→ 可算：${ok.map((x) => x.spec.name).join('、')}。`
            : `图层「${layer.name}」(${layer.id})：${shape.featureCount} 个要素（${FAMILY_LABEL[fam]}）→ 暂无可算指数（多是缺数值字段或几何不匹配，可传 index 看具体原因）。`)
        }
        return Promise.resolve({
          ok: true,
          stat: 'stat_inspect',
          value: { mode: 'scan', layers: report as unknown as JsonValue, catalog: INDEX_SPECS.map((s) => ({ id: s.id, name: s.name })) },
          message: `【统计体检】已扫描 ${targets.length} 个图层，可用指数如下（请把结论展示给用户，等确认后再计算）：\n`
            + `${lines.join('\n')}\n${catalogLine}`
            + '目录外的指数：可让 AI 按公式用 webgis_sql_layer 计算（公式未经框架校验，结果仅供参考）。'
            + '确认后调用对应计算工具。',
        })
      }

      const { spec, candidates } = findIndexSpec(query)

      // ---- 指数不在目录里：兜底报数据形态，而不是回「不支持」 ----
      if (!spec) {
        const lines: string[] = []
        const report: Array<Record<string, unknown>> = []
        for (const layer of targets) {
          const shape = shapeOf(layer)
          const fam = geometryFamily(shape.geometryTypes)
          report.push({
            layerId: layer.id,
            name: layer.name,
            featureCount: shape.featureCount,
            geometryFamily: fam,
            materialized: shape.materialized,
            totalCount: shape.totalCount,
            numericFields: shape.recommendedFields.map((f) => ({ field: f.field, valid: f.valid, min: f.min, max: f.max, mean: f.mean, unique: f.unique })),
            excludedFields: shape.excludedFields.map((f) => ({ field: f.field, reason: f.excluded })),
          })
          lines.push(`图层「${layer.name}」(${layer.id})：${shape.featureCount} 个要素（${FAMILY_LABEL[fam]}${shape.materialized ? '' : `，抽样显示 ${shape.featureCount}/${shape.totalCount ?? '?'} 行`}）；`
            + `可用数值列：${shape.recommendedFields.slice(0, 8).map((f) => f.field).join('、') || '（无）'}；`
            + `被排除：${shape.excludedFields.slice(0, 6).map((f) => `${f.field}（${f.excluded}）`).join('、') || '（无）'}。`)
        }
        const near = candidates.length ? `目录里最接近的是：${candidates.map((c) => c.name).join(' / ')}——请先与用户确认是不是这几个。` : ''
        return Promise.resolve({
          ok: true,
          stat: 'stat_inspect',
          value: { mode: 'fallback', query, layers: report as unknown as JsonValue, catalog: INDEX_SPECS.map((s) => ({ id: s.id, name: s.name })) },
          message: `【统计体检】「${query}」不在已知指数目录里。${near}\n`
            + `${lines.join('\n')}\n${catalogLine}`
            + `如果用户要的就是这个目录外指数：按公式用 webgis_sql_layer 计算，并向用户说明「公式由模型生成、未经框架校验，结果仅供参考」。`
            + `若数据里没有可用的数值列，请如实告诉用户不能算，不要编造结果。`,
        })
      }

      // ---- 命中目录：逐图层判定 ----
      const verdicts = targets.map((layer) => ({ layer, v: judgeIndex(spec, shapeOf(layer)) }))
      const lines = verdicts.map(({ v }) => formatVerdict(spec, v))
      const anyOk = verdicts.some(({ v }) => v.feasible)
      const tail = anyOk
        ? `确认后调用 ${spec.tool}；可用字段与建议参数见上（用户可改。${spec.emitsLayer ? '该指数会生成可上图的新图层' : '该指数只返回统计值，不生成图层'}）。`
        : '修正数据后请重新体检。'
      return Promise.resolve({
        ok: true,
        stat: 'stat_inspect',
        value: {
          mode: 'index',
          query,
          index: spec.id,
          name: spec.name,
          family: spec.family,
          tool: spec.tool,
          emitsLayer: spec.emitsLayer,
          caveats: spec.caveats as unknown as JsonValue,
          anyFeasible: anyOk,
          layers: verdicts.map(({ v }) => v as unknown as JsonValue),
          candidates: candidates.map((c) => ({ id: c.id, name: c.name })),
        },
        message: `【统计体检】${spec.summary}\n${lines.join('\n')}\n${tail}`,
      })
    },
  }))

  // ---- 基尼系数（纯字段统计，不需要几何） ----
  ctx.tools.register(defineTool({
    name: 'webgis_gini',
    description: COMMON
      + '计算基尼系数：单个数值列在要素间分布的不平等程度（0=完全平均，越接近 1 越不平均）。'
      + '要求字段非负且合计 > 0；基于抽样显示的子集计算会失真，请先筛出全量图层。'
      + '调用前应先经 webgis_stat_inspect 体检并把候选字段给用户确认。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id' },
      field: { type: 'string', required: true, description: '要统计的数值字段（非负）' },
    },
    output: { schema: STAT_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const res = opGini(layer.geojson, args.field)
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const sampleNote = layer.materialized === false
        ? `（⚠ 基于抽样 ${res.n}/${layer.totalCount ?? '?'} 行计算，基尼系数会失真，建议先筛出全量图层重算）`
        : ''
      return Promise.resolve({
        ok: true,
        stat: 'gini',
        value: {
          field: args.field,
          gini: res.gini,
          n: res.n,
          skipped: res.skipped,
          sum: res.sum,
          mean: res.mean,
          min: res.min,
          max: res.max,
        },
        message: `基尼系数 G=${res.gini}（0=完全平均，越接近 1 越不平均），字段「${args.field}」，基于 ${res.n} 个要素`
          + `${res.skipped ? `（另有 ${res.skipped} 个空值/非数值已跳过）` : ''}；合计 ${res.sum}、均值 ${res.mean}、范围 ${res.min}~${res.max}。`
          + `${sampleNote}${REMINDER}`,
      })
    },
  }))

  // ---- 香农熵 / 多样性 ----
  ctx.tools.register(defineTool({
    name: 'webgis_shannon',
    description: COMMON
      + '计算香农熵 H=−Σp·ln p（越大越分散、越小越集中），并给出 Pielou 均匀度 E=H/lnS。'
      + 'field 可以是分类列（土地利用类型等，按类别计数）或数值列（人口等，按数值当丰度）；'
      + 'mode 缺省 auto 自动判断（数值且唯一值多 → 按数值，否则按类别），结果里会说明实际用了哪种。'
      + '调用前应先经 webgis_stat_inspect 体检并把字段给用户确认。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id' },
      field: { type: 'string', required: true, description: '分类字段或数值字段' },
      mode: { type: 'string', enum: ['auto', 'category', 'value'], description: 'category=按类别计数；value=数值当丰度；auto=自动（默认）' },
    },
    output: { schema: STAT_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const mode = args.mode === 'category' || args.mode === 'value' ? args.mode : 'auto'
      const res = opShannon(layer.geojson, args.field, mode)
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const modeLabel = res.mode === 'value' ? '按数值（丰度）' : '按类别'
      const top = res.top.map((t) => `${t.key} ${(t.share * 100).toFixed(1)}%`).join('、')
      const sampleNote = layer.materialized === false ? `（⚠ 基于抽样 ${res.n}/${layer.totalCount ?? '?'} 行计算）` : ''
      return Promise.resolve({
        ok: true,
        stat: 'shannon',
        value: {
          field: args.field,
          mode: res.mode,
          h: res.h,
          hMax: res.hMax,
          evenness: res.evenness,
          categories: res.categories,
          n: res.n,
          top: res.top as unknown as JsonValue,
        },
        message: `香农熵 H=${res.h}（上限 ${res.hMax}），均匀度 E=${res.evenness}（1=完全均匀，越小越集中），`
          + `字段「${args.field}」${modeLabel}统计，共 ${res.categories} 类 / ${res.n} 个要素。占比前几：${top}。`
          + `${sampleNote}${REMINDER}`,
      })
    },
  }))

  // ---- Getis-Ord Gi*（热点分析，产出图层） ----
  ctx.tools.register(defineTool({
    name: 'webgis_getis_ord',
    description: COMMON
      + 'Getis-Ord Gi* 热点分析：找出统计显著的高值聚集（热点 z>0）/低值聚集（冷点 z<0），'
      + '生成带 gi_z / gi_p / gi_q / gi_class(hot|cold|ns) 的新图层，可直接上图看冷热点分布。'
      + '权重为二值邻接，默认面用 queen、点线用 knn k=5（需要 ≥6 个要素）；点/线若要素多建议改用 distance。'
      + 'p 用正态近似并做 Benjamini-Hochberg 假发现率校正（gi_q）——要素多时不做校正会冒出大量假热点。'
      + '调用前应先经 webgis_stat_inspect 体检并把字段/权重给用户确认。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id' },
      field: { type: 'string', required: true, description: '要分析的数值字段（每个要素都要有值）' },
      weight: { type: 'string', enum: ['queen', 'rook', 'distance', 'knn'], description: '空间权重：queen=面共边/共点（默认）；rook=仅共边；distance=距离阈值内；knn=最近 K 个' },
      distanceMeters: { type: 'number', description: 'weight=distance 的距离阈值（米）' },
      k: { type: 'integer', description: 'weight=knn 的邻居数（默认 5，1..50）' },
      alpha: { type: 'number', description: '显著性水平（默认 0.05）' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const res = opGetisOrd(layer.geojson, args.field, {
        ...(args.weight === 'queen' || args.weight === 'rook' || args.weight === 'distance' || args.weight === 'knn' ? { type: args.weight } : {}),
        ...(typeof args.distanceMeters === 'number' ? { distanceMeters: args.distanceMeters } : {}),
        ...(typeof args.k === 'number' ? { k: args.k } : {}),
        ...(typeof args.alpha === 'number' ? { alpha: args.alpha } : {}),
      })
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      const out = pushResult(`Gi*热点 - ${args.field}`, res.geojson, layer.name)
      const c = res.counts
      const sampleNote = layer.materialized === false
        ? '（⚠ 基于上图抽样子集计算，抽样会破坏空间邻接关系，结论不可靠）'
        : ''
      return Promise.resolve({
        ...out,
        message: `${out.message}。字段「${args.field}」共 ${res.n} 个要素：热点 ${c.hot} 个、冷点 ${c.cold} 个（合计 ${res.hotPercent}%），`
          + `其余 ${c.nonsig} 个不显著；权重 ${res.weightType}，α=${res.alpha}，已做 FDR 校正（对多重比较敏感的场景请以 gi_q 为准）。`
          + `新增字段 gi_z/gi_p/gi_q/gi_class。${sampleNote}${REMINDER}`,
      })
    },
  }))
}
