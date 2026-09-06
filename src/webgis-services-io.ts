/**
 * 叠加地图服务（WMTS/WMS/XYZ）文件 I/O（仅 host 侧使用，含 node 内置模块）。
 * 纯逻辑见 `webgis-services.ts`。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseServices, type OverlayService } from './webgis-services.js'

export const SERVICES_FILE = join(homedir(), '.dsh', 'webgis-services.json')

/** 读取服务清单（失败/不存在返回空清单）。 */
export async function readServices(file = SERVICES_FILE): Promise<OverlayService[]> {
  try {
    return parseServices(await readFile(file, 'utf8'))
  } catch {
    return []
  }
}

/** 写入服务清单（持久化）。 */
export async function writeServices(list: OverlayService[], file = SERVICES_FILE): Promise<void> {
  await writeFile(file, JSON.stringify({ services: list }), 'utf8')
}
