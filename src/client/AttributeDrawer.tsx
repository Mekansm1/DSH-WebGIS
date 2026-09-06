import { useEffect, useState } from 'react'
import styles from './webgis.module.css'
import { sessionUrl } from './sessionUrl.js'
import type { WebgisT } from './webgis-i18n.js'

/** 属性抽屉可显示的最大行数（超出提示）。 */
const MAX_ROWS = 200
/** 单元格最大字符数。 */
const MAX_CELL = 80

function cellText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

/**
 * 属性抽屉：拉取某图层的全量 GeoJSON，以表格展示属性（列=字段并集，行=要素，截断到 200 行）。
 * 由「图层 → 表」按钮打开，与点击属性浮窗互补（这是图层视角）。
 */
export function AttributeDrawer(props: {
  layer: { id: string; name: string; featureCount: number }
  sessionId?: string
  t: WebgisT
  onClose: () => void
}): JSX.Element {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [keys, setKeys] = useState<string[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setRows([])
    setKeys([])
    setError('')
    fetch(sessionUrl(props.sessionId, `/webgis/gis-result?id=${encodeURIComponent(props.layer.id)}`), { cache: 'no-store' })
      .then((res) => res.json())
      .then((fc) => {
        if (cancelled) return
        const feats = Array.isArray(fc?.features) ? fc.features : []
        const keySet = new Set<string>()
        for (const f of feats as Array<{ properties?: Record<string, unknown> }>) {
          for (const k of Object.keys(f.properties ?? {})) keySet.add(k)
        }
        setKeys([...keySet])
        setRows((feats as Array<{ properties?: Record<string, unknown> }>).slice(0, MAX_ROWS).map((f) => f.properties ?? {}))
      })
      .catch(() => {
        if (!cancelled) setError(props.t('attr.loadError'))
      })
    return () => {
      cancelled = true
    }
  }, [props.layer.id, props.sessionId])

  const shown = rows.length
  const total = props.layer.featureCount

  return (
    <div className={styles.attrDrawer}>
      <div className={styles.attrDrawerHead}>
        <span className={styles.attrDrawerTitle} title={props.layer.name}>
          {props.t('attr.title', { name: props.layer.name, total })}
        </span>
        <button className={styles.attrDrawerClose} onClick={props.onClose} title={props.t('attr.close')}>×</button>
      </div>
      {error && <div className={styles.attrDrawerNote}>{error}</div>}
      {shown < total && (
        <div className={styles.attrDrawerNote}>
          {props.t('attr.truncated', { shown, total })}
        </div>
      )}
      <div className={styles.attrDrawerBody}>
        {keys.length === 0 && !error && <div className={styles.layerEmpty}>{props.t('attr.empty')}</div>}
        {keys.length > 0 && (
          <table className={styles.attrTable}>
            <thead>
              <tr>
                <th className={styles.attrIdx}>#</th>
                {keys.map((k) => (
                  <th key={k} title={k}>{k}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  <td className={styles.attrIdx}>{i + 1}</td>
                  {keys.map((k) => {
                    const t = cellText(row[k])
                    return (
                      <td key={k} title={t.length > MAX_CELL ? t : undefined}>
                        {t.length > MAX_CELL ? `${t.slice(0, MAX_CELL)}…` : t}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
