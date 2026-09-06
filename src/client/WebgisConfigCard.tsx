import { useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { VisionConfigSection } from './VisionConfigCard.js'
import { PostgisConfigSection } from './PostgisConfigCard.js'
import { OverlayServicesSection } from './OverlayServicesSection.js'
import styles from './webgis.module.css'

/**
 * DSH 设置 → 插件 → WebGIS 插件配置：合并后的唯一卡片。
 *
 * 结构：折叠头（「WebGIS 插件配置」）+ body = 启停总开关 + 视觉模型子区 + 数据库子区。
 * 启停开关：读 GET /webgis/status、写 POST /webgis/plugin-config，立即生效（host 写内存+持久化）。
 * 关闭后 GIS 模式/地图/工具不生效，但本卡片仍可打开，子区仍可编辑（便于预配置后重新开启）。
 * `t` 由 DSH 渲染器按声明 `locale:'webgis'` 注入；子区非 slot 入口，经 props 接收 t。
 */
export function WebgisConfigCard({ t }: PropsLocale<'webgis'>) {
  const [open, setOpen] = useState(false)
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/webgis/status', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((s: { enabled: boolean }) => {
        if (cancelled) return
        setEnabled(!!s.enabled)
        setError('')
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggle = async (): Promise<void> => {
    setToggling(true)
    setError('')
    try {
      const next = !enabled
      const res = await fetch('/webgis/plugin-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`)
      setEnabled(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setToggling(false)
    }
  }

  return (
    <li className={open ? `${styles.settingsCard} ${styles.settingsCardOpen}` : styles.settingsCard}>
      <button
        type="button"
        className={styles.settingsHeader}
        aria-expanded={open}
        aria-label={`${open ? t('settings.collapse') : t('settings.expand')}: ${t('settings.cardName')}`}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.settingsHeadText}>
          <span className={styles.settingsName}>{t('settings.cardName')}</span>
          <span className={styles.settingsDesc}>{t('settings.cardDesc')}</span>
        </span>
        <IconChevronDownOutline14
          className={open ? `${styles.settingsChevron} ${styles.settingsChevronOpen}` : styles.settingsChevron}
        />
      </button>
      {open && (
        <div className={styles.settingsBody}>
          <div className={styles.settingsToggleRow}>
            <span className={styles.settingsToggleText}>
              <span className={styles.settingsToggleLabel}>{t('settings.enableLabel')}</span>
              <span className={styles.settingsHint}>{t('settings.enableHint')}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              data-on={enabled}
              className={styles.settingsSwitch}
              disabled={loading || toggling}
              onClick={toggle}
              aria-label={enabled ? t('settings.pluginAriaDisable') : t('settings.pluginAriaEnable')}
            />
          </div>
          {error && <p className={styles.settingsFailed}>{error}</p>}
          <VisionConfigSection t={t} />
          <PostgisConfigSection t={t} />
          <OverlayServicesSection t={t} />
          <div className={styles.settingsAbout}>
            <span>{t('settings.author', { name: 'Frank Wang' })}</span>
            <a href="mailto:cywanghn@gmail.com">{t('settings.feedback', { email: 'cywanghn@gmail.com' })}</a>
          </div>
        </div>
      )}
    </li>
  )
}
