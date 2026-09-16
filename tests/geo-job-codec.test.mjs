/**
 * 扁平编解码（src/geo-job-codec.ts）等价性测试。
 *
 * 这是本次 worker 改造里**最重要的一根杠杆**：编解码是纯函数、不需要 worker、毫秒级、可穷举。
 * 只要 `decode(encode(fc))` 与 `fc` 逐字段相等，下游那批 `opXxx` 就不可能被传输层改变行为 ——
 * 「大数据不再卡死」这件事才不会以「结果悄悄变了」为代价。
 *
 * 改动 geo-job-codec.ts 必须重跑本文件。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeFeatureCollection, encodeFeatureCollection } from '../lib/geo-job-codec.js'

/** 造一个 Feature。 */
const F = (geometry, properties, extra = {}) => ({ type: 'Feature', geometry, properties, ...extra })
const FC = (...features) => ({ type: 'FeatureCollection', features })

/** 编码成功并返回 flat；失败则带理由炸出来，便于定位。 */
function enc(fc) {
  const r = encodeFeatureCollection(fc)
  assert.equal(r.ok, true, `本应可扁平化，却被拒：${r.ok ? '' : r.reasons.join('; ')}`)
  return r
}

/** 对拍：decode(encode(fc)) 必须与 fc 逐字段相等。 */
function roundTrip(fc, label) {
  const r = enc(fc)
  assert.deepStrictEqual(decodeFeatureCollection(r.flat), fc, `round-trip 不等价：${label}`)
  return r
}

// ---------------------------------------------------------------------------
// 几何：7 种类型
// ---------------------------------------------------------------------------

const GEOMS = {
  Point: { type: 'Point', coordinates: [113.264, 23.129] },
  MultiPoint: { type: 'MultiPoint', coordinates: [[113.1, 23.1], [113.2, 23.2], [113.3, 23.3]] },
  LineString: { type: 'LineString', coordinates: [[113.1, 23.1], [113.2, 23.2], [113.3, 23.3]] },
  MultiLineString: {
    type: 'MultiLineString',
    coordinates: [[[113.1, 23.1], [113.2, 23.2]], [[114.1, 24.1], [114.2, 24.2], [114.3, 24.3]]],
  },
  Polygon: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
  MultiPolygon: {
    type: 'MultiPolygon',
    coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]],
  },
}

for (const [name, geom] of Object.entries(GEOMS)) {
  test(`几何往返：${name}`, () => {
    roundTrip(FC(F(geom, { a: 1 })), name)
  })
}

test('几何往返：带洞多边形（环序与内外环必须原样保留）', () => {
  const poly = {
    type: 'Polygon',
    coordinates: [
      [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], // 外环
      [[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]],     // 洞 1
      [[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]],     // 洞 2
    ],
  }
  roundTrip(FC(F(poly, {})), '带洞多边形')
})

test('几何往返：MultiPolygon 每个多边形都带洞（验证 partOuter 分组）', () => {
  const mp = {
    type: 'MultiPolygon',
    coordinates: [
      [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[2, 2], [3, 2], [3, 3], [2, 3], [2, 2]],
      ],
      [
        [[100, 100], [110, 100], [110, 110], [100, 110], [100, 100]],
        [[102, 102], [103, 102], [103, 103], [102, 103], [102, 102]],
        [[105, 105], [106, 105], [106, 106], [105, 106], [105, 105]],
      ],
      [
        [[200, 200], [210, 200], [210, 210], [200, 210], [200, 200]],
      ],
    ],
  }
  const r = roundTrip(FC(F(mp, {})), 'MultiPolygon 带洞')
  // 结构断言：3 个多边形 → 6 个部件，其中 3 个被标为外环
  const outer = [...r.flat.partOuter].filter((v) => v === 1).length
  assert.equal(outer, 3, '应恰好有 3 个外环哨兵（每个多边形一个）')
  assert.equal(r.flat.geomStart[1], 6, '该要素应占用 6 个部件')
})

test('几何往返：3D 坐标（stride=3，不补零）', () => {
  const g = { type: 'LineString', coordinates: [[113.1, 23.1, 50], [113.2, 23.2, 60]] }
  const r = roundTrip(FC(F(g, {})), '3D')
  assert.equal(r.flat.stride, 3)
})

test('几何往返：geometry 为 null（opSpatialJoin 不 clean 就遍历，必须原样保留）', () => {
  roundTrip(FC(F(null, { a: 1 }), F(GEOMS.Point, { b: 2 })), 'null 几何混合')
})

