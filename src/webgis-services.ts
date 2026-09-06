/**
 * 叠加地图服务（WMTS / WMS / XYZ）纯逻辑：校验、清单增删改、解析。
 *
 * **不含 node 内置模块**（客户端会 import 本模块的类型/逻辑），文件 I/O 在
 * `webgis-services-io.ts`（仅 host 侧）。持久化 `~/.dsh/webgis-services.json`。
 */

export interface OverlayService {
  id: string
  name: string
  /** xyz=普通瓦片；wmts=Web-Mercator KVP 模板（{z}/{x}/{y}）；wms=GetMap 模板（maplibre 替换 {bbox-epsg-3857}）。 */
  kind: 'xyz' | 'wmts' | 'wms'
  url: string
  tileSize?: number
  visible: boolean
}

const KINDS = new Set<string>(['xyz', 'wmts', 'wms'])

/** 解析文件内容为服务清单；非法/缺失字段的条目丢弃。 */
export function parseServices(raw: string): OverlayService[] {
  try {
    const parsed = JSON.parse(raw) as { services?: unknown }
    const list = Array.isArray(parsed?.services) ? parsed.services : []
    const out: OverlayService[] = []
    for (const item of list) {
      const v = validateService(item)
      if (v.ok) out.push(v.svc)
    }
    return out
  } catch {
    return []
  }
}

/** 校验并归一化一条服务输入（来自设置卡片）；`id` 可选（新增时由 nextServiceId 生成）。 */
export function validateService(input: unknown): { ok: true; svc: OverlayService } | { ok: false; message: string } {
  const raw = (input ?? {}) as { id?: unknown; name?: unknown; kind?: unknown; url?: unknown; tileSize?: unknown; visible?: unknown }
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : ''
  if (!name) return { ok: false, message: '服务名称不能为空' }
  const kind = typeof raw.kind === 'string' && KINDS.has(raw.kind) ? raw.kind as OverlayService['kind'] : ''
  if (!kind) return { ok: false, message: '类型必须是 xyz / wmts / wms 之一' }
  const url = typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim().slice(0, 2000) : ''
  if (!url) return { ok: false, message: '服务 URL 不能为空' }
  let tileSize: number | undefined
  if (raw.tileSize !== undefined && raw.tileSize !== '') {
    const n = Number(raw.tileSize)
    if (!Number.isInteger(n) || n < 128 || n > 512) return { ok: false, message: 'tileSize 需为 128–512 的整数' }
    tileSize = n
  }
  return {
    ok: true,
    svc: {
      id: typeof raw.id === 'string' && raw.id ? raw.id : '',
      name,
      kind,
      url,
      tileSize,
      visible: raw.visible === false ? false : true,
    },
  }
}

/** 新增/替换一条服务（有 id 且已存在 → 原位替换；否则追加）。 */
export function upsertService(list: OverlayService[], svc: OverlayService): OverlayService[] {
  const id = svc.id || nextServiceId(list)
  const entry = { ...svc, id }
  const i = list.findIndex((s) => s.id === id)
  if (i >= 0) {
    const next = [...list]
    next[i] = entry
    return next
  }
  return [...list, entry]
}

/** 删除指定 id 的服务。 */
export function removeService(list: OverlayService[], id: string): OverlayService[] {
  return list.filter((s) => s.id !== id)
}

/** 切换指定 id 服务的可见性。 */
export function setServiceVisibility(list: OverlayService[], id: string, visible: boolean): OverlayService[] {
  return list.map((s) => (s.id === id ? { ...s, visible } : s))
}

/** 生成下一个服务 id（`svc-<n>`，取现有最大数字后缀 +1）。 */
export function nextServiceId(list: OverlayService[]): string {
  let max = 0
  for (const s of list) {
    const m = /^svc-(\d+)$/.exec(s.id)
    if (m) max = Math.max(max, Number(m[1]) || 0)
  }
  return `svc-${max + 1}`
}
