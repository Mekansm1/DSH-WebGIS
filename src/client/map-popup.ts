/**
 * 点击属性浮窗 DOM：标题/元信息/关键字段表 +（字段多时）「查看全部属性」展开。
 * 自 MapView.tsx 拆分。
 */
import styles from './webgis.module.css'
import type { FeaturePayload } from './gis-types.js'
import type { WebgisT } from './webgis-i18n.js'

/** 属性值是否可直接展示（标量，排除对象/数组/空串）。 */
export function isScalar(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/** 要素属性里可展示的标量键值对（原顺序）。 */
export function scalarRows(props: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(props).filter(([k, v]) => k !== '' && isScalar(v) && v !== '')
}

/** 浮窗标题字段优先顺序：名称类 → 地址类 → 类型类。 */
export function featureTitle(props: Record<string, unknown>): string | null {
  const prefers = ['name', '名称', '名字', 'title', '地名', '小区名称', 'address', '地址', 'type', '类别', '大类']
  for (const k of prefers) {
    const v = props[k]
    if (isScalar(v) && String(v).trim()) return String(v).trim()
  }
  return null
}

export function fmtCell(v: unknown): string {
  const s = String(v)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

/** 属性键值对 → 两列表格元素。 */
export function makeAttrTable(rows: Array<[string, unknown]>): HTMLElement {
  const table = document.createElement('table')
  table.className = styles.popupTable!
  for (const [k, v] of rows) {
    const tr = document.createElement('tr')
    const th = document.createElement('th')
    th.textContent = k
    th.title = k
    const td = document.createElement('td')
    td.textContent = fmtCell(v)
    td.title = td.textContent
    tr.append(th, td)
    table.appendChild(tr)
  }
  return table
}

/** 浮窗 DOM：标题 + 图层/几何元信息 + 关键字段表 +（字段多时）「查看全部属性」展开。
 *  `onToggle`：展开后内容变高，需通知 popup 重新定位（maplibre 不自动重排）。
 *  `t` 在调用点传入（map 监听一次性绑定，从 tRef 取当前语言，避免语言切换后 stale）。 */
export function buildPopupContent(feature: FeaturePayload, t: WebgisT, onToggle?: () => void): HTMLElement {
  const root = document.createElement('div')
  root.className = styles.popupRoot!
  const title = featureTitle(feature.properties)
  if (title) {
    const h = document.createElement('div')
    h.className = styles.popupTitle!
    h.textContent = title
    root.appendChild(h)
  }
  const meta = document.createElement('div')
  meta.className = styles.popupMeta!
  meta.textContent = `${feature.layer}${feature.id != null ? ` · #${feature.id}` : ''}${feature.geometryType ? ` · ${feature.geometryType}` : ''}`
  root.appendChild(meta)

  const rows = scalarRows(feature.properties)
  if (rows.length === 0) {
    const empty = document.createElement('div')
    empty.className = styles.popupEmpty!
    empty.textContent = t('popup.empty')
    root.appendChild(empty)
    return root
  }
  const KEY_FIELDS = 4
  const table = makeAttrTable(rows.slice(0, KEY_FIELDS))
  root.appendChild(table)
  if (rows.length > KEY_FIELDS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = styles.popupToggle!
    btn.textContent = t('popup.viewAll', { n: rows.length })
    btn.addEventListener('click', () => {
      table.remove()
      btn.remove()
      root.appendChild(makeAttrTable(rows))
      onToggle?.()
    })
    root.appendChild(btn)
  }
  return root
}
