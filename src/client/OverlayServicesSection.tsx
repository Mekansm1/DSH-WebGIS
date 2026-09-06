import { useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

interface OverlayService {
  id: string
  name: string
  kind: 'xyz' | 'wmts' | 'wms'
  url: string
  tileSize?: number
  visible: boolean
}

/**
 * WebGIS 插件配置卡片内的「叠加地图服务」子区：管理 WMTS / WMS / XYZ 光栅叠加层。
 * 列表（名称 + 类型 + 可见性开关 + 删除）+ 添加表单。数据走 /webgis/services 三路由（全局）。
 */
export function OverlayServicesSection({ t }: { t: WebgisT }) {
  const [open, setOpen] = useState(false)
  const [services, setServices] = useState<OverlayService[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<OverlayService['kind']>('xyz')
  const [url, setUrl] = useState('')
  const [tileSize, setTileSize] = useState('')

  const applyBody = (body: { services?: OverlayService[]; message?: string } | null, res: Response): void => {
    if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`)
    if (body?.services) setServices(body.services)
    setError('')
  }

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch('/webgis/services', { cache: 'no-store' })
      const body = (await res.json().catch(() => null)) as { services?: OverlayService[] } | null
      if (res.ok && body?.services) setServices(body.services)
    } catch {
      // 网络错误忽略
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const add = async (): Promise<void> => {
    setError('')
    try {
      const res = await fetch('/webgis/services', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, kind, url, tileSize: tileSize ? Number(tileSize) : undefined }),
      })
      const body = (await res.json().catch(() => null)) as { services?: OverlayService[]; message?: string } | null
      applyBody(body, res)
      setName('')
      setUrl('')
      setTileSize('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const setVisible = async (id: string, visible: boolean): Promise<void> => {
    try {
      const res = await fetch('/webgis/services/visibility', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, visible }),
      })
      applyBody((await res.json().catch(() => null)) as { services?: OverlayService[] } | null, res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      const res = await fetch('/webgis/services/remove', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      applyBody((await res.json().catch(() => null)) as { services?: OverlayService[] } | null, res)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className={styles.settingsSubsection}>
      <button
        type="button"
        className={styles.settingsHeader}
        aria-expanded={open}
        aria-label={`${open ? t('settings.collapse') : t('settings.expand')}: ${t('overlay.cardName')}`}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.settingsHeadText}>
          <span className={styles.settingsName}>{t('overlay.cardName')}</span>
          <span className={styles.settingsDesc}>{t('overlay.cardDesc')}</span>
        </span>
        <IconChevronDownOutline14
          className={open ? `${styles.settingsChevron} ${styles.settingsChevronOpen}` : styles.settingsChevron}
        />
      </button>
      {open && (
        <div className={styles.settingsBody}>
          {services.map((s) => (
            <div key={s.id} className={styles.settingsListRow}>
              <span className={styles.settingsListRowName}>
                {s.name}
                <em className={styles.settingsListRowKind}>{s.kind.toUpperCase()}</em>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={s.visible}
                data-on={s.visible}
                className={styles.settingsSwitch}
                onClick={() => void setVisible(s.id, !s.visible)}
                aria-label={`${s.visible ? t('overlay.ariaHide') : t('overlay.ariaShow')} ${s.name}`}
              />
              <button type="button" className={styles.settingsListRemove} onClick={() => void remove(s.id)}>{t('overlay.remove')}</button>
            </div>
          ))}
          {!loading && services.length === 0 && <p className={styles.settingsHint}>{t('overlay.empty')}</p>}
          <div className={styles.settingsField}>
            <div className={styles.settingsFieldHead}>
              <span className={styles.settingsFieldLabel}>{t('overlay.addLabel')}</span>
            </div>
            <input className={styles.settingsFieldInput} type="text" placeholder={t('overlay.namePh')} value={name}
              onChange={(e) => setName(e.target.value)} />
            <select className={styles.settingsFieldInput} value={kind} onChange={(e) => setKind(e.target.value as OverlayService['kind'])}>
              <option value="xyz">{t('overlay.kindXyz')}</option>
              <option value="wmts">{t('overlay.kindWmts')}</option>
              <option value="wms">{t('overlay.kindWms')}</option>
            </select>
            <input className={styles.settingsFieldInput} type="text" placeholder={t('overlay.urlPh')} value={url}
              onChange={(e) => setUrl(e.target.value)} />
            <input className={styles.settingsFieldInput} type="text" placeholder={t('overlay.tileSizePh')} value={tileSize}
              onChange={(e) => setTileSize(e.target.value)} />
            {error && <p className={styles.settingsFailed}>{error}</p>}
            <div className={styles.settingsActions}>
              <button type="button" className={styles.settingsAction} disabled={!name || !url} onClick={() => void add()}>
                {t('overlay.add')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
