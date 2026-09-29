/**
 * dsh-webgis GIS 工具层 · 图层管理域：list_layers / remove_layer / clear_layers /
 * set_layer_visibility / set_layer_style / edit_field / od_matrix / set_render_mode / set_heatmap_mode。注册逻辑与工具行为与拆分前
 * geo-tools.ts 完全一致，仅把 sess/schema/文案/applyMode/applyStyle/hooks 等共享件来源
 * 从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ModeParams, SelectOperator } from './geo-processing.js'
import {
  opAddColumn,
  opAddSequence,
  opODMatrix,
  opSetAttribute,
  requireMaterialized,
  requirePointsOnly,
  summarize,
} from './geo-processing.js'
import { RAMPS, buildThematic, formatLegend } from './thematic.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

export function registerLayerTools(ctx: Context, rt: GeoToolRuntime): void {
  const {
    sess, hooks, COMMON, MODE_LABEL, REMINDER,
    LAYER_RESULT_SCHEMA, LAYER_PARAM, text, applyMode, applyStyle,
  } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_list_layers',
    description: '列出当前所有可用的 GIS 图层及其元信息（id/名称/要素数/bbox/几何类型/可见性/来源）。任何需要图层 id 的工具调用前先看这里。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layers: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    execute(_args, exec) {
      const { layers } = sess(exec)
      return Promise.resolve({
        ok: true,
        layers: layers().map(summarize) as unknown as JsonValue,
        message: `当前 ${layers().length} 个图层`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_remove_layer',
    description: '从地图移除一个图层（含基础数据集层 dataset；移除 dataset 即清除当前加载的数据集，结果图层保留）。',
    parameters: { layer: LAYER_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { st, layers, resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      if (layer.id === 'dataset') {
        st.dataset = null
        st.layers = layers().filter((l) => l.id !== 'dataset')
      } else {
        st.layers = layers().filter((l) => l.id !== layer.id)
      }
      // 联动释放图层引用的外部资源（如 DuckDB 内存表 DROP）。
      hooks?.onRemoveLayer?.(layer)
      return Promise.resolve({ ok: true, layerId: layer.id, message: `图层 ${layer.id} 已移除` })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_clear_layers',
    description: '清空全部结果图层；keepDataset 默认 true 保留基础数据集层。',
    parameters: {
      keepDataset: { type: 'boolean', description: '是否保留基础数据集层 dataset，默认 true' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          removed: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { st, layers } = sess(exec)
      const keep = args.keepDataset !== false
      const removed = layers().filter((l) => !(keep && l.id === 'dataset'))
      st.layers = keep ? layers().filter((l) => l.id === 'dataset') : []
      // keepDataset=false 时连基础数据集一起清掉（st.dataset 置空，地图上的点随之消失）。
      if (!keep) st.dataset = null
      // 联动释放被移除图层的外部资源（如 DuckDB 内存表 DROP）。
      for (const l of removed) hooks?.onRemoveLayer?.(l)
      return Promise.resolve({ ok: true, removed: removed.length, message: `已清除 ${removed.length} 个图层` })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_set_layer_visibility',
    description: '显示或隐藏一个图层（只切可见性，不删数据 —— 要移除请用 webgis_remove_layer）。图层 id 见 webgis_list_layers。',
    parameters: {
      layer: LAYER_PARAM,
      visible: { type: 'boolean', required: true, description: 'true=显示，false=隐藏' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          visible: { type: 'boolean' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      layer.visible = args.visible === true
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        visible: layer.visible,
        message: `图层 ${layer.id} 已${layer.visible ? '显示' : '隐藏'}`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_set_layer_thematic',
    description: COMMON + '【专题配色·按字段上色】按某个属性字段给图层分箱上色（choropleth），让同一图层不同要素显示不同颜色。'
      + '数值字段用 method=jenks（自然断点，默认，断点落在属性突变处）/ quantile（分位数，每类要素数相等）/ equal（等间距）；'
      + '文字或离散字段用 method=category（每个取值一个颜色）。'
      + 'ramp 选色带：数值常用 blues/greens/oranges/reds/purples/viridis（顺序型）、spectral（分歧型，有中心意义时用）；'
      + '分类用 set2（定性型）。classes 默认 5 级（2~12）。'
      + '⚠ 缺值**不会**被当成 0 混进某一级 —— 它们单独用中性灰显示，并在结果里报出个数。'
      + '⚠ 这是纯展示变更：不改数据、不影响统计结果。想改回单色用 webgis_set_layer_style 的 color 参数。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '用于上色的属性字段（数值列做分箱，文字列按类别）' },
      method: {
        type: 'string',
        enum: ['jenks', 'quantile', 'equal', 'category'],
        description: '分箱方法：jenks=自然断点（默认，数值）/ quantile=分位数（数值）/ equal=等间距（数值）/ category=按类别取值（文字列）',
      },
      classes: { type: 'integer', description: '分几级，默认 5（2~12）。仅数值型方法有效' },
      ramp: { type: 'string', description: `色带名（默认数值用 blues、分类用 set2）：${Object.keys(RAMPS).join(' / ')}` },
      colors: { type: 'json', description: '直接指定颜色数组（覆盖 ramp），长度需 ≥ 级数' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const method = args.method === 'jenks' || args.method === 'quantile' || args.method === 'equal' || args.method === 'category'
        ? args.method
        : 'jenks'
      const colors = Array.isArray(args.colors)
        ? args.colors.filter((c): c is string => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c))
        : undefined
      const res = buildThematic(layer.geojson, {
        field: args.field,
        method,
        ...(typeof args.classes === 'number' ? { classes: args.classes } : {}),
        ...(typeof args.ramp === 'string' && args.ramp ? { ramp: args.ramp } : {}),
        ...(colors && colors.length ? { colors } : {}),
      })
      if (!res.ok) return Promise.resolve({ ok: false, message: res.message })
      // 纯展示变更：原地写、不 bump rev（客户端按 thematic 字段重渲染，不重拉数据）。
      const err = applyStyle(layer, { thematic: res.spec })
      if (err) return Promise.resolve({ ok: false, message: err })
      // 大图层（materialized=false）的 layer.geojson 只是上图抽样：分箱断点与级内计数都基于抽样，
      // 不能沿用「级内计数仍按全量」那句话——那是物化图层才成立的（Jenks 2000 封顶抽样但 fc 是全量）。
      const sampled = layer.materialized === false
        ? `（⚠ 本层共 ${layer.totalCount ?? '?'} 行，地图上只显示 ${layer.featureCount} 行；分箱断点与级内计数都基于这 ${layer.featureCount} 行抽样，不是全量）`
        : res.spec.sampledFrom
          ? `（⚠ 断点基于 ${res.spec.sampledFrom} 个有效值的抽样计算，级内计数仍按全量）`
          : ''
      const noData = res.spec.missing > 0
        ? `\n⚠ 有 ${res.spec.missing} 个要素在该字段上没有值，已单独用中性灰显示（没有混进任何一级）。`
        : ''
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        thematic: res.spec as unknown as JsonValue,
        legend: res.labels,
        message: `${formatLegend(res.spec, res.labels)}${sampled}${noData}`
          + `\n请把这份图例转述给用户（颜色与区间要对应上）。改回单色用 webgis_set_layer_style 的 color 参数。`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_set_layer_style',
    description: COMMON + '修改图层渲染样式（仅改变显示、不改动图层数据，也不重新计算）：color=整体颜色（填充+描边默认值）、radius=点位大小（像素，点图层 circle-radius）、strokeWidth=外轮廓粗细（像素，点描边与面边界线宽）、fillColor=内填充颜色（覆盖 color 用于填充：点=圆点填充、面=多边形填充）。至少提供一个样式字段，缺省字段保持原值。设置 color/fillColor 会关闭专题配色。适用于任何图层。',
    parameters: {
      layer: LAYER_PARAM,
      color: { type: 'string', description: '整体颜色（十六进制 #rrggbb/#rgb 或颜色名），缺省保持原值' },
      radius: { type: 'number', description: '点位大小（像素，1~100），仅点图层生效，缺省 5' },
      strokeWidth: { type: 'number', description: '外轮廓粗细（像素，0~50），缺省点 1' },
      fillColor: { type: 'string', description: '内填充颜色（覆盖 color），缺省用 color' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      if ([args.color, args.radius, args.strokeWidth, args.fillColor].every(v => v === undefined)) {
        return Promise.resolve({ ok: false, message: '至少提供一个样式字段：color、radius、strokeWidth 或 fillColor' })
      }
      for (const key of ['color', 'fillColor'] as const) {
        if (args[key] !== undefined && typeof args[key] !== 'string') {
          return Promise.resolve({ ok: false, message: `${key} 必须是颜色字符串` })
        }
      }
      for (const key of ['radius', 'strokeWidth'] as const) {
        if (args[key] !== undefined && typeof args[key] !== 'number') {
          return Promise.resolve({ ok: false, message: `${key} 必须是数字` })
        }
      }
      const err = applyStyle(layer, {
        ...(typeof args.color === 'string' ? { color: args.color } : {}),
        ...(typeof args.radius === 'number' ? { pointRadius: args.radius } : {}),
        ...(typeof args.strokeWidth === 'number' ? { pointStrokeWidth: args.strokeWidth } : {}),
        ...(typeof args.fillColor === 'string' ? { fillColor: args.fillColor } : {}),
      })
      if (err) return Promise.resolve({ ok: false, message: err })
      const bits = [`color=${layer.color}`]
      if (layer.pointRadius !== undefined) bits.push(`点位=${layer.pointRadius}px`)
      if (layer.pointStrokeWidth !== undefined) bits.push(`描边=${layer.pointStrokeWidth}px`)
      if (layer.fillColor) bits.push(`填充=${layer.fillColor}`)
      return Promise.resolve({ ok: true, layerId: layer.id, message: `图层 ${layer.id} 样式已更新（${bits.join(', ')}）` })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_edit_field',
    description: '编辑图层字段：action=set 写常量（可按属性条件筛选）；add 新增空列，已有列不覆盖；sequence 按要素顺序写递增序号。'
      + '原地修改，自动刷新。未全量物化的图层需先筛出可处理子集。',
    parameters: {
      layer: LAYER_PARAM,
      action: { type: 'string', required: true, enum: ['set', 'add', 'sequence'], description: 'set=写常量；add=新增空列；sequence=递增编号' },
      field: { type: 'string', description: '字段名；set/add 必填，sequence 缺省 seq' },
      value: { type: 'json', description: 'set 必填，数字/字符串/布尔' },
      start: { type: 'number', description: 'sequence 的整数起点，缺省 0' },
      filterField: { type: 'string', description: 'set 可选筛选字段' },
      filterOperator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'in', 'is_null', 'not_null'], description: '筛选算子，缺省 eq' },
      filterValue: { type: 'string', description: '筛选值；is_null/not_null 不需要' },
    },
    output: { schema: LAYER_RESULT_SCHEMA, render: (_a, v) => text(JSON.stringify(v)) },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const merr = requireMaterialized(layer, '编辑字段')
      if (merr) return { ok: false, message: merr }
      const field = args.field?.trim() || (args.action === 'sequence' ? 'seq' : '')
      if (!field) return { ok: false, message: 'set/add 必须提供非空 field' }
      if (['__proto__', 'prototype', 'constructor'].includes(field)) return { ok: false, message: '不允许使用该字段名' }
      if (args.action !== 'set' && [args.value, args.filterField, args.filterOperator, args.filterValue].some(v => v !== undefined)) {
        return { ok: false, message: 'value/filterField/filterOperator/filterValue 仅适用于 set' }
      }
      if (args.action !== 'sequence' && args.start !== undefined) return { ok: false, message: 'start 仅适用于 sequence' }
      if (!layer.geojson.features.length) return { ok: false, message: '图层没有可编辑的要素' }
      let count: number
      if (args.action === 'set') {
        if (!['number', 'string', 'boolean'].includes(typeof args.value) || (typeof args.value === 'number' && !Number.isFinite(args.value))) {
          return { ok: false, message: 'set 的 value 必须是有限数字/字符串/布尔' }
        }
        if (!args.filterField && (args.filterOperator !== undefined || args.filterValue !== undefined)) return { ok: false, message: '筛选需提供 filterField' }
        if (args.filterField && !layer.geojson.features.some(f => Object.hasOwn(f.properties ?? {}, args.filterField!))) return { ok: false, message: 'filterField 不存在' }
        const operator = (args.filterOperator ?? 'eq') as SelectOperator
        if (args.filterField && !['is_null', 'not_null'].includes(operator) && args.filterValue === undefined) return { ok: false, message: '该筛选算子需提供 filterValue' }
        count = opSetAttribute(layer, field, args.value as string | number | boolean,
          args.filterField ? { field: args.filterField, operator, value: args.filterValue } : undefined)
      } else if (args.action === 'sequence') {
        const start = args.start ?? 0
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(start + layer.featureCount - 1)) return { ok: false, message: '序号必须在安全整数范围内' }
        count = opAddSequence(layer, field, start)
      } else {
        count = opAddColumn(layer, field)
      }
      if (!count) return { ok: false, message: args.action === 'add' ? `字段 ${field} 已存在，无需新增` : '没有要素被修改，请检查筛选条件' }
      layer.rev += 1
      return { ok: true, layerId: layer.id, featureCount: count, message: `图层 ${layer.id} 的字段 ${field} 已更新（${count} 个要素，${args.action}${args.action === 'sequence' ? `，${args.start ?? 0}~${(args.start ?? 0) + count - 1}` : ''}）` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_od_matrix',
    description: COMMON + 'OD 矩阵：把两个点图层配对成起点→终点的 OD 流向线图层（每个起点连到最近的 topN 个终点，flow=起点→终点大圆距离米；传 flowField 时取起点图层该数值字段作 flow）。结果图层自动以弧线图渲染（大圆最短路径 + 按 flow 流量映射线宽/颜色深浅）。单中心辐射可链式完成：先用 webgis_centroids 生成质心图层作为起点图层，再调本工具连回原图层。大数据量受 maxPairs 资源硬上限保护（默认 2000）；超过 warnOver（默认 200）返回消息会提醒视觉过密、建议降低密度。',
    parameters: {
      origin: LAYER_PARAM,
      destination: { type: 'string', description: '终点图层 id（需点要素），缺省与起点图层相同（图层内两两配对，自动跳过自环）' },
      topN: { type: 'number', description: '每个起点最多连接的终点数，缺省 100，无上限（超过 warnOver 时返回消息会提醒视觉过密）' },
      maxPairs: { type: 'number', description: '生成的 OD 对总数资源硬上限，缺省 2000（护栏，防止大数据量图层组合爆炸；密度调整用 topN/warnOver）' },
      warnOver: { type: 'number', description: '软提醒阈值（OD 总对数），缺省 200：超过时照常生成，但返回消息附 ⚠️ 提醒视觉过密、建议降低密度' },
      flowField: { type: 'string', description: '起点图层的数值属性字段名，作 flow（弧线粗细/深浅依据）；缺省用大圆距离（米）' },
    },
    output: {
      schema: LAYER_RESULT_SCHEMA,
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const origin = resolve(args.origin)
      if (typeof origin === 'string') return Promise.resolve({ ok: false, message: origin })
      let destination = origin
      if (typeof args.destination === 'string' && args.destination) {
        const d = resolve(args.destination)
        if (typeof d === 'string') return Promise.resolve({ ok: false, message: d })
        destination = d
      }
      const oerr = requirePointsOnly(origin, 'OD 矩阵')
      if (oerr) return Promise.resolve({ ok: false, message: oerr })
      const derr = requirePointsOnly(destination, 'OD 矩阵')
      if (derr) return Promise.resolve({ ok: false, message: derr })
      const moerr = requireMaterialized(origin, 'OD 矩阵')
      if (moerr) return Promise.resolve({ ok: false, message: moerr })
      const merr2 = requireMaterialized(destination, 'OD 矩阵')
      if (merr2) return Promise.resolve({ ok: false, message: merr2 })
      const topN = Math.max(1, Math.floor(Number(args.topN) || 100))
      const maxPairs = Math.max(1, Math.min(20000, Math.floor(Number(args.maxPairs) || 2000)))
      const warnOver = Number.isFinite(Number(args.warnOver)) ? Math.max(0, Math.floor(Number(args.warnOver))) : 200
      const flowField = typeof args.flowField === 'string' && args.flowField ? args.flowField : null
      const out = opODMatrix(origin, destination, topN, maxPairs, flowField)
      if (out.features.length === 0) {
        return Promise.resolve({ ok: false, message: '没有生成任何 OD 对：点太少，或 topN/maxPairs 上限过小（当前每起点最多连 topN 个终点）' })
      }
      const r = pushResult('OD 矩阵', out, `${origin.name} → ${destination.name}`, 'arc', { greatCircle: 1, flow: 1 })
      const dense = out.features.length > warnOver
      const msg = `${r.message}。共 ${out.features.length} 对 OD 流向，每起点最多连 ${topN} 个终点（maxPairs=${maxPairs} 为总对数资源硬上限），可用 topN/warnOver 调节密度。`
        + (dense ? ` ⚠️ 警告：已生成 ${out.features.length} 条 OD 线，超过阈值 ${warnOver}，视觉过密、渲染与交互会变卡，建议降低 topN 或缩小 origin/destination 图层；接受密度可调高 warnOver 参数。` : '')
      return Promise.resolve({ ...r, message: msg + REMINDER })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_set_render_mode',
    description: COMMON + '切换指定图层的展示方式/出图效果（仅改变显示、不改动图层数据，也不重新计算）：points=原始点；plane=平面热力图（maplibre 原生 heatmap 平滑热色）；hex=蜂窝热力图（六边形柱，柱高=密度，地图自动俯仰到 60°）；arc=弧线图（deck.gl，线图层每段首尾点连弧，OD 流向图）；trips=轨迹图（deck.gl，整条路径静态显示 + 白色高亮头点从起点缓缓走到终点）；wall=围墙图（deck.gl，面图层拉伸成 3D 半透明围栏/行政区划/AOI 块，突出区域）；radial=辐射图（deck.gl，点图层绕点画米制半径圆，表示影响范围/突出目标点）。几何要求：plane/hex/radial 需点要素、arc/trips 需线要素、wall 需面要素。可选 params：radius=辐射半径（米，radial 生效）、height=围墙高度（米，wall 生效）、width=线宽（像素，arc/trips 线宽、wall 描边宽）、speed=轨迹速度（trips 生效）、greatCircle=弧线沿地球表面最短路径大圆 0/1（arc 生效）、flow=弧线按流量字段（flow/value/volume/count）映射粗细深浅 0/1（arc 生效）。适用于任何图层。',
    parameters: {
      layer: LAYER_PARAM,
      mode: {
        type: 'string', required: true,
        enum: ['points', 'plane', 'hex', 'arc', 'trips', 'wall', 'radial'],
        description: '目标展示方式：points=原始点；plane=平面热力图；hex=蜂窝热力图；arc=弧线图；trips=轨迹图；wall=围墙图；radial=辐射图',
      },
      radius: { type: 'number', description: '辐射图半径（米），仅 radial 生效，缺省按图层 bbox 自动推算' },
      height: { type: 'number', description: '围墙图高度（米），仅 wall 生效，缺省按图层 bbox 自动推算' },
      width: { type: 'number', description: '线宽（像素）：弧线/轨迹线宽，或围墙图描边宽，仅 arc/trips/wall 生效，缺省 2~3' },
      speed: { type: 'number', description: '轨迹动画速度，仅 trips 生效，缺省 0.1' },
      trail: { type: 'number', description: '（已废弃）轨迹拖尾长度，轨迹图已改为全路径静态线 + 移动头点，此参数不再生效' },
      greatCircle: { type: 'number', description: '弧线沿地球表面最短路径（大圆，OD 流向标准画法），仅 arc 生效，1 开 0 关，缺省 0' },
      flow: { type: 'number', description: '弧线按流量字段（flow/value/volume/count，取首个数值）映射线宽与颜色深浅，仅 arc 生效，1 开 0 关，缺省 0' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          mode: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const mode = args.mode
      const params: ModeParams = {}
      if (typeof args.radius === 'number') params.radius = args.radius
      if (typeof args.height === 'number') params.height = args.height
      if (typeof args.width === 'number') params.width = args.width
      if (typeof args.speed === 'number') params.speed = args.speed
      if (typeof args.trail === 'number') params.trail = args.trail
      if (typeof args.greatCircle === 'number') params.greatCircle = args.greatCircle
      if (typeof args.flow === 'number') params.flow = args.flow
      const err = applyMode(layer, mode, params)
      if (err) return Promise.resolve({ ok: false, message: err })
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        mode,
        message: `图层 ${layer.id} 展示方式已切换为「${MODE_LABEL[mode]}」。${REMINDER}`,
      })
    },
  }))

  // 兼容旧名：仅热力三种展示方式，走同一 applyMode。
  ctx.tools.register(defineTool({
    name: 'webgis_set_heatmap_mode',
    description: COMMON + '【旧接口·建议优先用 webgis_set_render_mode】切换点图层的展示方式（等价 webgis_set_render_mode 的 points/plane/hex 子集；后者还支持 arc/trips/wall/radial）。points=原始点；plane=平面热力图（maplibre 原生 heatmap 平滑热色）；hex=蜂窝热力图（六边形柱，柱高=密度，地图自动俯仰到 60°）。适用于任何点图层。',
    parameters: {
      layer: LAYER_PARAM,
      mode: {
        type: 'string', required: true, enum: ['points', 'plane', 'hex'],
        description: '目标展示方式：points=原始点；plane=平面热力图；hex=蜂窝热力图',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          mode: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const mode = args.mode
      if (mode !== 'points' && mode !== 'plane' && mode !== 'hex') {
        return Promise.resolve({ ok: false, message: 'mode 必须是 points / plane / hex 之一' })
      }
      const err = applyMode(layer, mode)
      if (err) return Promise.resolve({ ok: false, message: err })
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        mode,
        message: `图层 ${layer.id} 展示方式已切换为「${MODE_LABEL[mode]}」。${REMINDER}`,
      })
    },
  }))
}
