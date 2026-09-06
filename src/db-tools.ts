/**
 * PostgreSQL/PostGIS 工具层：库结构读取 + 只读查询，结果走图层注册表上图。
 *
 * 与 geo-tools 的 turf 工具共用同一条「产出 FeatureCollection → 注册图层(source) → 客户端
 * syncLayers 渲染」管道（source: 'postgis'），图层 id 前缀 `db_<n>`。查询结果可直接被
 * webgis_buffer 等 turf 工具继续处理（链式），也可被 webgis_remove_layer 移除。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { BBox, FeatureCollection } from 'geojson'
import type { DbManager } from './db-manager.js'
import type { GisLayer } from './geo-processing.js'
import { RESULT_COLORS, makeResultLayer } from './geo-processing.js'
import type { ClusterParam } from './postgis.js'
import { effectiveCluster, normalizeColor, resolveClusterMode, runQuery } from './postgis.js'
import { DECK_FROM } from './render-policy.js'

/** 工具层所需的图层注册表状态（index.ts 传入的 state 结构上满足此接口）。 */
export interface DbToolsState {
  layers: GisLayer[]
}

function text(content: string): ContentBlock[] {
  return [{ type: 'text', text: content }]
}

/** schema 文本返回给模型的最大长度（过长截断提示）。 */
const MAX_SCHEMA_TEXT = 16000
/** 查询结果返回给模型的数据行预览条数。 */
const MAX_PREVIEW_ROWS = 15
/** 预览单元格最大长度。 */
const MAX_CELL = 300

/** 结果图层 id 递增计数器（进程内）。 */
let dbResultSeq = 0