test('几何往返：空坐标数组（LineString []、Polygon []、Polygon [[]]）', () => {
  roundTrip(
    FC(
      F({ type: 'LineString', coordinates: [] }, {}),
      F({ type: 'Polygon', coordinates: [] }, {}),
      F({ type: 'Polygon', coordinates: [[]] }, {}),
      F({ type: 'MultiLineString', coordinates: [] }, {}),
      F({ type: 'MultiPolygon', coordinates: [] }, {}),
    ),
    '空坐标',
  )
})

test('几何往返：GeometryCollection 走 escape 侧信道（不作为整单拒绝理由）', () => {
  const gc = {
    type: 'GeometryCollection',
    geometries: [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }],
  }
  const r = roundTrip(FC(F(gc, { k: 1 }), F(GEOMS.Point, { k: 2 })), 'GC 逃逸')
  assert.equal(r.flat.geomType[0], 6, 'GC 要素应标为 T_ESCAPE')
  assert.equal(r.flat.geomType[1], 0, '普通要素不受影响')
  assert.ok(r.flat.escape, '存在 GC 时应分配 escape 侧信道')
})

test('几何往返：坐标精度（1e6 量级 + 多位小数不得被 Float64 截断）', () => {
  const g = { type: 'Point', coordinates: [1234567.890123456, -987654.321098765] }
  roundTrip(FC(F(g, {})), '大数精度')
})

test('几何往返：NaN / -0 等特殊数值原样保留', () => {
  const g = { type: 'MultiPoint', coordinates: [[NaN, 0], [-0, 1]] }
  const r = roundTrip(FC(F(g, {})), 'NaN/-0')
  assert.ok(Number.isNaN(r.flat.coords[0]), 'NaN 应保留')
  assert.ok(Object.is(r.flat.coords[2], -0), '-0 应保留（与 0 不同）')
})

// ---------------------------------------------------------------------------
// 属性：四态 + 标量列
// ---------------------------------------------------------------------------

test('属性往返：四态各自保留（{} / null / 键缺失 / 有键）', () => {
  const fc = FC(
    F(GEOMS.Point, {}),
    F(GEOMS.Point, null),
    { type: 'Feature', geometry: GEOMS.Point }, // 无 properties 键
    F(GEOMS.Point, { a: 1, b: 'x', c: true }),
  )
  roundTrip(fc, '属性四态')
})

test('属性往返：键缺失 vs 值为 null 必须可区分（JSON.stringify 下前者键消失）', () => {
  const fc = FC(F(GEOMS.Point, { a: null }), { type: 'Feature', geometry: GEOMS.Point })
  const r = roundTrip(fc, 'absent vs null')
  assert.equal(r.flat.props.propsKind[0], 2, '第一条 properties 有键')
  assert.equal(r.flat.props.propsKind[1], 3, '第二条 properties 键缺失')
})

test('属性往返：部分要素缺某个键（三态 mask 的 absent 分支）', () => {
  const fc = FC(
    F(GEOMS.Point, { name: 'a', extra: 1 }),
    F(GEOMS.Point, { name: 'b' }),
    F(GEOMS.Point, { name: null }),
    F(GEOMS.Point, {}),
  )
  const r = roundTrip(fc, '缺键')
  const i = r.flat.props.keys.indexOf('extra')
  assert.deepStrictEqual([...r.flat.props.masks[i]], [2, 0, 0, 0], 'extra 只在第一条 present')
})

test('属性往返：中文与 emoji 字符串（UTF-8 列 + offsets）', () => {
  const fc = FC(
    F(GEOMS.Point, { name: '兰州市', tag: '🏙️' }),
    F(GEOMS.Point, { name: '天水市', tag: '🌾' }),
    F(GEOMS.Point, { name: '', tag: '' }),
  )
  roundTrip(fc, '中文/emoji')
})

test('属性往返：数值/布尔/字符串混合列并存', () => {
  const fc = FC(
    F(GEOMS.Point, { n: 1.5, s: 'x', b: true }),
    F(GEOMS.Point, { n: -2, s: 'yy', b: false }),
    F(GEOMS.Point, { n: 0, s: 'zzz', b: true }),
  )
  roundTrip(fc, '多类型列')
})

test('属性往返：属性键序跨要素不一致 → 归一化并记 notes（不静默）', () => {
  const fc = FC(F(GEOMS.Point, { a: 1, b: 2 }), F(GEOMS.Point, { b: 2, a: 1 }))
  const r = enc(fc)
  assert.ok(r.notes.some((n) => n.includes('键序')), '键序归一化必须出现在 notes 里')
  // 归一化后 a 排在 b 前 —— 值本身不变
  assert.deepStrictEqual(r.flat.props.keys, ['a', 'b'])
  assert.deepStrictEqual(decodeFeatureCollection(r.flat).features[1].properties, { a: 1, b: 2 })
})

