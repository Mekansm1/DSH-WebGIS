import { useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

interface VisionConfig {
  provider: string
  model: string
}

/**
 * WebGIS 插件配置卡片内的「视觉模型」子区（由 WebgisConfigCard 组合）。
 *
 * 外观复刻内置插件卡片（settings-plugins 包 PluginCard + ValueField）：
 * 折叠头（名称/描述/chevron/「未保存」徽标）+ 展开后的字段行（label + 已覆盖徽标 + 恢复默认
 * + 输入框 + hint）+ 底部「放弃修改 / 保存」。字体、圆角、间距全部走同一套 --dsw-alias-* token。
 *
 * 数据不走 DSH settingsScope（该传输对本插件命名空间不可用），仍走插件自身的 HTTP 路由：
 * host 读写 ~/.dsh/webgis-vision.json，本子区通过 GET/POST /webgis/vision-config 读写。
 */
export function VisionConfigSection({ t }: { t: WebgisT }) {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  // 最近一次保存成功的值（内置卡片的「composition 层基线」），用于判定 dirty / 已覆盖 / 恢复默认
  const [saved, setSaved] = useState<VisionConfig>({ provider: '', model: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/webgis/vision-config', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((cfg: VisionConfig) => {
        if (cancelled) return
        const value = { provider: cfg.provider ?? '', model: cfg.model ?? '' }
        setProvider(value.provider)
        setModel(value.model)
        setSaved(value)
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

  const dirty = provider !== saved.provider || model !== saved.model

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/webgis/vision-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSaved({ provider, model })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  const discard = (): void => {
    setProvider(saved.provider)
    setModel(saved.model)
    setError('')
  }

  const blocked = !dirty || saving

  return (
    <div className={styles.settingsSubsection}>
      <button
        type="button"
        className={styles.settingsHeader}
        aria-expanded={open}
        aria-label={`${open ? t('settings.collapse') : t('settings.expand')}: ${t('vision.cardName')}`}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.settingsHeadText}>
          <span className={styles.settingsName}>{t('vision.cardName')}</span>
          <span className={styles.settingsDesc}>{t('vision.cardDesc')}</span>
        </span>
        {dirty && <span className={styles.settingsPending}>{t('settings.unsaved')}</span>}
        <IconChevronDownOutline14
          className={open ? `${styles.settingsChevron} ${styles.settingsChevronOpen}` : styles.settingsChevron}
        />
      </button>
      {open && (
        <div className={styles.settingsBody}>
          <div className={styles.settingsField}>
            <div className={styles.settingsFieldHead}>
              <label className={styles.settingsFieldLabel} htmlFor="webgis-vision-provider">{t('vision.providerLabel')}</label>
              {provider !== saved.provider && (
                <span className={styles.settingsFieldBadges}>
                  <span className={styles.settingsFieldBadge}>{t('settings.overridden')}</span>
                  <button
                    type="button"
                    className={styles.settingsFieldReset}
                    disabled={loading}
                    onClick={() => setProvider(saved.provider)}
                  >
                    {t('settings.restoreDefault')}
                  </button>
                </span>
              )}
            </div>
            <input
              id="webgis-vision-provider"
              className={styles.settingsFieldInput}
              type="text"
              value={provider}
              placeholder={t('vision.providerPh')}
              disabled={loading}
              onChange={(e) => setProvider(e.target.value)}
            />
            <p className={styles.settingsHint}>{t('vision.providerHint')}</p>
          </div>
          <div className={styles.settingsField}>
            <div className={styles.settingsFieldHead}>
              <label className={styles.settingsFieldLabel} htmlFor="webgis-vision-model">{t('vision.modelLabel')}</label>
              {model !== saved.model && (
                <span className={styles.settingsFieldBadges}>
                  <span className={styles.settingsFieldBadge}>{t('settings.overridden')}</span>
                  <button
                    type="button"
                    className={styles.settingsFieldReset}
                    disabled={loading}
                    onClick={() => setModel(saved.model)}
                  >
                    {t('settings.restoreDefault')}
                  </button>
                </span>
              )}
            </div>
            <input
              id="webgis-vision-model"
              className={styles.settingsFieldInput}
              type="text"
              value={model}
              placeholder={t('vision.modelPh')}
              disabled={loading}
              onChange={(e) => setModel(e.target.value)}
            />
            <p className={styles.settingsHint}>{t('vision.modelHint')}</p>
          </div>
          <div className={styles.settingsFooter}>
            {error && <p className={styles.settingsFailed}>{error}</p>}
            <button type="button" className={styles.settingsDiscard} disabled={blocked} onClick={discard}>
              {t('settings.discard')}
            </button>
            <button type="button" className={styles.settingsSave} disabled={blocked} onClick={save}>
              {saving ? t('settings.saving') : t('settings.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