export function registerDbTools(
  ctx: Context,
  stateFor: (sessionId: string | undefined) => DbToolsState,
  db: DbManager,
): void {
  /** 按本次执行的会话 id 解析其图层注册表操作闭包（查询结果只写回该会话自己的 state）。 */
  const sess = (exec: { agent?: { id?: string } }) => {
    const st = stateFor(exec.agent?.id)
    const layers = (): GisLayer[] => st.layers
    /** 查询结果注册为新图层并返回工具输出（同 geo-tools pushResult 形状）。 */
    const pushResult = (
      label: string,
      fc: FeatureCollection,
      rowCount: number,
      cluster = false,
      color?: string,
    ): { ok: true; layerId: string; name: string; featureCount: number; bbox: BBox | null; message: string } => {
      const id = `db_${++dbResultSeq}`
      const layer = makeResultLayer({
        id,
        name: `查询 ${rowCount} 行 - ${label}`,
        geojson: fc,
        source: 'postgis',
        color: color ?? RESULT_COLORS[dbResultSeq % RESULT_COLORS.length] ?? '#f97316',
        cluster,
        totalCount: rowCount,
      })
      st.layers = [...layers(), layer]
      return {
        ok: true,
        layerId: id,
        name: layer.name,
        featureCount: layer.featureCount,
        bbox: layer.bbox,
        message: `查询完成：生成图层 ${id}（${layer.featureCount} 个要素）`,
      }
    }
    return { pushResult }
  }

  // ---- 库结构 ----
  ctx.tools.register(defineTool({
    name: 'webgis_db_schema',
    description:
      '读取并返回 PostgreSQL 数据库结构（表/视图、各列、几何列、主键、行数估算），作为编写 SQL 查询前的参考。'
      + '首次调用会自动扫描并缓存；之后默认返回缓存；传 refresh=true 强制重新扫描更新缓存（或在插件设置卡片里操作）。'
      + '查询数据库前先调用本工具，确认有哪些表、哪些几何字段、列名如何拼写（尤其含大写/中文/特殊字符的列）。'
      + '末尾「使用提示」区分面要素（围栏）表与点要素（POI）表——用户要「缩放到某小区/某地」时优先查面表取围栏。',
    parameters: {
      refresh: { type: 'boolean', description: 'true = 强制重新扫描数据库并更新缓存（默认用缓存，无缓存时自动扫描）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tables: { type: 'integer' },
          fromCache: { type: 'boolean' },
          schemaText: { type: 'string' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const { tables, text: full, fromCache } = await db.ensureSchema(args.refresh === true)
        const schemaText = full.length > MAX_SCHEMA_TEXT
          ? `${full.slice(0, MAX_SCHEMA_TEXT)}\n…（结构过长已截断，建议用 webgis_db_list_tables 先看表清单）`
          : full
        return {
          ok: true,
          tables: tables.length,
          fromCache,
          schemaText,
          message: `数据库结构${fromCache ? '（缓存）' : '（已扫描）'}：${tables.length} 个表/视图`,
        }
      } catch (err) {
        return { ok: false, message: `数据库结构读取失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_db_list_tables',
    description: '列出数据库中所有表/视图（轻量：表名 + 行数估算 + 几何列）。快速了解有哪些表可用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          tables: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute() {
      try {
        const { tables } = await db.ensureSchema()
        const list = tables.map((t) => ({
          schema: t.schema,
          name: t.name,
          kind: t.kind,
          estimatedRows: t.estimatedRows,
          geometryColumns: t.geometryColumns.map((g) => `${g.column}(${g.type}, SRID ${g.srid})`),
        }))
        return {
          ok: true,
          tables: list as unknown as JsonValue,
          message: `共 ${tables.length} 个表/视图`,
        }
      } catch (err) {
        return { ok: false, message: `表列表读取失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }))

  // ---- 只读查询 → 图层 ----
  // 描述里内插阈值（注册时快照；行为上 execute 内实时读当前配置）
  const thrDesc = effectiveCluster(db.getConfig().cluster)
  ctx.tools.register(defineTool({
    name: 'webgis_db_query',
    description:
      '对 PostgreSQL/PostGIS 执行只读 SQL 查询（仅 SELECT / WITH / EXPLAIN；写操作会被数据库拒绝；'
      + '单条查询、不允许注释与分号；连接层有 30 秒语句超时）。'
      + `查询前系统会先统计结果行数并按阈值决定加载方式：结果 ≤ ${thrDesc.askFrom} 行直接上图；`
      + `${thrDesc.askFrom}~${thrDesc.autoClusterFrom} 行返回待确认，需先询问用户是否用聚合（supercluster）显示，再携带 cluster 参数重查；`
      + `${thrDesc.autoClusterFrom}~${thrDesc.maxLoad} 行自动聚合显示；超过 ${thrDesc.maxLoad} 行不加载，返回建议`
      + '（加 WHERE 缩小范围 / 用 LIMIT / 先 GROUP BY 统计）。'
      + '若结果含几何列（PostGIS 几何列，或 ST_AsGeoJSON(...) 输出的几何），自动转成 GeoJSON 要素并作为新图层上图'
      + '（图层 id 为 db_<n>，source=postgis，可被 webgis_remove_layer 移除、被 webgis_buffer 等工具继续处理）；'
      + '若结果无几何列则不建图层，仅返回数据行预览。'
      + '推荐流程：先写 LIMIT 5 的查询看数据样例 → 写 count/GROUP BY 统计回答用户问题 → 再写明细查询上图。'
      + '写 SQL 前先调用 webgis_db_schema 看表结构；返回几何推荐写 ST_AsGeoJSON(ST_Transform(geom, 4326)) AS geom；'
      + '表名/列名含大写、中文或保留字时用双引号包裹。'
      + '图层默认橙红色（#f97316）；用户若指定显示颜色（说"用蓝色/红色/紫色显示"之类），'
      + '把颜色传给 color 参数（十六进制如 #3b82f6，或颜色名如 red/蓝/橙红），聚合圈的颜色会随数量在所选颜色上加深。'
      + '用户要「缩放到某小区/某地」时，优先在面要素（AOI/围栏）表按名称查围栏并加载（围栏会自动上图并缩放到边界），而不是只查 POI 点。'
      + '数据源路由（就近优先）：仅当用户要查询数据库数据，或当前没有已加载图层时使用本工具；已有加载图层时优先操作图层（先调 webgis_list_layers 确认）。',
    parameters: {
      sql: { type: 'string', required: true, description: '只读 SQL 查询语句（SELECT/WITH/EXPLAIN；系统会按行数阈值自动决定是否加载/聚合）' },
      cluster: {
        type: 'string',
        enum: ['auto', 'on', 'off'],
        description: '渲染方式：auto=按行数阈值自动（默认）；on=强制聚合显示；off=强制普通显示（仅点要素支持聚合，非点自动普通）',
      },
      color: {
        type: 'string',
        description: '结果显示颜色（十六进制 #rrggbb，或颜色名 red/orange/blue/green/purple/橙/蓝/红…）。默认橙红 #f97316；用户指定颜色时传入',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          count: { type: 'integer' },
          maxLoad: { type: 'integer' },
          layerId: { type: 'string' },
          name: { type: 'string' },
          featureCount: { type: 'integer' },
          bbox: { type: 'json' },
          columns: { type: 'json' },
          rowCount: { type: 'integer' },
          rows: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { pushResult } = sess(exec)
      const sql = typeof args.sql === 'string' ? args.sql : ''
      if (!sql.trim()) return { ok: false, message: 'sql 不能为空' }
      if (!db.isConfigured()) {
        return { ok: false, message: '未配置 PostgreSQL 连接（请在插件设置 → WebGIS 数据库卡片里填写连接信息）' }
      }
      // execute 内实时读阈值（GUI 改过不用重启也生效）
      const thr = effectiveCluster(db.getConfig().cluster)
      try {
        const result = await runQuery(db.getPool(), sql, { maxLoad: thr.maxLoad })
        // 超过上限：不加载，返回建议（模型转述给用户）
        if (result.status === 'too_many') {
          return {
            ok: true,
            status: 'too_many',
            count: result.count,
            maxLoad: result.maxLoad,
            rowCount: 0,
            message: `查询结果 ${result.count} 行，超过地图可加载上限 ${result.maxLoad}，未加载。`
              + '建议：1) 加 WHERE 条件缩小范围（如按城市/分类/时间）；2) 用 LIMIT 只取需要的部分；'
              + '3) 先写 GROUP BY 统计看分布，再决定查哪块。',
          }
        }
        const geomName = result.geometry?.name ?? null
        const preview = result.rows.slice(0, MAX_PREVIEW_ROWS).map((r) => {
          const out: Record<string, unknown> = {}
          for (const f of result.fields) {
            if (f.name === geomName) continue
            out[f.name] = previewCell(r[f.name])
          }
          return out
        })
        // 无几何列 → 返回行预览，不建图层
        if (!result.geometry || !result.features || result.features.features.length === 0) {
          const why = result.geometry ? '查询有几何列但无有效几何要素' : '结果无几何列'
          return {
            ok: true,
            status: 'ok',
            count: result.count,
            rowCount: result.rowCount,
            columns: result.fields.map((f) => f.name) as unknown as JsonValue,
            rows: preview as unknown as JsonValue,
            message: `${why}，未建图层。返回前 ${preview.length} 行预览${result.note ? `；${result.note}` : ''}。`,
          }
        }
        // cluster 决策（仅点要素可聚合）
        const isPoint = result.features.features.every((f) => f?.geometry?.type === 'Point')
        const decision = resolveClusterMode({
          count: result.count,
          param: (typeof args.cluster === 'string' ? args.cluster : 'auto') as ClusterParam,
          isPoint,
          askFrom: thr.askFrom,
          autoClusterFrom: thr.autoClusterFrom,
        })
        if (decision.mode === 'ask') {
          return {
            ok: true,
            status: 'need_confirm',
            count: result.count,
            rowCount: result.rowCount,
            columns: result.fields.map((f) => f.name) as unknown as JsonValue,
            rows: preview as unknown as JsonValue,
            message: `查询结果 ${result.count} 行（处于 ${thr.askFrom}~${thr.autoClusterFrom} 区间）。`
              + '请先询问用户是否用聚合（supercluster）显示，再携带 cluster 参数（on/off）重新执行本查询。',
          }
        }
        const label = result.fields
          .filter((f) => f.name !== geomName)
          .slice(0, 2)
          .map((f) => f.name)
          .join('+')
        const clustered = decision.mode === 'cluster' && result.count <= DECK_FROM // >10 万走 deck 原始点
        const color = normalizeColor(args.color)
        const push = pushResult(label || 'query', result.features, result.rowCount, clustered, color)
        return {
          ...push,
          status: 'ok',
          count: result.count,
          rowCount: result.rowCount,
          columns: result.fields.map((f) => f.name) as unknown as JsonValue,
          rows: preview as unknown as JsonValue,
          message: `${push.message}${clustered ? '（已启用聚合显示）' : ''}；${result.note || `几何列 ${geomName}`}。返回前 ${preview.length} 行预览。`,
        }
      } catch (err) {
        return { ok: false, message: `查询失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    },
  }))
}

function previewCell(v: unknown): unknown {
  if (v == null) return null
  if (typeof v === 'string') return v.length > MAX_CELL ? `${v.slice(0, MAX_CELL)}…` : v
  try {
    const s = JSON.stringify(v)
    return typeof s === 'string' && s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : v
  } catch {
    return String(v)
  }
}
