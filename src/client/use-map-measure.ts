/**
 * 测量工具（自 MapView.tsx 拆分）：点击加点测线长，点回起点闭合成面给「周长 + 面积」，
 * 自动吸附本次已画顶点。只读、不落地成图层；源/层由 map-style 的 ensureMeasureLayers 保证存在。
 *
 * 组件侧只做三件事：`measure.toggle()` 开关、把地图事件委托给 onMapClick/onMouseMove/onDblClick/onKeyDown、
 * 读 measuring/measureSegs 等状态渲染 readout。事件委托返回 true 表示本次事件已被测量消费。
 */
import { useRef, useState, type RefObject } from 'react'
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl'
import {
  formatArea, formatDistance, haversineM, pathMeters, polygonAreaM2, ringPathMeters, segmentMeters, type Pt,
} from './measure-utils.js'
import { EMPTY_COLLECTION } from './map-style.js'

/** 吸附阈值（像素）。吸附对象 = 本次测量**已画出的顶点**（含起点），用于精确对齐与点回起点闭合。 */
const SNAP_PX = 20

export interface MapMeasure {
  measuring: boolean
  measureDone: boolean
  measureClosed: boolean
  measureSegs: number[]
  /** mousemove 实时预览段长文字（末点→光标）的挂载点，直写 DOM 避免逐帧 setState。 */
  previewEl: RefObject<HTMLSpanElement>
  vertexCount: () => number
  toggle: () => void
  lengthText: () => string
  perimeterText: () => string
  areaText: () => string
  /** 图层重建后还原已有几何/预览（切底图样式重建用）。 */
  restoreIfActive: () => void
  onMapClick: (map: MapLibreMap, e: MapMouseEvent) => boolean
  onContextMenu: () => boolean
  onMouseMove: (map: MapLibreMap, e: MapMouseEvent) => void
  onDblClick: (e: MapMouseEvent) => boolean
  onKeyDown: (e: KeyboardEvent) => boolean
}