// ---------------------------------------------------------------------------
// id / bbox / 空集合
// ---------------------------------------------------------------------------

test('往返：要素 id（字符串与数字）与集合/要素 bbox', () => {
  const fc = {
    type: 'FeatureCollection',
    bbox: [0, 0, 10, 10],
    features: [
      F(GEOMS.Point, { a: 1 }, { id: 'abc' }),
      F(GEOMS.Point, { a: 2 }, { id: 42 }),
      F(GEOMS.Point, { a: 3 }, { bbox: [1, 2, 3, 4] }),
    ],
  }
  roundTrip(fc, 'id/bbox')
})

test('往返：空 FeatureCollection', () => {
  roundTrip(FC(), '空集合')
})

test('往返：单点', () => {
  roundTrip(FC(F(GEOMS.Point, { a: 1 })), '单点')
})

test('往返：不携带 id/bbox 时不分配侧信道（不该为空字段付内存）', () => {
  const r = enc(FC(F(GEOMS.Point, { a: 1 })))
  assert.equal(r.flat.ids, null)
  assert.equal(r.flat.featureBbox, null)
  assert.equal(r.flat.escape, null)
  assert.equal(r.flat.collectionBbox, null)
})

// ---------------------------------------------------------------------------
// 拒绝理由：必须整单退回 structuredClone，且理由具体
// ---------------------------------------------------------------------------

