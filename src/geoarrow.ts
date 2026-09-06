/**
 * host 侧 GeoArrow 转换：DuckDB 大文件图层 → Arrow IPC 二进制（客户端 @geoarrow/deck.gl-geoarrow 直吃）。
 *
 * 两条路径：
 * - 经纬度点图层：直接拼 interleaved Float64Array 构造 GeoArrow Point 表（免 spatial、免 WKB，最快）。
 * - 几何列图层：DuckDB spatial ST_AsWKB → @walkthru-earth/objex-utils buildGeoArrowTables。
 *
 * 最后统一 apache-arrow tableToIPC 出二进制流（保留 ARROW:extension:name 几何扩展元数据，
 * 客户端 tableFromIPC 还原出同样的 GeoArrow Table，可直接喂给 @geoarrow/deck.gl-geoarrow 图层）。
 */
import {
  Field,
  FixedSizeList,
  Float64,
  RecordBatch,
  Schema,
  Struct,
  Table,
  Utf8,
  makeData,
  tableFromIPC,
  tableToIPC,
  vectorFromArray,
  type Data,
} from 'apache-arrow'
import { buildGeoArrowTables } from '@walkthru-earth/objex-utils'

/** WGS84 坐标的 GeoArrow 扩展元数据（deck.gl-geoarrow 靠 ARROW:extension:name 定位几何列）。 */
const POINT_EXT = new Map<string, string>([['ARROW:extension:name', 'geoarrow.point']])

/** 点图层的几何列名（避免与属性列撞名）。 */
export const GEOMETRY_COL = '__geometry'

/**
 * 经纬度点行 → GeoArrow Point 表（interleaved FixedSizeList<Float64>(2)，字段元数据 geoarrow.point）。
 * 非法/越界坐标行跳过（与 rowsToGeoJSON 一致）；属性列：数值→Float64（null→NaN）、其余→Utf8。
 */
export function pointsToGeoArrowTable(
  rows: Array<Record<string, unknown>>,
  lonCol: string,
  latCol: string,
  attrs: string[],
): Table {
  const positions: number[] = []
  const attrValues: Record<string, unknown[]> = {}
  for (const a of attrs) attrValues[a] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const lonRaw = row[lonCol]
    const latRaw = row[latCol]
    if (lonRaw == null || latRaw == null) continue
    if ((typeof lonRaw === 'string' && lonRaw.trim() === '') || (typeof latRaw === 'string' && latRaw.trim() === '')) continue
    const lon = Number(lonRaw)
    const lat = Number(latRaw)
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue
    positions.push(lon, lat)
    for (const a of attrs) attrValues[a]!.push(row[a])
  }
  const n = positions.length / 2
  const xyType = new FixedSizeList(2, new Field('xy', new Float64()))
  const geomData = makeData({
    type: xyType,
    length: n,
    child: makeData({ type: new Float64(), data: new Float64Array(positions) }),
  })
  const fields: Field[] = [new Field(GEOMETRY_COL, xyType, true, POINT_EXT)]
  const children: Data[] = [geomData]
  for (const a of attrs) {
    const { field, data } = attrData(a, attrValues[a]!)
    fields.push(field)
    children.push(data)
  }
  const schema = new Schema(fields)
  const structData = makeData({ type: new Struct(fields), length: n, children })
  return new Table(new RecordBatch(schema, structData))
}

/** 属性列 → Field + Data（数值→Float64，否则 Utf8 字符串）。 */
function attrData(name: string, values: unknown[]): { field: Field; data: Data } {
  const allNumeric = values.every((v) => v == null || typeof v === 'number' || typeof v === 'bigint')
  if (allNumeric) {
    const arr = new Float64Array(values.length)
    for (let i = 0; i < values.length; i++) arr[i] = values[i] == null ? NaN : Number(values[i])
    const type = new Float64()
    return { field: new Field(name, type, true), data: makeData({ type, data: arr, length: arr.length }) }
  }
  const arr: string[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    arr.push(v == null ? '' : String(v))
  }
  // Utf8 的 makeData 不接受 data prop（类型约束），走 vectorFromArray 强制 Utf8 编码。
  const vec = vectorFromArray(arr, new Utf8())
  return { field: new Field(name, vec.type, true), data: vec.data[0]! }
}

