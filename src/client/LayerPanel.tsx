import { type ChangeEvent, type ComponentType, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import styles from './webgis.module.css'
import { sessionUrl } from './sessionUrl.js'
import { ensure } from './chunk-loader.js'
import type { WebgisT } from './webgis-i18n.js'

/** DrawToolbar（draw 懒 chunk）的 props（镜像自 DrawToolbar.tsx 实际签名）。 */
interface DrawToolbarProps {
  mapRef: { current: MapLibreMap | null }
  sessionId?: string
  t: WebgisT
  onActiveChange: (active: boolean) => void
  onDone: () => void
}

/** 与 MapView 的 LayerSummary 结构一致（host /webgis/state 的 summarize 输出）。 */
interface LayerSummary {
  id: string
  name: string
  featureCount: number
  bbox: [number, number, number, number] | null
  visible: boolean
  color: string
  rev: number
  source: string
  geometryTypes: string[]
  cluster: boolean
  /** points/plane/hex=maplibre；arc/trips/wall/radial=deck.gl 出图。 */
  mode: 'points' | 'plane' | 'hex' | 'arc' | 'trips' | 'wall' | 'radial'
  modeParams?: Record<string, number>
  /** 真实总行数（大文件图层 = 内存表行数；上图是抽样）。 */
  totalCount?: number
  /** 是否已全量物化（false = 上图是抽样子集）。 */
  materialized?: boolean
}

/** 大数显示：zh ≥1 万用「x.x 万」、≥1 亿用「x 亿」，否则原样（与历史逐字一致）；
 *  en 用千分位全数字（GIS 计数需精确，不用 k/M）。 */
function fmtCount(n: number, t: WebgisT): string {
  if (t('meta.lang') === 'en') return n.toLocaleString('en-US')
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1).replace(/\.0$/, '')} 亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1).replace(/\.0$/, '')} 万`
  return String(n)
}

/** 面板/悬浮图标默认位置（导航控件下方）。 */
const PANEL_POS_DEFAULT = { x: 12, y: 56 }

/** 图层折叠悬浮图标：三层堆叠的图层符号。 */
function LayersIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2 2 7l10 5 10-5-10-5z" fill="currentColor" opacity="0.9" />
      <path d="m2 12 10 5 10-5" stroke="currentColor" strokeWidth="1.6" fill="none" />
      <path d="m2 17 10 5 10-5" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  )
}

/**
 * 图层面板：列出所有图层（dataset / result_* / db_* / import_*），支持显隐、右键菜单
 * （查看属性 / 导出 geojson|csv|shp / 删除）与文件导入（shp/zip/csv/geojson）。
 * 头部【出图】打开出图弹窗（MapView 持有，也可由 AI 工具 webgis_export_map 触发）；
 * 【创建】按钮按需展开绘图工具条（面板下方），创建要素保存为新图层。
 * 面板可收起为一个可拖动的悬浮图标；操作走 host 路由，变更由 MapView 的 1s 轮询回显。
 */
export function LayerPanel(props: {
  layers: LayerSummary[]
  sessionId?: string
  t: WebgisT
  onShowAttributes: (l: LayerSummary) => void
  mapRef: { current: MapLibreMap | null }
  onDrawingActive: (active: boolean) => void
  onExportMap?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(true)
  const [busy, setBusy] = useState(false)
  /** 绘图工具条是否展开（【创建】开关）。 */
  const [drawingOpen, setDrawingOpen] = useState(false)
  /** draw 懒 chunk 加载完成的绘图工具条组件（点「创建」才拉 terra-draw）。 */
  const [DrawToolbarComp, setDrawToolbarComp] = useState<ComponentType<DrawToolbarProps> | null>(null)
  /** 首次展开绘图工具条时按需加载 draw chunk（幂等：已加载/加载中不重复触发）。 */
  useEffect(() => {
    if (!drawingOpen || DrawToolbarComp) return
    let cancelled = false
    ensure('draw')
      .then((m) => {
        if (cancelled) return
        const C = m.DrawToolbar as ComponentType<DrawToolbarProps> | undefined
        if (C) setDrawToolbarComp(() => C)
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn('[webgis] draw chunk 加载失败', err)
      })
    return () => { cancelled = true }
  }, [drawingOpen, DrawToolbarComp])
  /** 面板/悬浮图标的位置（拖拽更新；null = 默认位，面板与图标共用同一位置）。 */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  /** 右键菜单：目标图层 + 光标坐标。 */
  const [menu, setMenu] = useState<{ layer: LayerSummary; x: number; y: number } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  /** 拖拽是否发生位移（区分「拖动」与「点击」）。 */
  const didDrag = useRef(false)
  /** 乐观显隐覆盖：用户点击 checkbox 后立即按意图显示（不等 1s 轮询回显），
   *  服务器确认后（l.visible === override）清除。避免受控 checkbox 被旧值拉回、需点多次。 */
  const [visOverride, setVisOverride] = useState<Record<string, boolean>>({})

  const action = async (body: Record<string, unknown>): Promise<void> => {
    try {
      await fetch(sessionUrl(props.sessionId, '/webgis/layer-action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      // 网络错误忽略，靠轮询回显
    }
  }

  // 轮询回显后，与服务器一致的乐观值移除（否则覆盖永远残留）。
  useEffect(() => {
    setVisOverride((prev) => {
      const next: Record<string, boolean> = {}
      for (const [id, v] of Object.entries(prev)) {
        const layer = props.layers.find((l) => l.id === id)
        if (!layer || layer.visible !== v) next[id] = v
      }
      return Object.keys(next).length === Object.keys(prev).length ? prev : next
    })
  }, [props.layers])

  /** 显隐切换：先乐观翻转本地覆盖（视觉立即生效），再 POST set-visible（幂等、明确目标值）。 */
  const toggleVisible = (l: LayerSummary): void => {
    const next = !(visOverride[l.id] ?? l.visible)
    setVisOverride((o) => ({ ...o, [l.id]: next }))
    void action({ id: l.id, action: 'set-visible', visible: next })
  }

  const onFileChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
      await fetch(sessionUrl(props.sessionId, '/webgis/import'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: file.name, data }),
      })
    } catch {
      // 导入失败靠轮询回显；如无新图层说明出错
    } finally {
      setBusy(false)
    }
  }

  const clearAll = (): void => {
    for (const l of props.layers) {
      if (l.id !== 'dataset') void action({ id: l.id, action: 'remove' })
    }
  }

  // ---- 拖拽定位（面板标题与折叠图标共用）：指针按下记录起点，窗级移动更新位置 ----
  const startDrag = (e: ReactPointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    didDrag.current = false
    const base = pos ?? PANEL_POS_DEFAULT
    const sx = e.clientX
    const sy = e.clientY
    const onMove = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx
      const dy = ev.clientY - sy
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) didDrag.current = true
      setPos({ x: base.x + dx, y: base.y + dy })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** 点击动作但拖动刚结束（拖动后的 click 不算点击）。 */
  const clickIfNotDragged = (fn: () => void): void => {
    if (didDrag.current) {
      didDrag.current = false
      return
    }
    fn()
  }

  // ---- 图层行右键菜单 ----
  const openMenu = (e: ReactMouseEvent<HTMLDivElement>, layer: LayerSummary): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ layer, x: e.clientX, y: e.clientY })
  }
  const closeMenu = (): void => setMenu(null)

  /** 触发附件下载：用游离 anchor 触发，避免菜单卸载时浏览器取消下载。 */
  const downloadUrl = (url: string): void => {
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  if (!open) {
    // 折叠态：仅一个可拖动悬浮图标
    return (
      <button
        type="button"
        className={styles.layerPanelIcon}
        style={{ left: (pos ?? PANEL_POS_DEFAULT).x, top: (pos ?? PANEL_POS_DEFAULT).y }}
        onPointerDown={startDrag}
        onClick={() => clickIfNotDragged(() => setOpen(true))}
        title={props.t('layer.panelIconTitle')}
      >
        <LayersIcon />
      </button>
    )
  }

  return (
    <>
      <div
        className={styles.layerStack}
        style={{ left: (pos ?? PANEL_POS_DEFAULT).x, top: (pos ?? PANEL_POS_DEFAULT).y }}
      >
        <div className={styles.layerPanel} onContextMenu={(e) => e.preventDefault()}>
          <div className={styles.layerPanelHead} onPointerDown={startDrag} title={props.t('layer.panelDragTitle')}>
            <button
              className={styles.layerPanelToggle}
              onClick={() => {
                clickIfNotDragged(() => {
                  setOpen(false)
                  setDrawingOpen(false)
                })
              }}
              title={props.t('layer.collapseIconTitle')}
            >
              {props.t('layer.panelToggle', { n: props.layers.length })}
            </button>
            <div className={styles.layerPanelHeadActions}>
              {props.onExportMap && (
                <button
                  className={styles.layerImportBtn}
                  onClick={() => clickIfNotDragged(() => props.onExportMap?.())}
                  title={props.t('layer.exportTitle')}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {props.t('layer.exportBtn')}
                </button>
              )}
              <button
                className={styles.layerCreateBtn}
                onClick={() => clickIfNotDragged(() => setDrawingOpen((v) => !v))}
                title={props.t('layer.createTitle')}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {drawingOpen ? props.t('layer.createBtnClose') : props.t('layer.createBtn')}
              </button>
              <button
                className={styles.layerImportBtn}
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {busy ? props.t('layer.importBusy') : props.t('layer.importBtn')}
              </button>
              <button
                className={styles.layerActionBtn}
                onClick={clearAll}
                disabled={busy}
                title={props.t('layer.clearTitle')}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {props.t('layer.clearBtn')}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".shp,.zip,.csv,.geojson,.json"
              hidden
              onChange={(e) => void onFileChange(e)}
            />
          </div>
          <div className={styles.layerList}>
            {props.layers.length === 0 && <div className={styles.layerEmpty}>{props.t('layer.empty')}</div>}
            {props.layers.map((l) => (
              <div
                key={l.id}
                className={styles.layerRow}
                title={props.t('layer.rowMenuHint')}
                onContextMenu={(e) => openMenu(e, l)}
              >
                <label className={styles.layerVis} title={(visOverride[l.id] ?? l.visible) ? props.t('layer.visOn') : props.t('layer.visOff')}>
                  <input
                    type="checkbox"
                    checked={visOverride[l.id] ?? l.visible}
                    onChange={() => toggleVisible(l)}
                  />
                </label>
                <div className={styles.layerRowMain}>
                  <div className={styles.layerRowName} title={l.name}>{l.name}</div>
                  <div className={styles.layerRowMeta}>
                    {props.t('layer.featureCount', { n: String(l.featureCount) })}
                    {l.materialized === false && l.totalCount != null ? props.t('layer.sampledMeta', { total: fmtCount(l.totalCount, props.t) }) : ''}
                    {' · '}{l.geometryTypes.join('/')}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {drawingOpen && (DrawToolbarComp ? (
          <DrawToolbarComp
            mapRef={props.mapRef}
            sessionId={props.sessionId}
            t={props.t}
            onActiveChange={props.onDrawingActive}
            onDone={() => setDrawingOpen(false)}
          />
        ) : (
          <div className={styles.layerEmpty}>{props.t('layer.drawLoading')}</div>
        ))}
      </div>
      {menu && (
        <div
          className={styles.layerMenuOverlay}
          onPointerDown={closeMenu}
          onContextMenu={(e) => {
            e.preventDefault()
            closeMenu()
          }}
        >
          <div
            className={styles.layerMenu}
            style={{ left: menu.x, top: menu.y }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className={styles.layerMenuTitle} title={menu.layer.name}>
              {menu.layer.name}
            </div>
            <button
              type="button"
              className={styles.layerMenuItem}
              onClick={() => {
                props.onShowAttributes(menu.layer)
                closeMenu()
              }}
            >
              {props.t('layer.viewAttrs')}
            </button>
            <div className={styles.layerMenuLabel}>{props.t('layer.exportLabel')}</div>
            {(['geojson', 'csv', 'shp'] as const).map((fmt) => (
              <button
                key={fmt}
                type="button"
                className={styles.layerMenuItem}
                onClick={() => {
                  downloadUrl(sessionUrl(props.sessionId, `/webgis/export?id=${encodeURIComponent(menu.layer.id)}&format=${fmt}`))
                  closeMenu()
                }}
              >
                {props.t('layer.exportFmt', { fmt: fmt.toUpperCase() })}
              </button>
            ))}
            <div className={styles.layerMenuDivider} />
            <button
              type="button"
              className={`${styles.layerMenuItem} ${styles.layerMenuItemDanger}`}
              onClick={() => {
                void action({ id: menu.layer.id, action: 'remove' })
                closeMenu()
              }}
            >
              {props.t('layer.removeLayer')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
