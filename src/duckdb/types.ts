/**
 * DuckDB 领域类型：驱动/连接的行类型、引擎配置、列与几何句柄、Arrow 视口形态。
 * 拆分自 src/duckdb.ts（原文件已变为 barrel 兼容层，既有 import 路径不变）。
 * 纯类型模块：无运行时依赖，可被任意层引用。
 */
export interface DuckDbRow {
  [column: string]: unknown
}
export interface DuckDbOptions {
  /** 小文件「常规加载」行数阈值：count ≤ 此值的 CSV 不保留内存表，全部物化上图。默认 50000。 */
  papaparseThreshold?: number
  /** DuckDB 内存表总行数上限：超出自动 DROP 最久未用的表（LRU）。默认 2000 万。 */
  maxTotalRows?: number
  /** DuckDB 进程级内存上限（SET memory_limit）。默认 '2GB'。 */
  memoryLimit?: string
  /** 单条查询超时（毫秒）。默认 30s。 */
  timeoutMs?: number
}
/** CSV 行 → GeoJSON 的经纬度列探测结果。 */
export interface CoordColumns {
  lon: string | null
  lat: string | null
}
/** DESCRIBE 得到的列定义。 */
export interface DuckColumn {
  name: string
  type: string
}

export type DuckGeomFormat = 'geometry' | 'wkb' | 'wkt'

/** 检测出的几何列句柄。 */
export interface DuckGeomSpec {
  column: string
  format: DuckGeomFormat
  /** 显式 sourceCrs 或 ST_SRID 自动检出；null = 按 WGS84 处理。 */
  sourceCrs: string | null
}

/** createTableFromVector 的产出：本地矢量 ST_Read 建表后信息。 */
export interface VectorTableInfo {
  count: number
  columns: string[]
  /** 几何列名（GEOMETRY/WKB/WKT，detectGeomColumn 检出）；无几何列返回 null。 */
  geomCol: string | null
  /** 几何列格式（与 geomCol 配对；无几何列返回 null）。 */
  geomFormat: DuckGeomFormat | null
}
/** Arrow 视口裁剪的图层几何形态：duckCoords（经纬度点表）或 duckGeom（几何列表）。 */
export type ArrowViewportShape =
  | { coords: { lon: string; lat: string } }
  | { geom: { column: string; format: DuckGeomFormat; sourceCrs: string | null } }

/** Arrow 视口 bbox（经度/纬度区间；west≤east、south≤north）。 */
export interface ArrowBbox {
  west: number
  south: number
  east: number
  north: number
}
/** 图层「内存表几何源」的两种形态：经纬度点列（duckCoords）或几何列（duckGeom）。 */
export interface DuckGeomSource {
  coords?: { lon: string; lat: string }
  geom?: DuckGeomSpec
}
