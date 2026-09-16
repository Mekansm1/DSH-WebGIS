import { test } from 'node:test'
import assert from 'node:assert/strict'
import { polygon, featureCollection, feature, point } from '@turf/helpers'
import { makeResultLayer, regularGridCellCount } from '../lib/geo-processing.js'
import { registerGeoTools } from '../lib/geo-tools.js'
import { createGeoToolRuntime } from '../lib/geo-tools-runtime.js'
import { runGeoJobLocal } from '../lib/geo-job-ops.js'
import { GeoJobAbortedError } from '../lib/geo-jobs.js'
import { GEO_JOB_GATE, GEO_TOOL_TIMEOUTS } from '../lib/geo-job-policy.js'

function square(w, s, e, n, props = {}) {
  return polygon([[[w, s], [e, s], [e, n], [w, n], [w, s]]], props)
}

/** 造一个捕获了工具注册的假 ctx + 按会话隔离的注册表状态（模拟 host 的 SessionStateStore）。 */
function setup(initialLayers = [], deps = undefined) {
  const defs = []
  const ctx = { tools: { register: (d) => defs.push(d) } }
  const states = new Map()
  const stateFor = (sid) => {
    const key = sid ?? 'anon'
    let st = states.get(key)
    if (!st) {
      st = { layers: [...initialLayers] }
      states.set(key, st)
    }
    return st
  }
  // ⚠️ 第 3 个参数（hooks）必须显式占位：写成 registerGeoTools(ctx, stateFor, deps) 会把 deps
  // 送到 hooks 位上，deps 静默为 undefined —— 于是 worker 分支全部不可达，测试却照常"通过"。
  registerGeoTools(ctx, stateFor, undefined, deps)
  const tool = (name) => {
    const d = defs.find((x) => x.name === name)
    assert.ok(d, `未找到工具 ${name}`)
    return d
  }
  const run = (name, args, sid, execExtra = {}) =>
    tool(name).execute(args, { agent: sid ? { id: sid } : undefined, ...execExtra })
  return { defs, states, stateFor, state: stateFor(undefined), tool, run }
}

/**
 * 注入 **stub 执行器** 的 harness：不启真 worker，直接在主线程调 `runGeoJobLocal`。
 *
 * 这样 14 条 worker 分支能在毫秒级被覆盖（真 worker 有启动成本，只留给 geo-jobs.test.mjs）。
 * 它同时记录了每次派发的 `timeoutMs` 与 `signal`，用来验收"预算同源"与"信号透传"。
 */
function setupWithStubRunner(initialLayers = [], onJob = undefined) {
  const calls = []
  const deps = {
    runGeoJob: async (job, timeoutMs, opts) => {
      calls.push({ job, timeoutMs, signal: opts?.signal })
      if (onJob) return onJob(job, timeoutMs, opts)
      return runGeoJobLocal(job)
    },
  }
  return { ...setup(initialLayers, deps), calls }
}

const polygonLayer = makeResultLayer({
  id: 'dataset', name: '县域',
  geojson: featureCollection([square(0, 0, 10, 10, { name: '甲县', pop: 100 }), square(10, 0, 20, 10, { name: '乙县', pop: 200 })]),
  source: 'dataset',
})

test('registerGeoTools：经 inject 注册全局工具纪律系统提示段（#6）；无 inject 的假 ctx 不抛错', () => {
  const defs = []
  const sections = []
  const ctx = {
    tools: { register: (d) => defs.push(d) },
    inject: (names, cb) => {
      assert.deepEqual(names, ['systemPrompt'])
      cb({ systemPrompt: { section: (s) => sections.push(s) } })
    },
  }
  registerGeoTools(ctx, () => ({ layers: [] }))
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'webgis:tool-discipline')
  assert.equal(sections[0].order, 150)
  assert.match(sections[0].text, /工具使用纪律/)
  assert.match(sections[0].text, /连续失败 ≥2 次/)
  assert.match(sections[0].text, /简短精炼/)
  // 无 inject 也无线下挂载的假 ctx（现有 setup() 场景）不抛错
  registerGeoTools({ tools: { register: (d) => defs.push(d) } }, () => ({ layers: [] }))
  assert.ok(defs.length >= 35)
})

test('全部 44 个工具都注册了（21 构造/OD/样式 + 6 矢量 + 5 统计 + 4 指数 + 1 底图 + 4 展示方式/改色/专题 + 3 属性编辑）', () => {
  const { defs } = setup()
  const names = defs.map((d) => d.name).sort()
  const expected = [
    'webgis_add_column', 'webgis_add_sequence', 'webgis_attribute_join', 'webgis_average_nearest_neighbor', 'webgis_bounding_box',
    'webgis_buffer', 'webgis_centroids', 'webgis_clear_layers', 'webgis_clip',
    'webgis_convex_hull', 'webgis_difference', 'webgis_dissolve', 'webgis_explode', 'webgis_export_basemap',
    'webgis_feature_summary', 'webgis_getis_ord', 'webgis_gini', 'webgis_intersect', 'webgis_kernel_density', 'webgis_layer_info',
    'webgis_list_layers', 'webgis_local_moran', 'webgis_moran_i', 'webgis_moran_inspect', 'webgis_od_matrix', 'webgis_regular_grid', 'webgis_remove_layer',
    'webgis_reproject', 'webgis_select_by_location', 'webgis_select_by_value',
    'webgis_set_attribute', 'webgis_set_heatmap_mode', 'webgis_set_layer_color', 'webgis_set_layer_style', 'webgis_set_layer_thematic',
    'webgis_set_layer_visibility',
    'webgis_set_render_mode',
    'webgis_shannon', 'webgis_simplify', 'webgis_smooth',
    'webgis_spatial_join', 'webgis_stat_inspect', 'webgis_union', 'webgis_voronoi',
  ].sort()
  assert.deepEqual(names, expected)
})

test('buffer 产出新图层，返回要素数/bbox/layerId', async () => {
  const single = makeResultLayer({
    id: 'dataset', name: '单地块',
    geojson: featureCollection([square(0, 0, 10, 10)]),
    source: 'dataset',
  })
  const { state, run } = setup([single])
  const out = await run('webgis_buffer', { layer: 'dataset', distance: 0.5, unit: 'degrees' })
  assert.equal(out.ok, true)
  assert.match(out.layerId, /^result_\d+$/)
  assert.equal(out.featureCount, 1)
  assert.ok(Array.isArray(out.bbox))
  assert.equal(state.layers.length, 2)
  const layer = state.layers.find((l) => l.id === out.layerId)
  assert.equal(layer.source, 'gis-result')
})