/** 测量工具 hook：状态 + 地图交互，全部内聚在此。 */
export function useMapMeasure(mapRef: RefObject<MapLibreMap | null>): MapMeasure {
  const [measuring, setMeasuring] = useState(false)
  const measuringRef = useRef(false)
  measuringRef.current = measuring
  /** 已提交的测量顶点（折线 / 闭合多边形环）。 */
  const measurePts = useRef<Pt[]>([])
  /** 当前是否闭合为面（≥3 点且点回起点触发）。 */
  const [measureClosed, setMeasureClosed] = useState(false)
  const measureClosedRef = useRef(false)
  measureClosedRef.current = measureClosed
  /** 逐段距离（米），加点/收尾时重算（驱动 readout 渲染）。 */
  const [measureSegs, setMeasureSegs] = useState<number[]>([])
  /** 是否收尾保留了结果（非测量中也显示，再点测量即清空开新一轮）。 */
  const [measureDone, setMeasureDone] = useState(false)
  const previewEl = useRef<HTMLSpanElement>(null)
  /** 双击去抖：双击的两记 click 只算一记（第二记交给 dblclick 收尾）。 */
  const lastMeasureClick = useRef(0)

  /** 像素距离最近且在 SNAP_PX 内的候选；无则 null。 */
  const nearestPixelPt = (map: MapLibreMap, x: number, y: number, cands: Pt[]): { pt: Pt; d2: number } | null => {
    let best: { pt: Pt; d2: number } | null = null
    const lim = SNAP_PX * SNAP_PX
    for (const p of cands) {
      const s = map.project([p.lon, p.lat])
      const dx = s.x - x
      const dy = s.y - y
      const d2 = dx * dx + dy * dy
      if (d2 <= lim && (best == null || d2 < best.d2)) best = { pt: p, d2 }
    }
    return best
  }
  /** 测量时可吸附的自己顶点：≥3 点后才启用（此前除起点外没有可复用的点）；
   *  取除最近一个以外的全部（含起点）——避免刚点完就叠在同一点，且 2 点时不会误把第二点叠回起点。 */
  const ownSnapCands = (): Pt[] => {
    const pts = measurePts.current
    return pts.length >= 3 ? pts.slice(0, pts.length - 1) : []
  }

  /** 已提交顶点 → measure 源（折线 / 闭合多边形 + 顶点圆点）。 */
  const writeMeasure = (): void => {
    const map = mapRef.current
    const src = map?.getSource('measure') as GeoJSONSource | undefined
    if (!src) return
    const pts = measurePts.current
    if (pts.length === 0) { src.setData(EMPTY_COLLECTION); return }
    const coords = pts.map((p): [number, number] => [p.lon, p.lat])
    const feats: unknown[] = []
    if (measureClosedRef.current && pts.length >= 3) {
      // 闭合：一个多边形（fill 层填充、line 层描边），顶点仍画圆点。
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...coords, coords[0]!]] } })
    } else if (pts.length >= 2) {
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } })
    } else {
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coords[0] } })
    }
    for (const c of coords) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })
    src.setData({ type: 'FeatureCollection', features: feats } as never)
  }
  /** 末点→target 虚线预览 + 实时段长；吸附时在 target 画高亮点。null 清除。 */
  const writeMeasurePreview = (pv: { pt: Pt; snapped?: boolean } | null): void => {
    const map = mapRef.current
    const hover = map?.getSource('measure-hover') as GeoJSONSource | undefined
    const last = measurePts.current[measurePts.current.length - 1]
    const el = previewEl.current
    if (hover && pv && last) {
      const hf: unknown[] = [
        { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[last.lon, last.lat], [pv.pt.lon, pv.pt.lat]] } },
      ]
      if (pv.snapped) hf.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [pv.pt.lon, pv.pt.lat] } })
      hover.setData({ type: 'FeatureCollection', features: hf } as never)
      if (el) el.textContent = `  + ${formatDistance(haversineM(last, pv.pt))}`
    } else {
      if (hover) hover.setData(EMPTY_COLLECTION)
      if (el) el.textContent = ''
    }
  }
  /** 测量时光标变十字 + 禁双击缩放；结束恢复。 */
  const setMeasureCursor = (cross: boolean): void => {
    const map = mapRef.current
    if (!map) return
    map.getCanvas().style.cursor = cross ? 'crosshair' : ''
    try { if (cross) map.doubleClickZoom.disable(); else map.doubleClickZoom.enable() } catch { /* 忽略 */ }
  }
  const beginMeasure = (): void => {
    measurePts.current = []
    setMeasureSegs([])
    setMeasureDone(false)
    setMeasureClosed(false)
    measureClosedRef.current = false
    measuringRef.current = true
    setMeasuring(true)
    writeMeasure()
    writeMeasurePreview(null)
    setMeasureCursor(true)
  }
  /** 收尾：open=true 保留开环长度；closed=true 保留闭合周长+面积（≥3 点）；都 false 则清空。 */
  const endMeasure = (open: boolean, closed: boolean): void => {
    measuringRef.current = false
    setMeasuring(false)
    setMeasureCursor(false)
    writeMeasurePreview(null)
    const pts = measurePts.current
    const ok = closed ? pts.length >= 3 : open && pts.length >= 2
    if (ok) {
      measureClosedRef.current = closed
      setMeasureClosed(closed)
      setMeasureSegs(segmentMeters(pts))
      setMeasureDone(true)
    } else {
      measurePts.current = []
      measureClosedRef.current = false
      setMeasureClosed(false)
      setMeasureSegs([])
      setMeasureDone(false)
    }
    writeMeasure()
  }
  const finishMeasure = (): void => endMeasure(true, false)
  const finishClosedMeasure = (): void => endMeasure(true, true)
  const discardMeasure = (): void => endMeasure(false, false)
  const addMeasureVertex = (p: Pt): void => {
    measurePts.current.push(p)
    setMeasureSegs(segmentMeters(measurePts.current))
    writeMeasure()
    writeMeasurePreview(null)
  }

  return {
    measuring,
    measureDone,
    measureClosed,
    measureSegs,
    previewEl,
    vertexCount: () => measurePts.current.length,
    toggle: () => { if (measuringRef.current) finishMeasure(); else beginMeasure() },
    lengthText: () => (measurePts.current.length >= 2 ? formatDistance(pathMeters(measurePts.current)) : ''),
    perimeterText: () => (measurePts.current.length >= 3 ? formatDistance(ringPathMeters(measurePts.current)) : ''),
    areaText: () => (measurePts.current.length >= 3 ? formatArea(polygonAreaM2(measurePts.current)) : ''),
    restoreIfActive: () => {
      if (!measuringRef.current && measurePts.current.length === 0) return
      writeMeasure()
      if (!measuringRef.current) writeMeasurePreview(null)
    },
    onMapClick: (map, e) => {
      // 测量激活：左键加点。双击会连发两记 click，间隔 <300ms 的第二记交给 dblclick 收尾，不加点。
      if (!measuringRef.current) return false
      const now = performance.now()
      if (now - lastMeasureClick.current < 300) { lastMeasureClick.current = 0; return true }
      lastMeasureClick.current = now
      const pts = measurePts.current
      const start = pts[0]
      // 点回起点（≥3 点且在像素阈值内）→ 闭合成面：收尾给周长+面积。
      if (start && pts.length >= 3) {
        const sp = map.project([start.lon, start.lat])
        const dx = e.point.x - sp.x
        const dy = e.point.y - sp.y
        if (dx * dx + dy * dy <= SNAP_PX * SNAP_PX) {
          writeMeasurePreview(null)
          finishClosedMeasure()
          return true
        }
      }
      // 自动吸附：命中自己已画顶点（除最近一个）则落该点（含贴起点精确闭合引导），否则用点击坐标。
      const snap = nearestPixelPt(map, e.point.x, e.point.y, ownSnapCands())
      addMeasureVertex(snap ? snap.pt : { lon: e.lngLat.lng, lat: e.lngLat.lat })
      return true
    },
    onContextMenu: () => {
      if (!measuringRef.current) return false
      discardMeasure()
      return true
    },
    onMouseMove: (map, e) => {
      if (!measuringRef.current || measurePts.current.length === 0) return
      const raw: Pt = { lon: e.lngLat.lng, lat: e.lngLat.lat }
      let target = raw
      let snapped = false
      const cands = ownSnapCands()
      const snap = nearestPixelPt(map, e.point.x, e.point.y, cands)
      if (snap) { target = snap.pt; snapped = true }
      // ≥3 点且贴近起点 → 贴起点并提示可闭合（优先于其他顶点吸附）。
      const start = measurePts.current[0]
      if (start && measurePts.current.length >= 3) {
        const sp = map.project([start.lon, start.lat])
        const dx = e.point.x - sp.x
        const dy = e.point.y - sp.y
        if (dx * dx + dy * dy <= SNAP_PX * SNAP_PX) { target = start; snapped = true }
      }
      writeMeasurePreview({ pt: target, snapped })
    },
    onDblClick: (e) => {
      // 双击收尾（测距中）：保留结果。click 里已对 <300ms 第二记做去抖，不会多加一个点。
      if (!measuringRef.current) return false
      e.originalEvent?.preventDefault()
      lastMeasureClick.current = 0
      finishMeasure()
      return true
    },
    onKeyDown: (e) => {
      // Enter 收尾保留结果，Esc 丢弃并退出测距。
      if (!measuringRef.current) return false
      if (e.key === 'Escape') { e.preventDefault(); discardMeasure(); return true }
      if (e.key === 'Enter') { e.preventDefault(); finishMeasure(); return true }
      return false
    },
  }
}
