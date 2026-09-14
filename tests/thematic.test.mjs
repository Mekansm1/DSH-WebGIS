import { test } from 'node:test'
import assert from 'node:assert/strict'
import { point, polygon, featureCollection } from '@turf/helpers'
import {
  MAX_CATEGORIES, NO_DATA_COLOR, RAMPS, buildThematic, equalBreaks, formatLegend,
  jenksBreaks, numericValue, quantileBreaks, rampColors,
} from '../lib/thematic.js'

const pts = (vals) => featureCollection(vals.map((v, i) => point([i * 0.001, 0], { v })))
const cats = (vals) => featureCollection(vals.map((k, i) => point([i * 0.001, 0], { k })))

// ---- 色带 ----

test('rampColors: 按目标级数均匀取色，长度恒等于级数', () => {
  for (const n of [1, 2, 3, 5]) {
    const c = rampColors('blues', n)
    assert.equal(c.length, n, `n=${n}`)
    assert.ok(c.every((x) => /^#[0-9a-f]{6}$/i.test(x)), '必须是合法十六进制色')
  }
  // 色带本身有 5 色，取 5 色应当原样返回
  assert.deepEqual(rampColors('blues', 5), RAMPS.blues)
  // 超出色带长度时仍要给出 n 个（端点重复可接受，不能少给）
  assert.equal(rampColors('blues', 9).length, 9)
})

test('rampColors: 未知色带名回退到默认，不抛错', () => {
  assert.equal(rampColors('不存在的色带', 3).length, 3)
})

// ---- 数值归一（与 geo-indices 同规则）----

test('numericValue: 空值/空串/布尔一律 NaN —— 绝不静默当 0', () => {
  assert.ok(Number.isNaN(numericValue(null)))
  assert.ok(Number.isNaN(numericValue(undefined)))
  assert.ok(Number.isNaN(numericValue('')))
  assert.ok(Number.isNaN(numericValue(false)))
  assert.equal(numericValue(0), 0, '真正的 0 仍然是 0')
  assert.equal(numericValue('12.5'), 12.5)
})

// ---- 三种数值分箱 ----

test('equalBreaks: 等间距，断点数 = k-1 且在 min/max 之间', () => {
  const b = equalBreaks([0, 10], 5)
  assert.deepEqual(b, [2, 4, 6, 8])
  const b2 = equalBreaks([0, 100], 4)
  assert.deepEqual(b2, [25, 50, 75])
})

test('quantileBreaks: 分位数尽量均分要素数', () => {
  const xs = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
  const b = quantileBreaks(xs, 4)
  assert.equal(b.length, 3)
  assert.deepEqual(b, [25, 50, 75])
})

test('jenksBreaks: 明显断层要切在断层处', () => {
  // 1~4 与 100~104 两簇，自然断点必须切在中间
  const b = jenksBreaks([1, 2, 3, 4, 100, 101, 102, 103, 104], 2)
  assert.equal(b.length, 1)
  assert.ok(b[0] >= 4 && b[0] < 100, `断点应落在两簇之间，实得 ${b[0]}`)
})

test('jenksBreaks: 单调数据升序、无重复、数量不超过 k-1', () => {
  const xs = Array.from({ length: 50 }, (_, i) => i * i)
  const b = jenksBreaks(xs, 5)
  assert.ok(b.length <= 4)
  assert.deepEqual(b, [...b].sort((a, z) => a - z))
  assert.equal(new Set(b).size, b.length, '断点不能重复')
})

test('分箱函数：退化输入返回空数组而不是抛错', () => {
  assert.deepEqual(jenksBreaks([], 5), [])
  assert.deepEqual(jenksBreaks([5, 5, 5], 3), [])
  assert.deepEqual(quantileBreaks([], 4), [])
  assert.deepEqual(equalBreaks([5, 5, 5], 4), [], '常量数据分不出等间距')
})

// ---- buildThematic：数值型 ----

test('buildThematic: 数值字段分箱，级数 = 断点+1，每级计数之和 = 有效值数', () => {
  const r = buildThematic(pts(Array.from({ length: 100 }, (_, i) => i)), { field: 'v', method: 'quantile', classes: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.spec.breaks.length, 4)
  assert.equal(r.spec.colors.length, 5)
  assert.equal(r.spec.categories, undefined, '数值型不该有 categories')
  assert.equal(r.counts.reduce((a, b) => a + b, 0), 100)
  assert.equal(r.spec.missing, 0)
  assert.equal(r.labels.length, 5)
})

test('buildThematic: **缺失值不参与分箱，单独计数** —— 不能把「没有值」画成「值很小」', () => {
  const fc = featureCollection([
    ...Array.from({ length: 10 }, (_, i) => point([i * 0.001, 0], { v: i })),
    point([0.02, 0], { v: null }),
    point([0.021, 0], { v: '' }),
    point([0.022, 0], {}),
  ])
  const r = buildThematic(fc, { field: 'v', method: 'equal', classes: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.spec.missing, 3, '3 个缺值必须单独计数')
  assert.equal(r.counts.reduce((a, b) => a + b, 0), 10, '计数只覆盖有效值')
  assert.equal(r.spec.colors.length, r.spec.breaks.length + 1)
})

test('buildThematic: jenks 超过样本上限时抽样，并如实标注 sampledFrom', () => {
  const big = Array.from({ length: 20000 }, (_, i) => i * 1.5)
  const r = buildThematic(pts(big), { field: 'v', method: 'jenks', classes: 5 })
  assert.equal(r.ok, true)
  assert.ok(r.spec.sampledFrom >= 20000, '必须如实标注是按多少有效值抽样的')
  assert.ok(r.counts.reduce((a, b) => a + b, 0) === 20000, '计数仍走全量')
})

test('buildThematic: 未抽样时不出现 sampledFrom（别加噪音）', () => {
  const r = buildThematic(pts([1, 2, 3, 4, 5, 6, 7, 8]), { field: 'v', method: 'jenks', classes: 3 })
  assert.equal(r.ok, true)
  assert.equal(r.spec.sampledFrom, undefined)
})

test('buildThematic: classes 被钳制在 2..12', () => {
  const xs = Array.from({ length: 50 }, (_, i) => i)
  assert.equal(buildThematic(pts(xs), { field: 'v', method: 'equal', classes: 999 }).spec.colors.length, 12)
  assert.equal(buildThematic(pts(xs), { field: 'v', method: 'equal', classes: 0 }).spec.colors.length, 2)
})

// ---- buildThematic：分类型 ----

test('buildThematic: 分类字段，每类一个颜色，按频次降序', () => {
  const r = buildThematic(cats(['a', 'a', 'a', 'b', 'b', 'c']), { field: 'k', method: 'category' })
  assert.equal(r.ok, true)
  assert.deepEqual(r.spec.categories, ['a', 'b', 'c'])
  assert.deepEqual(r.counts, [3, 2, 1])
  assert.equal(r.spec.colors.length, 3)
  assert.equal(r.spec.breaks.length, 0)
})

test('buildThematic: 分类缺值单独计数', () => {
  const r = buildThematic(cats(['a', 'b', null, '']), { field: 'k', method: 'category' })
  assert.equal(r.ok, true)
  assert.equal(r.spec.missing, 2)
  assert.deepEqual(r.spec.categories, ['a', 'b'])
})

test('buildThematic: 类别过多时截断，并告知有低频类未上色', () => {
  const many = Array.from({ length: MAX_CATEGORIES + 5 }, (_, i) =>
    Array.from({ length: MAX_CATEGORIES + 5 - i }, () => `c${i}`)).flat()
  const r = buildThematic(cats(many), { field: 'k', method: 'category' })
  assert.equal(r.ok, true)
  assert.equal(r.spec.categories.length, MAX_CATEGORIES)
  assert.match(r.labels.join(''), /未上色/, '截断了必须说，不能让用户以为画全了')
})

// ---- 错误路径：中文可懂 ----

test('buildThematic: 各种算不了的情况都给中文原因，不是静默失败', () => {
  const constant = buildThematic(pts([7, 7, 7, 7]), { field: 'v', method: 'jenks' })
  assert.equal(constant.ok, false)
  assert.match(constant.message, /恒定/)

  const tooFew = buildThematic(pts([1, 2]), { field: 'v', method: 'equal' })
  assert.equal(tooFew.ok, false)
  assert.match(tooFew.message, /有效数值不足/)

  const oneCat = buildThematic(cats(['x', 'x']), { field: 'k', method: 'category' })
  assert.equal(oneCat.ok, false)
  assert.match(oneCat.message, /只有一个取值/)

  const noField = buildThematic(pts([1, 2, 3, 4]), { field: '不存在', method: 'equal' })
  assert.equal(noField.ok, false)
  assert.match(noField.message, /有效数值不足/)
})

test('buildThematic: 颜色数不足时明确报错，不静默循环取色', () => {
  const r = buildThematic(pts(Array.from({ length: 20 }, (_, i) => i)), {
    field: 'v', method: 'quantile', classes: 5, colors: ['#111111', '#222222'],
  })
  assert.equal(r.ok, false)
  assert.match(r.message, /颜色数不足/)
})

// ---- 图例 ----

test('formatLegend: 每条都带颜色与区间标签，用户能照着读图', () => {
  const r = buildThematic(pts(Array.from({ length: 20 }, (_, i) => i)), { field: 'v', method: 'equal', classes: 4 })
  const legend = formatLegend(r.spec, r.labels)
  assert.match(legend, /专题配色/)
  assert.match(legend, /字段「v」/)
  for (const c of r.spec.colors) assert.ok(legend.includes(c), `图例缺颜色 ${c}`)
})

test('NO_DATA_COLOR: 是中性灰且不与任何色带撞色', () => {
  assert.equal(NO_DATA_COLOR, '#9ca3af')
  for (const ramp of Object.values(RAMPS)) {
    assert.ok(!ramp.includes(NO_DATA_COLOR), '无数据色不能混进色带')
  }
})

test('minMax: 大数组不爆栈（Math.min(...xs) 在 12.5 万元素就 RangeError，实测 65 万行的图层会崩）', async () => {
  const { minMax } = await import('../lib/geo-stats.js')
  for (const n of [1000, 200000, 700000]) {
    const xs = Array.from({ length: n }, (_, i) => (i % 997) - 500)
    const r = minMax(xs)
    assert.equal(r.min, -500, `n=${n}`)
    assert.equal(r.max, 496, `n=${n}`)
  }
  // 空数组给中性极值，不抛错
  const empty = minMax([])
  assert.equal(empty.min, Number.POSITIVE_INFINITY)
  assert.equal(empty.max, Number.NEGATIVE_INFINITY)
})