test('会话隔离：A 会话 buffer 出的图层不影响 B 会话', async () => {
  const { run, stateFor } = setup([polygonLayer])
  const a = await run('webgis_buffer', { layer: 'dataset', distance: 0.5, unit: 'degrees' }, 'sessA')
  assert.equal(a.ok, true)
  assert.equal(stateFor('sessA').layers.length, 2)
  assert.equal(stateFor('sessB').layers.length, 1, 'B 会话注册表不应被 A 的写入污染')
  assert.equal(stateFor('sessB').layers[0].id, 'dataset')
})

test('链式：buffer 结果再 clip', async () => {
  const { state, run } = setup([polygonLayer])
  const b = await run('webgis_buffer', { layer: 'dataset', distance: 0.5 })
  const overlay = makeResultLayer({
    id: 'zone', name: '保护区',
    geojson: featureCollection([square(5, 5, 15, 15)]),
    source: 'gis-result',
  })
  state.layers = [...state.layers, overlay]
  const clip = await run('webgis_clip', { layer: b.layerId, overlay: 'zone' })
  assert.equal(clip.ok, true)
  assert.match(clip.layerId, /^result_\d+$/)
  const clipped = state.layers.find((l) => l.id === clip.layerId)
  assert.equal(clipped.geojson.features.length, 1)
})

test('缺图层 → ok:false 中文消息', async () => {
  const { run } = setup([polygonLayer])
  const out = await run('webgis_buffer', { layer: 'nope', distance: 1 })
  assert.equal(out.ok, false)
  assert.match(out.message, /找不到图层/)
})

test('dissolve 对点图层 → ok:false 提示仅面要素', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] })]),
    source: 'dataset',
  })
  const { run } = setup([pts])
  const out = await run('webgis_dissolve', { layer: 'dataset', field: 'name' })
  assert.equal(out.ok, false)
  assert.match(out.message, /仅支持面要素/)
})

test('dissolve 按字段分组产出多要素', async () => {
  const multi = makeResultLayer({
    id: 'dataset', name: '地块',
    geojson: featureCollection([
      square(0, 0, 5, 5, { group: 'x' }),
      square(5, 0, 10, 5, { group: 'x' }),
      square(20, 0, 25, 5, { group: 'y' }),
    ]),
    source: 'dataset',
  })
  const { run } = setup([multi])
  const out = await run('webgis_dissolve', { layer: 'dataset', field: 'group' })
  assert.equal(out.ok, true)
  assert.equal(out.featureCount, 2)
})

test('dissolve 不再按固定要素数拒绝：是否终止由隔离任务的时限决定', async () => {
  const many = makeResultLayer({
    id: 'dataset', name: '道路缓冲',
    geojson: featureCollection(Array.from({ length: 1001 }, (_, i) => square(i, 0, i + 0.5, 0.5))),
    source: 'gis-result',
  })
  const { state, run } = setup([many])
  const out = await run('webgis_dissolve', { layer: 'dataset' })
  assert.equal(out.ok, true)
  assert.equal(state.layers.length, 2)
})

test('select_by_value 缺字段 → ok:false', async () => {
  const { run } = setup([polygonLayer])
  const out = await run('webgis_select_by_value', { layer: 'dataset', field: 'nope', operator: 'eq', value: 'x' })
  assert.equal(out.ok, false)
  assert.match(out.message, /没有字段/)
})

test('list_layers / layer_info / feature_summary 形状', async () => {
  const { run } = setup([polygonLayer])
  const list = await run('webgis_list_layers', {})
  assert.equal(list.ok, true)
  assert.ok(Array.isArray(list.layers))
  assert.equal(list.layers[0].id, 'dataset')
  assert.ok(!('geojson' in list.layers[0]))

  const info = await run('webgis_layer_info', { layer: 'dataset' })
  assert.equal(info.ok, true)
  assert.ok(Array.isArray(info.layer.fields))
  assert.ok(info.layer.fields.includes('name'))

  const sum = await run('webgis_feature_summary', { layer: 'dataset', field: 'pop', stat: 'sum' })
  assert.equal(sum.ok, true)
  assert.equal(sum.value, 300)
  const cnt = await run('webgis_feature_summary', { layer: 'dataset', field: 'name', stat: 'count' })
  assert.equal(cnt.value, 2)
})

test('remove_layer / clear_layers / set_layer_visibility', async () => {
  const { state, run } = setup([polygonLayer])
  const b = await run('webgis_buffer', { layer: 'dataset', distance: 1 })
  assert.equal(state.layers.length, 2)

  const hide = await run('webgis_set_layer_visibility', { layer: b.layerId, visible: false })
  assert.equal(hide.ok, true)
  const hidden = state.layers.find((l) => l.id === b.layerId)
  assert.equal(hidden.visible, false)

  const rm = await run('webgis_remove_layer', { layer: b.layerId })
  assert.equal(rm.ok, true)
  assert.equal(state.layers.length, 1)

  // 基础数据集层 dataset 也可移除：st.dataset 置空、注册表清空
  const rmDataset = await run('webgis_remove_layer', { layer: 'dataset' })
  assert.equal(rmDataset.ok, true)
  assert.equal(state.layers.length, 0)
  assert.equal(state.dataset, null)

  // dataset 已移除，再对其 buffer 失败（图层不存在）
  const b2 = await run('webgis_buffer', { layer: 'dataset', distance: 1 })
  assert.equal(b2.ok, false)

  const clear = await run('webgis_clear_layers', {})
  assert.equal(clear.ok, true)
  assert.equal(clear.removed, 0)
  assert.deepEqual(state.layers.map((l) => l.id), [])

  // keepDataset=false 清空时连 dataset 一起移除（st.dataset 置空）
  const { state: s2, run: run2 } = setup([polygonLayer])
  const b3 = await run2('webgis_buffer', { layer: 'dataset', distance: 1 })
  assert.equal(s2.layers.length, 2)
  const clearAll = await run2('webgis_clear_layers', { keepDataset: false })
  assert.equal(clearAll.ok, true)
  assert.equal(clearAll.removed, 2)
  assert.deepEqual(s2.layers.map((l) => l.id), [])
  assert.equal(s2.dataset, null)
})

// ---- 功能 4：矢量扩展工具 ----

test('smooth 越界迭代钳制并产出新图层', async () => {
  const line = makeResultLayer({
    id: 'dataset', name: '线',
    geojson: featureCollection([feature({ type: 'LineString', coordinates: [[0, 0], [2, 0], [4, 2]] }, { name: 'x' })]),
    source: 'dataset',
  })
  const { state, run } = setup([line])
  const out = await run('webgis_smooth', { layer: 'dataset', iterations: 1 })
  assert.equal(out.ok, true)
  assert.match(out.layerId, /^result_\d+$/)
  assert.equal(state.layers.length, 2)
  // 3 点开线 1 次迭代 → 4 点（保端点）
  assert.equal(state.layers[1].geojson.features[0].geometry.coordinates.length, 4)
})

