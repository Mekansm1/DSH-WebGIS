import { useEffect, useRef, useState } from 'react'
import styles from './webgis.module.css'
import { sessionUrl } from './sessionUrl.js'
import type { WebgisT } from './webgis-i18n.js'

/** 属性抽屉每页行数（与服务端 /webgis/layer-attrs 默认页对齐）。 */
const PAGE = 200
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
 * 属性抽屉：分页拉取某图层的属性（列=字段并集，每页 PAGE 行，上一页/下一页翻页）。
 * 由「图层 → 表」按钮打开，与点击属性浮窗互补（这是图层视角）。
 * 用 /webgis/layer-attrs 而非 /webgis/gis-result 整层 GeoJSON——几万行图层整层下载 + JSON.parse 会卡数秒，
 * 表格其实每屏只看一页，服务端只切 offset/limit 一页返回。
 */
export function AttributeDrawer(props: {
  layer: { id: string; name: string; featureCount: number }
  sessionId?: string
  t: WebgisT
  onClose: () => void
}): JSX.Element {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [keys, setKeys] = useState<string[]>([])
  const [total, setTotal] = useState<number>(props.layer.featureCount)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const seqRef = useRef(0)

  // 切图层回到第一页
  useEffect(() => {
    setPage(0)
  }, [props.layer.id])

  useEffect(() => {
    const mySeq = ++seqRef.current
    setLoading(true)
    setError('')
    setRows([])
    setKeys([])
    const q = `id=${encodeURIComponent(props.layer.id)}&offset=${page * PAGE}&limit=${PAGE}`
    fetch(sessionUrl(props.sessionId, `/webgis/layer-attrs?${q}`), { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`)
        return res.json()
      })
      .then((d) => {
        if (seqRef.current !== mySeq) return // 已翻页/换层，丢弃过期响应
        setTotal(typeof d.total === 'number' ? d.total : props.layer.featureCount)
        setKeys(Array.isArray(d.keys) ? d.keys : [])
        setRows(Array.isArray(d.rows) ? d.rows : [])
        setLoading(false)
      })
      .catch(() => {
        if (seqRef.current !== mySeq) return
        setLoading(false)
        setError(props.t('attr.loadError'))
      })
  }, [props.layer.id, props.sessionId, page, props.t])

  const pages = Math.max(1, Math.ceil(total / PAGE))
  const cur = Math.min(page + 1, pages)

  return (
    <div className={styles.attrDrawer}>
      <div className={styles.attrDrawerHead}>
        <span className={styles.attrDrawerTitle} title={props.layer.name}>
          {props.t('attr.title', { name: props.layer.name, total })}
        </span>
        <button className={styles.attrDrawerClose} onClick={props.onClose} title={props.t('attr.close')}>×</button>
      </div>
      {error && <div className={styles.attrDrawerNote}>{error}</div>}
      <div className={styles.attrDrawerBody}>
        {loading && rows.length === 0 && <div className={styles.attrDrawerNote}>{props.t('attr.loading')}</div>}
        {!loading && keys.length === 0 && !error && <div className={styles.layerEmpty}>{props.t('attr.empty')}</div>}
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
                <tr key={page * PAGE + i}>
                  <td className={styles.attrIdx}>{page * PAGE + i + 1}</td>
                  {keys.map((k) => {
                    const v = row[k]
                    const isObj = v !== null && typeof v === 'object'
                    const t = isObj ? JSON.stringify(v) : cellText(v)
                    const display = t.length > MAX_CELL ? `${t.slice(0, MAX_CELL)}…` : t
                    return (
                      <td key={k} title={t.length > MAX_CELL ? t : undefined}>
                        {display}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!error && total > PAGE && (
        <div className={styles.attrPager}>
          <span className={styles.attrPagerInfo}>{props.t('attr.pager', { cur, pages })}</span>
          <button
            className={styles.attrPagerBtn}
            disabled={loading || cur <= 1}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            {props.t('attr.prev')}
          </button>
          <button
            className={styles.attrPagerBtn}
            disabled={loading || cur >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            {props.t('attr.next')}
          </button>
        </div>
      )}
    </div>
  )
}
