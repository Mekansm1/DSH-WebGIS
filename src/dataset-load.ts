/**
 * host 侧数据集加载：shapefile(zip/.shp)/CSV/GeoJSON 文本 → GeoJSON FeatureCollection。
 * 拆分自 src/index.ts：纯模块级 helper，供 apply()（默认数据集/load_dataset 工具）、/webgis/import 路由与单测复用。
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { DatasetInfo, GeoJson } from './session-state.js'
import { getShapefile } from 'shpjs'
import Papa from 'papaparse'
import wkx from 'wkx'
import { fetchData } from './http-fetch.js'
import { detectCoordColumns } from './duckdb.js'

/** CSV 转出的点要素结构。 */
interface CsvPointFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: number[] }
  properties: Record<string, unknown>
}

function countFeatures(geojson: GeoJson): number {
  if (geojson.type === 'FeatureCollection') {
    const features = geojson.features as unknown
    return Array.isArray(features) ? features.length : 0
  }
  return geojson.type === 'Feature' || typeof geojson.type === 'string' && geojson.type !== 'GeometryCollection' ? 1 : 0
}

/** shapefile 读取上限（几何+属性二进制本身）。 */
const MAX_SHAPEFILE_BYTES = 32 * 1024 * 1024

/** 把 shpjs 结果归一化为单个 FeatureCollection（zip 内多图层时取第一个）。 */
function normalizeShpResult(result: unknown): GeoJson {
  const list = Array.isArray(result) ? result : [result]
  const first = list.find((x) => x && typeof x === 'object' && (x as { type?: unknown }).type === 'FeatureCollection')
  if (!first) throw new Error('shapefile 没有可解析的 FeatureCollection 图层')
  return first as GeoJson
}

/** 从内存字节解析 shapefile（zip 包或单 .shp）。导出供单测/import 路由复用。 */
export async function parseShapefileBuffer(buf: Buffer, ext: 'zip' | 'shp'): Promise<GeoJson> {
  if (ext === 'zip') return normalizeShpResult(await getShapefile(buf))
  return normalizeShpResult(await getShapefile({ shp: buf }))
}

/**
 * 读取 shapefile（.shp 单文件或含 shapefile 的 .zip）并转换为 GeoJSON FeatureCollection。
 * 支持 http(s) URL 与本地路径（绝对路径 / 相对插件包根）。
 * - `.zip`：整个包交给 shpjs.parseZip（自动拆出 .shp/.dbf/.prj，也支持 zip 里的 .geojson）；
 * - `.shp`：读主文件 + 可选的 .dbf(属性)/.prj(投影)，组合解析（缺配套文件仅几何也可用）。
 * 二进制读取走自己的 fetch/readFile + 大小上限，不交给 shpjs 内部（避免无界下载）。
 */
/** 供 host 侧单测直接验证 shapefile 解析（仅此用途；exported for tests）。 */
export async function loadShapefile(source: string): Promise<GeoJson> {
  const isUrl = /^https?:\/\//i.test(source)
  const isZip = source.toLowerCase().endsWith('.zip')
  const base = source.slice(0, -4)
  // 本地路径解析与 JSON 分支一致：绝对路径直用，否则相对插件包根。
  const resolveLocal = (p: string): string =>
    source.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(source)
      ? p
      : fileURLToPath(new URL(`../${p}`, import.meta.url))

  const readBytes = async (path: string, allowMissing: boolean): Promise<Buffer | null> => {
    try {
      if (isUrl) {
        // SSRF 防护抓取：内网/回环 IP 拒绝、手动重定向逐跳复检、HTML 响应拒绝。
        const { buffer } = await fetchData(path, { maxBytes: MAX_SHAPEFILE_BYTES })
        return buffer
      }
      return await readFile(resolveLocal(path))
    } catch (err) {
      if (allowMissing) return null
      throw err
    }
  }

  if (isZip) {
    // readBytes(source, false) 失败会抛错，这里必为非空
    const zipBuf = (await readBytes(source, false))!
    return parseShapefileBuffer(zipBuf, 'zip')
  }
  const shpBuf = (await readBytes(source, false))!
  const [dbfBuf, prjBuf] = await Promise.all([
    readBytes(`${base}.dbf`, true),
    readBytes(`${base}.prj`, true),
  ])
  return normalizeShpResult(await getShapefile({
    shp: shpBuf,
    ...(dbfBuf ? { dbf: dbfBuf } : {}),
    ...(prjBuf ? { prj: prjBuf } : {}),
  }))
}

/**
 * 解析数据集来源并按格式分发：`.zip`/`.shp` → loadShapefile；`.csv` → loadCsv；
 * 其余按 GeoJSON 文本解析。支持 http(s) URL 或本地路径（绝对 / 相对插件包根）。
 */