test('regular_grid: 非法 bbox → ok:false', async () => {
  const { run } = setup()
  const out = await run('webgis_regular_grid', { bbox: [10, 0, 0, 10], cellSize: 5 })
  assert.equal(out.ok, false)
  assert.match(out.message, /bbox 非法/)
})

test('voronoi: 不足 3 点 → ok:false', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '两点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] }), feature({ type: 'Point', coordinates: [1, 1] })]),
    source: 'dataset',
  })
  const { run } = setup([pts])
  const out = await run('webgis_voronoi', { layer: 'dataset' })
  assert.equal(out.ok, false)
  assert.match(out.message, /至少需要 3 个点/)
})

test('attribute_join: 缺字段 → ok:false；正常连接 ok', async () => {
  const target = makeResultLayer({
    id: 'dataset', name: '目标',
    geojson: featureCollection([square(0, 0, 1, 1, { code: 'A', pop: 10 })]),
    source: 'dataset',
  })
  const join = makeResultLayer({
    id: 'dict', name: '字典',
    geojson: featureCollection([square(9, 9, 10, 10, { code: 'A', label: '甲' })]),
    source: 'gis-result',
  })
  const { state, run } = setup([target, join])
  const bad = await run('webgis_attribute_join', { target: 'dataset', joinLayer: 'dict', targetField: 'nope' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /没有字段/)
  const good = await run('webgis_attribute_join', { target: 'dataset', joinLayer: 'dict', targetField: 'code' })
  assert.equal(good.ok, true)
  assert.equal(good.featureCount, 1)
  assert.equal(state.layers[state.layers.length - 1].geojson.features[0].properties.label, '甲')
})

test('select_by_location: overlay+bbox 同传 → ok:false；bbox 筛选 ok', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [50, 50] })]),
    source: 'dataset',
  })
  const { run } = setup([pts])
  const both = await run('webgis_select_by_location', { layer: 'dataset', overlay: 'dataset', bbox: [0, 0, 1, 1] })
  assert.equal(both.ok, false)
  assert.match(both.message, /必须且只能提供一个/)
  const hit = await run('webgis_select_by_location', { layer: 'dataset', bbox: [45, 45, 55, 55] })
  assert.equal(hit.ok, true)
  assert.equal(hit.featureCount, 1)
})

// ---- 功能 4：空间统计工具 ----

test('kernel_density: 点层出图层、面层 ok:false（仅支持点）；默认 mode=plane 并提醒其他展示方式', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] }), feature({ type: 'Point', coordinates: [0.05, 0.05] })]),
    source: 'dataset',
  })
  const { state, run } = setup([pts])
  const out = await run('webgis_kernel_density', { layer: 'dataset' })
  assert.equal(out.ok, true)
  assert.match(out.layerId, /^result_\d+$/)
  const layer = state.layers[state.layers.length - 1]
  assert.ok(layer.geojson.features.length > 0)
  // 默认展示方式为平面热力图，且返回消息提醒用户还有其他展示方式
  assert.equal(layer.mode, 'plane')
  assert.match(out.message, /其他展示方式/)

  // 显式 mode:'hex' → 图层 mode=hex
  const { state: stateHex, run: runHex } = setup([pts])
  const outHex = await runHex('webgis_kernel_density', { layer: 'dataset', mode: 'hex' })
  assert.equal(outHex.ok, true)
  assert.equal(stateHex.layers[stateHex.layers.length - 1].mode, 'hex')
})

test('set_heatmap_mode: 点层切换成功且不 bump rev；非法 mode/面层/缺图层 ok:false', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] }), feature({ type: 'Point', coordinates: [1, 0] })]),
    source: 'dataset',
  })
  const { state, run } = setup([pts])
  const before = state.layers[0].rev
  const ok = await run('webgis_set_heatmap_mode', { layer: 'dataset', mode: 'hex' })
  assert.equal(ok.ok, true)
  assert.equal(ok.mode, 'hex')
  assert.equal(state.layers[0].mode, 'hex')
  assert.equal(state.layers[0].rev, before, '纯展示变更不应 bump rev')
  assert.match(ok.message, /蜂窝热力图/)
  assert.match(ok.message, /其他展示方式/)

  // 非法 mode 会被参数 schema 的 enum 校验拦截（抛 ToolArgsError），不在 handler 内出现。

  const missing = await run('webgis_set_heatmap_mode', { layer: 'nope', mode: 'plane' })
  assert.equal(missing.ok, false)

  const poly = makeResultLayer({
    id: 'dataset2', name: '面',
    geojson: featureCollection([square(0, 0, 10, 10)]),
    source: 'dataset',
  })
  const { run: run2 } = setup([poly])
  const badPoly = await run2('webgis_set_heatmap_mode', { layer: 'dataset2', mode: 'plane' })
  assert.equal(badPoly.ok, false)
  assert.match(badPoly.message, /不是点要素|几何类型.*不支持/)
})

test('set_render_mode: 四种 deck 出图 + 几何校验 + 参数落 modeParams', async () => {
  // 点层：radial 辐射图 + params.radius
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] }), feature({ type: 'Point', coordinates: [1, 0] })]),
    source: 'dataset',
  })
  const { state: stPts, run: runPts } = setup([pts])
  const out = await runPts('webgis_set_render_mode', { layer: 'dataset', mode: 'radial', radius: 5000 })
  assert.equal(out.ok, true)
  assert.equal(stPts.layers[0].mode, 'radial')
  assert.equal(stPts.layers[0].modeParams?.radius, 5000)
  assert.match(out.message, /辐射图/)

  // 线层：arc 弧线图
  const lineLayer = makeResultLayer({
    id: 'lines', name: '线',
    geojson: featureCollection([feature({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })]),
    source: 'dataset',
  })
  const { state: stLine, run: runLine } = setup([lineLayer])
  const arc = await runLine('webgis_set_render_mode', { layer: 'lines', mode: 'arc', width: 4 })
  assert.equal(arc.ok, true)
  assert.equal(stLine.layers[0].mode, 'arc')
  assert.equal(stLine.layers[0].modeParams?.width, 4)

  // trips 轨迹图（线层）
  const trips = await runLine('webgis_set_render_mode', { layer: 'lines', mode: 'trips', speed: 0.3, trail: 0.7 })
  assert.equal(trips.ok, true)
  assert.equal(stLine.layers[0].mode, 'trips')
  assert.equal(stLine.layers[0].modeParams?.speed, 0.3)

  // 面层：wall 围墙图
  const wallLayer = makeResultLayer({
    id: 'walls', name: '面',
    geojson: featureCollection([feature({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] })]),
    source: 'dataset',
  })
  const { run: runWall } = setup([wallLayer])
  const wall = await runWall('webgis_set_render_mode', { layer: 'walls', mode: 'wall', height: 300 })
  assert.equal(wall.ok, true)
  assert.equal(wall.layerId, 'walls')

  // 几何不匹配：点层切 arc → 拒绝
  const { run: runBad } = setup([pts])
  const bad = await runBad('webgis_set_render_mode', { layer: 'dataset', mode: 'arc' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /不支持「弧线图」/)

  // 点层切 wall → 拒绝
  const { run: runBad2 } = setup([pts])
  const bad2 = await runBad2('webgis_set_render_mode', { layer: 'dataset', mode: 'wall' })
  assert.equal(bad2.ok, false)
  assert.match(bad2.message, /不支持「围墙图」/)
})

