/**
 * 像素↔经纬度换算工具（`webgis_project` / `webgis_unproject`）。
 *
 * ## ⚠️ 已停止开放（2026-09-13 用户决定）
 *
 * `index.ts` **默认不调用本模块**（`PIXEL_TOOLS_ENABLED = false`）。代码保留，只是不注册成工具、
 * 模型看不到。要重新开放，把那个常量改成 `true` 即可。
 *
 * ## 为什么关掉
 * 实测**视觉模型不具备像素坐标测量能力**（16% 图宽 ≈ 234m 误差），而程序化像素扫描 ≈11m，
 * 好一个数量级。让模型估像素、再用这两个工具换算，这条路本身不成立 —— 误差主要来自模型那一侧，
 * 不是换算公式。视觉功能只保留「识别语义」（这是什么地方 / 图上有什么）。
 *
 * ## 保留代码的原因
 * `projectLngLatToCss` / `unprojectCssToLngLat`（`geo.ts`）**不能删** —— `screenshot-utils.ts`
 * 算截图地理范围还在用；`PickScreenshot` 的 viewport/scale 也是截图链路的公共产物。
 * 所以摘掉的只是「把换算暴露给模型」这一层。
 *
 * ⚠️ 停止开放后 `webgis_get_pick` 的返回文案里**不得再提示模型去调这两个工具**（否则模型会
 * 对着不存在的工具名产生幻觉 —— 见 ARCHITECTURE §6「工具描述必须与代码一致」）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectLngLatToCss, unprojectCssToLngLat } from './geo.js'
import type { WebgisState } from './session-state.js'
import { text } from './wait-utils.js'

/**
 * 注册像素换算工具（`webgis_project` / `webgis_unproject`）。
 *
 * @param stateFor 按会话解析状态；两个工具都读该会话最近一次截图（`pick.screenshot`）。
 */
export function registerPixelTools(
  ctx: Context,
  stateFor: (sessionId: string | undefined) => WebgisState,
): void {
  ctx.tools.register(defineTool({
    name: 'webgis_project',
    description:
      '将经纬度坐标转换为最近一次地图截图图像中的像素位置。截图是用户点击时截取的地图模块图像，'
      + '像素原点在图像左上角，x 向右、y 向下（0 ≤ x < width，0 ≤ y < height）。'
      + '当需要把某个地理坐标定位/标注到截图图像上时调用；需先存在地图点击截图（见 webgis_get_pick）。'
      + '返回的像素只对本工具链（webgis_get_pick / unproject）里那张截图有效：'
      + '要放到**别的尺寸的图**（如用户提供的 PNG）上，需再按两张图的尺寸比换算，'
      + '并用几何地标验证 —— 不要用地图文字标注定标（标注按像素渲染且做碰撞剔除，不随几何缩放）。',
    parameters: {
      longitude: { type: 'number', required: true, description: '经度，-180~180' },
      latitude: { type: 'number', required: true, description: '纬度，-90~90' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    execute(args, exec) {
      const shot = stateFor(exec.agent?.id).pick?.screenshot
      if (!shot) {
        return Promise.resolve({ ok: false, message: '尚无地图截图（需先在地图上点击一次）' })
      }
      if (args.longitude < -180 || args.longitude > 180 || args.latitude < -90 || args.latitude > 90) {
        return Promise.resolve({ ok: false, message: '坐标越界' })
      }
      const p = projectLngLatToCss(shot.viewport, args.longitude, args.latitude)
      return Promise.resolve({
        ok: true,
        x: p.x * shot.scale,
        y: p.y * shot.scale,
        width: shot.ref.width,
        height: shot.ref.height,
        message: `已换算: (${args.longitude}, ${args.latitude}) → 截图像素 (${p.x * shot.scale}, ${p.y * shot.scale})`,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'webgis_unproject',
    description:
      '将最近一次地图截图图像中的像素坐标换算为经纬度。截图是用户点击时截取的地图模块图像，'
      + '像素原点在图像左上角，x 向右、y 向下。'
      + '当需要确定截图里某个像素/区域对应的地理位置时调用；需先存在地图点击截图（见 webgis_get_pick）。'
      + '【换算纪律】① 只对 webgis_get_pick 本次返回的那张截图有效（像素坐标请以返回的 width/height 为准）；'
      + '② 需要的是**图像像素**，若你手上是别的尺寸的图（如用户提供的 PNG），先按尺寸比换算到本截图的像素，'
      + '且**必须用几何地标（水体/道路/建筑等形状特征）验证**比例与偏移都对得上；'
      + '③ **不要用地图上的文字标注来对两张图定标** —— 标注由样式引擎按像素渲染并做碰撞剔除，'
      + '不同像素尺寸/瓦片层级下位置和取舍都会变，拿来当基准会得出错误结论；'
      + '④ 用户给的外部图片若无法与本次截图对齐，就如实说明无法换算，不要硬猜坐标。',
    parameters: {
      x: { type: 'number', required: true, description: '截图像素 x，0 ≤ x < width' },
      y: { type: 'number', required: true, description: '截图像素 y，0 ≤ y < height' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          longitude: { type: 'number' },
          latitude: { type: 'number' },
          message: { type: 'string' },
        },
      },
      render: (_args, value) => text(JSON.stringify(value)),
    },
    execute(args, exec) {
      const shot = stateFor(exec.agent?.id).pick?.screenshot
      if (!shot) {
        return Promise.resolve({ ok: false, message: '尚无地图截图（需先在地图上点击一次）' })
      }
      if (!Number.isFinite(args.x) || !Number.isFinite(args.y)) {
        return Promise.resolve({ ok: false, message: '像素坐标不合法' })
      }
      const ll = unprojectCssToLngLat(shot.viewport, args.x / shot.scale, args.y / shot.scale)
      return Promise.resolve({
        ok: true,
        longitude: ll.lng,
        latitude: ll.lat,
        message: `已换算: 截图像素 (${args.x}, ${args.y}) → (${ll.lng.toFixed(6)}, ${ll.lat.toFixed(6)})`,
      })
    },
  }))
}
