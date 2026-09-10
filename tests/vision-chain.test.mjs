import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as vision from '../lib/vision-chain.js'
import {
  buildOpenAIVisionMessages, classifyVisionFailure, createDeadline, failureCodeFor,
} from '../lib/vision-chain.js'

// ---- 失败分类（决定给模型什么信号：别改措辞重试） ----

test('classifyVisionFailure: HTTP 状态码优先归类', () => {
  assert.equal(classifyVisionFailure({ status: 401 }), 'AUTH')
  assert.equal(classifyVisionFailure({ status: 403 }), 'AUTH')
  assert.equal(classifyVisionFailure({ status: 429 }), 'RATE_LIMIT')
  assert.equal(classifyVisionFailure({ status: 402 }), 'QUOTA')
  assert.equal(classifyVisionFailure({ status: 400 }), 'INVALID_REQUEST')
  assert.equal(classifyVisionFailure({ status: 404 }), 'INVALID_REQUEST')
  assert.equal(classifyVisionFailure({ status: 422 }), 'INVALID_REQUEST')
  assert.equal(classifyVisionFailure({ status: 500 }), 'SERVER')
  assert.equal(classifyVisionFailure({ status: 503 }), 'SERVER')
})

test('classifyVisionFailure: 无状态码时按错误文本归类（含网络/超时）', () => {
  assert.equal(classifyVisionFailure(new Error('fetch failed')), 'NETWORK')
  assert.equal(classifyVisionFailure(new Error('ECONNREFUSED 127.0.0.1')), 'NETWORK')
  assert.equal(classifyVisionFailure(new Error('The operation was aborted')), 'TIMEOUT')
  assert.equal(classifyVisionFailure(new Error('insufficient balance')), 'QUOTA')
  assert.equal(classifyVisionFailure(new Error('model does not support image')), 'INVALID_REQUEST')
  assert.equal(classifyVisionFailure(new Error('something odd')), 'OTHER')
  assert.equal(classifyVisionFailure(null), 'OTHER')
  assert.equal(classifyVisionFailure(undefined), 'OTHER')
})

test('failureCodeFor: 单一原因给具体码，混合/未知给通用码', () => {
  assert.equal(failureCodeFor(['AUTH']), 'VISION_AUTH_FAILED')
  assert.equal(failureCodeFor(['RATE_LIMIT']), 'VISION_RATE_LIMITED')
  assert.equal(failureCodeFor(['TIMEOUT']), 'VISION_TIMEOUT')
  // 多个不同原因 → 不指向单一结论
  assert.equal(failureCodeFor(['AUTH', 'TIMEOUT']), 'VISION_BACKEND_UNAVAILABLE')
  assert.equal(failureCodeFor(['SERVER']), 'VISION_BACKEND_UNAVAILABLE')
  assert.equal(failureCodeFor([]), 'VISION_BACKEND_UNAVAILABLE')
})

// ---- 请求体构造 ----

test('buildOpenAIVisionMessages: 图片在前、提问在后，data URL 带正确 mediaType', () => {
  const bytes = new Uint8Array([1, 2, 3, 4])
  const msgs = buildOpenAIVisionMessages(bytes, 'image/png', '这是什么地方？')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, 'user')
  const [img, txt] = msgs[0].content
  assert.equal(img.type, 'image_url')
  assert.equal(img.image_url.url, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`)
  assert.equal(txt.type, 'text')
  assert.equal(txt.text, '这是什么地方？')
})

// ---- 共享时间预算 ----

test('createDeadline: 未超时 remaining>0、expired=false；预算为 0 时立即过期', () => {
  const d = createDeadline(1000)
  assert.equal(d.expired(), false)
  assert.ok(d.remaining() > 0 && d.remaining() <= 1000)
  assert.ok(d.signal() instanceof AbortSignal)

  const zero = createDeadline(0)
  assert.equal(zero.expired(), true)
  assert.equal(zero.remaining(), 0)
})

// ---- 回归护栏：匿名免费兜底不得复活 ----

test('匿名免费兜底已删除：模块不再导出 OVH 端点表', () => {
  assert.equal(vision.OVH_FREE_PROVIDERS, undefined)
  assert.equal(Object.keys(vision).some((k) => /ovh|free/i.test(k)), false)
})