test('webgis_od_matrix：双图层配对生成 OD 线图层，自动以 arc 大圆+流量渲染', async () => {
  const pt = (lng, lat, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } })
  const origins = makeResultLayer({
    id: 'origins', name: '起点',
    geojson: featureCollection([pt(116, 39), pt(117, 39)]),
    source: 'dataset',
  })
  const dests = makeResultLayer({
    id: 'dests', name: '终点',
    geojson: featureCollection([pt(116, 39), pt(116.5, 39.5), pt(117, 40)]),
    source: 'dataset',
  })
  const { state, run } = setup([origins, dests])
  const out = await run('webgis_od_matrix', { origin: 'origins', destination: 'dests', topN: 2 })
  assert.equal(out.ok, true)
  assert.match(out.layerId, /^result_\d+$/)
  assert.match(out.message, /OD 流向/)
  const layer = state.layers.find((l) => l.id === out.layerId)
  assert.ok(layer)
  assert.equal(layer.mode, 'arc')
  assert.deepEqual(layer.modeParams, { greatCircle: 1, flow: 1 })
  assert.ok(layer.featureCount > 0 && layer.featureCount <= 4, '每起点最多 topN=2 个终点')
  for (const f of layer.geojson.features) {
    assert.equal(f.geometry.type, 'LineString')
    assert.equal(f.geometry.coordinates.length, 2)
    assert.ok(Number.isFinite(f.properties.flow) && f.properties.flow >= 0, 'flow 为有限非负值')
  }
})

test('webgis_od_matrix：缺省 destination=同图层，跳过自环，maxPairs 生效', async () => {
  const pt = (lng, lat, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } })
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([pt(0, 0), pt(1, 0), pt(0, 1)]),
    source: 'dataset',
  })
  const { state, run } = setup([pts])
  // 同图层 topN=2 → 3 起点 × 2 终点 = 6 对；无自环（坐标相同的起点==终点被跳过）
  const out = await run('webgis_od_matrix', { origin: 'dataset', topN: 2 })
  assert.equal(out.ok, true)
  const layer = state.layers.find((l) => l.id === out.layerId)
  assert.equal(layer.featureCount, 6)
  for (const f of layer.geojson.features) {
    const [a, b] = f.geometry.coordinates
    assert.ok(!(a[0] === b[0] && a[1] === b[1]), '不应有自环')
    assert.ok(f.properties.flow > 0)
  }
  // maxPairs=2 硬上限：只留最近 2 对
  const { state: st2, run: run2 } = setup([pts])
  const capped = await run2('webgis_od_matrix', { origin: 'dataset', topN: 2, maxPairs: 2 })
  assert.equal(capped.ok, true)
  const layer2 = st2.layers.find((l) => l.id === capped.layerId)
  assert.equal(layer2.featureCount, 2)
})

test('webgis_od_matrix：几何校验（非点图层拒绝、缺图层拒绝）', async () => {
  const lineLayer = makeResultLayer({
    id: 'lines', name: '线',
    geojson: featureCollection([feature({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })]),
    source: 'dataset',
  })
  const { run } = setup([lineLayer])
  const bad = await run('webgis_od_matrix', { origin: 'lines' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /仅支持点要素/)
  const missing = await run('webgis_od_matrix', { origin: 'nope' })
  assert.equal(missing.ok, false)
  assert.match(missing.message, /找不到图层/)
})

test('webgis_od_matrix：warnOver 软提醒——超过阈值仍生成但消息带 ⚠️，未超则无警告', async () => {
  const pt = (lng, lat, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } })
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([pt(0, 0), pt(1, 0), pt(0, 1)]),
    source: 'dataset',
  })
  // 同图层 topN=2 → 3×2=6 对 > warnOver=5 → 照常 ok 但带警告
  const { state, run } = setup([pts])
  const warn = await run('webgis_od_matrix', { origin: 'dataset', topN: 2, warnOver: 5 })
  assert.equal(warn.ok, true)
  assert.match(warn.message, /⚠️/)
  assert.match(warn.message, /过密/)
  const layer = state.layers.find((l) => l.id === warn.layerId)
  assert.equal(layer.featureCount, 6, '超过阈值照常生成，不阻断')
  // warnOver=100 不触发警告
  const { run: runQ } = setup([pts])
  const quiet = await runQ('webgis_od_matrix', { origin: 'dataset', topN: 2, warnOver: 100 })
  assert.equal(quiet.ok, true)
  assert.doesNotMatch(quiet.message, /⚠️/)
})

test('webgis_od_matrix：topN 无硬上限（>100 生效），缺省每起点 100', async () => {
  const pt = (lng, lat, props = {}) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lng, lat] } })
  const origins = makeResultLayer({
    id: 'orig', name: '起点',
    geojson: featureCollection([pt(0, 0), pt(0, 5), pt(5, 0)]),
    source: 'dataset',
  })
  const dests = makeResultLayer({
    id: 'dst', name: '终点',
    geojson: featureCollection(Array.from({ length: 300 }, (_, i) => pt((i % 30) * 0.1, Math.floor(i / 30) * 0.1))),
    source: 'dataset',
  })
  // topN=1000：每起点连全部 300 个终点 → 3×300=900，无 100 钳制
  const { state, run } = setup([origins, dests])
  const out = await run('webgis_od_matrix', { origin: 'orig', destination: 'dst', topN: 1000, warnOver: 10000, maxPairs: 20000 })
  assert.equal(out.ok, true)
  const layer = state.layers.find((l) => l.id === out.layerId)
  assert.equal(layer.featureCount, 900)
  // 缺省 topN=100：每起点连最近 100 个 → 3×100=300
  const { state: st2, run: run2 } = setup([origins, dests])
  const out2 = await run2('webgis_od_matrix', { origin: 'orig', destination: 'dst', warnOver: 10000, maxPairs: 20000 })
  assert.equal(out2.ok, true)
  const layer2 = st2.layers.find((l) => l.id === out2.layerId)
  assert.equal(layer2.featureCount, 300)
})

