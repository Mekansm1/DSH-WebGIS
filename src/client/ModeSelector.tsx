import type { WebgisMode } from './webgisMode.js'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

/** 新对话空白页的模式选择器。root 可点穿透，仅卡片可交互。 */
export function ModeSelector({ onPick, t }: { onPick: (mode: WebgisMode) => void; t: WebgisT }) {
  return (
    <div className={styles.modeSelectorRoot}>
      <div className={styles.modeSelectorCard}>
        <h2 className={styles.modeSelectorTitle}>{t('mode.chooseTitle')}</h2>
        <p className={styles.modeSelectorSub}>{t('mode.chooseSub')}</p>
        <div className={styles.modeSelectorOptions}>
          <button
            className={styles.modeOption}
            onClick={() => onPick('traditional')}
          >
            <span className={styles.modeOptionTitle}>{t('mode.traditional')}</span>
            <span className={styles.modeOptionDesc}>{t('mode.traditionalDesc')}</span>
          </button>
          <button
            className={styles.modeOption}
            onClick={() => onPick('gis')}
          >
            <span className={styles.modeOptionTitle}>{t('mode.gis')}</span>
            <span className={styles.modeOptionDesc}>{t('mode.gisDesc')}</span>
          </button>
        </div>
      </div>
    </div>
  )
}
