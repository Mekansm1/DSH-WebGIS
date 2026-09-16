/**
 * GeoJSON ↔ 扁平 typed array 编解码 —— worker 传输层。
 *
 * ## 为什么存在
 * `worker_threads` 传对象只有 structuredClone 一条路:它要**序列化 + 全量复制 + 反序列化**三趟,
 * 20 万面图层实测约 602MB,占掉一次 simplify 的 16s 里约 11s。而传输层其实只需要"把数据搬过去",
 * 不需要保留对象图 —— 于是改成:主线程把几何写进 typed array(`transferList` 零拷贝移交),
 * worker 在自己线程上重建 GeoJSON。
 *
 * ## 设计约束(改动前先读)
 * 1. **本文件零 turf import**。主线程和 worker 都要加载它,拉进 `@turf/*` 会让 worker 启动更贵。
 * 2. **语义透明**:解码结果必须与编码输入**逐字段等价**,因为下游是现有那批 `opXxx`,
 *    它们的行为已被大量测试锁定,不允许被传输层悄悄改变。等价性由 `tests/geo-job-codec.test.mjs`
 *    的对拍测试保证 —— 改本文件必须同步跑它。
 * 3. **不确定就退回 structuredClone**,绝不猜。`encode` 返回 `reasons` 时调用方走原路径,
 *    宁可慢也不能错。`notes` 是非致命的信息(如属性键序被归一化),要记录、要能看见。
 *
 * ## 几何表示:两层 offsets + 外环标志
 * ```
 * coords     Float64Array   interleaved 位置流,stride ∈ {2,3}
 * partStart  Uint32Array(P+1)  第 p 个"部件"(线 / 环;点要素的部件是单点)的起始【位置序号】
 * geomStart  Uint32Array(N+1)  第 n 个要素占用的部件区间 [geomStart[n], geomStart[n+1])
 * geomType   Uint8Array(N)     见 T_* 常量
 * partOuter  Uint8Array(P)     该部件是否为某个多边形的【外环】(1=是)
 * ```
 * 为什么不设第三层"要素→多边形→环":MultiPolygon 的多边形分组**等价于外环哨兵** ——
 * 顺序扫描,遇 `partOuter=1` 就开一个新多边形,紧随其后的 `=0` 都是它的洞。于是第三层被压成
 * 一个 `Uint8Array(P)`(20 万环 = 200KB),而三层方案在 MultiPolygon 之外全是恒等映射、纯浪费。
 *
 * ## 属性:列式 + 三态 mask
 * `mask` 必须三态(`0=该要素无此键 / 1=值为 null / 2=值在列里`),因为 `{}` 与 `{a:null}` 虽然
 * 在 `properties?.['a']` 上都是 falsy,但在 `JSON.stringify` 给客户端的输出里不同 ——
 * absent 键会消失、null 键会保留。`propsKind` 另标整个 `properties` 的形态(`{}` / `null` / 有键)。
 */
import type { BBox, Feature, FeatureCollection, Geometry, Position } from 'geojson'

/** 几何类型码。`T_ESCAPE` 与 `T_NULL` 都不占部件。 */
export const T_POINT = 0
export const T_MULTIPOINT = 1
export const T_LINESTRING = 2
export const T_MULTILINESTRING = 3
export const T_POLYGON = 4
export const T_MULTIPOLYGON = 5
/** GeometryCollection:递归结构,无损需链表 —— 让这一小撮要素单独付 structuredClone 成本。 */
export const T_ESCAPE = 6
export const T_NULL = 255

/** 属性列的标量类型码。 */
const K_NUMBER = 0
const K_STRING = 1
const K_BOOLEAN = 2

/**
 * `propsKind`:整个 `properties` 的形态。**必须四态。**
 * `undefined`(键整个缺失)与 `null` 在 `properties?.[k]` 上都是 undefined-ish,但在
 * `JSON.stringify` 给客户端的输出里不同 —— null 会保留键,undefined 会让键消失。
 * 把它们并成一态就是静默改数据。
 */
const P_EMPTY = 0 // {}
const P_NULL = 1 // null
const P_KEYS = 2 // 有键
const P_UNDEFINED = 3 // 键缺失(properties === undefined)

/** 属性三态 mask。 */
const M_ABSENT = 0
const M_NULL = 1
const M_PRESENT = 2

/** 一串字符串的列式表示:`bytes` 里连续存放,`offsets[i]..offsets[i+1]` 是第 i 个值的字节区间。 */
export interface Utf8Column {
  bytes: Uint8Array
  offsets: Uint32Array
}

/** 属性列。每键一列,列型由 `kinds[i]` 决定,`masks[i]` 是三态 mask。 */
export interface FlatProps {
  /** 全图层出现过的键,按**首次出现顺序**(解码按此顺序建对象)。 */
  keys: string[]
  /** 每键的标量类型码(K_*)。列内类型已统一 —— 混合类型的键会在编码期被判为不支持。 */
  kinds: Uint8Array
  masks: Uint8Array[]
  nums: Array<Float64Array | null>
  strs: Array<Utf8Column | null>
  bools: Array<Uint8Array | null>
  /** 每要素的 `properties` 形态(P_*)。 */
  propsKind: Uint8Array
}