test('set_layer_style: 点位大小/描边/填充色落字段，不 bump rev；非法值拒绝', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] }), feature({ type: 'Point', coordinates: [1, 0] })]),
    source: 'dataset',
  })
  const { state, run } = setup([pts])
  const before = state.layers[0].rev
  const out = await run('webgis_set_layer_style', { layer: 'dataset', color: '#ff0000', radius: 12, strokeWidth: 3, fillColor: '#00ff00' })
  assert.equal(out.ok, true)
  const l = state.layers[0]
  assert.equal(l.color, '#ff0000')
  assert.equal(l.pointRadius, 12)
  assert.equal(l.pointStrokeWidth, 3)
  assert.equal(l.fillColor, '#00ff00')
  assert.equal(l.rev, before, '纯展示变更不 bump rev')
  const bad = await run('webgis_set_layer_style', { layer: 'dataset', radius: 0 })
  assert.equal(bad.ok, false)
  const badColor = await run('webgis_set_layer_style', { layer: 'dataset', fillColor: 'not-a-color' })
  assert.equal(badColor.ok, false)
})

test('set_attribute / add_sequence: 属性编辑 bump rev，客户端重拉；筛选只改命中要素', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([
      feature({ type: 'Point', coordinates: [0, 0] }, { label: 'a' }),
      feature({ type: 'Point', coordinates: [1, 0] }, { label: 'b' }),
    ]),
    source: 'dataset',
  })
  const { state, run } = setup([pts])
  const before = state.layers[0].rev
  // add_sequence：0..n-1
  const seq = await run('webgis_add_sequence', { layer: 'dataset', field: 'seq' })
  assert.equal(seq.ok, true)
  assert.equal(seq.featureCount, 2)
  assert.equal(state.layers[0].rev, before + 1, '属性编辑应 bump rev')
  assert.deepEqual(state.layers[0].geojson.features.map((f) => f.properties.seq), [0, 1])
  // add_sequence start=1：1 基递增（count 从 1 开始）
  const seq1 = await run('webgis_add_sequence', { layer: 'dataset', field: 'count', start: 1 })
  assert.equal(seq1.ok, true)
  assert.match(seq1.message, /1~2/)
  assert.deepEqual(state.layers[0].geojson.features.map((f) => f.properties.count), [1, 2])
})

test('webgis_add_column: 新增空字段（值 null），已存在的字段拒绝', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([
      feature({ type: 'Point', coordinates: [0, 0] }, { label: 'a' }),
      feature({ type: 'Point', coordinates: [1, 0] }, { label: 'b' }),
    ]),
    source: 'dataset',
  })
  const { state, run } = setup([pts])
  const before = state.layers[0].rev
  const out = await run('webgis_add_column', { layer: 'dataset', field: 'test' })
  assert.equal(out.ok, true)
  assert.equal(out.featureCount, 2)
  assert.equal(state.layers[0].rev, before + 1, '新增列应 bump rev')
  assert.deepEqual(state.layers[0].geojson.features.map((f) => f.properties.test), [null, null])
  assert.equal(state.layers[0].geojson.features[0].properties.label, 'a', '原有字段不受影响')
  // 字段已存在 → ok:false
  const again = await run('webgis_add_column', { layer: 'dataset', field: 'test' })
  assert.equal(again.ok, false)
  assert.match(again.message, /已存在/)
  // set_attribute 全部要素
  const all = await run('webgis_set_attribute', { layer: 'dataset', field: 'kind', value: 'x' })
  assert.equal(all.ok, true)
  assert.equal(all.featureCount, 2)
  assert.deepEqual(state.layers[0].geojson.features.map((f) => f.properties.kind), ['x', 'x'])
  // set_attribute 带筛选：只改 label=a 的
  const filt = await run('webgis_set_attribute', { layer: 'dataset', field: 'tag', value: 1, filterField: 'label', filterOperator: 'eq', filterValue: 'a' })
  assert.equal(filt.ok, true)
  assert.equal(filt.featureCount, 1)
  assert.deepEqual(state.layers[0].geojson.features.map((f) => f.properties.tag), [1, undefined])
  // 筛选不命中 → ok:false
  const miss = await run('webgis_set_attribute', { layer: 'dataset', field: 'tag', value: 1, filterField: 'label', filterOperator: 'eq', filterValue: 'nope' })
  assert.equal(miss.ok, false)
  assert.match(miss.message, /没有要素被修改/)
  // 空字段名（过 schema 但为空）→ handler 守卫 ok:false
  const emptyField = await run('webgis_set_attribute', { layer: 'dataset', field: '', value: 1 })
  assert.equal(emptyField.ok, false)
})

test('average_nearest_neighbor / moran_i: 返回 stat 且不产出图层', async () => {
  const pts = makeResultLayer({
    id: 'dataset', name: '点',
    geojson: featureCollection([feature({ type: 'Point', coordinates: [0, 0] }), feature({ type: 'Point', coordinates: [1, 0] })]),
    source: 'dataset',
  })
  const { state, run } = setup([pts])
  const ann = await run('webgis_average_nearest_neighbor', { layer: 'dataset' })
  assert.equal(ann.ok, true)
  assert.equal(ann.stat, 'ann')
  assert.ok(!('layerId' in ann))
  assert.equal(state.layers.length, 1) // 未新增图层

  const poly = makeResultLayer({
    id: 'dataset2', name: '面',
    geojson: featureCollection([
      square(0, 0, 1, 1, { v: 10 }),
      square(1, 0, 2, 1, { v: 10 }),
      square(2, 0, 3, 1, { v: 1 }),
      square(3, 0, 4, 1, { v: 1 }),
    ]),
    source: 'dataset',
  })
  const { run: run2 } = setup([poly])
  const mi = await run2('webgis_moran_i', { layer: 'dataset2', field: 'v' })
  assert.equal(mi.ok, true)
  assert.equal(mi.stat, 'moran_i')
  assert.ok(!('layerId' in mi))
  assert.ok(mi.value.I > 0)
})

