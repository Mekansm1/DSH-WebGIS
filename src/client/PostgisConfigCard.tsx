import { useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

interface PostgisConfig {
  host: string
  port: string
  database: string
  user: string
  password: string
  passwordSet?: boolean
  /** GET 返回的阈值（嵌套）；本地编辑态用平铺的 askFrom/autoClusterFrom/maxLoad。 */
  cluster?: { askFrom?: number; autoClusterFrom?: number; maxLoad?: number }
  /** 加载阈值（结果行数驱动 cluster / 拒绝）。 */
  askFrom: string
  autoClusterFrom: string
  maxLoad: string
}

const EMPTY: PostgisConfig = {
  host: '', port: '5432', database: '', user: '', password: '',
  askFrom: '50000', autoClusterFrom: '100000', maxLoad: '200000',
}

type DbAction = 'test' | 'scan' | 'clear'

/**
 * WebGIS 插件配置卡片内的「数据库」子区（由 WebgisConfigCard 组合）：PostgreSQL/PostGIS 连接配置。
 *
 * 外观与 VisionConfigCard 一致（折叠头 + 字段行 + 底部按钮，全部走 --dsw-alias-* token）。
 * 数据通过 /webgis/postgis-config（读写）+ /webgis/postgis-action（测试/扫描/清除）HTTP 路由
 * 与 host 通信，host 持久化到 ~/.dsh/webgis-postgis.json。
 *
 * 密码安全：host 端不回显已保存的密码（GET 只给 passwordSet），卡片密码框留空保存 = 保留原密码。
 */
export function PostgisConfigSection({ t }: { t: WebgisT }) {
  const [open, setOpen] = useState(false)
  const [cfg, setCfg] = useState<PostgisConfig>(EMPTY)
  const [saved, setSaved] = useState<PostgisConfig>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<DbAction | ''>('')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/webgis/postgis-config', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((c: PostgisConfig) => {
        if (cancelled) return
        const value: PostgisConfig = {
          host: c.host ?? '',
          port: String(c.port ?? 5432),
          database: c.database ?? '',
          user: c.user ?? '',
          password: '',
          passwordSet: !!c.passwordSet,
          askFrom: String(c.cluster?.askFrom ?? 50000),
          autoClusterFrom: String(c.cluster?.autoClusterFrom ?? 100000),
          maxLoad: String(c.cluster?.maxLoad ?? 200000),
        }
        setCfg(value)
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

  const dirty =
    cfg.host !== saved.host
    || cfg.port !== saved.port
    || cfg.database !== saved.database
    || cfg.user !== saved.user
    || cfg.askFrom !== saved.askFrom
    || cfg.autoClusterFrom !== saved.autoClusterFrom
    || cfg.maxLoad !== saved.maxLoad

  const save = async (): Promise<void> => {
    setSaving(true)
    setError('')
    setStatus('')
    try {
      const res = await fetch('/webgis/postgis-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          host: cfg.host,
          port: Number(cfg.port) || undefined,
          database: cfg.database,
          user: cfg.user,
          password: cfg.password,
          askFrom: Number(cfg.askFrom) || undefined,
          autoClusterFrom: Number(cfg.autoClusterFrom) || undefined,
          maxLoad: Number(cfg.maxLoad) || undefined,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`)
      const nextSaved: PostgisConfig = {
        ...cfg,
        password: '',
        passwordSet: cfg.password !== '',
      }
      setSaved(nextSaved)
      setCfg((c) => ({ ...c, password: '' }))
      setStatus(t('settings.saved'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const discard = (): void => {
    setCfg(saved)
    setError('')
    setStatus('')
  }

  const runAction = async (action: DbAction): Promise<void> => {
    setBusy(action)
    setError('')
    setStatus('')
    try {
      const res = await fetch('/webgis/postgis-action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const body = (await res.json().catch(() => ({}))) as { message?: string }
      if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`)
      const actionLabel = action === 'test' ? t('postgis.actionTest') : action === 'scan' ? t('postgis.actionScan') : t('postgis.actionClear')
      setStatus(body.message ?? t('postgis.actionDone', { name: actionLabel }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy('')
    }
  }

  const blocked = (!dirty && cfg.password === '') || saving

  const set = (key: keyof Pick<PostgisConfig, 'host' | 'port' | 'database' | 'user' | 'password' | 'askFrom' | 'autoClusterFrom' | 'maxLoad'>) =>
    (v: string) => setCfg((c) => ({ ...c, [key]: v }))

  const Field = (props: {
    id: string
    label: string
    value: string
    placeholder?: string
    type?: string
    saved: string
    hint?: string
    onChange: (v: string) => void
  }) => {
    const overridden = props.value !== props.saved
    return (
      <div className={styles.settingsField}>
        <div className={styles.settingsFieldHead}>
          <label className={styles.settingsFieldLabel} htmlFor={props.id}>{props.label}</label>
          {overridden && (
            <span className={styles.settingsFieldBadges}>
              <span className={styles.settingsFieldBadge}>{t('settings.overridden')}</span>
              <button
                type="button"
                className={styles.settingsFieldReset}
                disabled={loading}
                onClick={() => props.onChange(props.saved)}
              >
                {t('settings.restoreDefault')}
              </button>
            </span>
          )}
        </div>
        <input
          id={props.id}
          className={styles.settingsFieldInput}
          type={props.type ?? 'text'}
          value={props.value}
          placeholder={props.placeholder}
          disabled={loading}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.hint && <p className={styles.settingsHint}>{props.hint}</p>}
      </div>
    )
  }

  return (
    <div className={styles.settingsSubsection}>
      <button
        type="button"
        className={styles.settingsHeader}
        aria-expanded={open}
        aria-label={`${open ? t('settings.collapse') : t('settings.expand')}: ${t('postgis.cardName')}`}
        onClick={() => setOpen(!open)}
      >
        <span className={styles.settingsHeadText}>
          <span className={styles.settingsName}>{t('postgis.cardName')}</span>
          <span className={styles.settingsDesc}>{t('postgis.cardDesc')}</span>
        </span>
        {dirty && <span className={styles.settingsPending}>{t('settings.unsaved')}</span>}
        <IconChevronDownOutline14
          className={open ? `${styles.settingsChevron} ${styles.settingsChevronOpen}` : styles.settingsChevron}
        />
      </button>
      {open && (
        <div className={styles.settingsBody}>
          <Field id="webgis-pg-host" label="Host" value={cfg.host} saved={saved.host} placeholder={t('postgis.pgHostPh')} hint={t('postgis.pgHostHint')} onChange={set('host')} />
          <Field id="webgis-pg-port" label="Port" value={cfg.port} saved={saved.port} placeholder="5432" hint={t('postgis.pgPortHint')} onChange={set('port')} />
          <Field id="webgis-pg-database" label="Database" value={cfg.database} saved={saved.database} placeholder={t('postgis.pgDbPh')} hint={t('postgis.pgDbHint')} onChange={set('database')} />
          <Field id="webgis-pg-user" label="User" value={cfg.user} saved={saved.user} placeholder={t('postgis.pgUserPh')} hint={t('postgis.pgUserHint')} onChange={set('user')} />
          <Field
            id="webgis-pg-password"
            label="Password"
            type="password"
            value={cfg.password}
            saved=""
            placeholder={saved.passwordSet ? t('postgis.pgPwdPhSet') : t('postgis.pgPwdPhEmpty')}
            hint={saved.passwordSet ? `${t('postgis.pgPwdHintSet')}${t('postgis.pgPwdHintGui')}` : t('postgis.pgPwdHintGui')}
            onChange={set('password')}
          />

          <p className={styles.settingsSectionLabel}>{t('postgis.thresholdLabel')}</p>
          <Field id="webgis-pg-askfrom" label={t('postgis.askFromLabel')} value={cfg.askFrom} saved={saved.askFrom} placeholder="50000" hint={t('postgis.askFromHint')} onChange={set('askFrom')} />
          <Field id="webgis-pg-autocluster" label={t('postgis.autoClusterLabel')} value={cfg.autoClusterFrom} saved={saved.autoClusterFrom} placeholder="100000" hint={t('postgis.autoClusterHint')} onChange={set('autoClusterFrom')} />
          <Field id="webgis-pg-maxload" label={t('postgis.maxLoadLabel')} value={cfg.maxLoad} saved={saved.maxLoad} placeholder="200000" hint={t('postgis.maxLoadHint')} onChange={set('maxLoad')} />

          <div className={styles.settingsActions}>
            <button
              type="button"
              className={styles.settingsAction}
              disabled={busy !== ''}
              onClick={() => runAction('test')}
            >
              {busy === 'test' ? t('postgis.actionTestBusy') : t('postgis.actionTest')}
            </button>
            <button
              type="button"
              className={styles.settingsAction}
              disabled={busy !== ''}
              onClick={() => runAction('scan')}
            >
              {busy === 'scan' ? t('postgis.actionScanBusy') : t('postgis.actionScan')}
            </button>
            <button
              type="button"
              className={styles.settingsAction}
              disabled={busy !== ''}
              onClick={() => runAction('clear')}
            >
              {t('postgis.actionClear')}
            </button>
          </div>
          <p className={styles.settingsHint}>{t('postgis.footerHint')}</p>

          <div className={styles.settingsFooter}>
            {error && <p className={styles.settingsFailed}>{error}</p>}
            {status && !error && <p className={styles.settingsStatus}>{status}</p>}
            <button type="button" className={styles.settingsDiscard} disabled={!dirty && cfg.password === ''} onClick={discard}>
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
