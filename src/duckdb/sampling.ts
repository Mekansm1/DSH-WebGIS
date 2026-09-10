/**
 * DuckDB 几何族与抽样（纯/引擎只读）：几何「族」判定（point/line/polygon，Multi* 归并）与
 * 上层抽样（多族分层抽样，保证每族都上图、不静默丢族）。
 * 拆分自 src/duckdb-tools.ts。
 */
import type { DuckGeomSpec } from './types.js'
import type { DuckDbEngine } from './engine.js'
import { geomExprOfCol, quoteIdent } from './geometry.js'

/** 几何“族”（deck 一族一层 / arrow 只吃单族的划分单位；Multi* 归并到单件族）。 */
export type GeomFamily = 'point' | 'line' | 'polygon'

/** 族 → duckdb spatial 的 ST_GeometryType 返回串（大写）。 */
const FAMILY_GEOM_TYPES: Record<GeomFamily, string[]> = {
  point: ['POINT', 'MULTIPOINT'],
  line: ['LINESTRING', 'MULTILINESTRING'],
  polygon: ['POLYGON', 'MULTIPOLYGON'],
}

/** 行数组（ST_GeometryType 结果）→ 几何族集合（Multi* 归并到单件族）。 */
function rowsToFamilies(rows: Array<Record<string, unknown>>): GeomFamily[] {
  const fams = new Set<GeomFamily>()
  for (const r of rows) {
    const t = String(r.t ?? '').toUpperCase()
    for (const [fam, types] of Object.entries(FAMILY_GEOM_TYPES)) {
      if ((types as string[]).includes(t)) fams.add(fam as GeomFamily)
    }
  }
  return [...fams]
}

/** 表里 GEOMETRY 列的几何族集合（空表/出错返回 []；需 spatial 扩展）。 */
export async function geomFamiliesOf(engine: DuckDbEngine, table: string, col: string): Promise<GeomFamily[]> {
  try {
    const rows = await engine.run(
      `SELECT DISTINCT ST_GeometryType(${quoteIdent(col)}) AS t FROM ${table} WHERE ${quoteIdent(col)} IS NOT NULL`,
    )
    return rowsToFamilies(rows)
  } catch {
    return []
  }
}

/** duckGeom 层几何族（兼容 WKT/WKB 列：先转几何再 ST_GeometryType；GEOMETRY 列直用）。
 *  空表/出错返回 []。需 spatial 扩展。 */
export async function duckGeomFamiliesOf(
  engine: DuckDbEngine,
  table: string,
  spec: DuckGeomSpec,
): Promise<GeomFamily[]> {
  try {
    const inner = geomExprOfCol(spec.column, spec.format) // 只做格式解析，不做 CRS 变换（族与 CRS 无关）
    const rows = await engine.run(
      `SELECT DISTINCT ST_GeometryType(${inner}) AS t FROM ${table} WHERE ${quoteIdent(spec.column)} IS NOT NULL`,
    )
    return rowsToFamilies(rows)
  } catch {
    return []
  }
}

/** WKB BLOB 几何列的几何族集合（先 ST_GeomFromWKB 再 ST_GeometryType；空表/出错返回 []；需 spatial）。 */
export async function geomFamiliesOfWkb(engine: DuckDbEngine, table: string, col: string): Promise<GeomFamily[]> {
  return duckGeomFamiliesOf(engine, table, { column: col, format: 'wkb', sourceCrs: null })
}

function familyWhere(geomSql: string, fam: GeomFamily): string {
  return `ST_GeometryType(${geomSql}) IN (${FAMILY_GEOM_TYPES[fam].map((t) => `'${t}'`).join(', ')})`
}

/**
 * 几何列抽样：多族时**各族各抽一份再合并**（保证每族都上图，不静默丢族）；单族/未知退化为 USING SAMPLE。
 * colToGeom 可选：把列名转成可被 ST_GeometryType 包裹的几何表达式（WKB BLOB 列需 ST_GeomFromWKB(col)，
 * GEOMETRY 列/缺省直接引用列本身）。分层 WHERE 只判断族、不改输出（selList 已含 CRS 转换）。
 */
export async function geometrySampleRows(
  engine: DuckDbEngine,
  table: string,
  selList: string,
  col: string,
  families: GeomFamily[],
  maxRows: number,
  colToGeom?: (col: string) => string,
): Promise<Array<Record<string, unknown>>> {
  if (families.length <= 1) {
    return engine.run(`SELECT ${selList} FROM ${table} USING SAMPLE ${Math.max(1, maxRows)} ROWS`)
  }
  const geomSql = colToGeom ? colToGeom(col) : quoteIdent(col)
  const per = Math.max(1, Math.floor(maxRows / families.length))
  const parts = families.map((f) => `(SELECT ${selList} FROM ${table} WHERE ${familyWhere(geomSql, f)} USING SAMPLE ${per} ROWS)`)
  return engine.run(parts.join(' UNION ALL '))
}