test('抽样守卫：逐要素空间分析拒做未物化图层；已物化正常；统计注记基于抽样', async () => {
  const pts = featureCollection([
    point([113, 23]), point([113.1, 23.1]), point([113.2, 23.2]), point([113.3, 23.3]), point([113.4, 23.4]),
  ])
  // 模拟 DuckDB 大文件图层的抽样子集（geojson 只含 5 个点，真实 10 万行在内存表）
  const sampled = makeResultLayer({
    id: 'csv_1', name: '大点集', geojson: pts, source: 'csv',
    duckTable: 'duckdb_1', duckCoords: { lon: 'lon', lat: 'lat' }, totalCount: 100_000, cluster: false,
  })
  const materialized = makeResultLayer({ id: 'dataset', name: '小点集', geojson: pts, source: 'dataset' })
  const { state, run } = setup([sampled, materialized])

  // 未物化图层：buffer / od_matrix / centroids 拒做
  for (const [name, args, re] of [
    ['webgis_buffer', { layer: 'csv_1', distance: 1 }, /抽样子集/],
    ['webgis_od_matrix', { origin: 'csv_1' }, /抽样子集/],
    ['webgis_centroids', { layer: 'csv_1' }, /抽样子集/],
  ]) {
    const out = await run(name, args)
    assert.equal(out.ok, false, name)
    assert.match(out.message, re, name)
  }
  // 已物化图层：正常执行
  const ok = await run('webgis_buffer', { layer: 'dataset', distance: 1 })
  assert.equal(ok.ok, true)
  // 统计类不拒做但注记「基于抽样」
  const kde = await run('webgis_kernel_density', { layer: 'csv_1', mode: 'plane' })
  assert.equal(kde.ok, true)
  assert.match(kde.message, /抽样/)
})

// ---- 莫兰：体检 → 确认 → 计算 的工作流 ----

test('webgis_moran_inspect：不传 layer 扫描全部图层，推荐数值字段、排除 ID/常量/文本，并给出默认参数', async () => {
  const messy = makeResultLayer({
    id: 'ds_messy', name: '混装',
    geojson: featureCollection([
      square(0, 0, 1, 1, { name: '甲', OBJECTID: 1, code: 'A01', pop: 10, ratio: '1.5' }),
      square(1, 0, 2, 1, { name: '乙', OBJECTID: 2, code: 'A02', pop: 20, ratio: '2.5' }),
      square(0, 1, 1, 2, { name: '丙', OBJECTID: 3, code: 'A03', pop: 30, ratio: '3.5' }),
      square(1, 1, 2, 2, { name: '丁', OBJECTID: 4, code: 'A04', pop: 40, ratio: '4.5' }),
    ]),
    source: 'dataset',
  })
  const { run } = setup([messy])
  const res = await run('webgis_moran_inspect', {})
  assert.equal(res.ok, true)
  assert.equal(res.stat, 'moran_inspect')
  const layer = res.value.layers.find((l) => l.layerId === 'ds_messy')
  assert.ok(layer, '应报告该图层')
  assert.equal(layer.feasible, true)
  const rec = layer.recommendedFields.map((f) => f.field).sort()
  assert.deepEqual(rec, ['pop', 'ratio'], '数值列（含数值字符串）应推荐')
  const excl = Object.fromEntries(layer.excludedFields.map((f) => [f.field, f.excluded]))
  assert.match(excl.OBJECTID, /标识/)
  assert.match(excl.code, /标识/)
  assert.match(excl.name, /非数值/)
  assert.equal(layer.defaultWeight, 'queen')
  assert.match(res.message, /推荐字段/)
  assert.match(res.message, /等待确认/)
})

test('webgis_moran_inspect：无可用数值字段 / 要素过少 → 明确说明不可分析及原因', async () => {
  const noNum = makeResultLayer({
    id: 'ds_text', name: '纯文本',
    geojson: featureCollection([
      square(0, 0, 1, 1, { a: 'x' }), square(1, 0, 2, 1, { a: 'y' }),
    ]),
    source: 'dataset',
  })
  const { run } = setup([noNum])
  const res = await run('webgis_moran_inspect', {})
  assert.equal(res.ok, true)
  const layer = res.value.layers[0]
  assert.equal(layer.feasible, false)
  assert.ok(layer.reasons.some((r) => /要素过少/.test(r)))
  assert.ok(layer.reasons.some((r) => /没有可用的数值字段/.test(r)))
  assert.equal(res.value.anyFeasible, false)
  assert.match(res.message, /无法支持莫兰指数分析/)
})

test('webgis_moran_inspect：抽样图层给出警示（须先筛成全量）', async () => {
  const sampled = makeResultLayer({
    id: 'ds_big', name: '大文件抽样',
    geojson: featureCollection([
      square(0, 0, 1, 1, { pop: 1 }), square(1, 0, 2, 1, { pop: 2 }),
      square(0, 1, 1, 2, { pop: 3 }), square(1, 1, 2, 2, { pop: 4 }),
    ]),
    source: 'dataset',
    duckTable: 'duckdb_x', duckGeom: { column: 'geom', format: 'geometry', sourceCrs: null },
    totalCount: 200000,
  })
  const { run } = setup([sampled])
  const res = await run('webgis_moran_inspect', {})
  const layer = res.value.layers[0]
  assert.equal(layer.materialized, false)
  assert.match(layer.warning, /抽样/)
  assert.match(res.message, /先用 webgis_filter_layer/)
})

test('webgis_local_moran：生成带 lisa_class 的新图层并汇总四类', async () => {
  const vals = [90, 95, 100, 1, 1, 1, 1, 1, 1, 1]
  const grid = makeResultLayer({
    id: 'ds_grid', name: '格网',
    geojson: featureCollection(vals.map((v, i) => square(i, 0, i + 1, 1, { v }))),
    source: 'dataset',
  })
  const { run, state } = setup([grid])
  const res = await run('webgis_local_moran', { layer: 'ds_grid', field: 'v', permutations: 999, seed: 11 })
  assert.equal(res.ok, true)
  assert.ok(res.layerId, '应产出新图层')
  const out = state.layers.find((l) => l.id === res.layerId)
  assert.ok(out)
  assert.equal(out.featureCount, 10)
  for (const f of out.geojson.features) {
    assert.ok(['HH', 'LL', 'HL', 'LH', 'nonsig'].includes(f.properties.lisa_class))
    assert.ok(Number.isFinite(f.properties.lisa_I))
  }
  assert.match(res.message, /HH \d+/)
  assert.match(res.message, /不显著/)
})