/** 一个扁平化的 FeatureCollection。 */
export interface FlatFC {
  /** 坐标分量数:2 或 3。全集合统一 —— 混维会在编码期被判为不支持。 */
  stride: number
  /** 要素数。 */
  n: number
  coords: Float64Array
  partStart: Uint32Array
  geomStart: Uint32Array
  geomType: Uint8Array
  partOuter: Uint8Array
  /** 仅当存在 `T_ESCAPE` 要素时分配;其余位置为 null。长度 = n。 */
  escape: Array<Geometry | null> | null
  /** 仅当至少一个要素带 `id` 时分配。长度 = n。 */
  ids: Array<string | number | null> | null
  /** 仅当至少一个要素带 `bbox` 时分配。长度 = n。 */
  featureBbox: Array<BBox | null> | null
  /** 仅当要素集合自身带 `bbox` 时非 null。 */
  collectionBbox: BBox | null
  props: FlatProps | null
  /**
   * 要素对象里 `properties` 是否排在 `geometry` 之前。
   *
   * 为什么要记这一个 bit:JSON 的键序不影响语义,**但影响 `JSON.stringify` 的字节**。
   * GeoJSON 两种写法都常见(`{type,properties,geometry}` 与 `{type,geometry,properties}`),
   * 解码时按输入的顺序重建才能做到逐字节等价 —— 否则"值一样、字节不同",
   * 属于那种不报错但会让对比/缓存困惑的差异。
   *
   * ⚠️ 只保证这一个相对顺序。`id`/`bbox` 的绝对位置不保留(它们在 GeoJSON 里罕见,
   * 且下游按 key 读取)。这是刻意取舍,不是遗漏。
   */
  propsBeforeGeom: boolean
}

/** 编码结果:要么可扁平化,要么给出**具体**的不支持理由(调用方据此退回 structuredClone)。 */
export type EncodeResult =
  | { ok: true; flat: FlatFC; transfer: ArrayBuffer[]; notes: string[] }
  | { ok: false; reasons: string[] }

// ---------------------------------------------------------------------------
// 几何:计数趟 + 写入趟(两趟,避免中间 JS 数组 —— 那正是要消灭的开销)
// ---------------------------------------------------------------------------

interface Measure {
  positions: number
  parts: number
  /** 该几何内部一致的位置维数(2 或 3);null = 该几何无坐标(空集合)。 */
  stride: number | null
}

/**
 * 计数趟。返回 null = 这个几何不支持扁平化(GeometryCollection / 非法坐标形状 / 内部混维)。
 * 只做计数与形状校验,不分配任何东西。
 */
function measureGeometry(g: Geometry | null): Measure | { bad: string } | null {
  if (g === null) return { positions: 0, parts: 0, stride: null }
  switch (g.type) {
    case 'GeometryCollection':
      return null // 走 escape 侧信道,由调用方判定是否可接受
    case 'Point': {
      const st = strideOf(g.coordinates as Position)
      return st === BAD ? { bad: 'Point 坐标形状非法' } : { positions: 1, parts: 1, stride: st }
    }
    case 'MultiPoint': {
      let st: number | null = null
      for (const p of g.coordinates) {
        const s = strideOf(p)
        if (s === BAD) return { bad: 'MultiPoint 坐标形状非法' }
        if (st === null) st = s
        else if (st !== s) return { bad: 'MultiPoint 内部混维' }
      }
      return { positions: g.coordinates.length, parts: g.coordinates.length, stride: st }
    }
    case 'LineString': {
      const st = strideOfList(g.coordinates)
      if (st === BAD) return { bad: 'LineString 坐标形状非法或内部混维' }
      return { positions: g.coordinates.length, parts: 1, stride: st }
    }
    case 'MultiLineString': {
      const st = strideOfLists(g.coordinates)
      if (st === BAD) return { bad: 'MultiLineString 坐标形状非法或内部混维' }
      let n = 0
      for (const l of g.coordinates) n += l.length
      return { positions: n, parts: g.coordinates.length, stride: st }
    }
    case 'Polygon': {
      const st = strideOfLists(g.coordinates)
      if (st === BAD) return { bad: 'Polygon 坐标形状非法或内部混维' }
      let n = 0
      for (const r of g.coordinates) n += r.length
      return { positions: n, parts: g.coordinates.length, stride: st }
    }
    case 'MultiPolygon': {
      const st = strideOfListsOfLists(g.coordinates)
      if (st === BAD) return { bad: 'MultiPolygon 坐标形状非法或内部混维' }
      let n = 0
      let parts = 0
      for (const poly of g.coordinates) {
        parts += poly.length
        for (const r of poly) n += r.length
      }
      return { positions: n, parts, stride: st }
    }
    default:
      return { bad: `未知几何类型 ${String((g as { type?: unknown }).type)}` }
  }
}

