import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import {
  parseServices,
  validateService,
  upsertService,
  removeService,
  setServiceVisibility,
  nextServiceId,
} from '../lib/webgis-services.js'
import { readServices, writeServices } from '../lib/webgis-services-io.js'

test('validateService: 合法输入归一化；非法拒绝', () => {
  const ok = validateService({ name: '天地图', kind: 'wmts', url: 'https://x/wmts?{z}/{x}/{y}', tileSize: 256 })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.svc.name, '天地图')
    assert.equal(ok.svc.kind, 'wmts')
    assert.equal(ok.svc.tileSize, 256)
    assert.equal(ok.svc.visible, true, 'visible 缺省 true')
  }
  assert.equal(validateService({ kind: 'wmts', url: 'https://x' }).ok, false, '缺 name')
  assert.equal(validateService({ name: 'x', kind: 'tms', url: 'https://x' }).ok, false, '非法 kind')
  assert.equal(validateService({ name: 'x', kind: 'wms', url: '' }).ok, false, '空 url')
  assert.equal(validateService({ name: 'x', kind: 'xyz', url: 'https://x', tileSize: 999 }).ok, false, 'tileSize 越界')
  const vis = validateService({ name: 'x', kind: 'xyz', url: 'https://x', visible: false })
  assert.equal(vis.ok && vis.svc.visible, false, '显式 visible:false 保留')
})

test('upsertService / removeService / setServiceVisibility / nextServiceId', () => {
  const a = validateService({ name: 'A', kind: 'xyz', url: 'https://a' })
  const b = validateService({ name: 'B', kind: 'wms', url: 'https://b' })
  assert.ok(a.ok && b.ok)
  let list = upsertService([], a.svc)
  assert.equal(list.length, 1)
  assert.match(list[0].id, /^svc-\d+$/, '新增自动生成 id')
  const idA = list[0].id
  list = upsertService(list, b.svc)
  assert.equal(list.length, 2)
  // 同 id 更新替换
  const a2 = validateService({ id: idA, name: 'A2', kind: 'xyz', url: 'https://a2' })
  assert.ok(a2.ok)
  list = upsertService(list, a2.svc)
  assert.equal(list.length, 2, '替换不新增')
  assert.equal(list.find((s) => s.id === idA).name, 'A2')
  // 可见性
  list = setServiceVisibility(list, idA, false)
  assert.equal(list.find((s) => s.id === idA).visible, false)
  // 删除
  list = removeService(list, idA)
  assert.equal(list.length, 1)
  assert.equal(nextServiceId(list), 'svc-3', 'id 后缀按现存最大递增')
})

test('parseServices / readServices / writeServices 文件往返', async () => {
  assert.deepEqual(parseServices('not json'), [])
  assert.deepEqual(parseServices('{"services":[]}'), [])
  const ok = validateService({ name: '影像', kind: 'wms', url: 'https://x/wms?bbox={bbox-epsg-3857}' })
  assert.ok(ok)

  const dir = mkdtempSync(join(tmpdir(), 'webgis-services-'))
  const file = join(dir, 'services.json')
  try {
    await writeServices([ok.svc], file)
    const back = await readServices(file)
    assert.equal(back.length, 1)
    assert.equal(back[0].name, '影像')
    assert.equal(back[0].kind, 'wms')
    assert.match(back[0].url, /bbox-epsg-3857/)
    // 缺文件 → 空清单
    assert.deepEqual(await readServices(join(dir, 'nope.json')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