test('webgis_moran_i：weight=distance 需阈值；点图层默认 knn 可算', async () => {
  const pts = makeResultLayer({
    id: 'ds_pts', name: '点',
    geojson: featureCollection([
      point([0, 0], { v: 10 }), point([0.01, 0], { v: 11 }), point([0.02, 0], { v: 9 }),
      point([1, 0], { v: 1 }), point([1.01, 0], { v: 2 }), point([1.02, 0], { v: 1 }),
    ]),
    source: 'dataset',
  })
  const { run } = setup([pts])
  const noThr = await run('webgis_moran_i', { layer: 'ds_pts', field: 'v', weight: 'distance' })
  assert.equal(noThr.ok, false)
  assert.match(noThr.message, /distanceMeters/)
  const knnRes = await run('webgis_moran_i', { layer: 'ds_pts', field: 'v' })
  assert.equal(knnRes.ok, true)
  assert.equal(knnRes.value.weight, 'knn')
})

// ---------------------------------------------------------------------------
// 隔离派发：门控分流 / 预算同源 / 信号透传 / 取消不写图层 / 错误形态统一
// ---------------------------------------------------------------------------

/** 一个"规模很大但几何很小"的图层：用来只测**路由决策**，不真造几十万要素。 */
function bigLayer(id, name, geojson, totalCount) {
  return makeResultLayer({ id, name, source: 'gis-result', geojson, totalCount })
}

const pointLayerForAnn = makeResultLayer({
  id: 'result_pts', name: '点位', source: 'gis-result',
  geojson: featureCollection([point([0, 0]), point([1, 1]), point([2, 2]), point([3, 3])]),
})

test('门控：小图层在主线程直算，不调隔离执行器', async () => {
  const { run, calls } = setupWithStubRunner([polygonLayer])
  const out = await run('webgis_dissolve', { layer: 'dataset' })
  assert.equal(out.ok, true, out.message)
  assert.equal(calls.length, 0, '2 个要素远低于 dissolve 阈值(2000)，不该隔离')
})

test('门控：大图层才隔离，且预算与工具 timeoutMs 同源、signal 原样透传', async () => {
  // 阈值从 GEO_JOB_GATE 取，不写死数字 —— 否则每次重新标定这条都会红
  const big = bigLayer('result_big', '大层', polygonLayer.geojson, GEO_JOB_GATE.dissolve.min)
  const { run, calls } = setupWithStubRunner([big])
  const ac = new AbortController()
  const out = await run('webgis_dissolve', { layer: 'result_big' }, undefined, { signal: ac.signal })
  assert.equal(out.ok, true, out.message)
  assert.equal(calls.length, 1, `规模恰好等于阈值(${GEO_JOB_GATE.dissolve.min})，应走隔离`)
  assert.equal(calls[0].timeoutMs, GEO_TOOL_TIMEOUTS.op - 2000, 'worker 预算必须 = 工具预算 − 2000')
  assert.equal(calls[0].signal, ac.signal, 'exec.signal 必须原样透传（同一对象，不是副本）')
})

test('门控判据用 totalCount：抽样层不能被当成小图层（最容易搞反的一条）', async () => {
  // 同一个 geojson，一个声明真实 5 万行、一个没声明 —— 前者必须隔离，后者不必
  const sampled = bigLayer('result_sampled', '抽样层', polygonLayer.geojson, GEO_JOB_GATE.dissolve.min * 2)
  const plain = bigLayer('result_plain', '普通层', polygonLayer.geojson, undefined)
  const a = setupWithStubRunner([sampled])
  await a.run('webgis_dissolve', { layer: 'result_sampled' })
  assert.equal(a.calls.length, 1, 'totalCount 越线应隔离（用 featureCount=2 就会漏判）')
  const b = setupWithStubRunner([plain])
  await b.run('webgis_dissolve', { layer: 'result_plain' })
  assert.equal(b.calls.length, 0, '无 totalCount 时按 featureCount=2 判，不隔离')
})

test('取消：上游 abort 时返回 ok:false，且**不写入任何图层**', async () => {
  const big = bigLayer('result_big2', '大层', polygonLayer.geojson, GEO_JOB_GATE.dissolve.min)
  const { run, state } = setupWithStubRunner([big], () => { throw new GeoJobAbortedError() })
  const before = state.layers.length
  const out = await run('webgis_dissolve', { layer: 'result_big2' })
  assert.equal(out.ok, false, '取消必须返回 ok:false')
  assert.match(out.message, /已取消/)
  assert.equal(state.layers.length, before, '取消后不得留下"模型认为不存在"的图层')
})

test('错误形态统一：隔离路径下，原本没有 try/catch 的工具也返回 {ok:false} 而不是抛异常', async () => {
  // buffer / simplify / average_nearest_neighbor 都在原先那 7 个「无 try/catch」的名单里。
  // 改动前隔离任务的失败会让异常**逃出 execute()**（变 isError 工具调用失败），
  // 拿不到项目统一的中文结果，而且不同工具形态还不一样。
  // ⚠️ 阈值各不同：buffer/simplify 是 20000，ann 是 2000 —— 数据要按各自阈值造。
  const boom = () => { throw new Error('模拟算子异常') }
  const bigPoly = bigLayer('result_bigp', '大面层', polygonLayer.geojson, 50_000)
  const bigPts = bigLayer('result_bigpt', '大点层', pointLayerForAnn.geojson, 5_000)
  const { run } = setupWithStubRunner([bigPoly, bigPts], boom)
  const cases = [
    ['webgis_buffer', { layer: 'result_bigp', distance: 100, unit: 'meters' }],
    ['webgis_simplify', { layer: 'result_bigp', tolerance: 0.01 }],
    ['webgis_average_nearest_neighbor', { layer: 'result_bigpt' }],
  ]
  for (const [name, args] of cases) {
    const out = await run(name, args)
    assert.equal(out.ok, false, `${name} 应返回 ok:false 而不是抛异常`)
    assert.equal(typeof out.message, 'string')
    assert.match(out.message, /模拟算子异常/, `${name} 的报错应带上原因`)
  }
})

test('错误形态统一：直算路径同样在同一个 try 里（sync 抛异常也收成 ok:false）', async () => {
  // 直接在运行时层测，不绕工具 schema —— 框架会先按 enum 校验参数，
  // 用"非法 unit"这类输入根本到不了算子，测不到 sync 分支。
  const rt = createGeoToolRuntime(() => ({ layers: [] }))
  const job = { kind: 'buffer', layer: { geojson: polygonLayer.geojson }, distance: 1, unit: 'meters' }
  const r = await rt.runGeoOp({
    exec: {},
    job,
    budgetMs: 28_000,
    sync: () => { throw new Error('同步侧失败') },
    scale: 1, // 远低于阈值 → 走 sync 分支
  })
  assert.equal(r.ok, false, 'sync 抛异常必须被收成 ok:false')
  assert.match(r.message, /同步侧失败/)
  // 对照：同一个 runGeoOp，sync 正常时返回 ok:true + 值
  const ok = await rt.runGeoOp({ exec: {}, job, budgetMs: 28_000, sync: () => ({ done: true }), scale: 1 })
  assert.deepEqual(ok, { ok: true, value: { done: true } })
})