/**
 * 「形状非法」哨兵。**必须与 `null` 区分开**:`null` 表示"这一层没有坐标"(空数组是合法
 * GeoJSON,如 `LineString: []`、`Polygon: []`),而 `BAD` 才是真的不合法。把两者混成一个
 * 值会让空几何被整单拒绝、白白退回 structuredClone。
 */
const BAD = Symbol('geo-job-codec:bad-shape')

/** 单个位置的维数;非 2/3 或含非数字 → BAD(位置不存在"空"这一说)。 */
function strideOf(p: unknown): number | typeof BAD {
  if (!Array.isArray(p) || (p.length !== 2 && p.length !== 3)) return BAD
  for (const v of p) if (typeof v !== 'number') return BAD
  return p.length
}

/** 一条位置序列的维数。空序列 → null(合法无坐标);非法或内部混维 → BAD。 */
function strideOfList(list: unknown): number | null | typeof BAD {
  if (!Array.isArray(list)) return BAD
  let st: number | null = null
  for (const p of list) {
    const s = strideOf(p)
    if (s === BAD) return BAD
    if (st === null) st = s
    else if (st !== s) return BAD
  }
  return st
}

/** 环/线数组(LineString[] / Polygon 环)的维数。空 → null;非法或跨项混维 → BAD。 */
function strideOfLists(lists: unknown): number | null | typeof BAD {
  if (!Array.isArray(lists)) return BAD
  let st: number | null = null
  for (const l of lists) {
    const s = strideOfList(l)
    if (s === BAD) return BAD
    if (s === null) continue
    if (st === null) st = s
    else if (st !== s) return BAD
  }
  return st
}

/** MultiPolygon 的维数。空 → null;非法或跨项混维 → BAD。 */
function strideOfListsOfLists(lists: unknown): number | null | typeof BAD {
  if (!Array.isArray(lists)) return BAD
  let st: number | null = null
  for (const l of lists) {
    const s = strideOfLists(l)
    if (s === BAD) return BAD
    if (s === null) continue
    if (st === null) st = s
    else if (st !== s) return BAD
  }
  return st
}

/** 写入趟的光标状态。 */
interface Sink {
  coords: Float64Array
  partStart: Uint32Array
  partOuter: Uint8Array
  stride: number
  pos: number
  part: number
}

/** 写入一个部件(一段位置序列);`outer` 表示它是否是多边形的外环。 */
function writePart(sink: Sink, list: Position[], outer: boolean): void {
  sink.partStart[sink.part] = sink.pos
  sink.partOuter[sink.part] = outer ? 1 : 0
  sink.part++
  for (const p of list) {
    const base = sink.pos * sink.stride
    for (let k = 0; k < sink.stride; k++) sink.coords[base + k] = p[k] as number
    sink.pos++
  }
}

/** 写入趟。与 `measureGeometry` 必须严丝合缝 —— 计数错了这里就越界。 */
function writeGeometry(sink: Sink, g: Geometry): void {
  switch (g.type) {
    case 'Point':
      writePart(sink, [g.coordinates as Position], false)
      return
    case 'MultiPoint':
      for (const p of g.coordinates) writePart(sink, [p], false)
      return
    case 'LineString':
      writePart(sink, g.coordinates, false)
      return
    case 'MultiLineString':
      for (const l of g.coordinates) writePart(sink, l, false)
      return
    case 'Polygon':
      g.coordinates.forEach((r, i) => writePart(sink, r, i === 0))
      return
    case 'MultiPolygon':
      for (const poly of g.coordinates) poly.forEach((r, i) => writePart(sink, r, i === 0))
      return
    default:
      // measureGeometry 已把 GC / 未知类型挡在外面;走到这里说明两趟不一致,属内部错误。
      throw new Error(`writeGeometry: 不该出现的几何类型 ${String((g as { type?: unknown }).type)}`)
  }
}

// ---------------------------------------------------------------------------
// 属性
// ---------------------------------------------------------------------------

/** 属性值是否是可列式化的标量。`undefined` 判为不可 —— JSON 不会产出它,出现即来自手搓对象,含义有歧义。 */
function scalarKindOf(v: unknown): number | null {
  if (typeof v === 'number') return K_NUMBER
  if (typeof v === 'string') return K_STRING
  if (typeof v === 'boolean') return K_BOOLEAN
  return null
}

interface PropsPrep {
  props: FlatProps
  notes: string[]
}

/**
 * 准备属性列。返回 null = 不支持(有非标量值,或同一个键在不同要素上类型不一致)。
 *
 * 类型不一致(如 `{v:1}` 与 `{v:"n/a"}`)确实在真实数据里常见,但**本版选择整 job 退回
 * structuredClone 而不是逐要素混合** —— 混合需要每种类型各存一列 + 一个 tag 列,
 * 解码复杂度翻倍。这是需要真实数据分布才能定的取舍,先把 `reasons` 报出来。
 */
