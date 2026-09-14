/**
 * dsh-webgis GIS 工具层 · 信息类域：layer_info / feature_summary。注册逻辑与工具行为
 * 与拆分前 geo-tools.ts 完全一致，仅把 sess/schema/文案等共享件来源从大闭包改为 runtime 参数 rt。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { requireField } from './geo-processing.js'
import { minMax } from './geo-stats.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

export function registerInfoTools(ctx: Context, rt: GeoToolRuntime): void {
  const { sess, MODE_LABEL, LAYER_PARAM, text } = rt

  ctx.tools.register(defineTool({
    name: 'webgis_layer_info',
    description: '返回图层的完整元信息：id、名称、要素数、bbox、几何类型、可见性、来源、属性字段列表。',
    parameters: { layer: LAYER_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layer: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const fields = [...new Set(layer.geojson.features.flatMap((f) => Object.keys(f?.properties ?? {})))]
      return Promise.resolve({
        ok: true,
        layer: {
          id: layer.id,
          name: layer.name,
          // ⚠ 大图层上 featureCount 只是**上图抽样行数**，真数据行数在 totalCount；
          // 两个都给出，避免模型把 featureCount 当成"这层只有这么多要素"。
          featureCount: layer.featureCount,
          totalCount: layer.totalCount ?? layer.featureCount,
          materialized: layer.materialized,
          bbox: layer.bbox,
          geometryTypes: layer.geometryTypes,
          visible: layer.visible,
          source: layer.source,
          mode: layer.mode,
          fields,
        } as unknown as JsonValue,
        message: `${layer.id}：${layer.featureCount} 个要素，展示方式「${MODE_LABEL[layer.mode]}」，字段 ${fields.join(', ') || '无'}`
          + (layer.materialized === false
            ? `\n⚠ 本层共 ${layer.totalCount ?? '?'} 行，地图上只显示其中 ${layer.featureCount} 行的抽样；全量筛选/统计请用 webgis_filter_layer / webgis_layer_stats / webgis_sql_layer。`
            : ''),
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_feature_summary',
    description: '【字段级统计·任意图层】对图层某属性字段做统计：count 非空数；sum/avg/min/max 数值统计；distinct 去重计数；values 列出去重前 20 个值。'
      + '⚠ 与 webgis_layer_stats 的分工：**本工具对任意图层可用，但在「当前显示的要素」上算** —— 抽样显示的大文件图层会得到抽样均值，务必如实转述；'
      + '要基于 DuckDB 内存表跑**全表**统计（大 CSV）请用 webgis_layer_stats。'
      + '本工具属简单字段统计，不需要先经 webgis_stat_inspect。',
    parameters: {
      layer: LAYER_PARAM,
      field: { type: 'string', required: true, description: '属性字段名' },
      stat: {
        type: 'string',
        required: true,
        enum: ['count', 'sum', 'avg', 'min', 'max', 'distinct', 'values'],
        description: '统计方式',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          layer: { type: 'string' },
          field: { type: 'string' },
          stat: { type: 'string' },
          value: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    execute(args, exec) {
      const { resolve } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return Promise.resolve({ ok: false, message: layer })
      const fieldErr = requireField(layer, args.field)
      if (fieldErr) return Promise.resolve({ ok: false, message: fieldErr })
      const values = layer.geojson.features.map((f) => f?.properties?.[args.field])
      const present = values.filter((v) => v != null && v !== '')
      let value: unknown
      switch (args.stat) {
        case 'count':
          value = present.length
          break
        case 'sum': {
          const nums = present.map(Number).filter((n) => Number.isFinite(n))
          value = nums.reduce((a, b) => a + b, 0)
          break
        }
        case 'avg': {
          const nums = present.map(Number).filter((n) => Number.isFinite(n))
          value = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null
          break
        }
        case 'min': {
          const nums = present.map(Number).filter((n) => Number.isFinite(n))
          value = nums.length ? minMax(nums).min : null
          break
        }
        case 'max': {
          const nums = present.map(Number).filter((n) => Number.isFinite(n))
          value = nums.length ? minMax(nums).max : null
          break
        }
        case 'distinct':
          value = new Set(present.map((v) => String(v))).size
          break
        case 'values':
          value = [...new Set(present.map((v) => String(v)))].slice(0, 20)
          break
        default:
          return Promise.resolve({ ok: false, message: `未知统计方式 ${args.stat}` })
      }
      // 大图层（materialized=false）这里算的是**上图抽样**。本工具按定义就是「在当前显示的要素上算」，
      // 所以不拦；但警告必须盖在返回值上——只写在工具描述里，模型很容易漏读然后照读数字当全量结论。
      const sampleWarn = layer.materialized === false
        ? `⚠ 这是**上图抽样**（图层共 ${layer.totalCount ?? '?'} 行，本次只统计了显示的 ${layer.featureCount} 行）的统计值，`
          + '不是全量；要全量请改用 webgis_layer_stats。转述给用户时必须说明是抽样口径。'
        : ''
      return Promise.resolve({
        ok: true,
        layer: layer.id,
        field: args.field,
        stat: args.stat,
        value: value as unknown as JsonValue,
        message: `${layer.id}.${args.field} ${args.stat} = ${JSON.stringify(value)}${sampleWarn ? `\n${sampleWarn}` : ''}`,
      })
    },
  }))
}