/**
 * WKB 几何行 → GeoArrow 表（经 objex-utils buildGeoArrowTables）。多几何类型混合时取要素最多的主类型
 * （首版按主类型；多类型分图层渲染留作后续）。wkbCol 行的值为 Buffer/Uint8Array。无有效几何返回 null。
 */
export function wkbRowsToGeoArrowTable(
  rows: Array<Record<string, unknown>>,
  wkbCol: string,
  attrs: string[],
): Table | null {
  const wkbs: Uint8Array[] = []
  const attrValues: Record<string, unknown[]> = {}
  for (const a of attrs) attrValues[a] = []
  for (const row of rows) {
    const w = row[wkbCol]
    if (w == null) continue
    const bytes = w instanceof Uint8Array ? w : new Uint8Array((w as { buffer: ArrayBufferLike }).buffer)
    if (bytes.byteLength === 0) continue
    wkbs.push(bytes)
    for (const a of attrs) attrValues[a]!.push(row[a])
  }
  if (wkbs.length === 0) return null
  const attributes = new Map<string, { values: unknown[]; type: string }>()
  for (const a of attrs) {
    const vals = attrValues[a]!
    const allNumeric = vals.every((v) => v == null || typeof v === 'number' || typeof v === 'bigint')
    attributes.set(a, {
      values: allNumeric ? vals.map((v) => (v == null ? 0 : Number(v))) : vals.map((v) => (v == null ? '' : String(v))),
      type: allNumeric ? 'Float64' : 'Utf8',
    })
  }
  const results = buildGeoArrowTables(wkbs, attributes)
  if (!results || results.length === 0) return null
  return [...results].sort((a, b) => b.table.numRows - a.table.numRows)[0]!.table
}

/** Table → Arrow IPC 二进制流（application/vnd.apache.arrow.stream）。 */
export function tableToIpc(table: Table): Uint8Array {
  return tableToIPC(table, 'stream')
}

/**
 * 从「DuckDB 原生 Arrow IPC（两列 DOUBLE lon/lat）」直构 GeoArrow Point 表（无属性列）。
 * 绕开 conn.all 的 JS 行对象物化：DuckDB arrowIPC 出来的 buffer 直接 decode → 类型化读列 → 拼点表。
 * 非法/越界/空值行跳过（与 pointsToGeoArrowTable 同一校验）。无有效点返回 null。
 */
export function pointsToGeoArrowFromIpc(ipc: Uint8Array, lonCol: string, latCol: string): Table | null {
  const table = tableFromIPC(ipc)
  const positions: number[] = []
  for (const batch of table.batches) {
    const lon = batch.getChild(lonCol)
    const lat = batch.getChild(latCol)
    const n = batch.numRows
    for (let i = 0; i < n; i++) {
      const lv = lon ? lon.get(i) : null
      const tv = lat ? lat.get(i) : null
      if (lv == null || tv == null) continue
      const lonN = Number(lv)
      const latN = Number(tv)
      if (!Number.isFinite(lonN) || !Number.isFinite(latN) || lonN < -180 || lonN > 180 || latN < -90 || latN > 90) continue
      positions.push(lonN, latN)
    }
  }
  if (positions.length === 0) return null
  const n = positions.length / 2
  const xyType = new FixedSizeList(2, new Field('xy', new Float64()))
  const geomData = makeData({
    type: xyType,
    length: n,
    child: makeData({ type: new Float64(), data: new Float64Array(positions) }),
  })
  const geomField = new Field(GEOMETRY_COL, xyType, true, POINT_EXT)
  const schema = new Schema([geomField])
  const structData = makeData({ type: new Struct([geomField]), length: n, children: [geomData] })
  return new Table(new RecordBatch(schema, structData))
}