function prepareProps(features: Feature[]): PropsPrep | { bad: string } | null {
  const n = features.length
  const propsKind = new Uint8Array(n)
  const keys: string[] = []
  const seen = new Set<string>()
  let anyKeys = false
  let keyOrderNormalized = false

  for (let i = 0; i < n; i++) {
    const f = features[i]
    // 「键缺失」与「值为 null」要分开 —— 见 P_UNDEFINED 的注释。
    if (f === undefined || !('properties' in f)) {
      propsKind[i] = P_UNDEFINED
      continue
    }
    const p = f.properties
    if (p === null) {
      propsKind[i] = P_NULL
      continue
    }
    const own = Object.keys(p)
    if (own.length === 0) {
      propsKind[i] = P_EMPTY
      continue
    }
    propsKind[i] = P_KEYS
    anyKeys = true
    for (const k of own) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      } else if (keys.indexOf(k) !== own.indexOf(k)) {
        // 键序与首次出现序不一致 —— 解码会归一化,记录但不致命(JSON 键序无语义)。
        keyOrderNormalized = true
      }
    }
  }
  if (!anyKeys) return { props: emptyProps(n, propsKind), notes: [] }

  const K = keys.length
  const kinds = new Uint8Array(K)
  const masks: Uint8Array[] = []
  const nums: Array<Float64Array | null> = []
  const strs: Array<Utf8Column | null> = []
  const bools: Array<Uint8Array | null> = []
  const kindKnown = new Uint8Array(K) // 0=未定 1=已定

  // 一遍填充:定类型 + 填 mask + 收集字符串(按要素顺序 push,故 p 列天然有序)
  const strParts: string[][] = keys.map(() => [])
  const numBufs: Float64Array[] = keys.map(() => new Float64Array(n))
  const boolBufs: Uint8Array[] = keys.map(() => new Uint8Array(n))
  for (let k = 0; k < K; k++) masks[k] = new Uint8Array(n)

  for (let i = 0; i < n; i++) {
    if (propsKind[i] !== P_KEYS) continue // `{}` / null:所有键都absent,掩码默认 0 即为所求
    const p = features[i]!.properties as Record<string, unknown>
    const own = Object.keys(p)
    for (let k = 0; k < K; k++) {
      const key = keys[k]!
      if (!own.includes(key)) continue // M_ABSENT
      const v = p[key]
      if (v === null) {
        masks[k]![i] = M_NULL
        continue
      }
      const kind = scalarKindOf(v)
      if (kind === null) return { bad: `属性 ${key} 含非标量值(对象/数组/undefined),无法列式化` }
      if (kindKnown[k] === 0) {
        kindKnown[k] = 1
        kinds[k] = kind
      } else if (kinds[k] !== kind) {
        return { bad: `属性 ${key} 在不同要素上类型不一致,无法列式化` }
      }
      masks[k]![i] = M_PRESENT
      if (kind === K_NUMBER) numBufs[k]![i] = v as number
      else if (kind === K_BOOLEAN) boolBufs[k]![i] = v ? 1 : 0
      else strParts[k]!.push(v as string)
    }
  }

  // 按已定类型产出列
  for (let k = 0; k < K; k++) {
    if (kindKnown[k] === 0) {
      // 该键在所有要素上都是 absent 或 null —— 用空字符串列占位,解码只走 mask 分支
      kinds[k] = K_STRING
      strs[k] = { bytes: new Uint8Array(0), offsets: new Uint32Array(n + 1) }
      nums[k] = null
      bools[k] = null
    } else if (kinds[k] === K_NUMBER) {
      nums[k] = numBufs[k]!
      strs[k] = null
      bools[k] = null
    } else if (kinds[k] === K_BOOLEAN) {
      bools[k] = boolBufs[k]!
      nums[k] = null
      strs[k] = null
    } else {
      strs[k] = encodeUtf8(strParts[k]!)
      nums[k] = null
      bools[k] = null
    }
  }

  // 键序归一化不致命(JSON 键序无语义),但要让调用方看得见 —— 静默改变输出字节同样是问题。
  const notes = keyOrderNormalized ? ['属性键序在不同要素间不一致,已按首次出现顺序归一化'] : []
  return { props: { keys, kinds, masks, nums, strs, bools, propsKind }, notes }
}

/** 无任何键时的空属性表(仍要保留 propsKind,因为 `{}` 与 `null` 有别)。 */
function emptyProps(n: number, propsKind: Uint8Array): FlatProps {
  return {
    keys: [],
    kinds: new Uint8Array(0),
    masks: [],
    nums: [],
    strs: [],
    bools: [],
    propsKind,
  }
}

