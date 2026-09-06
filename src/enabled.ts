/**
 * WebGIS 插件启停开关（运行态 + 持久化）。
 *
 * DSH 平台无 per-plugin enabled 钩子，这里自建一个模块级运行态开关：
 * - 默认启用（保证启动窗口与既有行为不变）；
 * - 持久化到 `~/.dsh/webgis-enabled.json`（与 vision/postgis 配置同目录同模式）；
 * - 关闭时：工具经 `ctx.tools.guard` 拒绝、数据 HTTP 路由 503，但设置相关路由常驻可用（卡片可重新开启）。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

let enabled = true

const DEFAULT_FILE = join(homedir(), '.dsh', 'webgis-enabled.json')

/** 当前插件是否启用（默认 true）。 */
export function isPluginEnabled(): boolean {
  return enabled
}

/** 内存开关（路由 / 工具 guard / 客户端状态共用）。 */
export function setPluginEnabled(v: boolean): void {
  enabled = v
}

/** 解析持久化文件内容；非法/缺字段默认启用。 */
export function parseEnabled(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return typeof parsed?.enabled === 'boolean' ? parsed.enabled : true
  } catch {
    return true
  }
}

/** 读文件 → 开关值（失败/不存在默认启用）。 */
export async function readEnabledFile(file = DEFAULT_FILE): Promise<boolean> {
  try {
    return parseEnabled(await readFile(file, 'utf8'))
  } catch {
    return true
  }
}

/** apply 启动时 fire-and-forget 读取（与 vision/postgis 配置读取同模式）。 */
export async function loadPluginEnabled(file = DEFAULT_FILE): Promise<void> {
  enabled = await readEnabledFile(file)
}

/** 写入内存 + 持久化（路由 / 卡片用）。 */
export async function savePluginEnabled(v: boolean, file = DEFAULT_FILE): Promise<void> {
  enabled = v
  await writeFile(file, JSON.stringify({ enabled: v }), 'utf8')
}

/** 插件关闭时仍允许访问的 /webgis/* 路径（配置读写 / 状态 / 静态资源）。 */
export const ENABLED_ALLOWLIST: ReadonlySet<string> = new Set([
  '/webgis/vision-config',
  '/webgis/postgis-config',
  '/webgis/postgis-action',
  '/webgis/plugin-config',
  '/webgis/status',
  '/webgis/services',
  '/webgis/services/remove',
  '/webgis/services/visibility',
  '/webgis/maplibre-gl.css',
  '/webgis/maplibre-gl-csp-worker.js',
])

/** 路由门：插件关闭且路径不在白名单 → 应拒绝（503）。 */
export function isWebgisRouteBlocked(pathname: string): boolean {
  return !enabled && !ENABLED_ALLOWLIST.has(pathname)
}
