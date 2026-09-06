import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from 'react'
import type { GlobalStandardProps, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { useWebgisMode, webgisModeStore } from './webgisMode.js'
import { ensure } from './chunk-loader.js'
import { ModeSelector } from './ModeSelector.js'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

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
      return
    }
    root.dataset.webgisGis = ''
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
    /** 网格第一列宽度（宿主为侧栏保留的列宽），兼容 "280px" 与 "minmax(0px, 952px)"。 */
    const gridColumnWidth = (): number => {
      const ov = document.querySelector('[data-shell-overlay]')
      const frame = ov ? ov.parentElement : null
      if (!frame) return 0
      const first = (getComputedStyle(frame).gridTemplateColumns.split(/\s+/)[0] ?? '').trim()
      const nums = first.match(/\d+(?:\.\d+)?/g)
      if (!nums || nums.length === 0) return 0
      const px = Math.max(...nums.map(Number))
      return Number.isFinite(px) && px > 0 ? Math.round(px) : 0
    }
    const measure = () => {
      if (!el) return
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
        left = gridColumnWidth()
      }
      const prev = lastLeft.current
      if (prev !== left) {
        lastLeft.current = left
        el.style.left = `${left}px`
        root.style.setProperty('--webgis-sidebar-width', `${left}px`)
        console.info(`[webgis] GIS 地图层 left=${left}px`)
      }
    }
    measure()
    window.addEventListener('resize', measure)
    const observers: ResizeObserver[] = []
    const ov = document.querySelector('[data-shell-overlay]')
    const frame = ov ? ov.parentElement : null
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
    }
    return () => {
      delete root.dataset.webgisGis
      if (el) el.style.left = ''
      root.style.removeProperty('--webgis-sidebar-width')
      window.removeEventListener('resize', measure)
      observers.forEach((o) => o.disconnect())
      lastLeft.current = null
    }
  }, [mode, pluginEnabled])

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