/** `string[]` → UTF-8 字节 + offsets。 */
function encodeUtf8(values: string[]): Utf8Column {
  const enc = new TextEncoder()
  const parts = values.map((s) => enc.encode(s))
  let total = 0
  for (const b of parts) total += b.length
  const bytes = new Uint8Array(total)
  const offsets = new Uint32Array(values.length + 1)
  let o = 0
  for (let i = 0; i < parts.length; i++) {
    bytes.set(parts[i]!, o)
    o += parts[i]!.length
    offsets[i + 1] = o
  }
  return { bytes, offsets }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 编码一个 FeatureCollection。
 *
 * 返回 `{ok:false, reasons}` 表示**不支持扁平化**,调用方必须退回 structuredClone ——
 * 这是刻意的保守设计:编解码只做它能证明等价的事,证明不了就交给原路径。
 */
export function encodeFeatureCollection(fc: FeatureCollection): EncodeResult {
  const features = fc.features as Feature[]
  const n = features.length
  const reasons: string[] = []
  const notes: string[] = []

  // ---- 计数趟 ----
  let totalPositions = 0
  let totalParts = 0
  let stride: number | null = null
  let escapeCount = 0

  for (let i = 0; i < n; i++) {
    const g = (features[i]?.geometry ?? null) as Geometry | null
    const m = measureGeometry(g)
    if (m === null) {
      escapeCount++ // GeometryCollection:走 escape 侧信道
      continue
    }
    if ('bad' in m) {
      reasons.push(`要素 ${i}: ${m.bad}`)
      continue
    }
    if (m.stride !== null) {
      if (stride === null) stride = m.stride
      else if (stride !== m.stride) reasons.push(`坐标维数不一致(${stride} 与 ${m.stride} 混用)`)
    }
    totalPositions += m.positions
    totalParts += m.parts
  }

  // ---- 属性 ----
  const propsPrep = prepareProps(features)
  if (propsPrep !== null && 'bad' in propsPrep) reasons.push(propsPrep.bad)
  if (propsPrep !== null && 'notes' in propsPrep) notes.push(...propsPrep.notes)

  // 集合自身的 bbox:保留(否则 round-trip 不等价)。要素级 bbox 同理。
  const collectionBbox = (fc.bbox ?? null) as BBox | null
  const anyFeatureBbox = features.some((f) => f?.bbox != null)
  const anyId = features.some((f) => f?.id != null)

  if (reasons.length > 0) return { ok: false, reasons }

  // ---- 分配 + 写入趟 ----
  const st = stride ?? 2
  const coords = new Float64Array(totalPositions * st)
  const partStart = new Uint32Array(totalParts + 1)
  const geomStart = new Uint32Array(n + 1)
  const geomType = new Uint8Array(n)
  const partOuter = new Uint8Array(totalParts)
  const escape: Array<Geometry | null> | null = escapeCount > 0 ? new Array<Geometry | null>(n).fill(null) : null
  const ids: Array<string | number | null> | null = anyId ? new Array<string | number | null>(n).fill(null) : null
  const featureBbox: Array<BBox | null> | null = anyFeatureBbox ? new Array<BBox | null>(n).fill(null) : null

  const sink: Sink = { coords, partStart, partOuter, stride: st, pos: 0, part: 0 }
  for (let i = 0; i < n; i++) {
    const f = features[i]!
    geomStart[i] = sink.part
    const g = (f.geometry ?? null) as Geometry | null
    if (g === null) {
      geomType[i] = T_NULL
    } else if (g.type === 'GeometryCollection') {
      geomType[i] = T_ESCAPE
      escape![i] = g
    } else {
      geomType[i] = TYPE_CODE[g.type]!
      writeGeometry(sink, g)
    }
    if (ids) ids[i] = (f.id ?? null) as string | number | null
    if (featureBbox) featureBbox[i] = (f.bbox ?? null) as BBox | null
  }
  geomStart[n] = sink.part
  partStart[totalParts] = sink.pos

  const flat: FlatFC = {
    stride: st,
    n,
    coords,
    partStart,
    geomStart,
    geomType,
    partOuter,
    escape,
    ids,
    featureBbox,
    collectionBbox,
    props: propsPrep !== null && 'props' in propsPrep ? propsPrep.props : null,
    propsBeforeGeom: detectPropsBeforeGeom(features),
  }

  // 🔴 只有**本函数新分配**的 buffer 才能进 transferList。绝不能转移调用方已有的 typed array ——
  // 一旦转移,主线程那边的图层 buffer 会被 detach,数据静默损坏。
  const transfer: ArrayBuffer[] = [
    coords.buffer as ArrayBuffer,
    partStart.buffer as ArrayBuffer,
    geomStart.buffer as ArrayBuffer,
    geomType.buffer as ArrayBuffer,
    partOuter.buffer as ArrayBuffer,
  ]
  if (flat.props) {
    for (const c of flat.props.strs) if (c) transfer.push(c.bytes.buffer as ArrayBuffer, c.offsets.buffer as ArrayBuffer)
    for (const c of flat.props.nums) if (c) transfer.push(c.buffer as ArrayBuffer)
    for (const c of flat.props.bools) if (c) transfer.push(c.buffer as ArrayBuffer)
    for (const m of flat.props.masks) transfer.push(m.buffer as ArrayBuffer)
    transfer.push(flat.props.kinds.buffer as ArrayBuffer, flat.props.propsKind.buffer as ArrayBuffer)
  }

  return { ok: true, flat, transfer, notes }
}

/** 几何类型 → 类型码。 */
const TYPE_CODE: Record<string, number> = {
  Point: T_POINT,
  MultiPoint: T_MULTIPOINT,
  LineString: T_LINESTRING,
  MultiLineString: T_MULTILINESTRING,
  Polygon: T_POLYGON,
  MultiPolygon: T_MULTIPOLYGON,
}

/** 读第 p 个部件覆盖的位置区间 `[start, end)`。 */
function partRange(flat: FlatFC, p: number): [number, number] {
  return [flat.partStart[p]!, flat.partStart[p + 1]!]
}

/** 取一个位置(按 stride 还原成 `number[]`)。 */
function readPosition(flat: FlatFC, idx: number): Position {
  const base = idx * flat.stride
  const out: number[] = new Array(flat.stride)
  for (let k = 0; k < flat.stride; k++) out[k] = flat.coords[base + k]!
  return out as Position
}

/** 取一段部件的位置序列。 */
function readPart(flat: FlatFC, p: number): Position[] {
  const [start, end] = partRange(flat, p)
  const out: Position[] = new Array(end - start)
  for (let i = start; i < end; i++) out[i - start] = readPosition(flat, i)
  return out
}

/** 由 flat 重建第 n 个要素的几何。 */
function decodeGeometry(flat: FlatFC, i: number): Geometry | null {
  const t = flat.geomType[i]!
  if (t === T_NULL) return null
  if (t === T_ESCAPE) return flat.escape?.[i] ?? null
  const gs = flat.geomStart[i]!
  const ge = flat.geomStart[i + 1]!
  switch (t) {
    case T_POINT:
      return { type: 'Point', coordinates: readPosition(flat, partRange(flat, gs)[0]) }
    case T_MULTIPOINT: {
      const coordinates: Position[] = []
      for (let p = gs; p < ge; p++) coordinates.push(readPart(flat, p)[0]!)
      return { type: 'MultiPoint', coordinates } as Geometry
    }
    case T_LINESTRING:
      return { type: 'LineString', coordinates: readPart(flat, gs) } as Geometry
    case T_MULTILINESTRING: {
      const coordinates: Position[][] = []
      for (let p = gs; p < ge; p++) coordinates.push(readPart(flat, p))
      return { type: 'MultiLineString', coordinates } as Geometry
    }
    case T_POLYGON: {
      const coordinates: Position[][] = []
      for (let p = gs; p < ge; p++) coordinates.push(readPart(flat, p))
      return { type: 'Polygon', coordinates } as Geometry
    }
    case T_MULTIPOLYGON: {
      const coordinates: Position[][][] = []
      let cur: Position[][] | null = null
      for (let p = gs; p < ge; p++) {
        if (flat.partOuter[p] === 1 || cur === null) {
          cur = []
          coordinates.push(cur)
        }
        cur.push(readPart(flat, p))
      }
      return { type: 'MultiPolygon', coordinates } as Geometry
    }
    default:
      throw new Error(`decodeGeometry: 未知类型码 ${t}`)
  }
}

/** `decodeProps` 的第三态:整个 `properties` 键缺失(与 `null` 不同,见 P_UNDEFINED)。 */
const ABSENT = Symbol('geo-job-codec: properties-absent')

/**
 * 还原一个属性对象(或 null,或"键缺失")。
 *
 * ⚠️ `cursors` 是**每个字符串列当前该取第几个 present 值**的游标,由调用方在 i 递增的循环里
 * 传递。字符串列为了省内存只存 present 值(紧凑排布),所以要按 mask 计数才能定位。
 * **绝不要写成"对每一行回扫前面的 mask"** —— 那是 O(n²):实测 20 万面 × 1 个字符串列
 * 要跑 26.75 秒(小 N 单测完全测不出来)。用游标摊还后是 O(n·列数)。
 */
function decodeProps(flat: FlatFC, i: number, cursors: Uint32Array): Record<string, unknown> | null | typeof ABSENT {
  const p = flat.props
  if (!p) return null
  const kind = p.propsKind[i]!
  if (kind === P_UNDEFINED) return ABSENT
  if (kind === P_NULL) return null
  if (kind === P_EMPTY) return {}
  const out: Record<string, unknown> = {}
  for (let k = 0; k < p.keys.length; k++) {
    const m = p.masks[k]![i]!
    if (m === M_ABSENT) continue
    if (m === M_NULL) {
      out[p.keys[k]!] = null
      continue
    }
    const kk = p.kinds[k]!
    if (kk === K_NUMBER) out[p.keys[k]!] = p.nums[k]![i]!
    else if (kk === K_BOOLEAN) out[p.keys[k]!] = p.bools[k]![i] === 1
    else out[p.keys[k]!] = decodeUtf8At(p.strs[k]!, cursors[k]!++)
  }
  return out
}

/** 取字符串列第 idx 个值。 */
function decodeUtf8At(col: Utf8Column, idx: number): string {
  const a = col.offsets[idx]!
  const b = col.offsets[idx + 1]!
  return DECODER.decode(col.bytes.subarray(a, b))
}

const DECODER = new TextDecoder()

/**
 * 由 flat 重建 FeatureCollection(逐字段等价于编码输入)。
 *
 * ⚠️ 类型说明:`@types/geojson` 的 `Feature<G = Geometry>` **默认不含 null**,
 * 而 GeoJSON 允许 `geometry: null`(且 `opSpatialJoin` 不 clean 就遍历,必须原样保留)。
 * 所以内部按 `Feature<Geometry | null>` 构造,出口再收口成项目惯用的 `FeatureCollection` ——
 * 这个 cast 只关乎类型库的默认参数,不改变任何运行时值。
 */
export function decodeFeatureCollection(flat: FlatFC): FeatureCollection {
  // 用宽松的记录类型构造:`properties` 有四态(含"键缺失"),`@types/geojson` 表达不了;
  // 出口统一收口成 `FeatureCollection`(见上面的类型说明)。
  const features: Array<Record<string, unknown>> = new Array(flat.n)
  // 字符串列的定位游标（见 decodeProps 的说明：按行回扫是 O(n²)）
  const cursors = new Uint32Array(flat.props ? flat.props.keys.length : 0)
  for (let i = 0; i < flat.n; i++) {
    // 按输入原本的键序重建：`{type,properties,geometry}` 与 `{type,geometry,properties}` 都常见，
    // 顺序错了就是"值一样、JSON.stringify 字节不同"。见 FlatFC.propsBeforeGeom。
    const props = decodeProps(flat, i, cursors)
    const f: Record<string, unknown> = { type: 'Feature' }
    if (flat.propsBeforeGeom && props !== ABSENT) f.properties = props
    f.geometry = decodeGeometry(flat, i)
    if (!flat.propsBeforeGeom && props !== ABSENT) f.properties = props
    if (flat.ids) {
      const id = flat.ids[i]
      if (id != null) f.id = id
    }
    if (flat.featureBbox) {
      const b = flat.featureBbox[i]
      if (b) f.bbox = b
    }
    features[i] = f
  }
  const out = { type: 'FeatureCollection', features } as unknown as FeatureCollection
  if (flat.collectionBbox) out.bbox = flat.collectionBbox
  return out
}

/** 探测要素层的键序(取第一个要素)。见 `FlatFC.propsBeforeGeom` 的说明。 */
function detectPropsBeforeGeom(features: Feature[]): boolean {
  for (const f of features) {
    if (!f || typeof f !== 'object') continue
    const keys = Object.keys(f)
    const pi = keys.indexOf('properties')
    const gi = keys.indexOf('geometry')
    if (pi >= 0 && gi >= 0) return pi < gi
  }
  return false
}

// ---------------------------------------------------------------------------
// job / result 级别的编解码(worker 传的是整个 job,不只是单个 FeatureCollection)
// ---------------------------------------------------------------------------

/**
 * 各 job kind 里**携带几何**的字段名。
 *
 * 维护要求:新增 job kind 必须在这里登记,否则 `encodeJob` 会把它当标量走 structuredClone ——
 * 不会算错(标量克隆仍然正确),但会静默失去扁平化的收益。`tests/geo-job-codec.test.mjs`
 * 有一条覆盖全部 kind 的登记检查。
 */
export const JOB_GEO_FIELDS: Record<string, readonly string[]> = {
  buffer: ['layer'],
  dissolve: ['layer'],
  simplify: ['layer'],
  clip: ['a', 'b'],
  intersect: ['a', 'b'],
  difference: ['a', 'b'],
  union: ['a', 'b'],
  spatialJoin: ['target', 'join'],
  selectByLocation: ['layer', 'overlay'], // overlay 可缺省
  voronoi: ['layer'],
  regularGrid: [], // 没有几何入参 —— 正好用来验证编解码器的"零输入"路径
  kernelDensity: ['geojson'],
  ann: ['geojson'],
  moran: ['geojson'],
  localMoran: ['geojson'],
  getisOrd: ['geojson'],
}

/**
 * 扁平化的 job:几何进 `geo`,其余标量原样留 `scalars`。
 *
 * `__flat` 是**判别标记**:宿主编码失败时会退回把裸 job 交给 worker(structuredClone),
 * worker 必须能分辨两者。裸 job 也有 `kind`,所以不能靠 kind 判。
 */
export interface FlatJob {
  __flat: true
  kind: string
  scalars: Record<string, unknown>
  /** 几何字段名 → 扁平集合。缺省字段(如 selectByLocation 的 overlay)不出现在这里。 */
  geo: Record<string, FlatFC>
}

/** worker 侧判别:收到的是扁平 job 还是退回克隆的裸 job。 */
export function isFlatJob(x: unknown): x is FlatJob {
  return !!x && typeof x === 'object' && (x as FlatJob).__flat === true
}

/** job 编码结果;`ok:false` 表示**任一**几何无法扁平化 → 整个 job 退回 structuredClone。 */
export type EncodeJobResult =
  | { ok: true; flat: FlatJob; transfer: ArrayBuffer[]; notes: string[] }
  | { ok: false; reasons: string[] }

/**
 * 编码整个 job。
 *
 * `geojson` 字段(统计类)与 `layer`/`a`/`b`/… 字段(图层类,形如 `{geojson}`)在解码时
 * 会还原成各自原来的形状 —— 传输层对算子完全透明。
 */
export function encodeJob(job: { kind: string } & Record<string, unknown>): EncodeJobResult {
  const fields = JOB_GEO_FIELDS[job.kind]
  if (!fields) return { ok: false, reasons: [`未知 job kind: ${job.kind}(未在 JOB_GEO_FIELDS 登记)`] }

  const scalars: Record<string, unknown> = {}
  const geo: Record<string, FlatFC> = {}
  const transfer: ArrayBuffer[] = []
  const notes: string[] = []

  for (const [k, v] of Object.entries(job)) {
    if (k === 'kind') continue
    if (!fields.includes(k) || v === undefined) {
      scalars[k] = v // 标量字段(含可缺省的 overlay)原样走 structuredClone
      continue
    }
    // `geojson` 字段直接就是 FeatureCollection;其余形如 `{ geojson }`。
    const fc = (k === 'geojson' ? v : (v as { geojson?: unknown })?.geojson) as FeatureCollection | undefined
    if (!fc || typeof fc !== 'object' || !Array.isArray((fc as FeatureCollection).features)) {
      scalars[k] = v
      continue
    }
    const r = encodeFeatureCollection(fc)
    if (!r.ok) return { ok: false, reasons: r.reasons.map((x) => `${k}: ${x}`) }
    geo[k] = r.flat
    transfer.push(...r.transfer)
    notes.push(...r.notes)
  }
  return { ok: true, flat: { __flat: true, kind: job.kind, scalars, geo }, transfer, notes }
}

/** 还原 job(几何字段的形状与编码前一致)。 */
export function decodeJob(flat: FlatJob): { kind: string } & Record<string, unknown> {
  const out: Record<string, unknown> = { kind: flat.kind }
  for (const [k, v] of Object.entries(flat.scalars)) out[k] = v
  for (const [k, g] of Object.entries(flat.geo)) {
    const fc = decodeFeatureCollection(g)
    out[k] = k === 'geojson' ? fc : { geojson: fc }
  }
  return out as { kind: string } & Record<string, unknown>
}

/**
 * 结果的扁平信封。
 *
 * ⚠️ 用 `t` 而**不是** `ok` —— 4 个统计 op 的**正常返回值本身就是 `{ok:false,message}`**
 * (如"网格过密")。若信封也用 `ok`,业务失败会被误判成进程失败。
 */
export type FlatResult =
  | { t: 'ok'; geo: FlatFC | null; scalars: unknown }
  | { t: 'err'; message: string }

/** 结果编码:能扁平化就扁平化,不能就整个退回 structuredClone(不报错,只是慢)。 */
export function encodeResult(value: unknown): { flat: FlatResult; transfer: ArrayBuffer[] } {
  const asFC = (x: unknown): FeatureCollection | null =>
    x && typeof x === 'object' && (x as FeatureCollection).type === 'FeatureCollection' ? (x as FeatureCollection) : null
  const bare = asFC(value)
  const withGeo = !bare && value && typeof value === 'object'
    ? { geo: asFC((value as { geojson?: unknown }).geojson), scalars: { ...(value as Record<string, unknown>) } }
    : null
  const target = bare ?? withGeo?.geo ?? null
  if (!target) return { flat: { t: 'ok', geo: null, scalars: value }, transfer: [] }

  const r = encodeFeatureCollection(target)
  if (!r.ok) return { flat: { t: 'ok', geo: null, scalars: value }, transfer: [] }
  if (bare) return { flat: { t: 'ok', geo: r.flat, scalars: null }, transfer: r.transfer }
  const scalars = withGeo!.scalars
  delete scalars.geojson // 几何单独走 geo,避免重复搬运
  return { flat: { t: 'ok', geo: r.flat, scalars }, transfer: r.transfer }
}

/** 还原结果(与 operator 的原始返回逐字段等价)。 */
export function decodeResult(flat: FlatResult): unknown {
  if (flat.t === 'err') throw new Error(flat.message)
  if (!flat.geo) return flat.scalars
  const fc = decodeFeatureCollection(flat.geo)
  if (flat.scalars === null) return fc
  return { ...(flat.scalars as Record<string, unknown>), geojson: fc }
}
