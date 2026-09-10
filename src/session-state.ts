/**
 * 按 DSH 会话隔离的地图状态存储（MapSessionStateStore）。
 *
 * 修复「全局状态串会话、串用户」：dataset/navigate/pick/图层 等进程内状态按
 * `sessionId` 键独立维护，一个会话加载数据、点击地图或清图层不会影响另一个会话。
 *
 * 两个写入来源共用同一个键：
 * - Agent 工具：`exec.agent?.id` 即会话 id（会话销毁时状态一并回收）；
 * - 浏览器客户端：fetch 携带 `?session=<会话 id>`，host 路由用同一键解析。
 *
 * 未带会话 id 的请求（curl / 无 agent 直调）落入 `anon` 桶，永不回收。
 */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GeoViewport } from './geo.js'
import type { GisLayer } from './geo-processing.js'

/** 宽松的 GeoJSON 结构（FeatureCollection / Feature / Geometry）。 */
export type GeoJson = { type: string; [key: string]: unknown }

export interface DatasetInfo {
  name: string
  geojson: GeoJson
  featureCount: number
}

export interface NavigateIntent {
  id: number
  lng: number
  lat: number
  zoom?: number
}

/** 点击提取到的矢量要素（供模型识别位置属性）。 */
export interface PickFeature {
  id: number | string | null
  layer: string
  source: string
  geometryType: string | null
  properties: Record<string, unknown>
}

/** 点击时截取的地图模块截图：附件引用 + 换算所需的全部元信息。 */
export interface PickScreenshot {
  /** 已持久化到附件服务的图片引用（含宽高/字节数）。 */
  ref: ImageAttachmentRef
  /** 截图像素 / 地图模块 css 像素 比例（截图像素 = css 像素 × scale）。 */
  scale: number
  /** 关注位置在截图图像里的像素位置（原点左上角，x 向右 y 向下）。捕获时即画面中心。 */
  pin: { x: number; y: number }
  /** 图上是否真的画了红点：仅用户手动点击底图时为 true；捕获当前视野时图为"干净"的。 */
  pinned?: boolean
  /** 截图那一刻的地图视口，用于像素↔经纬度换算（不依赖当前 live map）。 */
  viewport: GeoViewport
}

/**
 * 用户最近一次地图位置（点击或按请求捕获的图框中心；只保留最后一次，新记录覆盖旧记录）。
 * `captureSeq`：由 host 发起「捕获当前视图」请求（state.capture）时，客户端回传的关联序号，
 * 用于 `webgis_get_pick` 等待期间把「本次捕获结果」和「用户恰好点了一下」区分开。
 */
export interface PickState {
  id: number
  lng: number
  lat: number
  features: PickFeature[]
  /** 点击/捕获时截取的地图截图；截图失败时为 null（仅坐标/要素仍有效）。 */
  screenshot: PickScreenshot | null
  /** 关联的捕获请求序号；来自用户点击时为 undefined。 */
  captureSeq?: number
}

/** AI 出图工具下发的出图请求参数（客户端据此预填出图弹窗）。 */
export interface ExportRequestParams {
  title?: string
  /** 限定导出的图层 id（缺省=全部可见层）。 */
  layerIds?: string[]
  legend?: boolean
  north?: boolean
  scale?: boolean
  note?: string
  extent?: 'view' | 'all'
}

export interface ExportImageResult {
  /** 关联的出图请求 seq（GUI 手动导出时是自增 id）。 */
  id: number
  ref: ImageAttachmentRef
  width: number
  height: number
  title?: string
}

/** 单个会话的完整地图状态（默认数据集 + 导航意图 + 最近点击 + 图层注册表）。 */
export interface WebgisState {
  dataset: DatasetInfo | null
  navigate: NavigateIntent | null
  pick: PickState | null
  /** host 发起「捕获当前视图」请求（无点击记录时由 webgis_get_pick 设置，客户端轮询消费）。 */
  capture: { seq: number } | null
  /** 客户端上报的捕获失败信息（一次一报，读取后清空）。 */
  captureError: string | null
  /** host 发起的出图请求（AI 工具 webgis_export_map 设置；客户端见新 seq → 打开出图弹窗并预填）。 */
  exportRequest: { seq: number; params: ExportRequestParams } | null
  /** 出图等待被打断的原因（用户关掉了出图弹窗）→ 等待者立刻返回，不必干等 60s 超时。 */
  exportError: string | null
  /** 最近一次出图结果（附件引用；AI 工具 webgis_get_export_map 读取）。 */
  exportImage: ExportImageResult | null
  /**
   * 图层注册表（source-agnostic）：`dataset` 是基础数据集层，GIS 结果工具（webgis_buffer 等）
   * 产出 `result_<n>` 图层；PostGIS 查询结果产出 `db_<n>`。客户端靠每层的 rev 做变更检测。
   */
  layers: GisLayer[]
}

/** 无会话 id 的请求共享此桶（curl / 无 agent 直调兜底；永不回收）。 */
const ANON_KEY = 'anon'

export function emptyWebgisState(): WebgisState {
  return {
    dataset: null, navigate: null, pick: null, capture: null, captureError: null,
    exportRequest: null, exportImage: null, exportError: null,
    layers: [],
  }
}

/**
 * 会话状态存储：以 session id 为键，懒创建 + 会话销毁回收。
 * `seed` 在首次创建该会话状态时调用一次（可注入默认数据集等），返回独立副本。
 */
export class SessionStateStore {
  private readonly map = new Map<string, WebgisState>()

  constructor(private readonly seed: () => WebgisState = emptyWebgisState) {}

  /** 取某会话的状态；不存在则按 seed 新建。会话 id 为空时落 anon 桶。 */
  get(sessionId: string | null | undefined): WebgisState {
    const key = sessionId && sessionId.trim() !== '' ? sessionId : ANON_KEY
    let st = this.map.get(key)
    if (!st) {
      st = this.seed()
      this.map.set(key, st)
    }
    return st
  }

  has(sessionId: string | null | undefined): boolean {
    const key = sessionId && sessionId.trim() !== '' ? sessionId : ANON_KEY
    return this.map.has(key)
  }

  /** 会话销毁时回收其状态；anon 桶不回收（无会话生命周期）。 */
  dispose(sessionId: string | null | undefined): void {
    const key = sessionId && sessionId.trim() !== '' ? sessionId : ANON_KEY
    if (key === ANON_KEY) return
    this.map.delete(key)
  }

  /** 全部会话状态（用于默认数据集加载后补发到已有会话）。 */
  all(): WebgisState[] {
    return [...this.map.values()]
  }

  get size(): number {
    return this.map.size
  }
}
