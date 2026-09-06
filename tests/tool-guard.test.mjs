import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPluginEnabled, setPluginEnabled } from '../lib/enabled.js'
import { WEBGIS_TOOL_DISABLED_MESSAGE, webgisToolGuardReason } from '../lib/tool-guard.js'

test('webgisToolGuardReason: 启用时放行所有 webgis 工具', () => {
  assert.equal(isPluginEnabled(), true, '测试前置：默认启用')
  assert.equal(webgisToolGuardReason({ name: 'webgis_buffer' }), undefined)
  assert.equal(webgisToolGuardReason({ name: 'webgis_db_query' }), undefined)
  assert.equal(webgisToolGuardReason({ name: 'webgis_load_dataset' }), undefined)
})

test('webgisToolGuardReason: 关闭时拒绝 webgis_*、放行他插件工具（结束恢复）', () => {
  setPluginEnabled(false)
  try {
    assert.equal(webgisToolGuardReason({ name: 'webgis_buffer' }), WEBGIS_TOOL_DISABLED_MESSAGE)
    assert.equal(webgisToolGuardReason({ name: 'webgis_kernel_density' }), WEBGIS_TOOL_DISABLED_MESSAGE)
    // 其他插件的工具不受影响
    assert.equal(webgisToolGuardReason({ name: 'some_other_tool' }), undefined)
    assert.equal(webgisToolGuardReason({ name: 'search' }), undefined)
  } finally {
    setPluginEnabled(true)
  }
  assert.equal(webgisToolGuardReason({ name: 'webgis_buffer' }), undefined, '恢复后放行')
})
