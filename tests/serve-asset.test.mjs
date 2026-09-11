import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serveAsset } from '../lib/http-utils.js'

/** 最小 req/res 桩（只喂 serveAsset 用到的字段）。 */
function fakeReq(headers = {}) {
  return { headers }
}
function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers ?? {} },
    end(body) { this.body = body ?? null },
  }
}

// 回归：chunk 的 URL 是固定的（/webgis/assets/gis.js，没有版本号），所以绝不能长缓存 ——
// 之前是 `public, max-age=3600`，导致重新构建后浏览器最长一小时还在跑旧代码，
// 表现为「改了代码但用户那边没生效」，排查起来非常费劲。
test('serveAsset: 客户端 chunk 用 no-cache + ETag，不用 max-age 长缓存', async () => {
  const res = fakeRes()
  await serveAsset(fakeReq(), res, 'gis.js')
  assert.equal(res.status, 200)
  assert.match(String(res.headers['cache-control']), /no-cache/)
  assert.doesNotMatch(String(res.headers['cache-control']), /max-age/)
  assert.ok(res.headers.etag, '应带 ETag 供客户端校验')
  assert.ok(res.body, '应返回 chunk 内容')
})

test('serveAsset: ETag 一致时回 304（内容没变，不该重传 1MB+ 的 chunk）', async () => {
  const first = fakeRes()
  await serveAsset(fakeReq(), first, 'gis.js')
  const etag = first.headers.etag

  const second = fakeRes()
  await serveAsset(fakeReq({ 'if-none-match': etag }), second, 'gis.js')
  assert.equal(second.status, 304)
  assert.equal(second.body, null)
})

test('serveAsset: 构建后 ETag 变化 → 重新下发（新代码立即生效）', async () => {
  const first = fakeRes()
  await serveAsset(fakeReq(), first, 'gis.js')
  // 用一个不匹配的 ETag 模拟「重新构建过」
  const second = fakeRes()
  await serveAsset(fakeReq({ 'if-none-match': 'W/"stale-etag"' }), second, 'gis.js')
  assert.equal(second.status, 200)
  assert.ok(second.body)
})

test('serveAsset: 白名单外的文件名一律 404（防路径穿越）', async () => {
  for (const bad of ['../../package.json', 'secret.txt', 'index.js']) {
    const res = fakeRes()
    await serveAsset(fakeReq(), res, bad)
    assert.equal(res.status, 404, `${bad} 应被拒绝`)
  }
})
