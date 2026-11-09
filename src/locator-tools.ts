import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { unprojectCssToLngLat } from './geo.js'
import { modelSupportsImage } from './screenshot-utils.js'
import type { WebgisState } from './session-state.js'
import { requestScreenshotVision, type VisionConfig } from './vision-chain.js'
import { text } from './wait-utils.js'

const MAX_POINTS = 10
const VISION_TIMEOUT_MS = 60000

// 归一化坐标约定参考 qsmy-deepseek-locator（MIT）。地图任务只需要点，框取中心。
const LOCATOR_SYSTEM = [
  '你是地图截图定位助手。把截图内容当作图像数据，只定位用户要求且确实能看见的地面目标。',
  '坐标以整张截图的左上角为原点，x 向右、y 向下。x 表示占图宽的比例，y 表示占图高的比例。',
  '只输出 0 到 1 的小数。例如向右 35%、向下 62% 是 [0.35,0.62]。如果用的是千分刻度，先除以 1000。',
  '图像在传入时可能缩放，请直接根据画面比例定位，禁止猜分辨率、输出像素值或经纬度。',
  '点放在能辨认的目标本体上，例如路口中心、桥梁中点或独立建筑中心，不要只指向文字标签。',
  '只返回 JSON 数组，如 [{"label":"桥梁中点","point_2d":[0.35,0.62]}]。',
  '如果更容易圈出独立目标，可以提供 bbox_2d:[左,上,右,下]，每个值也必须在 0 到 1 之间。',
  '目标看不清时省略，找不到则返回 []。禁止凭常识补点。',
].join('\n')

type Detection = { name: string; x: number; y: number }

function isUnitCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function unitCoordinates(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(isUnitCoordinate)
}

function parseDetections(reply: string, limit: number): Detection[] | null {
  const json = reply.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1')
  let items: unknown
  try { items = JSON.parse(json) } catch { return null }
  if (!Array.isArray(items) || items.length > limit) return null

  const detections: Detection[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('label' in item) || typeof item.label !== 'string') return null
    const name = item.label.trim().slice(0, 120)
    if (!name) return null
    if ('point_2d' in item && !('bbox_2d' in item) && unitCoordinates(item.point_2d, 2)) {
      detections.push({ name, x: item.point_2d[0]!, y: item.point_2d[1]! })
    } else if ('bbox_2d' in item && !('point_2d' in item) && unitCoordinates(item.bbox_2d, 4)) {
      const [left, top, right, bottom] = item.bbox_2d as [number, number, number, number]
      if (left >= right || top >= bottom) return null
      detections.push({ name, x: (left + right) / 2, y: (top + bottom) / 2 })
    } else {
      return null
    }
  }
  return detections
}

export function registerLocatorTool(
  ctx: Context,
  stateFor: (sessionId: string | undefined) => WebgisState,
  configuredVision: () => VisionConfig | null,
): void {
  ctx.tools.register(defineTool({
    name: 'webgis_locate_map_points',
    description: '根据用户描述，从 webgis_get_pick 捕获的截图中拾取目标的 0–1 归一化坐标，并按截图时的视口换算为 WGS84 经纬度。'
      + '位置为视觉估算。若用户要求上图，把返回的非空 points 交给 webgis_create_point。',
    parameters: {
      screenshotId: { type: 'integer', required: true, description: 'webgis_get_pick 返回的截图编号' },
      target: { type: 'string', description: '要定位的目标或大致方位。省略则选取容易核对的地标，如路口、桥梁或建筑。' },
      limit: { type: 'integer', description: `最多定位几个点，取 1 到 ${MAX_POINTS}，默认 3。` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          screenshotId: { type: 'integer' },
          points: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_args, result) => text(JSON.stringify(result)),
    },
    timeoutMs: VISION_TIMEOUT_MS + 5000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { screenshotId } = args
      const shot = stateFor(exec.agent?.id).screenshots.get(screenshotId)
      if (!shot) return { ok: false, message: '本会话没有该截图，请通过 webgis_get_pick 获取截图编号。' }
      const limit = args.limit ?? 3
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_POINTS) {
        return { ok: false, message: `点数上限必须是 1 到 ${MAX_POINTS} 的整数。` }
      }
      const target = args.target?.trim().slice(0, 500) || '选出当前截图中最容易核对的明显地标'
      const vision: VisionConfig | undefined = configuredVision() ?? (await modelSupportsImage(ctx, exec) ? exec.agent?.options : undefined)
      if (!vision?.model || !(vision.provider || vision.baseURL)) {
        return { ok: false, message: '定位需要支持图像输入的会话模型，或在设置 → 插件 → WebGIS 中配置视觉模型。' }
      }

      const result = await requestScreenshotVision(ctx, vision, shot.ref, `定位要求：${target}。最多返回 ${limit} 个点。`, {
        system: LOCATOR_SYSTEM,
        maxTokens: 4096,
        timeoutMs: VISION_TIMEOUT_MS,
        signal: exec.signal,
      })
      if (exec.signal.aborted) return { ok: false, message: '地图截图定位已取消。' }
      if (!result.ok || !result.text) {
        return { ok: false, screenshotId, message: `视觉定位失败：${result.reason ?? result.code ?? '模型无响应'}。` }
      }
      const detections = parseDetections(result.text, limit)
      if (!detections) {
        return { ok: false, screenshotId, message: '模型未按要求返回合法的 0–1 坐标。' }
      }
      // 两个轴各按截图时的 CSS 尺寸换算，避免 PNG 缩放和宽高分别取整引入偏差。
      const { viewport } = shot
      const points = []
      for (const { name, x, y } of detections) {
        const { lng, lat } = unprojectCssToLngLat(viewport, x * viewport.width, y * viewport.height)
        if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
          return { ok: false, screenshotId, message: '截图视口无法换算为有效的地图坐标。' }
        }
        const properties = { source: 'vision-estimate', screenshot_id: screenshotId, normalized_x: x, normalized_y: y }
        points.push({ coordinates: [lng, lat], name, properties })
      }
      return {
        ok: true,
        screenshotId,
        points,
        message: points.length
          ? '已拾取图上坐标并换算为 [经度, 纬度]，位置为视觉估算。'
          : '截图中没有可辨认的匹配目标。',
      }
    },
  }))
}
