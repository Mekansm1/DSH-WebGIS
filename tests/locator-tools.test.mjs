import { Readable } from 'node:stream'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectLngLatToCss } from '../lib/geo.js'
import { registerCreateTools } from '../lib/geo-create-tools.js'
import { createGeoToolRuntime } from '../lib/geo-tools-runtime.js'
import { registerLocatorTool } from '../lib/locator-tools.js'
import { handlePick } from '../lib/routes-pick.js'
import { rememberScreenshot } from '../lib/screenshot-utils.js'
import { emptyWebgisState } from '../lib/session-state.js'
import { awaitCurrentViewCapture } from '../lib/wait-utils.js'

const viewport = { width: 1231, height: 713, zoom: 14, bearing: 30, pitch: 45, centerLng: 116.4, centerLat: 39.9 }
const ref = { attachmentId: 'capture.png', mediaType: 'image/png', width: 1024, height: 593, bytes: 3, name: 'map' }
const screenshot = { dataUrl: 'data:image/png;base64,AAAA', viewport, scale: 1024 / viewport.width }

async function postPick(state, api, payload) {
  const status = await new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(payload))])
    const res = { status: 0, writeHead(status) { this.status = status }, end() { resolve(this.status) } }
    handlePick(req, res, null, '/webgis/pick', 'session-a', state, api)
  })
  assert.equal(status, 200)
}

function setup({ reply, configured = null, imageSupport = true } = {}) {
  const state = emptyWebgisState()
  const otherState = emptyWebgisState()
  const requests = []
  const controller = new AbortController()
  const tools = new Map()
  const ctx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    attachments: {
      saveImage: async () => ref,
      readImage: async () => ({ data: new Uint8Array([0, 0, 0]) }),
    },
    logger: { warn() {} },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: imageSupport ? ['image'] : ['text'] }),
      async *stream(request) {
        requests.push(request)
        yield { type: 'text-delta', text: typeof reply === 'function' ? reply(controller) : reply }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
  }
  const stateFor = (id) => id === 'session-a' ? state : otherState
  rememberScreenshot(state, 8, { ref, viewport })
  registerLocatorTool(ctx, stateFor, () => configured)
  assert.deepEqual([...tools.keys()], ['webgis_locate_map_points'])
  registerCreateTools(ctx, createGeoToolRuntime(stateFor))
  const run = (name, args, id = 'session-a') => tools.get(name).execute(args, {
    agent: { id, options: { provider: 'mock', model: imageSupport ? 'vision' : 'text' } },
    signal: controller.signal,
  })
  return {
    state, otherState, requests, run, api: { ctx, seqs: { pickSeq: 0 } },
    locate: (args = {}) => run('webgis_locate_map_points', { screenshotId: 8, ...args }),
  }
}

test('locator projects normalized points and box centers from the specified screenshot', async () => {
  const { state, otherState, requests, run, api } = setup({
    reply: '```json\n[{"label":"路口","point_2d":[0.5,0.5]},{"label":"桥梁","bbox_2d":[0.2,0.3,0.4,0.5]}]\n```',
  })
  const pending = awaitCurrentViewCapture(state, 9, 500)
  const competing = await awaitCurrentViewCapture(state, 10, 500)
  assert.equal(competing.ok, false)
  await postPick(state, api, { captureSeq: 8, ok: false, message: 'stale capture' })
  await postPick(state, api, { captureSeq: 9, lng: 116.4, lat: 39.9, screenshot })
  await postPick(state, api, { lng: 117, lat: 40 })
  const capture = await pending
  assert.equal(capture.ok, true)
  const screenshotId = capture.pick.id
  assert.equal(screenshotId, 1)
  rememberScreenshot(state, screenshotId, capture.pick.screenshot)
  assert.equal(state.pick.id, 2)

  const wrongSession = await run('webgis_locate_map_points', { screenshotId }, 'other-session')
  assert.equal(wrongSession.ok, false)
  assert.equal(requests.length, 0)
  const result = await run('webgis_locate_map_points', { screenshotId, target: '路口和桥梁', limit: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.screenshotId, screenshotId)
  assert.equal(result.points[0].name, '路口')
  assert.deepEqual(result.points[0].properties, {
    normalized_x: 0.5, normalized_y: 0.5, source: 'vision-estimate', screenshot_id: screenshotId,
  })
  assert.equal(state.capture, null)
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].messages[0].content[0].attachment, ref)
  assert.match(requests[0].system, /0 到 1/)
  assert.match(requests[0].messages[0].content[1].text, /路口和桥梁/)
  assert.deepEqual(state.layers, [])

  const created = await run('webgis_create_point', { points: result.points, name: '截图地标' })
  assert.equal(created.featureCount, 2)
  assert.equal(otherState.layers.length, 0)
  assert.equal(state.layers.length, 1)
  const [junction, bridge] = state.layers[0].geojson.features
  assert.equal(junction.properties.name, '路口')
  assert.equal(junction.properties.source, 'vision-estimate')
  assert.equal(junction.properties.screenshot_id, screenshotId)
  assert.ok(Math.abs(junction.geometry.coordinates[0] - viewport.centerLng) < 1e-8)
  assert.ok(Math.abs(junction.geometry.coordinates[1] - viewport.centerLat) < 1e-8)
  const [lng, lat] = bridge.geometry.coordinates
  const projected = projectLngLatToCss(viewport, lng, lat)
  assert.ok(Math.abs(projected.x / viewport.width - 0.3) < 1e-8)
  assert.ok(Math.abs(projected.y / viewport.height - 0.4) < 1e-8)
})

test('locator rejects pixels, reversed boxes and replies without normalized coordinates', async () => {
  for (const reply of [
    '[{"label":"道路","point_2d":[350,620]}]',
    '[{"label":"道路","bbox_2d":[0.7,0.3,0.4,0.5]}]',
    '[{"id":3,"label":"道路"}]',
  ]) {
    const { state, requests, locate } = setup({ reply, configured: { provider: 'configured', model: 'vision' }, imageSupport: false })
    const result = await locate()
    assert.equal(requests[0].provider, 'configured')
    assert.equal(result.image, undefined)
    assert.equal(result.ok, false)
    assert.match(result.message, /0–1/)
    assert.deepEqual(state.layers, [])
  }
  const { locate } = setup({ reply: '[]' })
  assert.deepEqual((await locate()).points, [])
})

test('cancelled visual reply cannot return points', async () => {
  const { state, locate } = setup({ reply: (controller) => {
    controller.abort()
    return '[{"label":"路口","point_2d":[0.5,0.5]}]'
  } })
  const result = await locate()
  assert.equal(result.ok, false)
  assert.match(result.message, /取消/)
  assert.deepEqual(state.layers, [])
})

test('configured HTTP locator sends the same screenshot and system prompt', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://vision.example/chat/completions')
    const { model, messages } = JSON.parse(options.body)
    assert.equal(model, 'vision')
    assert.equal(messages[0].role, 'system')
    assert.match(messages[0].content, /0 到 1/)
    assert.equal(messages[1].content[0].image_url.url, screenshot.dataUrl)
    return Response.json({ choices: [{ message: { content: '[{"label":"路口","point_2d":[0.5,0.5]}]' } }] })
  })
  const { state, locate } = setup({ configured: { baseURL: 'https://vision.example', model: 'vision' }, imageSupport: false })
  assert.equal((await locate()).points.length, 1)
  assert.equal(fetch.mock.callCount(), 1)
  assert.deepEqual(state.layers, [])
})