test('错误形态统一：隔离路径与直算路径给出同一种**信封形状**', async () => {
  const rt = createGeoToolRuntime(() => ({ layers: [] }))
  const job = { kind: 'buffer', layer: { geojson: polygonLayer.geojson }, distance: 1, unit: 'meters' }
  const viaLocal = await rt.runGeoOp({
    exec: {}, job, budgetMs: 28_000, sync: () => { throw new Error('直算侧失败') }, scale: 1,
  })
  const big = bigLayer('result_big3', '大层', polygonLayer.geojson, GEO_JOB_GATE.buffer.min)
  const viaIsolate = await setupWithStubRunner([big], () => { throw new Error('隔离侧失败') })
    .run('webgis_buffer', { layer: 'result_big3', distance: 1, unit: 'meters' })
  for (const [label, out] of [['直算', viaLocal], ['隔离', viaIsolate]]) {
    assert.equal(out.ok, false, `${label}路径应 ok:false`)
    assert.equal(typeof out.message, 'string', `${label}路径应带 message`)
    assert.ok(out.message.length > 0, `${label}路径的 message 不该为空`)
    assert.equal('layerId' in out, false, `${label}路径失败时不该带 layerId`)
  }
})

// ---------------------------------------------------------------------------
// 规则格网 / 泰森多边形：迁移到隔离执行 + 格数硬上限
// ---------------------------------------------------------------------------

test('规则格网：格数超过上限时拒绝，并给出可直接照做的 cellSize 建议', async () => {
  const { run } = setup()
  // 全国范围 + 极小格距 → 天文数字的格子
  const out = await run('webgis_regular_grid', { bbox: [73, 18, 135, 54], cellSize: 0.0001, unit: 'degrees' })
  assert.equal(out.ok, false, '荒谬输入必须被拒绝，而不是等 OOM')
  assert.match(out.message, /格网过密/)
  assert.match(out.message, /cellSize/, '要告诉用户改哪个参数')
  assert.match(out.message, /缩小 bbox/, '也要给出另一个可行方向')
  // 建议值必须是可解析的数字，用户照着填就能过
  const m = /调大到 ([\d.]+)/.exec(out.message)
  assert.ok(m, `建议值应出现在文案里：${out.message}`)
  assert.ok(Number(m[1]) > 0.0001)
})

test('规则格网：小格网在主线程直算，格子数与 turf 生成的一致', async () => {
  const { run, calls } = setupWithStubRunner([])
  const bbox = [113, 23, 113.1, 23.1]
  const out = await run('webgis_regular_grid', { bbox, cellSize: 0.01, unit: 'degrees' })
  assert.equal(out.ok, true, out.message)
  // 用**同一个** regularGridCellCount 断言，而不是手算 10×10 ——
  // turf 内部是 Math.floor(|宽| / cellDeg)，而 (113.1-113)/0.01 = 9.999999999999998 → 9 列，
  // 所以实际是 9×10=90 而不是 100。手算会把浮点行为当成 bug。
  const cells = regularGridCellCount(bbox, 0.01, 'degrees')
  assert.equal(out.featureCount, cells)
  assert.ok(cells < 2000, `前置：这组参数应低于隔离阈值（实际 ${cells} 格）`)
  assert.equal(calls.length, 0, '格数低于阈值 → 门控应让它留在主线程直算')
})

test('规则格网：中等格网在主线程直算（生成近乎免费，隔离只会加 169ms 延迟）', async () => {
  // 实测：20,000 格只要 2ms，而隔离固定成本 169ms —— 所以门控阈值定在 100 万格量级。
  // 工具层造不出百万格的真格网（stub 会真的生成它们），所以"越线才派发"由 policy 测试钉，
  // 这里钉相反的一面：中等格网**不该**被送去隔离。
  const { run, calls } = setupWithStubRunner([])
  const out = await run('webgis_regular_grid', { bbox: [113, 23, 114, 24], cellSize: 0.02, unit: 'degrees' })
  assert.equal(out.ok, true, out.message)
  assert.equal(calls.length, 0, '约 2500 格远低于阈值，应留主线程')
})

test('规则格网：cellSize 非法时给中文提示，不抛异常', async () => {
  const { run } = setup()
  for (const bad of [0, -1]) {
    const out = await run('webgis_regular_grid', { bbox: [0, 0, 1, 1], cellSize: bad, unit: 'degrees' })
    assert.equal(out.ok, false)
    assert.match(out.message, /cellSize/)
  }
})

test('泰森多边形：≥3 点可执行；小图层不隔离（门控正确留在主线程）', async () => {
  const pts = makeResultLayer({
    id: 'result_pts3', name: '四点', source: 'gis-result',
    geojson: featureCollection([point([113, 23]), point([113.1, 23.1]), point([113.2, 23]), point([113.3, 23.2])]),
  })
  const two = makeResultLayer({
    id: 'result_pts2', name: '两点', source: 'gis-result',
    geojson: featureCollection([point([113, 23]), point([113.1, 23.1])]),
  })
  const { run, calls } = setupWithStubRunner([pts, two])
  const ok = await run('webgis_voronoi', { layer: 'result_pts3' })
  assert.equal(ok.ok, true, ok.message)
  assert.equal(ok.featureCount, 4, '每点一个面')
  assert.equal(calls.length, 0, '4 个点远低于阈值(2000)，门控应让它留在主线程直算')
  const bad = await run('webgis_voronoi', { layer: 'result_pts2' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /至少需要 3 个点/)
})

test('泰森多边形：大图层才走隔离，且 job 形状正确', async () => {
  const big = makeResultLayer({
    id: 'result_bigv', name: '大点层', source: 'gis-result',
    geojson: featureCollection([point([113, 23]), point([113.1, 23.1]), point([113.2, 23]), point([113.3, 23.2])]),
    totalCount: 600_000,
  })
  const { run, calls } = setupWithStubRunner([big])
  const out = await run('webgis_voronoi', { layer: 'result_bigv', bbox: [112, 22, 114, 24] })
  assert.equal(out.ok, true, out.message)
  assert.equal(calls.length, 1, 'totalCount=60万 应走隔离')
  assert.equal(calls[0].job.kind, 'voronoi')
  assert.deepEqual(calls[0].job.bbox, [112, 22, 114, 24], 'bbox 是「无几何输入」之外唯一的空间参数，必须原样带上')
})
