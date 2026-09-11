import { useEffect, useLayoutEffect, useRef, useState, type ComponentType, type PointerEvent as ReactPointerEvent } from 'react'
import type { GlobalStandardProps, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useWebgisMode, webgisModeStore } from './webgisMode.js'
import { ensure } from './chunk-loader.js'
import { ModeSelector } from './ModeSelector.js'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

// ---- GIS 布局：地图与对话列之间的拖拽分隔条（对话列宽度） ----
/** 对话列默认宽度（px）。 */
const CHAT_W_DEFAULT = 360
/** 对话列最小宽度（px）——再窄输入框就没法用了。 */
const CHAT_W_MIN = 300
/** 宽度持久化键（localStorage）。 */
const CHAT_W_KEY = 'webgis.chatWidth'
const CHAT_W_VAR = '--webgis-chat-width'

/** 钳制对话列宽度：≥300px，且不超过视口一半（地图永远占大头）。 */
function clampChatWidth(w: number): number {
  const max = Math.max(CHAT_W_MIN, Math.round(window.innerWidth * 0.5))
  const n = Math.round(Number.isFinite(w) ? w : CHAT_W_DEFAULT)
  return Math.max(CHAT_W_MIN, Math.min(max, n))
}

/** 读持久化宽度（无/非法/隐私模式 → 默认值）。 */
function readChatWidth(): number {
  try {
    const raw = localStorage.getItem(CHAT_W_KEY)
    const v = raw == null ? NaN : Number(raw)
    if (Number.isFinite(v) && v > 0) return clampChatWidth(v)
  } catch {
    // localStorage 不可用（隐私模式等）：用默认值
  }
  return CHAT_W_DEFAULT
}

/** 传给懒加载 MapView 的 props（手写镜像，与 MapView.tsx 的入参一致；跨 bundle 走运行参数注入）。 */
export type GisMapCompProps = { sessionId?: string; t: WebgisT }

/**
 * shell.overlay 入口：GIS 模式下渲染全帧地图；新对话空白页渲染模式选择器。
 * 根元素填满 overlayLayer（position:absolute; inset:0）。
 * `t` 由 DSH 渲染器按声明 `locale:'webgis'` 注入（语言切换给新引用 → 自动重渲染）。
 */
