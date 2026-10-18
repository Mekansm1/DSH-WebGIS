import type { PropsLocale, SessionStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { useWebgisMode, webgisModeStore } from './webgisMode.js'
import styles from './webgis.module.css'

/**
 * 会话标题栏里的「传统 / GIS」模式切换（conversation.session.header.actions）。
 *
 * 为什么放这里：原先它是 shell.overlay 里的绝对定位浮钮（top/right 12px），在 DSH 官方桌面端
 * 会被原生窗口标题栏盖住，只露出一个边。标题栏是宿主自己的 DOM，不会被桌面标题栏遮挡。
 *
 * 会话作用域 slot 直接拿 `sessionId`，因此不再依赖 useSessions 推导当前会话。
 * 文案用两字短标签（GIS / 传统）：GIS 模式下对话列只有 360px，长标签会挤掉标题。
 */
export function ModeToggle(props: SessionStandardProps & PropsLocale<'webgis'>): JSX.Element {
  const { sessionId, t } = props
  const mode = useWebgisMode(sessionId)
  const isGis = mode === 'gis'
  const label = isGis ? t('mode.shortTraditional') : t('mode.shortGis')
  const title = isGis ? t('mode.toTraditional') : t('mode.toGis')
  return (
    <button
      type="button"
      className={`${styles.headerModeToggle}${isGis ? ` ${styles.headerModeToggleActive}` : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={isGis}
      onClick={() => webgisModeStore.setMode(sessionId, isGis ? 'traditional' : 'gis')}
    >
      {label}
    </button>
  )
}