test('拒绝：非标量属性值（对象/数组/undefined）→ 整单不扁平化', () => {
  for (const bad of [{ nested: { x: 1 } }, { arr: [1, 2] }, { u: undefined }]) {
    const r = encodeFeatureCollection(FC(F(GEOMS.Point, bad)))
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒`)
    assert.ok(r.reasons.length > 0 && r.reasons[0].includes('非标量'), `理由应指明非标量：${r.reasons}`)
  }
})

test('拒绝：同一个键在不同要素上类型不一致', () => {
  const r = encodeFeatureCollection(FC(F(GEOMS.Point, { v: 1 }), F(GEOMS.Point, { v: 'n/a' })))
  assert.equal(r.ok, false)
  assert.ok(r.reasons[0].includes('类型不一致'), r.reasons.join('; '))
})

test('拒绝：坐标维数混用（2D 与 3D 同层）', () => {
  const r = encodeFeatureCollection(
    FC(F({ type: 'Point', coordinates: [1, 2] }, {}), F({ type: 'Point', coordinates: [1, 2, 3] }, {})),
  )
  assert.equal(r.ok, false)
  assert.ok(r.reasons.some((x) => x.includes('维数不一致')), r.reasons.join('; '))
})

test('拒绝：坐标形状非法（长度 4 / 非数字 / 非数组）', () => {
  for (const g of [
    { type: 'Point', coordinates: [1, 2, 3, 4] },
    { type: 'Point', coordinates: [1, 'x'] },
    { type: 'Point', coordinates: 5 },
    { type: 'LineString', coordinates: [[1, 2], [3]] },
  ]) {
    const r = encodeFeatureCollection(FC(F(g, {})))
    assert.equal(r.ok, false, `${JSON.stringify(g)} 应被拒`)
  }
})

test('拒绝时 reasons 逐条可读（不是一句「不支持」）', () => {
  const r = encodeFeatureCollection(FC(F({ type: 'Point', coordinates: [1, 2, 3, 4] }, {})))
  assert.equal(r.ok, false)
  for (const line of r.reasons) assert.ok(line.length > 0 && typeof line === 'string')
})

// ---------------------------------------------------------------------------
// transferList 红线：不得 detach 调用方持有的数据
// ---------------------------------------------------------------------------

test('transfer 列表里都是本函数新分配的 buffer，转移后调用方数据完好', () => {
  const fc = FC(F(GEOMS.Polygon, { a: 1 }), F(GEOMS.MultiPolygon, { a: 2 }))
  const snapshot = structuredClone(fc)
  const r = enc(fc)

  assert.ok(r.transfer.length >= 5, '至少应转移 coords/partStart/geomStart/geomType/partOuter')
  for (const buf of r.transfer) assert.ok(buf instanceof ArrayBuffer, 'transfer 元素必须是 ArrayBuffer')

  // 真转移一次（模拟 worker 的接收端拿到的那份）
  const received = structuredClone(r.flat, { transfer: r.transfer })

  // ① 红线：调用方持有的 FeatureCollection 必须一字未改（没有被 detach 的图层数据）
  assert.deepStrictEqual(fc, snapshot, '转移不应影响调用方持有的 FeatureCollection')
  // ② 接收端可正确解码 —— 这才是 worker 真正会做的事
  assert.deepStrictEqual(decodeFeatureCollection(received), snapshot, '接收端应能解出等价数据')
  // ③ 契约固化：转移后原 flat 的 buffer 已被 detach，调用方**不得**再使用它。
  //    这条写成断言是为了让「转移 = 移交所有权」这件事在测试里可见，而不是靠注释提醒。
  assert.equal(r.flat.geomType.length, 0, '转移后原 flat 应已 detach（调用方不得再用）')
})

test('同一输入编码两次结果一致（无隐藏状态）', () => {
  const fc = FC(F(GEOMS.Polygon, { a: 1 }), F(GEOMS.Point, { b: 'x' }))
  const a = enc(fc)
  const b = enc(fc)
  assert.deepStrictEqual([...a.flat.coords], [...b.flat.coords])
  assert.deepStrictEqual([...a.flat.geomType], [...b.flat.geomType])
  assert.deepStrictEqual(a.flat.props.keys, b.flat.props.keys)
})

test('规模：1 万要素往返正确且不依赖 worker', () => {
  const features = []
  for (let i = 0; i < 10000; i++) {
    features.push(F({ type: 'Point', coordinates: [113 + i * 1e-4, 23 + i * 1e-4] }, { i, name: `p${i}`, flag: i % 2 === 0 }))
  }
  const fc = FC(...features)
  roundTrip(fc, '1 万要素')
})

// ---------------------------------------------------------------------------
// 实测暴露出来的两类问题：小 N 单测抓不到，必须专门钉住
// ---------------------------------------------------------------------------

test('往返逐字节一致（JSON.stringify 相等）—— 两种要素键序都必须保持', () => {
  // 原来解码统一输出 {type,geometry,properties}，而输入常见 {type,properties,geometry} ——
  // 字段值一样、JSON 字节不同。deepStrictEqual 不看键序，所以只有逐字节比才抓得到。
  const geom = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }
  const props = { a: 1, b: 'x' }
  const cases = [
    { label: 'properties 在前', features: [{ type: 'Feature', properties: props, geometry: geom }] },
    { label: 'geometry 在前', features: [{ type: 'Feature', geometry: geom, properties: props }] },
  ]
  for (const c of cases) {
    const fc = { type: 'FeatureCollection', features: c.features }
    const back = decodeFeatureCollection(enc(fc).flat)
    assert.equal(JSON.stringify(back), JSON.stringify(fc), `${c.label}：应逐字节一致`)
  }
})

test('大 N 解码必须线性 —— 守卫 O(n²) 回归', () => {
  // 曾经的 bug：字符串列为了定位"第几个 present 值"对每行回扫 mask → O(n²)。
  // 实测 20 万面要 26.75 秒、把隔离执行变成 52× 的性能灾难。小 N 完全测不出来。
  const n = 50_000
  const features = []
  for (let i = 0; i < n; i++) {
    features.push(F({ type: 'Point', coordinates: [113 + (i % 500) * 0.002, 23 + Math.floor(i / 500) * 0.002] }, { name: `p${i}`, v: i }))
  }
  const flat = enc(FC(...features)).flat
  const t0 = performance.now()
  const back = decodeFeatureCollection(flat)
  const ms = performance.now() - t0
  assert.equal(back.features.length, n)
  assert.equal(back.features[n - 1].properties.name, `p${n - 1}`, '末行的字符串列取值要正确（游标不能错位）')
  // O(n²) 版本在 5 万面约 6 秒以上；线性版本约 50ms。5 秒是宽松分界。
  assert.ok(ms < 5000, `解码 5 万面耗时 ${ms.toFixed(0)}ms —— 疑似退化成 O(n²)`)
})

test('大 N 编解码：多列 + 缺值 + 混合类型在规模下仍逐字节一致', () => {
  const n = 20_000
  const features = []
  for (let i = 0; i < n; i++) {
    const props = i % 7 === 0 ? { name: `p${i}`, v: i * 1.5, flag: i % 2 === 0 }
      : i % 11 === 0 ? { name: null, v: i }
        : { name: `p${i}`, v: i * 1.5, flag: i % 2 === 0, extra: 'x' }
    features.push(F({ type: 'Point', coordinates: [113 + (i % 500) * 0.002, 23 + Math.floor(i / 500) * 0.002] }, props))
  }
  const fc = FC(...features)
  const back = decodeFeatureCollection(enc(fc).flat)
  assert.equal(JSON.stringify(back), JSON.stringify(fc))
})
