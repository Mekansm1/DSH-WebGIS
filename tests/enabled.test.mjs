import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import {
  parseEnabled,
  isPluginEnabled,
  setPluginEnabled,
  readEnabledFile,
  savePluginEnabled,
  isWebgisRouteBlocked,
} from '../lib/enabled.js'

const DATA_PATHS = ['/webgis/state', '/webgis/dataset', '/webgis/gis-result', '/webgis/layer-action', '/webgis/import', '/webgis/export', '/webgis/pick']
const ALLOWED_PATHS = ['/webgis/status', '/webgis/plugin-config', '/webgis/vision-config', '/webgis/postgis-config', '/webgis/postgis-action', '/webgis/maplibre-gl.css', '/webgis/maplibre-gl-csp-worker.js']

test('parseEnabled: 合法/非法/缺字段 各分支', () => {
  assert.equal(parseEnabled('{"enabled":false}'), false)
  assert.equal(parseEnabled('{"enabled":true}'), true)
  assert.equal(parseEnabled('not json'), true)
  assert.equal(parseEnabled('{}'), true)
  assert.equal(parseEnabled('{"enabled":"yes"}'), true)
})

test('isPluginEnabled / setPluginEnabled 内存开关（结束恢复 true）', () => {
  assert.equal(isPluginEnabled(), true, '默认启用（不破坏既有行为）')
  setPluginEnabled(false)
  assert.equal(isPluginEnabled(), false)
  setPluginEnabled(true)
  assert.equal(isPluginEnabled(), true)
})

test('文件往返：save 后 read 一致；缺文件默认启用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'webgis-enabled-'))
  const file = join(dir, 'enabled.json')
  try {
    await savePluginEnabled(false, file)
    assert.equal(await readEnabledFile(file), false)
    await savePluginEnabled(true, file)
    assert.equal(await readEnabledFile(file), true)
    writeFileSync(file, 'garbage')
    assert.equal(await readEnabledFile(file), true, '非法文件默认启用')
    rmSync(file)
    assert.equal(await readEnabledFile(file), true, '缺文件默认启用')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isWebgisRouteBlocked: 启用时全放行；关闭时数据路径挡、白名单放行', async () => {
  setPluginEnabled(true)
  for (const p of [...DATA_PATHS, ...ALLOWED_PATHS]) {
    assert.equal(isWebgisRouteBlocked(p), false, `启用时 ${p} 不应被挡`)
  }
  setPluginEnabled(false)
  for (const p of DATA_PATHS) {
    assert.equal(isWebgisRouteBlocked(p), true, `关闭时 ${p} 应被挡`)
  }
  for (const p of ALLOWED_PATHS) {
    assert.equal(isWebgisRouteBlocked(p), false, `关闭时 ${p} 应放行`)
  }
  setPluginEnabled(true)
})
