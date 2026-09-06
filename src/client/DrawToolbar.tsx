import { useEffect, useRef, useState } from 'react'
import type { Map as MapLibreMap, GeoJSONSource } from 'maplibre-gl'
import {
  TerraDraw,
  TerraDrawLineStringMode,
  TerraDrawPointMode,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
  type TerraDrawMouseEvent,
} from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { bezierSpline } from '@turf/bezier-spline'
import type { Feature, FeatureCollection, LineString, Position } from 'geojson'
import { sessionUrl } from './sessionUrl.js'
import type { WebgisT } from './webgis-i18n.js'
import styles from './webgis.module.css'

type DrawTarget = 'point' | 'linestring' | 'polygon' | 'bezier' | 'select' | null

/** 从地图所有 geojson 源收集顶点坐标（dataset 的 data 源 + 结果/导入层的 gis-* 源），超 cap 均匀抽样。 */
async function collectSnapPoints(map: MapLibreMap, cap = 5000): Promise<Position[]> {
  const pts: Position[] = []
  const sources = map.getStyle()?.sources ?? {}
  for (const key of Object.keys(sources)) {
    const src = map.getSource(key) as (GeoJSONSource & { type?: string }) | undefined
    if (!src || src.type !== 'geojson') continue
    try {
      const data = (await src.getData()) as FeatureCollection | undefined
      if (data) collectCoords(data, pts)
    } catch {
      // 单个源读取失败跳过
    }
  }
  if (pts.length <= cap) return pts
  const step = Math.ceil(pts.length / cap)
  const out: Position[] = []
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]!)
  return out
}

/** 递归收集几何所有坐标对。 */
function collectCoords(geo: unknown, out: Position[]): void {
  const g = geo as { type?: string; features?: unknown[]; geometry?: unknown; coordinates?: unknown } | null | undefined
  if (!g?.type) return
  switch (g.type) {
    case 'FeatureCollection':
      ;(g.features ?? []).forEach((f) => collectCoords(f, out))
      break
    case 'Feature':
      collectCoords(g.geometry, out)
      break
    case 'Point':
      out.push(g.coordinates as Position)
      break
    case 'MultiPoint':
    case 'LineString':
      ;((g.coordinates ?? []) as Position[]).forEach((c) => out.push(c))
      break
    case 'MultiLineString':
    case 'Polygon':
      ;((g.coordinates ?? []) as Position[][]).forEach((ring) => ring.forEach((c) => out.push(c)))
      break
    case 'MultiPolygon':
      ;((g.coordinates ?? []) as Position[][][]).forEach((poly) =>
        poly.forEach((ring) => ring.forEach((c) => out.push(c))),
      )
      break
  }
}

/**
 * 绘图工具条：点 / 线 / 面 / 贝塞尔 / 选择 / 删除选中 / 清空 / 保存为图层 / 完成。
 * 由图层面板【创建】按钮按需展开（面板下方）。底层 @watergis/maplibre-gl-terradraw（主线程，无 worker，安全）。
 * - 点位吸附：绘制时按像素阈值吸附到现有图层（dataset/结果/导入层）顶点（toCustom + 投影缓存）。
 * - 贝塞尔：画控制点线（复用 linestring），finish 后用 @turf/bezier-spline 平滑成曲线。
 * - 保存：getSnapshot() → base64 GeoJSON → POST /webgis/import → 新 import_<n> 图层。
 * 激活期间 MapView 的点击逻辑（属性弹窗/图钉/pick）让位（onActiveChange）。
 *
 * 顺序注意：terra-draw 的 addFeatures 内部走 checkEnabled()，未 start 时抛 "Terra Draw is not
 * enabled"——所以必须先 draw.start() 再 addFeatures(existing)，否则画布上有要素时切换模式会静默失败。
 */
