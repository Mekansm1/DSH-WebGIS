/**
 * DuckDB 模块入口（barrel 兼容层）。
 *
 * 实现已拆分到 `src/duckdb/`：
 *  - `./duckdb/types.js`    —— 驱动/连接行类型、引擎配置、列与几何句柄、Arrow 视口形态（纯类型）
 *  - `./duckdb/geometry.js` —— 坐标/几何列探测、几何表达式与 CRS 归一、Arrow 视口 WHERE、
 *                              行 → GeoJSON、值归一化、错误友好化、SQL 标识符引用（纯函数）
 *  - `./duckdb/engine.js`   —— DuckDbEngine（连接/建表/查询/Arrow IPC/抽样）+ getDuckDb
 *
 * 这里只做再导出，保证既有 `import ... from './duckdb.js'`（工具层/路由层/单测）全部无需改动。
 * 新增代码请直接引用具体子模块，别再过 barrel：拆分的意义就是让依赖面可见。
 */
export * from './duckdb/types.js'
export * from './duckdb/geometry.js'
export * from './duckdb/engine.js'
