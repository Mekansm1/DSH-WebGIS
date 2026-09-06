/**
 * dsh-webgis GIS 工具层 · 图层管理域：list_layers / remove_layer / clear_layers /
 * set_layer_visibility / set_layer_color / set_layer_style / set_attribute / add_sequence /
 * add_column / od_matrix / set_render_mode / set_heatmap_mode。注册逻辑与工具行为与拆分前
 * geo-tools.ts 完全一致，仅把 sess/schema/文案/applyMode/applyStyle/hooks 等共享件来源
 * 从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
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
    description: '显示或隐藏一个图层。',
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
    name: 'webgis_set_layer_color',
    description: COMMON + '修改指定图层的显示颜色（仅改变显示、不改动图层数据，也不重新计算）。接受十六进制（#f73 / f97316）或颜色名（red / orange / 橙红 / 蓝 / 绿…）。适用于任何图层（含基础数据集 dataset 与结果图层）。更完整的样式（点位大小/外轮廓/填充色）请用 webgis_set_layer_style。',
    parameters: {
      layer: LAYER_PARAM,
      color: { type: 'string', required: true, description: '目标颜色：十六进制 #rrggbb / #rgb（可省略 #）或颜色名（red/orange/blue/绿/蓝…）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          color: { type: 'string' },
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
      const err = applyStyle(layer, { color: String(args.color) })
      if (err) return Promise.resolve({ ok: false, message: err })
      // 原地改、不 bump rev：纯展示变更，客户端按 color 字段重渲染、不重拉数据。
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        color: layer.color,
        message: `图层 ${layer.id} 颜色已改为 ${layer.color}`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_set_layer_style',
    description: COMMON + '修改图层渲染样式（仅改变显示、不改动图层数据，也不重新计算）：color=整体颜色（填充+描边默认值）、radius=点位大小（像素，点图层 circle-radius）、strokeWidth=外轮廓粗细（像素，点描边与面边界线宽）、fillColor=内填充颜色（覆盖 color 用于填充：点=圆点填充、面=多边形填充）。字段缺省保持原值。适用于任何图层（含基础数据集 dataset 与结果图层）。',
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
      const err = applyStyle(layer, {
        ...(typeof args.color === 'string' && args.color ? { color: args.color } : {}),
        ...(typeof args.radius === 'number' ? { pointRadius: args.radius } : {}),
        ...(typeof args.strokeWidth === 'number' ? { pointStrokeWidth: args.strokeWidth } : {}),
        ...(typeof args.fillColor === 'string' && args.fillColor ? { fillColor: args.fillColor } : {}),
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
    name: 'webgis_set_attribute',
    description: COMMON + '编辑图层属性：给要素写入字段（field=value），可选按 filterField/filterOperator/filterValue 只改命中的要素（算子同 webgis_select_by_value：eq/neq/gt/gte/lt/lte/contains/starts_with/ends_with/in/is_null/not_null）。原地改并 bump rev，客户端自动重拉。典型用法：给临时图层打类别/标注。注意：本工具只写同一个常量值——如需递增编号/逐要素不同值，用 webgis_add_sequence（支持 start 起点，如 1 基递增）。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '要写入的字段名' },
      value: { type: 'json', required: true, description: '写入值（数字/字符串/布尔）' },
      filterField: { type: 'string', description: '筛选字段（不传则改全部要素）' },
      filterOperator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'ends_with', 'in', 'is_null', 'not_null'], description: '筛选算子，缺省 eq' },
      filterValue: { type: 'string', description: '筛选值（is_null/not_null 忽略）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          featureCount: { type: 'integer' },
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
      const field = typeof args.field === 'string' && args.field ? args.field : ''
      if (!field) return Promise.resolve({ ok: false, message: 'field 不能为空' })
      const value = args.value
      if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'boolean') {
        return Promise.resolve({ ok: false, message: 'value 必须是数字/字符串/布尔' })
      }
      const filter = typeof args.filterField === 'string' && args.filterField
        ? { field: args.filterField, operator: (args.filterOperator as SelectOperator) ?? 'eq', value: typeof args.filterValue === 'string' ? args.filterValue : undefined }
        : undefined
      const count = opSetAttribute(layer, field, value, filter)
      if (count === 0) {
        return Promise.resolve({ ok: false, message: '没有要素被修改（检查 filterField/filterOperator/filterValue 是否匹配）' })
      }
      layer.rev += 1
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        featureCount: count,
        message: `图层 ${layer.id} 已写入字段 ${field}（${count} 个要素${filter ? '，按筛选命中' : '，全部要素'}）`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_add_sequence',
    description: COMMON + '给图层的全部要素赋顺序号字段（start..start+n-1，按要素在图层里的顺序，缺省从 0 开始）。原地改并 bump rev，客户端自动重拉。典型用途：给临时/结果图层排个序、做后续按序号筛选的底子；要 1 基递增（如 1..n）传 start:1。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', description: '顺序号字段名，缺省 seq' },
      start: { type: 'number', description: '起点序号，缺省 0（0 基）；要 1 基递增传 1' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layerId: { type: 'string' },
          featureCount: { type: 'integer' },
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
      const field = typeof args.field === 'string' && args.field ? args.field : 'seq'
      const start = Number.isFinite(Number(args.start)) ? Math.floor(Number(args.start)) : 0
      const count = opAddSequence(layer, field, start)
      layer.rev += 1
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        featureCount: count,
        message: `图层 ${layer.id} 已写入顺序号字段 ${field}（${start}~${start + count - 1}）`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_add_column',
    description: COMMON + '给图层的全部要素新增一列空字段（值 null，不填内容）。若字段已存在则提示无需新增。原地改并 bump rev，客户端自动重拉。典型用途：用户说"新增一列/加个字段"时用它（不要用 webgis_set_attribute 填占位值）。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '要新增的字段名' },
    },
    output: {
      schema: LAYER_RESULT_SCHEMA,
      render: (_a, v) => text(JSON.stringify(v)),
    },
    isConcurrencySafe: () => false,
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const field = typeof args.field === 'string' && args.field ? args.field : ''
      if (!field) return Promise.resolve({ ok: false, message: 'field 不能为空' })
      const count = opAddColumn(layer, field)
      if (count === 0) return Promise.resolve({ ok: false, message: `字段 ${field} 在图层 ${layer.id} 已存在，无需新增` })
      layer.rev += 1
      return Promise.resolve({
        ok: true,
        layerId: layer.id,
        featureCount: count,
        message: `图层 ${layer.id} 已新增空字段 ${field}（${count} 个要素，值为空）`,
      })
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
    description: COMMON + '切换指定图层的展示方式/出图效果（仅改变显示、不改动图层数据，也不重新计算）：points=原始点；plane=平面热力图（maplibre 原生 heatmap 平滑热色）；hex=蜂窝热力图（六边形柱，柱高=密度，地图自动俯仰到 60°）；arc=弧线图（deck.gl，线图层每段首尾点连弧，OD 流向图）；trips=轨迹图（deck.gl，整条路径静态显示 + 白色高亮头点从起点缓缓走到终点）；wall=围墙图（deck.gl，面图层拉伸成 3D 半透明围栏/行政区划/AOI 块，突出区域）；radial=辐射图（deck.gl，点图层绕点画米制半径圆，表示影响范围/突出目标点）。几何要求：plane/hex/radial 需点要素、arc/trips 需线要素、wall 需面要素。可选 params：radius=辐射半径（米，radial 生效）、height=围墙高度（米，wall 生效）、width=线宽（像素，arc/trips 线宽、wall 描边宽）、speed=轨迹速度（trips 生效）、greatCircle=弧线沿地球表面最短路径大圆 0/1（arc 生效）、flow=弧线按流量字段（flow/value/volume/count）映射粗细深浅 0/1（arc 生效）。适用于任何图层（含基础数据集 dataset 与原始点图层）。',
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
    description: COMMON + '切换指定图层的展示方式（等价 webgis_set_render_mode 的 points/plane/hex 子集）。points=原始点；plane=平面热力图（maplibre 原生 heatmap 平滑热色）；hex=蜂窝热力图（六边形柱，柱高=密度，地图自动俯仰到 60°）。适用于任何点图层（含基础数据集 dataset 与原始点图层）。',
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