export function DrawToolbar({ mapRef, sessionId, t, onActiveChange, onDone }: {
  mapRef: { current: MapLibreMap | null }
  sessionId?: string
  t: WebgisT
  onActiveChange: (active: boolean) => void
  onDone?: () => void
}): JSX.Element {
  const [mode, setMode] = useState<DrawTarget>(null)
  const drawRef = useRef<TerraDraw | null>(null)
  const adapterRef = useRef<TerraDrawMapLibreGLAdapter<MapLibreMap> | null>(null)
  const bezierRef = useRef(false)
  const selectedIdsRef = useRef<Set<string>>(new Set())
  const snapPointsRef = useRef<Position[]>([])
  /** 吸附投影缓存：地图 transform 变化时重建（避免每次 mousemove 全量 project）。 */
  const projCacheRef = useRef<{ sig: string; pts: Array<{ x: number; y: number; p: Position }> }>({ sig: '', pts: [] })
  /** 供 style.load 重建回调读取的最新激活态（闭包拿不到 state）。 */
  const modeRef = useRef<DrawTarget>(null)
  const activeRef = useRef(false)

  const teardown = (): void => {
    // 换底图（setStyle）后 terradraw 图层已随旧样式销毁：maplibre 的 removeLayer 对不存在的图层是
    // fire(ErrorEvent)（有监听才不打印）而非同步 throw，try/catch 接不住。临时挂一个 error 过滤器，
    // 把「Cannot remove non-existing layer/source」这类清理期无谓错误吞掉（有监听 maplibre 即不刷 console）。
    const map = mapRef.current
    const swallow = (e: { error?: { message?: string } | null; preventDefault?: () => void }): void => {
      const msg = e?.error?.message ?? ''
      if (msg.includes('Cannot remove non-existing layer') || msg.includes('Cannot remove non-existing source')) e.preventDefault?.()
    }
    if (map) map.on('error', swallow)
    try { drawRef.current?.stop() } catch { /* 图层可能已不存在 */ }
    try { adapterRef.current?.unregister() } catch { /* 同上 */ }
    if (map) map.off('error', swallow)
    adapterRef.current = null
    drawRef.current = null
    bezierRef.current = false
    selectedIdsRef.current = new Set()
    projCacheRef.current = { sig: '', pts: [] }
  }

  const activate = async (target: Exclude<DrawTarget, null>): Promise<void> => {
    const map = mapRef.current
    if (!map) return
    const existing = drawRef.current?.getSnapshot() ?? []
    try {
      teardown()
      const adapter = new TerraDrawMapLibreGLAdapter({ map, coordinatePrecision: 9 })
      adapterRef.current = adapter
      snapPointsRef.current = await collectSnapPoints(map)

      const wantsSnap = target === 'point' || target === 'linestring' || target === 'polygon' || target === 'bezier'
      const snapping = wantsSnap
        ? {
            toCoordinate: true,
            toCustom: (event: TerraDrawMouseEvent): Position | undefined => {
              const pts = snapPointsRef.current
              if (pts.length === 0) return undefined
              // 投影缓存：transform 或吸附点集变化时重建
              const sig = `${map.getCenter().lng.toFixed(5)},${map.getCenter().lat.toFixed(5)},`
                + `${map.getZoom().toFixed(2)},${map.getPitch().toFixed(1)},${map.getBearing().toFixed(1)},${pts.length}`
              let cache = projCacheRef.current
              if (cache.sig !== sig) {
                cache = {
                  sig,
                  pts: pts.map((p) => {
                    const sp = map.project([p[0] ?? 0, p[1] ?? 0])
                    return { x: sp.x, y: sp.y, p }
                  }),
                }
                projCacheRef.current = cache
              }
              let best: Position | undefined
              let bestD2 = 30 * 30
              for (const sp of cache.pts) {
                const dx = sp.x - event.containerX
                const dy = sp.y - event.containerY
                const d2 = dx * dx + dy * dy
                if (d2 < bestD2) {
                  bestD2 = d2
                  best = sp.p
                }
              }
              return best
            },
          }
        : undefined

      const draw = new TerraDraw({
        adapter,
        modes: [
          new TerraDrawPointMode({ snapping }),
          new TerraDrawLineStringMode({ snapping }),
          new TerraDrawPolygonMode({ snapping }),
          // 选择模式缺省 flags={} 会让 select() 因 flags[feature.mode].feature 不存在而直接跳过——
          // 必须显式启用 point/linestring/polygon 可选中（含拖拽）；styles 提供选中高亮色
          // （缺省回退到要素原色，选中看不出任何变化）。
          new TerraDrawSelectMode({
            flags: {
              point: { feature: { draggable: true } },
              linestring: { feature: { draggable: true } },
              polygon: { feature: { draggable: true } },
            },
            styles: {
              selectedPointColor: '#f97316',
              selectedPointOutlineColor: '#ffffff',
              selectedPointOutlineWidth: 3,
              selectedLineStringColor: '#f97316',
              selectedLineStringWidth: 6,
              selectedPolygonColor: '#f97316',
              selectedPolygonOutlineColor: '#ffffff',
              selectedPolygonOutlineWidth: 4,
            },
          }),
        ],
      })
      // 必须先 start 再 addFeatures(existing)：addFeatures 内部 checkEnabled()，未 start 直接抛错
      // （画布上已有要素时切模式会静默失败）。start 后模式已注册，原要素按各自 mode 校验重建。
      draw.start()
      if (existing.length > 0) draw.addFeatures(existing as never)
      drawRef.current = draw

      // 贝塞尔：复用 linestring 的控制点绘制，finish 后用 bezier-spline 平滑
      bezierRef.current = target === 'bezier'
      draw.on('finish', (featureId: string) => {
        if (!bezierRef.current) return
        const feat = draw.getSnapshot().find((f) => f.id === featureId)
        if (!feat || feat.geometry.type !== 'LineString') return
        const control = { type: 'Feature', properties: {}, geometry: feat.geometry } as Feature<LineString>
        const curved = bezierSpline(control, { sharpness: 0.85, resolution: 5000 })
        draw.removeFeatures([featureId])
        draw.addFeatures([curved as never])
      })
      draw.on('select', (featureId: string) => {
        selectedIdsRef.current.add(featureId)
      })
      draw.on('deselect', (featureId: string) => {
        selectedIdsRef.current.delete(featureId)
      })

      const actualMode = target === 'bezier' ? 'linestring' : target
      draw.setMode(actualMode)
      setMode(target)
      onActiveChange(true)
      activeRef.current = true
      modeRef.current = target
    } catch (err) {
      // 激活失败：清理现场并复位，避免工具条卡在「点了没反应」的状态。
      teardown()
      activeRef.current = false
      modeRef.current = null
      onActiveChange(false)
      setMode(null)
      console.error('[DrawToolbar] 激活绘图模式失败', err)
    }
  }

  const finish = (): void => {
    teardown()
    activeRef.current = false
    modeRef.current = null
    onActiveChange(false)
    setMode(null)
    // 完成 = 结束本次创建会话，收起工具条（由父组件卸载本组件，自动再清理一次）。
    onDone?.()
  }

  const clearAll = (): void => {
    drawRef.current?.clear()
  }

  const deleteSelected = (): void => {
    const draw = drawRef.current
    if (!draw) return
    // removeFeatures 对不存在的 id 会抛错（如先删了一个、又选过另一个再删）→ 先过滤掉已失效的。
    const ids = [...selectedIdsRef.current].filter((id) => draw.hasFeature(id))
    if (ids.length > 0) draw.removeFeatures(ids)
    selectedIdsRef.current = new Set()
  }

  const saveLayer = async (): Promise<void> => {
    const draw = drawRef.current
    if (!draw) return
    const snapshot = draw.getSnapshot()
    if (snapshot.length === 0) return
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: snapshot.map((f) => ({ type: 'Feature', properties: f.properties ?? {}, geometry: f.geometry })),
    }
    const bytes = new TextEncoder().encode(JSON.stringify(fc))
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    try {
      const res = await fetch(sessionUrl(sessionId, '/webgis/import'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: t('draw.defaultLayerName'), data: btoa(binary) }),
      })
      // 只在保存成功后清空画布；失败保留已绘内容，可重试或改完再存。
      if (!res.ok) return
      draw.clear()
    } catch {
      // 网络错误忽略：保留画布内容，靠轮询回显
    }
  }

  // 换底图（setStyle）后 terradraw 图层消失：style.load 时若仍在激活态则重建实例。
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const onStyleLoad = (): void => {
      const current = modeRef.current
      if (activeRef.current && current) void activate(current)
    }
    map.on('style.load', onStyleLoad)
    return () => {
      map.off('style.load', onStyleLoad)
      teardown()
      onActiveChange(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const targets: Array<Exclude<DrawTarget, null>> = ['point', 'linestring', 'polygon', 'bezier', 'select']
  const targetLabel = (target: Exclude<DrawTarget, null>): string =>
    target === 'point' ? t('draw.point')
      : target === 'linestring' ? t('draw.line')
        : target === 'polygon' ? t('draw.polygon')
          : target === 'bezier' ? t('draw.bezier')
            : t('draw.select')

  return (
    <div className={styles.drawToolbar}>
      {targets.map((target) => {
        const label = targetLabel(target)
        return (
          <button
            key={target}
            type="button"
            className={`${styles.drawToolbarBtn}${mode === target ? ` ${styles.drawToolbarBtnActive}` : ''}`}
            title={t('draw.modeTitle', { name: label })}
            onClick={() => void activate(target)}
          >
            {label}
          </button>
        )
      })}
      <button type="button" className={styles.drawToolbarBtn} onClick={deleteSelected}>{t('draw.deleteSelected')}</button>
      <button type="button" className={styles.drawToolbarBtn} onClick={clearAll}>{t('draw.clear')}</button>
      <button type="button" className={styles.drawToolbarBtn} onClick={() => void saveLayer()}>{t('draw.save')}</button>
      <button type="button" className={styles.drawToolbarBtn} onClick={finish}>{t('draw.done')}</button>
    </div>
  )
}
