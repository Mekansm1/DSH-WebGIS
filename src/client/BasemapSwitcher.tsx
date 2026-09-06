import { useState } from 'react'
import { BASE_MAPS, type BaseMapDef } from '../basemaps.js'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

/**
 * 左下角底图切换器：按钮显示当前底图，点击弹出按「矢量 / 影像」分组的目录。
 * 纯展示组件，切换动作由上层（MapView）执行。
 * 分组标签与名称显示走 t；`src/basemaps.ts` 里的 category/name 数据不动
 * （tests 锁定，且切换按 id 引用）——只映射少数中文名（default / esri-imagery），
 * 其余已是英文、直接显示 name。
 */
export function BasemapSwitcher({ baseMap, onSwitch, t }: {
  baseMap: BaseMapDef
  onSwitch: (def: BaseMapDef) => void
  t: WebgisT
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const groups = ['矢量', '影像'] as const
  /** 分组头：category 是数据键，展示走词典。 */
  const groupLabel = (g: string): string => (g === '矢量' ? t('basemap.groupVector') : t('basemap.groupImagery'))
  /** 底图名：少数中文名映射到词典，其余原样。 */
  const baseName = (d: BaseMapDef): string => (d.id === 'default' ? t('basemap.default') : d.id === 'esri-imagery' ? t('basemap.esriImagery') : d.name)
  return (
    <div className={styles.baseSwitcher}>
      <button
        type="button"
        className={styles.baseSwitcherBtn}
        onClick={() => setOpen(!open)}
        title={t('basemap.switchTitle')}
      >
        {baseName(baseMap)}
      </button>
      {open && (
        <div className={styles.baseSwitcherPanel}>
          {groups.map((g) => {
            const items = BASE_MAPS.filter((d) => d.category === g)
            if (items.length === 0) return null
            return (
              <div key={g}>
                <div className={styles.baseSwitcherGroupLabel}>{groupLabel(g)}</div>
                {items.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    className={`${styles.baseSwitcherItem}${d.id === baseMap.id ? ` ${styles.baseSwitcherItemActive}` : ''}`}
                    onClick={() => {
                      onSwitch(d)
                      setOpen(false)
                    }}
                  >
                    {baseName(d)}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