export function GisSurface({ useSessions, t }: GlobalStandardProps & PropsLocale<'webgis'>) {
  const sessions = useSessions((s) => s)
  const current = sessions.current
  // 尚无会话（hero）或当前会话为空白 → 视为"新对话"状态
  const blank = current === undefined ? true : !!sessions.byId[current]?.blank
  const mode = useWebgisMode(current)
  const prevCurrent = useRef<typeof current>(current)
  const gisRef = useRef<HTMLDivElement>(null)
  const lastLeft = useRef<number | null>(null)
  /** 上次实测的宿主右侧栏轨道宽度（px），用于避免无谓的 DOM 写入。 */
  const lastRightbar = useRef<number | null>(null)
  /** 当前对话列宽度（拖动时实时更新；视口变化时重新钳制）。 */
  const chatWidthRef = useRef(CHAT_W_DEFAULT)

  // ---- 启停开关：轮询 /webgis/status；关闭 → 整个 surface 隐藏（组件保持挂载，轮询继续才能检测重新开启） ----
  const [pluginEnabled, setPluginEnabledState] = useState(true)
  useEffect(() => {
    let cancelled = false
    const check = async (): Promise<void> => {
      try {
        const res = await fetch('/webgis/status', { cache: 'no-store' })
        if (!res.ok) return
        const s = (await res.json()) as { enabled: boolean }
        if (!cancelled) setPluginEnabledState(!!s.enabled)
      } catch {
        // 网络错误忽略，下一轮重试
      }
    }
    void check()
    const timer = setInterval(check, 1000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  // 关闭时清掉当前会话的模式，重新开启后从干净状态恢复（新对话重新弹选择器）。
  useEffect(() => {
    if (pluginEnabled === false && current) webgisModeStore.clearMode(current)
  }, [pluginEnabled, current])

  // 离开一个"未提交"的会话时清掉其模式：DSH 会复用/重新聚焦被隐藏的空白会话，
  // 若不清理，上次选的模式会被当作默认继承，导致新会话不再弹选择器。
  // "未提交" = 会话已从列表移除（被删）或仍是空白（无消息）；有内容的会话模式保留。
  useEffect(() => {
    const prev = prevCurrent.current
    if (prev && prev !== current && (!sessions.byId[prev] || sessions.byId[prev].blank)) {
      webgisModeStore.clearMode(prev)
    }
    prevCurrent.current = current
  }, [current, sessions.byId])

  // GIS 模式布局：置 html[data-webgis-gis] + 实测左侧会话列表右缘、把地图层 left 推进到其之后。
  // 用 useLayoutEffect（绘制前同步执行），保证 MapView 创建地图时容器宽度已经正确；
  // 用 inline style（优先级高于样式表）而不只依赖 CSS 变量，避免变量/时机问题导致仍满宽。
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = gisRef.current
    if (mode !== 'gis' || pluginEnabled === false) {
      delete root.dataset.webgisGis
      if (el) el.style.left = ''
      root.style.removeProperty('--webgis-sidebar-width')
      root.style.removeProperty('--webgis-rightbar-width')
      return
    }
    root.dataset.webgisGis = ''
    // 对话列宽度：应用持久化值（地图与对话列共用同一 CSS 变量）。
    chatWidthRef.current = readChatWidth()
    root.style.setProperty(CHAT_W_VAR, `${chatWidthRef.current}px`)
    /** 从侧栏槽向下找第一个有盒子的元素（其右缘即侧栏实际可见宽度）。 */
    const findSidebarBox = (rootEl: Element): Element | null => {
      const r = rootEl.getBoundingClientRect()
      if (r.width > 0 || r.height > 0) return rootEl
      for (const c of rootEl.children) {
        const found = findSidebarBox(c)
        if (found) return found
      }
      return null
    }
    /** 宿主 frame（.frame 网格容器）：overlay 层是它的绝对定位子元素，网格轨道写在它身上。 */
    const frameEl = (): Element | null => {
      const ov = document.querySelector('[data-shell-overlay]')
      return ov ? ov.parentElement : null
    }
    /** 网格第 idx 列的宽度（0=左；-1=右），兼容 "280px" 与 "minmax(0px, 952px)"。
        宿主把轨道写成 inline gridTemplateColumns `${sidebar}px minmax(0,1fr) ${rightbar}px`。 */
    const gridTrackWidth = (idx: number): number => {
      const frame = frameEl()
      if (!frame) return 0
      const tracks = getComputedStyle(frame).gridTemplateColumns.split(/\s+/).filter(Boolean)
      const cell = (idx < 0 ? tracks[tracks.length + idx] : tracks[idx]) ?? ''
      const nums = cell.match(/\d+(?:\.\d+)?/g)
      if (!nums || nums.length === 0) return 0
      const px = Math.max(...nums.map(Number))
      return Number.isFinite(px) && px > 0 ? Math.round(px) : 0
    }
    const measure = () => {
      if (!el) return
      // 视口变化时重新钳制对话列宽度（窗口变小 → 对话列不许超过 50vw，否则地图被挤没）
      const cw = clampChatWidth(chatWidthRef.current)
      if (cw !== chatWidthRef.current) {
        chatWidthRef.current = cw
        root.style.setProperty(CHAT_W_VAR, `${cw}px`)
      }
      let left = 0
      // 量「侧栏实际可见内容」而非「宿主保留的列宽」：折叠时宿主保留网格列宽但把内容藏起来，
      // 量列宽会导致折叠区留白、地图不延伸。内容隐藏（折叠）→ 无可见盒子 → left=0，地图铺满。
      const sb = document.querySelector('[data-slot="sidebar"]')
      if (sb) {
        const box = findSidebarBox(sb)
        if (box) left = Math.round(box.getBoundingClientRect().right)
        // sb 存在但无可见盒子 = 已折叠（或内容为空）→ left 保持 0，地图延伸到最左
      } else {
        // 找不到侧栏槽 → 用网格列宽兜底
        left = gridTrackWidth(0)
      }
      const prev = lastLeft.current
      if (prev !== left) {
        lastLeft.current = left
        el.style.left = `${left}px`
        root.style.setProperty('--webgis-sidebar-width', `${left}px`)
        console.info(`[webgis] GIS 地图层 left=${left}px`)
      }

      // 右侧：宿主右侧栏占的网格轨道宽（≤0.1.2 是 details，0.1.5+ 是 rightbar）。
      // 轨道是 0（关闭）时地图铺到中列右缘；展开时地图让开，正好贴住被推左的对话列。
      // 右侧栏全屏不用管：它是 position:fixed + z-index:40，天然盖在 overlay 层（z-index:20）之上。
      const rightbar = gridTrackWidth(-1)
      if (lastRightbar.current !== rightbar) {
        lastRightbar.current = rightbar
        root.style.setProperty('--webgis-rightbar-width', `${rightbar}px`)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    const observers: ResizeObserver[] = []
    const frame = frameEl()
    if (typeof ResizeObserver !== 'undefined') {
      // 折叠/展开可能只改侧栏内容尺寸不改网格 → 同时观察侧栏可见盒与 .frame。
      if (frame) {
        const ro = new ResizeObserver(measure)
        ro.observe(frame)
        observers.push(ro)
      }
      const sb = document.querySelector('[data-slot="sidebar"]')
      if (sb) {
        const box = findSidebarBox(sb)
        if (box && box !== frame) {
          const ro2 = new ResizeObserver(measure)
          ro2.observe(box)
          observers.push(ro2)
        }
      }
      const rb = document.querySelector('[data-rightbar-col]')
      if (rb && rb !== frame) {
        const ro3 = new ResizeObserver(measure)
        ro3.observe(rb)
        observers.push(ro3)
      }
    }
    // 网格轨道的开合只改 frame 的 inline gridTemplateColumns：frame 自己的盒子尺寸没变，
    // ResizeObserver 不会触发（它观察的是盒子，不是轨道），必须靠属性观察补上。
    let attrObserver: MutationObserver | undefined
    if (frame && typeof MutationObserver !== 'undefined') {
      attrObserver = new MutationObserver(measure)
      attrObserver.observe(frame, {
        attributes: true,
        attributeFilter: ['style', 'data-rightbar-collapsed', 'data-sidebar-collapsed'],
      })
    }
    return () => {
      delete root.dataset.webgisGis
      if (el) el.style.left = ''
      root.style.removeProperty('--webgis-sidebar-width')
      root.style.removeProperty('--webgis-rightbar-width')
      root.style.removeProperty(CHAT_W_VAR)
      window.removeEventListener('resize', measure)
      observers.forEach((o) => o.disconnect())
      attrObserver?.disconnect()
      lastLeft.current = null
      lastRightbar.current = null
    }
  }, [mode, pluginEnabled])

  /** 拖动分隔条：实时写 CSS 变量（不触发重渲染），松手持久化宽度。 */
  const onResizeStart = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const root = document.documentElement
    const handle = e.currentTarget
    const startX = e.clientX
    const startW = chatWidthRef.current
    let last = startW
    handle.dataset.dragging = 'true'
    handle.setPointerCapture(e.pointerId)
    const onMove = (ev: PointerEvent): void => {
      last = clampChatWidth(startW + (startX - ev.clientX))
      chatWidthRef.current = last
      root.style.setProperty(CHAT_W_VAR, `${last}px`)
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      delete handle.dataset.dragging
      try { localStorage.setItem(CHAT_W_KEY, String(last)) } catch { /* 隐私模式：不持久化 */ }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }

  // ---- 按需加载地图核心（gis 懒 chunk）：首次进 GIS 才拉 maplibre+MapView，加载中显示占位。
  const [MapComp, setMapComp] = useState<ComponentType<GisMapCompProps> | null>(null)
  const [mapLoading, setMapLoading] = useState(false)
  useEffect(() => {
    if (mode !== 'gis') return
    let cancelled = false
    setMapLoading(true)
    ensure('gis')
      .then((m) => {
        if (cancelled) return
        const C = m.MapView as ComponentType<GisMapCompProps> | undefined
        if (C) setMapComp(() => C)
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn('[webgis] gis chunk 加载失败', err)
      })
      .finally(() => {
        if (!cancelled) setMapLoading(false)
      })
    return () => { cancelled = true }
  }, [mode])

  // 浮动切换按钮：任何非「空白会话待选模式」的状态都显示，随时可在传统/GIS 间切换。
  // 放在本组件自己的渲染里（shell.overlay 座已确认始终可见：地图/选择器都在这渲染），
  // 不依赖会话头部 actions 槽——该槽在活跃布局下不可靠（用户实测切换按钮消失）。
  const showToggle = current !== undefined && !(blank && mode === null)

  // 插件关闭：整个 surface 渲染为空（地图/模式选择器/切换按钮都不出现），但组件保持挂载以继续轮询启停状态。
  if (pluginEnabled === false) return null

  if (mode === 'gis') {
    return (
      <div ref={gisRef} className={styles.gisLayer}>
        {MapComp ? (
          <MapComp sessionId={current} t={t} />
        ) : (
          <div className={styles.gisLoading}>{mapLoading ? t('gis.mapLoading') : t('gis.mapLoadFailed')}</div>
        )}
        {/* 地图/对话列分隔条：拖动调整对话列宽度（持久化） */}
        <div
          className={styles.chatResizer}
          role="separator"
          aria-orientation="vertical"
          title={t('layout.resizeHint')}
          onPointerDown={onResizeStart}
        />
        {showToggle && (
          <button
            type="button"
            className={styles.modeFloat}
            title={t('mode.toTraditional')}
            onClick={() => webgisModeStore.setMode(current, 'traditional')}
          >
            {t('mode.toTraditional')}
          </button>
        )}
      </div>
    )
  }

  // 新对话空白页且尚未选模式 → 显示模式选择器
  if (blank && mode === null) {
    return <ModeSelector onPick={(m) => webgisModeStore.setMode(current, m)} t={t} />
  }

  // 传统模式（或活跃会话尚未选模式）：只渲染一个浮动的「进入 GIS」按钮
  if (showToggle) {
    return (
      <button
        type="button"
        className={styles.modeFloat}
        title={t('mode.toGis')}
        onClick={() => webgisModeStore.setMode(current, 'gis')}
      >
        {t('mode.toGis')}
      </button>
    )
  }

  return null
}
