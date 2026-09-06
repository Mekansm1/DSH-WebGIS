/**
 * 图层导出序列化：GeoJSON / CSV（几何列以 WKT 保存）/ Shapefile（zip：shp+dbf+prj+cpg）。
 *
 * SHP/DBF 为手写二进制写入器（Esri Shapefile / dBase III 规范）——shpjs 只读不写，这里
 * 按规范逐字节输出（头大端 / 体小端；长度单位为 16-bit 字），zip 打包用 fflate。
 * 全部函数导出供单测（含 shpjs 往返校验）。
 */
import type { Feature, FeatureCollection } from 'geojson'
import wkx from 'wkx'
import { strToU8, zipSync } from 'fflate'
import Papa from 'papaparse'

/** EPSG:4326 投影描述串（.prj 内容）。 */
export const PRJ_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'

/** CSV 导出时几何列名（导入端按此识别 WKT 列，见 loadCsvText）。 */
export const GEOM_WKT_COLUMN = 'geom_wkt'

/** 要素属性键并集（CSV/DBF 列来源，保留首见顺序）。 */
function propKeys(fc: FeatureCollection): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const f of fc.features) {
    for (const k of Object.keys(f.properties ?? {})) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  return keys
}

/** 单元格文本：标量原样，对象/数组 JSON 化，null/undefined 空串。 */
function propCell(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

/** 要素几何 → WKT（空几何/解析失败 → 空串）。 */
function geomWkt(f: Feature): string {
  if (!f.geometry) return ''
  try {
    return wkx.Geometry.parseGeoJSON(f.geometry as unknown as Record<string, unknown>).toWkt()
  } catch {
    return ''
  }
}

// ---- GeoJSON / CSV ----

export function toGeoJSON(fc: FeatureCollection): string {
  return JSON.stringify(fc)
}

export function toCsv(fc: FeatureCollection): string {
  const keys = propKeys(fc)
  const columns = [...keys, GEOM_WKT_COLUMN]
  if (fc.features.length === 0) return `${columns.join(',')}\n`
  const rows = fc.features.map((f) => {
    const row: Record<string, unknown> = {}
    for (const k of keys) row[k] = propCell(f.properties?.[k])
    row[GEOM_WKT_COLUMN] = geomWkt(f)
    return row
  })
  return Papa.unparse(rows, { columns })
}

// ---- Shapefile（SHP + DBF）----

interface NormRecord {
  type: number
  parts: number[]
  points: number[][]
}

/** 要素 → SHP 记录（GeometryCollection/空几何返回 null）。PolyLine/Polygon 每 ring/线一个 part。 */
function normalizeRecord(f: Feature): NormRecord | null {
  const g = f.geometry
  if (!g) return null
  switch (g.type) {
    case 'Point':
      return { type: 1, parts: [], points: [g.coordinates] }
    case 'MultiPoint':
      return { type: 8, parts: [], points: g.coordinates }
    case 'LineString':
      return { type: 3, parts: [0], points: g.coordinates }
    case 'MultiLineString': {
      const points: number[][] = []
      const parts: number[] = []
      for (const line of g.coordinates) {
        parts.push(points.length)
        points.push(...line)
      }
      return { type: 3, parts, points }
    }
    case 'Polygon': {
      const points: number[][] = []
      const parts: number[] = []
      for (const ring of g.coordinates) {
        parts.push(points.length)
        points.push(...ring)
      }
      return { type: 5, parts, points }
    }
    case 'MultiPolygon': {
      const points: number[][] = []
      const parts: number[] = []
      for (const poly of g.coordinates) {
        for (const ring of poly) {
          parts.push(points.length)
          points.push(...ring)
        }
      }
      return { type: 5, parts, points }
    }
    default:
      return null
  }
}

function bboxOfPoints(points: number[][]): [number, number, number, number] | null {
  if (points.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pt of points) {
    const x = pt[0] ?? 0
    const y = pt[1] ?? 0
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}

function writeBox(buf: Buffer, o: number, b: [number, number, number, number]): number {
  buf.writeDoubleLE(b[0], o)
  o += 8
  buf.writeDoubleLE(b[1], o)
  o += 8
  buf.writeDoubleLE(b[2], o)
  o += 8
  buf.writeDoubleLE(b[3], o)
  o += 8
  return o
}

/** 单条记录内容（不含 8 字节记录头；小端）。 */
function writeRecordContent(rec: NormRecord): Buffer {
  const n = rec.points.length
  const b = bboxOfPoints(rec.points) ?? [0, 0, 0, 0]
  let size = 4
  if (rec.type === 1) size += 16
  else if (rec.type === 8) size += 32 + 4 + 16 * n
  else size += 32 + 4 + 4 + 4 * rec.parts.length + 16 * n
  const buf = Buffer.alloc(size)
  let o = 0
  buf.writeInt32LE(rec.type, o)
  o += 4
  if (rec.type === 1) {
    buf.writeDoubleLE(rec.points[0]?.[0] ?? 0, o)
    o += 8
    buf.writeDoubleLE(rec.points[0]?.[1] ?? 0, o)
    o += 8
  } else if (rec.type === 8) {
    o = writeBox(buf, o, b)
    buf.writeInt32LE(n, o)
    o += 4
    for (const pt of rec.points) {
      buf.writeDoubleLE(pt[0] ?? 0, o)
      o += 8
      buf.writeDoubleLE(pt[1] ?? 0, o)
      o += 8
    }
  } else {
    o = writeBox(buf, o, b)
    buf.writeInt32LE(rec.parts.length, o)
    o += 4
    buf.writeInt32LE(n, o)
    o += 4
    for (const p of rec.parts) {
      buf.writeInt32LE(p, o)
      o += 4
    }
    for (const pt of rec.points) {
      buf.writeDoubleLE(pt[0] ?? 0, o)
      o += 8
      buf.writeDoubleLE(pt[1] ?? 0, o)
      o += 8
    }
  }
  return buf
}

/** 写出 .shp 主文件（100 字节头 + 逐记录；头 0–27 大端，其余小端）。 */
export function writeShp(fc: FeatureCollection): Buffer {
  const recs = fc.features.map(normalizeRecord).filter((r): r is NormRecord => r != null)
  if (recs.length === 0) throw new Error('没有可写入 shapefile 的要素')
  // 全局 shapeType 取首个非 Null 记录（混合类型图层以首个为准，文档注明）。
  const globalType = recs[0]!.type
  const recordBufs: Buffer[] = []
  for (const rec of recs) {
    const content = writeRecordContent(rec)
    const header = Buffer.alloc(8)
    header.writeInt32BE(recordBufs.length + 1, 0) // RecordNumber（从 1）
    header.writeInt32BE(content.length / 2, 4)    // ContentLength（16-bit 字，不含头）
    recordBufs.push(Buffer.concat([header, content]))
  }
  const totalBytes = 100 + recordBufs.reduce((s, b) => s + b.length, 0)
  const b = bboxOfPoints(recs.flatMap((r) => r.points)) ?? [0, 0, 0, 0]
  const out = Buffer.alloc(totalBytes)
  out.writeInt32BE(9994, 0) // 文件码（大端）
  // 4–23 五段 unused 保持 0
  out.writeInt32BE(totalBytes / 2, 24) // 文件总长度（16-bit 字，大端）
  out.writeInt32LE(1000, 28)           // 版本（小端）
  out.writeInt32LE(globalType, 32)     // 全局 shapeType（小端）
  let o = 36
  o = writeBox(out, o, b)
  out.fill(0, o, 100) // Zmin/Zmax/Mmin/Mmax = 0
  let off = 100
  for (const rb of recordBufs) {
    rb.copy(out, off)
    off += rb.length
  }
  return out
}

// ---- DBF（dBase III）----

interface DbfField {
  name: string
  type: 'N' | 'L' | 'C'
  length: number
  decimals: number
}

/** 数值格式化：整数直写，否则保留原串（长度/小数位据此统计）。 */
function numStr(v: number): string {
  return Number.isInteger(v) ? String(v) : String(v)
}

/** 单元格按字段长度填充到恰好 length 字节（UTF-8 按字节计，防劈开多字节字符）。 */
function padCell(str: string, length: number, align: 'left' | 'right'): string {
  let s = str
  while (Buffer.byteLength(s, 'utf8') > length) s = s.slice(0, -1)
  while (Buffer.byteLength(s, 'utf8') < length) s = align === 'left' ? `${s} ` : ` ${s}`
  return s
}

/** 字段描述符（类型探测 + 长度/小数位统计 + 名字 ≤10 字节去重）。 */
function buildField(name: string, idx: number, values: unknown[], used: Set<string>): DbfField {
  let base = name.trim().replace(/[^\w一-龥]/g, '_').slice(0, 10)
  if (!base) base = `field_${idx}`
  let unique = base
  let suffix = 2
  while (used.has(unique)) {
    unique = `${base.slice(0, 10 - String(suffix).length)}_${suffix}`
    suffix += 1
  }
  used.add(unique)
  const nonNull = values.filter((v) => v != null)
  const allNum = nonNull.length > 0 && nonNull.every((v) => typeof v === 'number' && Number.isFinite(v))
  const allBool = nonNull.length > 0 && nonNull.every((v) => typeof v === 'boolean')
  if (allNum) {
    const strs = nonNull.map((v) => numStr(v as number))
    const length = Math.min(18, Math.max(1, ...strs.map((s) => s.length)))
    const decimals = Math.min(10, Math.max(...strs.map((s) => {
      const dot = s.indexOf('.')
      return dot < 0 ? 0 : s.length - dot - 1
    })))
    return { name: unique, type: 'N', length, decimals }
  }
  if (allBool) return { name: unique, type: 'L', length: 1, decimals: 0 }
  const lengths = nonNull.map((v) => Buffer.byteLength(propCell(v), 'utf8'))
  return { name: unique, type: 'C', length: Math.min(254, Math.max(1, ...lengths)), decimals: 0 }
}

function dbfCell(f: DbfField, raw: unknown): string {
  if (raw == null) return ' '.repeat(f.length)
  if (f.type === 'L') return padCell(raw === true ? 'T' : raw === false ? 'F' : '?', f.length, 'left')
  const str = f.type === 'N' && typeof raw === 'number' && Number.isFinite(raw)
    ? numStr(raw)
    : propCell(raw)
  return padCell(str, f.length, f.type === 'N' ? 'right' : 'left')
}

/** 写出 .dbf（dBase III）。文本按 UTF-8 字节写（配 .cpg=UTF-8）。 */
export function writeDbf(fc: FeatureCollection): Buffer {
  const keys = propKeys(fc)
  const used = new Set<string>()
  const fields: DbfField[] = keys.map((k, i) => buildField(k, i, fc.features.map((f) => f.properties?.[k]), used))
  const headerLen = 32 + 32 * fields.length + 1
  const recordLen = 1 + fields.reduce((s, f) => s + f.length, 0)
  const out = Buffer.alloc(headerLen + recordLen * fc.features.length + 1)
  out[0] = 0x03
  const now = new Date()
  out[1] = Math.max(0, now.getFullYear() - 1900)
  out[2] = now.getMonth() + 1
  out[3] = now.getDate()
  out.writeUInt32LE(fc.features.length, 4) // 记录数
  out.writeUInt16LE(headerLen, 8)          // header 长度
  out.writeUInt16LE(recordLen, 10)         // 记录长度
  let o = 32
  for (const f of fields) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    nameBuf.copy(out, o)
    out[o + 11] = f.type.charCodeAt(0)
    out[o + 16] = f.length
    out[o + 17] = f.decimals
    o += 32
  }
  out[o] = 0x0D // header 终止
  o += 1
  for (const feat of fc.features) {
    out[o] = 0x20 // 未删除
    o += 1
    for (const f of fields) {
      const cell = dbfCell(f, feat.properties?.[f.name])
      out.write(cell, o, f.length, 'utf8')
      o += f.length
    }
  }
  out[out.length - 1] = 0x1A // EOF
  return out
}

/** 打包 shapefile zip（shp+dbf+prj+cpg）。 */
export function toShpZip(fc: FeatureCollection, base = 'export'): Uint8Array {
  return zipSync({
    [`${base}.shp`]: writeShp(fc),
    [`${base}.dbf`]: writeDbf(fc),
    [`${base}.prj`]: strToU8(PRJ_WGS84),
    [`${base}.cpg`]: strToU8('UTF-8'),
  })
}
