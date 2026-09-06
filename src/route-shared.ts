/**
 * 路由拆分共享类型：RouteApi = apply() 闭包内分发给各域路由 handler 的共享对象。
 * 拆分自 src/index.ts：HTTP 路由改为表驱动分发后，各 routes-*.ts 只依赖本文件的
 * 类型/helper 与其它扁平模块（http-utils / dataset-load / ...），不再看到 apply 闭包细节。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import type { Config } from './index.js'
import type { DbManager } from './db-manager.js'
import type { GisLayer } from './geo-processing.js'
import type { PostgisConfig } from './postgis.js'
import type { VisionConfig } from './vision-chain.js'
import type { WebgisState } from './session-state.js'

/** 出图/导入/点选的自增序号（路由与工具共用同一对象，保持原递增语义）。 */
export interface Seqs {
  pickSeq: number
  importSeq: number
  exportSeq: number
}

/** apply 闭包内路由 handler 需要的全部共享对象（能拿到同一组 api 字段即可）。 */
export interface RouteApi {
  ctx: Context
  config: Config
  stateFor: (sessionId?: string) => WebgisState
  seqs: Seqs
  db: DbManager
  effectivePostgis: () => PostgisConfig
  effectiveVision: () => VisionConfig | null
  dropLayerResources: (layer: GisLayer) => void
  /** GUI 视觉配置（内存态）：路由读写；effectiveVision/工具读取同一变量。 */
  visionCfg: { get: () => VisionConfig | null; set: (cfg: VisionConfig | null) => void }
  /** GUI PostGIS 配置（内存态）：路由读写；effectivePostgis 读取同一变量。 */
  postgisCfg: { get: () => PostgisConfig | null; set: (cfg: PostgisConfig | null) => void }
  visionFile: string
  postgisFile: string
  servicesFile: string
  postgisPasswordRef: string
  sseClients: Map<string, Set<ServerResponse>>
  sseStateHash: Map<string, string>
  stateFingerprint: (st: WebgisState) => string
}

/** 单条路由 handler：命中后负责写完整响应（返回 void/Promise<void>）。 */
export type RouteHandler = (
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  url: URL,
  pathname: string,
  sessionId: string | undefined,
  state: WebgisState,
  api: RouteApi,
) => void | Promise<void>

/** 路由匹配谓词：pathname + method（method 用 'GET'/'POST'/null=任意）。 */
export type RouteMatcher = (pathname: string, method: string) => boolean

export interface RouteDef {
  match: RouteMatcher
  h: RouteHandler
}

/** 构造一条精确 path 匹配的路由（method=null 表示任意方法）。 */
export const route = (method: 'GET' | 'POST' | null, path: string, h: RouteHandler): RouteDef => ({
  match: (p, m) => p === path && (method === null || m === method),
  h,
})
