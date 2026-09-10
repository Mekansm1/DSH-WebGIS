/**
 * DuckDB 工具层入口（薄注册器 + 兼容再导出）。
 *
 * 实现已拆分到 `src/duckdb/`：
 *  - `./duckdb/types.js`            驱动/连接行类型、引擎配置、列与几何句柄（纯类型）
 *  - `./duckdb/geometry.js`         几何/坐标列探测、几何表达式、Arrow 视口 WHERE、行→GeoJSON、值归一化
 *  - `./duckdb/filters.js`          等值/bbox/半径/围栏筛选子句构造（纯函数）
 *  - `./duckdb/sampling.js`         几何族判定与多族分层抽样
 *  - `./duckdb/ingestion.js`        CSV/矢量/大 GeoJSON → DuckDB 内存表 + 上图抽样
 *  - `./duckdb/engine.js`           DuckDbEngine（连接/建表/查询/Arrow IPC/抽样）
 *  - `./duckdb/tools-shared.js`     工具的会话上下文（sess/pushResult）与公共件
 *  - `./duckdb/tools/*.ts`          各 webgis_* 工具的注册（load-csv / filter / sql / spatial-*）
 *
 * 这里只做「建 engine → 建会话解析器 → 调用各工具注册」与对外再导出，
 * 保证既有 `import ... from './duckdb-tools.js'`（index.ts / routes-layers.ts / 单测）无需改动。
 */
import type { Context } from '@deepseek-ai/cordis'
import { getDuckDb } from './duckdb.js'
import {
  makeSessionResolver, type DuckDbToolsOptions, type DuckToolDeps, type DuckToolsState,
} from './duckdb/tools-shared.js'
import { registerLoadCsvTool } from './duckdb/tools/load-csv.js'
import { registerLayerFilterTools } from './duckdb/tools/filter.js'
import { registerSqlTools } from './duckdb/tools/sql.js'
import { registerSpatialFilterTool } from './duckdb/tools/spatial-filter.js'
import { registerSpatialAggregateTool } from './duckdb/tools/spatial-aggregate.js'

export type {
  DuckDbToolsOptions, DuckToolDeps, DuckToolsState,
  PushExtra, PushResult, SessionApi, SessionResolver,
} from './duckdb/tools-shared.js'
export { makeSessionResolver } from './duckdb/tools-shared.js'
export { geomFamiliesOf, geomFamiliesOfWkb } from './duckdb/sampling.js'
// 加载器与相关类型在 duckdb/ingestion.js；这里再导出，保持 index.ts / routes-layers.ts / 单测的既有导入路径不变。
export { ingestBigGeojson, loadCsvSourceData, loadVectorSourceData, VECTOR_SOURCE_EXTS } from './duckdb/ingestion.js'
export type { CsvLayerData, IngestBigResult, VectorLayerData, VectorSourceDataOpts } from './duckdb/ingestion.js'

/**
 * 注册 DuckDB 工具族（webgis_load_csv / filter_layer / layer_stats / sql_layer /
 * export_layer / spatial_filter / spatial_aggregate）。
 */
export function registerDuckDbTools(
  ctx: Context,
  stateFor: (sessionId: string | undefined) => DuckToolsState,
  opts: DuckDbToolsOptions = {},
): void {
  const engine = opts.engine ?? getDuckDb(opts.duckdb)
  const sess = makeSessionResolver(engine, stateFor)
  const deps: DuckToolDeps = { ctx, engine, sess }
  registerLoadCsvTool(ctx, deps)
  registerLayerFilterTools(ctx, deps)
  registerSqlTools(ctx, deps)
  registerSpatialFilterTool(ctx, deps)
  registerSpatialAggregateTool(ctx, deps)
}
