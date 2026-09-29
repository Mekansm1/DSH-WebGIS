import { jsTextOf, columnKindOf } from './attr-filter.js'
import type { GisLayer } from '../geo-processing.js'
import type { DuckDbEngine } from './engine.js'
import { quoteIdent, normalizeValue, DUCK_RID } from './geometry.js'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** 单字段统计下推，只读取聚合结果；绝不把全表转换为 JS 行。 */
export async function summarizeFullField(engine: DuckDbEngine, layer: GisLayer, field: string, stat: string): Promise<JsonValue> {
  if (!layer.duckTable) throw new Error('图层只有抽样，完整数据不可用，请重新加载')
  const columns = await engine.describe(layer.duckTable)
  if (!columns.some(c => c.name === field)) throw new Error(`字段 ${field} 不存在`)
  const c = quoteIdent(field)
  const source = quoteIdent(layer.duckTable)
  const text = jsTextOf(c, columnKindOf(columns.find(col => col.name === field)!.type))
  const present = `${c} IS NOT NULL AND CAST(${c} AS VARCHAR) <> ''`
  if (stat === 'values') {
    const order = columns.some(c => c.name === DUCK_RID) ? `ORDER BY min(${quoteIdent(DUCK_RID)})` : 'ORDER BY v'
    const rows = await engine.run(`SELECT ${text} AS v FROM ${source} WHERE ${present} GROUP BY 1 ${order} LIMIT 20`)
    return rows.map(r => String(r.v))
  }
  // 与本地 Number() 对齐空白为 0，非有限数不进入数值统计。
  const n = `CASE WHEN trim(CAST(${c} AS VARCHAR)) = '' THEN 0 ELSE TRY_CAST(${c} AS DOUBLE) END`
  const numeric = `CASE WHEN isfinite(${n}) THEN ${n} END`
  const expr = stat === 'count' ? 'count(*)'
    : stat === 'distinct' ? `count(DISTINCT ${text})`
    : ['sum', 'avg', 'min', 'max'].includes(stat) ? `${stat}(${numeric})` : null
  if (!expr) throw new Error('未知统计方式')
  const rows = await engine.run(`SELECT ${expr} AS v FROM ${source} WHERE ${present}`)
  return normalizeValue(rows[0]?.v ?? (stat === 'sum' ? 0 : null)) as JsonValue
}