/** 供 host 侧单测直接验证格式分发（仅此用途；exported for tests）。 */
export async function loadDataset(source: string): Promise<DatasetInfo> {
  const cleanSource = source.split(/[?#]/)[0] ?? source
  // 取捕获组（不带点）：'zip'/'shp'/'csv'；match 失败为 null
  const ext = cleanSource.toLowerCase().match(/\.(zip|shp|csv)$/)?.[1] ?? null
  if (ext === 'zip' || ext === 'shp') {
    const geojson = await loadShapefile(source)
    const count = countFeatures(geojson)
    return { name: source.split('/').pop() ?? source, geojson, featureCount: count }
  }
  if (ext === 'csv') {
    const geojson = await loadCsv(source)
    const count = countFeatures(geojson)
    return { name: source.split('/').pop() ?? source, geojson, featureCount: count }
  }
  // 默认按 GeoJSON 文本解析
  const raw = await readDatasetText(source)
  const geojson = JSON.parse(raw) as GeoJson
  const count = countFeatures(geojson)
  return { name: source.split('/').pop() ?? source, geojson, featureCount: count }
}

/** 本地路径解析：绝对路径（含盘符/UNC）直用，否则相对插件包根（load_shapefile / CSV 建表共用）。 */
export function resolveSourceLocal(source: string): string {
  return source.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(source)
    ? source
    : fileURLToPath(new URL(`../${source}`, import.meta.url))
}

/** 读取数据集文本（http(s) URL 或本地路径，32MB 上限；http 走 SSRF 防护抓取）。 */
async function readDatasetText(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const { buffer } = await fetchData(source, { maxBytes: 32 * 1024 * 1024 })
    return buffer.toString('utf8')
  }
  return await readFile(resolveSourceLocal(source), 'utf8')
}

/**
 * 读取 CSV 来源（http(s) URL 或本地路径）并解析为要素，见 loadCsvText（WKT 列优先，回退经纬度列）。
 */
export async function loadCsv(source: string): Promise<GeoJson> {
  return loadCsvText(await readDatasetText(source))
}

/**
 * 解析 CSV 文本为要素：**先探测 WKT 几何列**（值形如 POINT(...)/POLYGON(...)/SRID=4326;...），
 * 有则解析任意几何类型（点/线/面，几何列不重复保留为属性）；否则回退经纬度列 → Point。
 * 经纬度列名按优先级识别：lon/lat、longitude/latitude、lng/lat、lon_wgs84/lat_wgs84、
 * lon_gcj02/lat_gcj02、lon_bd09/lat_bd09；兜底任意 lon* 与 lat* 前缀列。非法/越界坐标行跳过。
 * 导出供单测与 /webgis/import 复用。
 */
export function loadCsvText(csvText: string): GeoJson {
  const csv = csvText.replace(/^\uFEFF/, '')
  const parsed = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true })
  const rows = parsed.data
  if (rows.length === 0) throw new Error('CSV 没有数据行')
  const headers = parsed.meta.fields ?? Object.keys(rows[0] ?? {})
  const wktCol = detectWktColumn(headers, rows)
  if (wktCol) return csvToFeatures(rows, headers, wktCol)
  // 经纬度列识别与 duckdb 建表路径共用同一实现（duckdb.ts 的 COORD_PAIRS 唯一真源）。
  const coords = detectCoordColumns(headers)
  const lonCol = coords.lon
  const latCol = coords.lat
  if (!lonCol || !latCol) {
    throw new Error(
      `CSV 未找到经纬度列或 WKT 几何列（需要 lon/lat、longitude/latitude、lng/lat 或 lon_*/lat_* 类列名，`
      + `或任意列值为 WKT 如 POINT(...)/POLYGON(...)），当前列：${headers.join(', ')}`,
    )
  }
  const features: CsvPointFeature[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const lon = Number(row[lonCol])
    const lat = Number(row[latCol])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)
      || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue
    const properties: Record<string, unknown> = {}
    for (const h of headers) {
      if (h === lonCol || h === latCol) continue
      properties[h] = row[h] ?? null
    }
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties,
    })
  }
  if (features.length === 0) throw new Error('CSV 没有有效的经纬度数据行')
  return { type: 'FeatureCollection', features } as GeoJson
}

/** WKT 类型 token 前缀（含可选 SRID=4326; 前缀）。 */
const WKT_PREFIX = /^(SRID=\d+;)?\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON|GEOMETRYCOLLECTION)\b/i

/** 探测 CSV 里是否有 WKT 几何列（每列前 50 个非空值，任一匹配即命中）。 */
function detectWktColumn(headers: string[], rows: Array<Record<string, string>>): string | null {
  for (const h of headers) {
    let checked = 0
    for (const row of rows) {
      if (!row) continue
      const v = row[h]
      if (v == null || v.trim() === '') continue
      if (WKT_PREFIX.test(v.trim())) return h
      checked += 1
      if (checked >= 50) break
    }
  }
  return null
}

/** 逐行解析 WKT 列 → 要素（失败行跳过；全失败抛错）。 */
function csvToFeatures(rows: Array<Record<string, string>>, headers: string[], wktCol: string): GeoJson {
  const features: Array<{ type: 'Feature'; geometry: unknown; properties: Record<string, unknown> }> = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const raw = row[wktCol]
    if (raw == null || raw.trim() === '') continue
    const wkt = raw.trim().replace(/^SRID=\d+;/i, '')
    let geometry: unknown
    try {
      geometry = wkx.Geometry.parse(wkt).toGeoJSON()
    } catch {
      continue
    }
    const properties: Record<string, unknown> = {}
    for (const h of headers) {
      if (h === wktCol) continue
      properties[h] = row[h] ?? null
    }
    features.push({ type: 'Feature', geometry, properties })
  }
  if (features.length === 0) throw new Error('CSV 的 WKT 列无法解析出有效几何')
  return { type: 'FeatureCollection', features } as GeoJson
}
