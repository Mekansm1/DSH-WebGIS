import { useEffect, useRef, useState, type ComponentType } from 'react'
import maplibregl from 'maplibre-gl'
import type { GeoJSONSource, Map as MapLibreMap, Point, RasterTileSource } from 'maplibre-gl'
import styles from './webgis.module.css'
import { LayerPanel } from './LayerPanel.js'
import { AttributeDrawer } from './AttributeDrawer.js'
import type { ExportPrefill } from './ExportMapDialog.js'
import type { WebgisT } from './webgis-i18n.js'
import { ensure } from './chunk-loader.js'
import { sessionUrl } from './sessionUrl.js'
import { BASE_MAPS, baseMapAction, CARTO_LIGHT_TILES, type BaseMapDef } from '../basemaps.js'
import type { OverlayService } from '../webgis-services.js'
import { BasemapSwitcher } from './BasemapSwitcher.js'
import { hexbinFC } from './hex-bins.js'
import type { DeckController, DeckControllerHost } from './deck/controller.js'
import type { DeckChartMode } from './deck-charts.js'
import { geojsonKindOf, rawLineData, rawPointData, rawPolygonData } from './geoarrow-utils.js'
import type { DisplayMode, FeaturePayload, LayerSummary } from './gis-types.js'
import type { FeatureCollection } from 'geojson'
import { formatArea, formatDistance, haversineM, pathMeters, polygonAreaM2, ringPathMeters, segmentMeters, type Pt } from './measure-utils.js'
// 自本文件拆分出的模块级 helper（样式/高亮/浮窗/点击链路/渲染规格）
import { EMPTY_COLLECTION, applyBaseMap, baseStyle, fmtCoord, ensureDataLayers, ensureMeasureLayers, syncOverlays } from './map-style.js'
import { useMapMeasure } from './use-map-measure.js'
import { createLayerSync } from './layer-sync.js'
import { SEL_SRC, ensureSelLayers, clearMapSelection, setMapSelection, isSelectionLayerId } from './map-highlight.js'
import { extractBasemapFeatures } from './basemap-extract.js'
import type { BasemapExportParams } from '../session-state.js'
import { isScalar, scalarRows, featureTitle, fmtCell, makeAttrTable, buildPopupContent } from './map-popup.js'
import { queryFeatures, collectCoords, captureMapScreenshot, drawPin, fitToGeoJSON, clearPick, recordPick } from './map-pick.js'
import type { ScreenshotPayload } from './map-pick.js'
import { renderKinds, makeRenderLayer, darkenHex, maxDensityOf, hexHeightFor, makeHeatLayer, makeHexLayer, CLUSTER_BASE_RADIUS, shadeColor, clusterColorFor, clusterRadius, makeClusterLayer, makeClusterCountLayer, LAYER_KINDS, ALL_RENDER_SUFFIXES, RENDER_ROW_KEY, RENDER_LAYER_KEY, DECK_MODES, SRC, RID, SRC_HEX, layerShapeKey } from './map-render-spec.js'
import type { RenderKind, RenderStyle } from './map-render-spec.js'

interface StateResponse {
  baseTileUrl: string
  dataset: { name: string; featureCount: number; visible: boolean } | null
  navigate: { id: number; lng: number; lat: number; zoom?: number } | null
  /** host 请求「捕获当前视图」：seq 变化即需要截一次当前地图（中心为关注点）。 */
  capture: { seq: number } | null
  /** host 发起的出图请求（AI 工具 webgis_export_map）：见新 seq → 打开出图弹窗并预填。 */
  exportRequest: {
    seq: number
    params?: { title?: string; layerIds?: string[]; legend?: boolean; north?: boolean; scale?: boolean; note?: string; extent?: 'view' | 'all' }
  } | null
  exportImage: { id: number; width: number; height: number; title?: string } | null
  /** host 发起的底图要素导出（AI 工具 webgis_export_basemap）：见新 seq → 按当前视窗提取并回传。 */
  basemapRequest: { seq: number; params: BasemapExportParams } | null
  /** 图层注册表摘要（无 geojson）：rev 变化时按 id 拉全量渲染。 */
  layers: LayerSummary[]
}

// ---- 底图切换 + 叠加服务 + 样式重建 ----

// ---- supercluster 聚合圈：单层 circle + circle-blur 羽化边缘（内发光） ----
// maplibre 官方 paint 属性 circle-blur 直接生成"实心核心 + 高斯羽化边缘"，单层即内发光效果，
// 比多同心圆叠加省约 20 倍绘制、无环纹、增删/点击管理更简单。
// 数量越大：圈越大、颜色越深（在图层基色上加深，支持用户指定任意颜色）。

/** ExportMapDialog（export 懒 chunk）的 props（镜像自 ExportMapDialog.tsx 实际签名）。 */
interface ExportDialogProps {
  open: boolean
  onClose: () => void
  layers: LayerSummary[]
  mapRef: { current: MapLibreMap | null }
  t: WebgisT
  prefill?: ExportPrefill | null
  onExported?: (dataUrl: string, width: number, height: number, title: string) => void
}

/** 全帧 WebGIS 地图（GIS 模式下填满对话页主区域）。 */
export function MapView({ sessionId, t }: { sessionId?: string; t: WebgisT }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markerRef = useRef<maplibregl.Marker | null>(null)
  /** 当前会话 id（随渲染更新；异步轮询/事件回调经 ref 读取最新值）。 */
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  /** 当前翻译函数（随语言切换更新；一次性绑定的事件回调经此读取最新 t，避免 stale）。 */
  const tRef = useRef(t)
  tRef.current = t
  /** 点击属性浮窗（maplibre Popup）：同一时刻最多一个，新点击/空点击/捕获会先关闭旧的。 */
  const popupRef = useRef<maplibregl.Popup | null>(null)
  /** 关闭属性浮窗（新点击/空点击/视图捕获/卸载时复用；只依赖 ref，可在组件各处调用）。 */
  const closePopup = (): void => {
    popupRef.current?.remove()
    popupRef.current = null
    // 关闭浮窗/空点击/右键时一并清掉点击高亮（maplibre 的 gis-sel 与 deck 侧各一份：
    // 点中的要素由哪个渲染器画就由哪个高亮，两处都要清，否则会残留上一次的高亮）。
    const m = mapRef.current
    if (m) {
      try { clearMapSelection(m) } catch { /* 样式未就绪/已卸载：忽略 */ }
    }
    deckRef.current?.clearSelection()
  }
  /** 出图结果上传 host（下载与「导出并给 AI 看」共用；带 AI 请求的 seq 回传，供等待中的 webgis_export_map 收）。
   *  成功回传后消费掉 seq：之后关闭弹窗不会再发一个本该无效的「取消」信号。失败静默（本地下载仍可用）。 */
  const postExportImage = async (dataUrl: string, width: number, height: number, title: string): Promise<void> => {
    const seq = lastExportSeq.current
    try {
      await fetch(sessionUrl(sessionRef.current, '/webgis/export-image'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seq: seq > 0 ? seq : undefined,
          title: title || undefined,
          width,
          height,
          dataUrl,
        }),
      })
      if (seq > 0) lastExportSeq.current = 0
    } catch {
      // 网络失败忽略：用户已能本地下载
    }
  }

  /**
   * 执行一次「底图要素导出」并回传 host：按当前视窗从矢量瓦片提取 → POST /webgis/basemap-extract。
   * 失败（栅格底图 / 视野内无该图层 / 筛选后为空）也要回传，让等待中的工具立刻拿到原因，而不是干等超时。
   */
  const runBasemapExtract = async (
    map: maplibregl.Map,
    req: { seq: number; params: BasemapExportParams },
  ): Promise<void> => {
    let payload: Record<string, unknown>
    try {
      const res = extractBasemapFeatures(map, req.params)
      payload = res.ok
        ? {
            seq: req.seq, ok: true, groups: res.outputs, source: res.source,
            rawCount: res.rawCount, dedupedCount: res.dedupedCount, usedLayers: res.usedLayers,
            names: res.names, classes: res.classes, note: res.note,
          }
        : { seq: req.seq, ok: false, message: res.message }
    } catch (err) {
      payload = { seq: req.seq, ok: false, message: `底图要素提取失败：${err instanceof Error ? err.message : String(err)}` }
    }
    try {
      await fetch(sessionUrl(sessionRef.current, '/webgis/basemap-extract'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      console.warn('[MapView] 底图要素回传失败', err)
    }
  }

  const lastNavigateId = useRef(0)
  /** 最近一次已处理的底图要素导出请求 seq（避免同一次请求被重复执行）。 */
  const lastBasemapSeq = useRef(0)
  /** 最近一轮 /webgis/state 的指纹：轮询时状态没变就整轮跳过（空转零开销）。 */
  const pollFpRef = useRef('')
  const lastCaptureSeq = useRef(0)
  const datasetSeen = useRef('')
  /** 结果图层变更检测：每层记录 rev + visible + mode（+modeParams + 内容形态签名），相同则不重拉。 */
  const gisSeen = useRef<Record<string, {
    rev: number; visible: boolean; mode: DisplayMode; color?: string; params?: string; style?: string; shape?: string
  }>>({})
  /** 客户端已拉取的图层全量数据缓存（deck 出图/raw geojson/热力等需要属性的路径用）。 */
  const dataCache = useRef<Record<string, FeatureCollection>>({})
  /** 客户端已拉取的「渲染轻量」缓存（/webgis/layer-render：几何+__i，无属性；maplibre 直接渲染用，
   *  避免属性极重的大图层整层拖到浏览器）。点击属性按 __i 走 /webgis/layer-row 按行取。 */
  const renderCache = useRef<Record<string, FeatureCollection>>({})
  /** 当前激活的聚合层 id（点击放大用；syncLayers 维护）。 */
  const clusterLayerIds = useRef<Set<string>>(new Set())
  /** 图层面板数据（轮询 /webgis/state 回填）与当前打开属性的图层。 */
  const [layers, setLayers] = useState<LayerSummary[]>([])
  const [attrLayer, setAttrLayer] = useState<LayerSummary | null>(null)
  /** 出图弹窗开关。 */
  const [exportOpen, setExportOpen] = useState(false)
  /** 底部状态条：当前缩放级别 + 视窗四至（西/南/东/北），move/zoom 结束后刷新；null = 地图未就绪前不显示。 */
  const [viewInfo, setViewInfo] = useState<{ zoom: number; w: number; s: number; e: number; n: number } | null>(null)

  // ---- 测量：点击加点沿折线测长；点回起点闭合 → 同时给周长+面积；自动吸附图层点。只读，不落地成图层。 ----
  // 测量工具（状态 + 地图交互）内聚在 hook 里；本组件只做事件委托与 readout 渲染。
  const measure = useMapMeasure(mapRef)
  /** AI 出图请求预填（webgis_export_map）。 */
  const [exportPrefill, setExportPrefill] = useState<ExportPrefill | null>(null)
  const lastExportSeq = useRef(0)
  /** export 懒 chunk 加载完成的出图弹窗组件（点「出图」/AI 请求时才拉导出相关代码）。 */
  const [ExportDialogComp, setExportDialogComp] = useState<ComponentType<ExportDialogProps> | null>(null)
  /** 打开出图弹窗（手点「出图」与 AI webgis_export_map 同一入口）：先确保 export chunk 已加载，再开弹窗。 */
  const openExport = (prefill: ExportPrefill | null): void => {
    setExportPrefill(prefill)
    setExportOpen(true)
    void ensure('export')
      .then((m) => {
        const C = m.ExportMapDialog as ComponentType<ExportDialogProps> | undefined
        if (C) setExportDialogComp(() => C)
      })
      .catch((err: unknown) => console.warn('[webgis] export chunk 加载失败', err))
  }
  /**
   * 关闭出图弹窗。若有 AI 在等这次出图（`webgis_export_map` 的等待），回传一个「用户取消」信号 ——
   * 否则 host 只能干等到 60s 超时才返回，用户看到的是"工具卡住了"。
   * 没有等待中的请求时不发（seq 已消费/为 0），host 侧也只认 seq 匹配的取消。
   */
  const closeExport = (): void => {
    setExportOpen(false)
    const seq = lastExportSeq.current
    if (seq <= 0) return
    lastExportSeq.current = 0
    void fetch(sessionUrl(sessionRef.current, '/webgis/export-image'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cancelSeq: seq }),
    }).catch(() => { /* 网络失败：host 侧仍会按超时收尾 */ })
  }
  /** 当前底图（左下角切换器）；默认条目（default）url 为空，apply 时用 /webgis/state 的 baseTileUrl 填。 */
  const [baseMap, setBaseMap] = useState<BaseMapDef>(() => BASE_MAPS.find((d) => d.id === 'default') ?? BASE_MAPS[0]!)
  const baseMapRef = useRef(baseMap)
  baseMapRef.current = baseMap
  /** 最新 /webgis/state 的图层摘要与 baseTileUrl（样式重建 / 底图切换用）。 */
  const lastLayersRef = useRef<LayerSummary[]>([])
  const stBaseTileUrlRef = useRef('')
  /** 最新叠加服务清单（/webgis/services 轮询回填）。 */
  const overlaysRef = useRef<OverlayService[]>([])
  /** 绘图工具条激活时置 true：MapView 点击逻辑（属性弹窗/图钉/pick）让位给 terradraw。 */
  const drawingActiveRef = useRef(false)
  /** 样式重建去重（style.load 可能重复触发）。 */
  const styleRebuildPending = useRef(false)
  const lastServicesFetch = useRef(0)
  /** deck.gl 运行时控制器（出图 overlay / raw 分级拉取 / 点选回查 / trips 动画；实现见 ./deck/controller.ts）。
   *  不再建图时 eager 构造：首个「需 deck 渲染」的图层出现时经 {@link ensureDeckForMap} 懒建。 */
  const deckRef = useRef<DeckController | null>(null)
  /** deck 懒 chunk 加载进行中 Promise（并发去重；失败清空便于后续重试）。 */
  const deckPromiseRef = useRef<Promise<DeckController> | null>(null)
  /** 拉 deck.js chunk → 懒建 controller（host 绑定 session / dataCache / arrow 回退写缓存）。 */
  const getDeck = (): Promise<DeckController> => {
    if (deckRef.current) return Promise.resolve(deckRef.current)
    if (deckPromiseRef.current) return deckPromiseRef.current
    const p = ensure('deck').then((m) => {
      const factory = m.createDeckController as ((host: DeckControllerHost) => DeckController) | undefined
      if (typeof factory !== 'function') throw new Error('deck chunk 未导出 createDeckController')
      deckRef.current = factory({
        getSessionId: () => sessionRef.current,
        getCachedData: (id) => dataCache.current[id],
        onArrowFallbackGeojson: (id, fc) => { dataCache.current[id] = fc },
      })
      return deckRef.current
    })
    deckPromiseRef.current = p
    // 失败清空占位：允许下次重试（成功后 deckRef.current 已置位，走顶部短路）。
    p.catch(() => { if (deckPromiseRef.current === p) deckPromiseRef.current = null })
    return p
  }
  /** 首个需 deck 渲染的图层出现时调用：懒建 controller + 挂 map + 建 overlay。失败返回 null。 */
  const ensureDeckForMap = async (map: MapLibreMap): Promise<DeckController | null> => {
    if (deckRef.current) return deckRef.current
    try {
      const deck = await getDeck()
      deck.setMap(map)
      // interleaved overlay 需 map load 后 WebGL painter 就绪：已 load 则即时建，否则交给 load once（首个
      // deck 层晚于 map load 出现时 map.loaded() 已 true → 即时可用，无旧 once('load') 竞态）。
      if (map.loaded()) deck.ensureOverlay()
      else map.once('load', () => { deckRef.current?.ensureOverlay(); deckRef.current?.syncLayers() })
      return deck
    } catch (err) {
      console.warn('[MapView] deck chunk 加载失败，本轮跳过该图层（下轮图层状态变更时重试）', err)
      return null
    }
  }

  // 创建地图
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    maplibregl.setWorkerUrl('/webgis/maplibre-gl-csp-worker.js')
    const map = new maplibregl.Map({
      container,
      style: baseStyle([CARTO_LIGHT_TILES]),
      center: [104, 35],
      zoom: 3,
      attributionControl: false,
      // 必须保留绘制缓冲区：否则浏览器合成后清空 WebGL buffer，
      // getCanvas().toDataURL() 截图是空白（点击截图就只剩合成上去的图钉）。
      preserveDrawingBuffer: true,
    })
    mapRef.current = map
    ;(window as unknown as Record<string, unknown>).__webgisMap = map
    map.addControl(new maplibregl.NavigationControl(), 'top-left')
    // deck.gl 出图 overlay 不再建图时 eager 构造：首个「需 deck 渲染」的图层出现时才经 ensureDeckForMap
    // 懒拉 deck.js chunk → 建 controller → setMap → ensureOverlay（interleaved 需 map load 后 WebGL painter
    // 就绪；ensureDeckForMap 内对 map.loaded() 与 'load' once 已做兼容，首个 deck 层晚于 load 出现时即时建）。
    // 底部状态条：当前缩放 + 视窗范围。地图就绪/每次平移缩放结束后刷一次（低频，无每帧开销）。
    const syncViewInfo = (): void => {
      const b = map.getBounds()
      setViewInfo({ zoom: map.getZoom(), w: b.getWest(), s: b.getSouth(), e: b.getEast(), n: b.getNorth() })
    }
    map.on('load', () => {
      map.resize()
      syncViewInfo()
      // 测距常驻源/层（初始光栅样式就绪时建好；此后切底图整重建由 rebuildAfterStyleLoad 补齐）。
      ensureMeasureLayers(map)
    })
    map.on('moveend', syncViewInfo)
    map.on('zoomend', syncViewInfo)

    // 属性浮窗：复用组件级 closePopup（同一时刻最多一个，新点击先关旧的）。
    const showFeaturePopup = (feature: FeaturePayload, lngLat: { lng: number; lat: number }): void => {
      closePopup()
      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        maxWidth: '340px',
        offset: 12,
      })
      popupRef.current = popup
      // 展开「全部属性」后内容变高，setLngLat(同值) 触发 _update 重排。
      const reposition = (): void => { popup.setLngLat(popup.getLngLat()) }
      popup.setLngLat([lngLat.lng, lngLat.lat])
        .setDOMContent(buildPopupContent(feature, tRef.current, reposition))
        .addTo(map)
    }

    // zoom 分级密度：缩放结束 → 大图层 arrow 原始点跨档位时拉新分档（低缩放稀疏、放大逐渐加密、高缩放全量）。
    map.on('zoomend', () => { deckRef.current?.syncRawTiers(lastLayersRef.current) })
    // 视口裁剪：平移/缩放结束（moveend 都触发）→ ~350ms 尾随防抖后按新视野刷新 arrow 大层（只拉视野内）。
    // zoomend 已驱动的 syncRawTiers 保留；两者都汇聚到 lastViewKey（档位|bbox）去重，同键不再重复拉。
    const viewRefreshTimer = { id: 0 }
    const scheduleViewportRefresh = (): void => {
      if (viewRefreshTimer.id) window.clearTimeout(viewRefreshTimer.id)
      viewRefreshTimer.id = window.setTimeout(() => {
        viewRefreshTimer.id = 0
        deckRef.current?.viewportRefresh(lastLayersRef.current)
      }, 350)
    }
    map.on('moveend', scheduleViewportRefresh)

    // 点击联动（GIS 交互重构：点击 = 属性查询，LLM 出环，全部路径都上报 pick 供 webgis_get_pick 消费）：
    //   聚合圈 → 放大一级（导航手势，不弹属性）
    //   命中要素 → 弹属性浮窗（maplibre Popup，显示最上层要素）+ 记录 pick（供 AI 引用被点要素），不落图钉
    //   空点击   → 落图钉标记关注点 + 记录 pick（供 AI 引用坐标）
    // 截图红点 = 关注位置（点击处或图框中心），始终合成在截图里（与 DOM 图钉无关）。
    map.on('click', (e) => {
      // 测量激活：左键加点/点回起点闭合（细节见 use-map-measure）。
      if (measure.onMapClick(map, e)) return
      // 绘图工具条激活时（点/线/面/贝塞尔/选择）：点击让位给 terradraw，不做属性查询/落图钉/pick。
      if (drawingActiveRef.current) return
      const clusterHits = map.queryRenderedFeatures(e.point, { layers: [...clusterLayerIds.current] })
      const cluster = clusterHits[0]
      if (cluster?.properties?.cluster_id != null) {
        closePopup()
        const src = map.getSource(cluster.source) as GeoJSONSource | undefined
        src?.getClusterExpansionZoom(cluster.properties.cluster_id)
          .then((z) => {
            if (typeof z === 'number') {
              const center = (cluster.geometry as { coordinates: number[] }).coordinates as [number, number]
              map.easeTo({ center, zoom: Math.max(map.getZoom() + 1, z) })
            }
          })
          .catch(() => {})
        return
      }

      const lng = e.lngLat.lng
      const lat = e.lngLat.lat
      // deck 原始数据图层（>10 万 arrow / 大 geojson 点层）：maplibre queryRenderedFeatures 查不到 deck 层，
      // 用 controller.pickObject（proxy overlay.pickObject）同步判中；命中则按坐标查 host duck 表属性
      // （arrow 只传坐标，属性点击时才查）。缺 overlay/异常已由 controller 内拦截为日志并返回 null。
      const deckHit = deckRef.current?.pickObject(e.point.x, e.point.y)
      // deck 命中解析：arrow 层 id `deck-<id>-raw`；geojson 分族子层 `deck-<id>-raw-{point|line|polygon}`。
      const deckRawMatch = deckHit?.picked && deckHit.layer?.id
        ? /^deck-(.+?)-raw(-(?:point|line|polygon))?$/.exec(deckHit.layer.id)
        : null
      const deckRawId = deckRawMatch?.[1] ?? null
      const deckRawKind = (deckRawMatch?.[2]?.slice(1) as 'point' | 'line' | 'polygon' | undefined) ?? null
      if (deckRawId && deckHit) {
        const arrowTable = deckRef.current?.arrowTableFor(deckRawId)
        if (arrowTable) {
          // Arrow 几何列图层（点/线/面，duckGeom）带稳定行号列 __rid：命中行 → host 按 rowid 回查整行属性。
          // 跨 zoom 分档稳定（抽样子集/行索引都会变，rowid 不变）；坐标像素反投影有误差、polygon 无中心点可投。
          const ridChild = arrowTable.getChild('__rid')
          const rid = ridChild == null ? null : Number(ridChild.get(deckHit.index))
          if (ridChild != null && Number.isFinite(rid)) {
            closePopup()
            const url = sessionUrl(sessionRef.current, `/webgis/arrow-rid?id=${encodeURIComponent(deckRawId)}&rid=${rid}`)
            void fetch(url, { cache: 'no-store' })
              .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; name?: string; message?: string; attrs?: Record<string, unknown>; geometry?: unknown }>) : null))
              .then((d) => {
                if (!d?.ok || !d.attrs) {
                  if (d?.message) console.warn('[MapView] Arrow 行号属性未命中', deckRawId, 'index', deckHit.index, 'rid', rid, '|', d.message)
                  return
                }
                const feature: FeaturePayload = {
                  id: null,
                  layer: d.name ?? deckRawId,
                  source: 'duckdb',
                  geometryType: d.geometry && typeof d.geometry === 'object' ? ((d.geometry as { type?: string }).type ?? null) : null,
                  properties: d.attrs,
                }
                closePopup()
                showFeaturePopup(feature, { lng, lat })
                // deck 图层（arrow 大图层）也要和 maplibre 图层一样高亮：host 已随属性返回该行几何。
                // ⚠️ 走 deck 侧高亮（不是 gis-sel）：maplibre 图层压不过 deck 的 group 自定义层。
                if (d.geometry) deckRef.current?.setSelection(d.geometry)
                recordPick(map, lng, lat, [feature], undefined, sessionRef.current)
              })
              .catch((err) => console.warn('[MapView] Arrow 行号属性查询失败', deckRawId, err))
            return
          }
          // 旧 duckCoords 点表（无 __rid）：info.coordinate 是「点击像素反投影」（有半像素误差）→
          // 按 pick 的 index 从 arrow 表几何列取精确坐标 → host 坐标属性查询。
          // ⚠️ FixedSizeList.get(i) 返回的是 apache-arrow 的 Vector（iterable），必须 Array.from 展开。
          let p: number[] | undefined
          const v = arrowTable.getChild('__geometry')?.get(deckHit.index)
          if (v != null && typeof (v as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
            const arr = Array.from(v as ArrayLike<number>)
            if (arr.length >= 2 && Number.isFinite(arr[0]) && Number.isFinite(arr[1])) p = [Number(arr[0]), Number(arr[1])]
          }
          const dlon = p?.[0] ?? lng
          const dlat = p?.[1] ?? lat
          closePopup()
          const url = sessionUrl(sessionRef.current, `/webgis/arrow-attr?id=${encodeURIComponent(deckRawId)}&lon=${dlon}&lat=${dlat}`)
          void fetch(url, { cache: 'no-store' })
            .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; name?: string; message?: string; attrs?: Record<string, unknown> }>) : null))
            .then((d) => {
              if (!d?.ok || !d.attrs) {
                if (d?.message) console.warn('[MapView] Arrow 属性未命中', deckRawId, 'index', deckHit.index, '坐标', dlon, dlat, '|', d.message)
                return
              }
              const feature: FeaturePayload = {
                id: null,
                layer: d.name ?? deckRawId,
                source: 'duckdb',
                geometryType: 'Point',
                properties: d.attrs,
              }
              closePopup()
              showFeaturePopup(feature, { lng: dlon, lat: dlat })
              // 与 maplibre 图层一致：deck 命中的点要素也高亮（用 arrow 表里的精确坐标）
              deckRef.current?.setSelection({ type: 'Point', coordinates: [dlon, dlat] })
              recordPick(map, dlon, dlat, [feature], undefined, sessionRef.current)
            })
            .catch((err) => console.warn('[MapView] Arrow 属性查询失败', deckRawId, err))
          return
        }
        // geojson 原始层（materialized 大层 / 多族混合 / 面）：分族子层 id 带 kind 后缀，pickObject 的 index
        // 对齐对应族（rawPolygonData/rawLineData/rawPointData）过滤数组；旧单族层无后缀时按首族兜底。
        const cachedFC = dataCache.current[deckRawId]
        if (cachedFC) {
          const kind = deckRawKind ?? (geojsonKindOf(cachedFC) as 'point' | 'line' | 'polygon')
          const f =
            kind === 'polygon' ? rawPolygonData(cachedFC)[deckHit.index]
            : kind === 'line' ? rawLineData(cachedFC)[deckHit.index]
            : rawPointData(cachedFC)[deckHit.index]
          if (f?.properties) {
            const feature: FeaturePayload = {
              id: null,
              layer: deckRawId,
              source: 'geojson',
              geometryType: f.geometry.type,
              properties: f.properties,
            }
            closePopup()
            showFeaturePopup(feature, { lng, lat })
            // 与 maplibre 图层一致：geojson 原始 deck 层用要素几何高亮（面填充/线描边/点圆点）
            deckRef.current?.setSelection(f.geometry)
            recordPick(map, lng, lat, [feature], undefined, sessionRef.current)
          }
          return
        }
      }
      // 排除聚合圈自身（聚合层已在上面单独处理，这里兜底过滤掉混入的 cluster 要素）。
      // 点中要素：取最上层非聚合要素（连同原始 geometry，供点击高亮）与其 payload 列表。
      let topPayload: FeaturePayload | null = null
      let topGeometry: unknown = null
      const payloads: FeaturePayload[] = []
      for (const f of map.queryRenderedFeatures(e.point).slice(0, 30)) {
        if (f.properties?.cluster_id != null) continue // 排除聚合圈自身（聚合已在上面处理）
        // 排除点击高亮层自身：它被置顶，会抢走 topPayload，而它的 properties 是空的
        // → 表现为「同一要素第二次点选提示无属性字段」。
        if (isSelectionLayerId(f.layer.id)) continue
        const pl: FeaturePayload = {
          id: f.id ?? null,
          layer: f.layer.id,
          source: f.source,
          geometryType: f.geometry?.type ?? null,
          properties: f.properties ?? {},
        }
        payloads.push(pl)
        if (!topPayload) { topPayload = pl; topGeometry = f.geometry ?? null }
      }

      if (topPayload) {
        markerRef.current?.remove()
        markerRef.current = null
        const lightId = topPayload.properties[RENDER_LAYER_KEY]
        const lightRow = topPayload.properties[RENDER_ROW_KEY]
        if (typeof lightId === 'string' && typeof lightRow === 'number') {
          // 轻量渲染层（无属性，面/线）命中：先关旧浮窗/清旧高亮，再高亮当前几何 + 按行取属性弹窗。
          closePopup()
          setMapSelection(map, topGeometry)
          const popup = new maplibregl.Popup({
            closeButton: true,
            closeOnClick: false,
            maxWidth: '340px',
            offset: 12,
          })
          popupRef.current = popup
          const loadingEl = document.createElement('div')
          loadingEl.className = styles.popupRoot!
          loadingEl.textContent = tRef.current('attr.loading')
          popup.setLngLat([lng, lat]).setDOMContent(loadingEl).addTo(map)
          void fetch(
            sessionUrl(sessionRef.current, `/webgis/layer-row?id=${encodeURIComponent(lightId)}&row=${lightRow}`),
            { cache: 'no-store' },
          )
            .then((r) => (r.ok ? (r.json() as Promise<{ ok?: boolean; name?: string; message?: string; attrs?: Record<string, unknown> }>) : null))
            .then((d) => {
              if (!d?.ok || !d.attrs) {
                if (d?.message) console.warn('[MapView] 行号属性未命中', lightId, 'row', lightRow, '|', d.message)
                closePopup() // 属性没取到：关掉 loading 浮窗与高亮
                return
              }
              const reposition = (): void => { popup.setLngLat(popup.getLngLat()) }
              const feat: FeaturePayload = {
                id: null,
                layer: d.name ?? lightId,
                source: 'layer',
                geometryType: topPayload?.geometryType ?? null,
                properties: d.attrs,
              }
              popup.setDOMContent(buildPopupContent(feat, tRef.current, reposition))
              recordPick(map, lng, lat, [feat], undefined, sessionRef.current)
            })
            .catch((err) => {
              console.warn('[MapView] 行号属性查询失败', lightId, err)
              closePopup()
            })
          return
        }
        showFeaturePopup(topPayload, e.lngLat)
        // 普通（未瘦身）图层：同样高亮被点几何——点要素画圆点、线/面画描边（此前只有瘦身层才高亮，
        // 导致「点的点选完全看不出高亮」）。
        setMapSelection(map, topGeometry)
        recordPick(map, lng, lat, payloads, undefined, sessionRef.current)
        return
      }

      // 空点击：落图钉标记关注点，供用户/AI 引用坐标。
      closePopup()
      if (markerRef.current) {
        markerRef.current.setLngLat([lng, lat])
      } else {
        markerRef.current = new maplibregl.Marker({ color: '#ef4444' }).setLngLat([lng, lat]).addTo(map)
      }
      recordPick(map, lng, lat, [], undefined, sessionRef.current)
    })

    // 右键：测距中 = 丢弃本次测量；否则清除图钉/关闭属性浮窗并通知 host 清掉最近一次 pick。
    map.on('contextmenu', (e) => {
      e.originalEvent?.preventDefault()
      if (measure.onContextMenu()) return
      closePopup()
      if (markerRef.current) {
        markerRef.current.remove()
        markerRef.current = null
      }
      clearPick(sessionRef.current)
    })

    // 测量预览：移动光标把「末点→光标」画成虚线并实时刷新待加段长（有顶点才画）。
    // 自动吸附（自己已画顶点）：≥3 点后光标靠近起点/中间顶点即贴过去并高亮，点击可精确闭合或回折。
    map.on('mousemove', (e) => {
      measure.onMouseMove(map, e)
    })
    // 双击收尾（测距中）：保留结果。click 里已对 <300ms 第二记做去抖，不会多加一个点。
    map.on('dblclick', (e) => { measure.onDblClick(e) })
    // 测距键盘：Enter 收尾保留结果，Esc 丢弃并退出测距。
    // 测距键盘：Enter 收尾保留结果，Esc 丢弃并退出测距。
    const onMeasureKey = (e: KeyboardEvent): void => { measure.onKeyDown(e) }
    window.addEventListener('keydown', onMeasureKey)

    const onResize = () => map.resize()
    window.addEventListener('resize', onResize)
    // 容器尺寸变化（地图层 left 被推进到会话列表之后、GIS 布局切换等）时同步地图大小，
    // 保证 canvas/图框中心与可见区域一致。map.resize() 只改 canvas 不改容器，不会死循环。
    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => map.resize())
      resizeObserver.observe(container)
    }
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onMeasureKey)
      resizeObserver?.disconnect()
      if (viewRefreshTimer.id) window.clearTimeout(viewRefreshTimer.id)
      deckRef.current?.dispose()
      deckRef.current = null
      markerRef.current?.remove()
      markerRef.current = null
      popupRef.current?.remove()
      popupRef.current = null
      delete (window as unknown as Record<string, unknown>).__webgisMap
      map.remove()
      mapRef.current = null
    }
  }, [])

  // 轮询状态：数据集 + 导航意图
  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const loadDataset = async (map: MapLibreMap, fit = true): Promise<void> => {
      const res = await fetch(sessionUrl(sessionRef.current, '/webgis/dataset'), { cache: 'no-store' })
      if (!res.ok) throw new Error('dataset fetch failed')
      const geojson = await res.json()
      // 缓存进 dataCache：dataset 切 plane/hex 时走普通点图层路径，若无缓存且 rev 未变会直接 continue 跳过渲染
      dataCache.current.dataset = geojson
      const source = map.getSource('data') as GeoJSONSource | undefined
      if (source) source.setData(geojson)
      if (fit) fitToGeoJSON(map, geojson)
    }


    // 换底图（setStyle）后：样式 load 时把数据图层补挂回来——data-points、叠加服务、结果图层。
    const mountMap = mapRef.current
    if (mountMap) mountMap.on('style.load', () => { void rebuildAfterStyleLoad(mountMap) })
    // ⚠️ 底图切换的 setStyle 已统一带 { diff: false } 强制整样式重建（见 applyBaseMap），会触发 style.load。
    // 兜底：万一有别的路径以 diff 方式换样式（diff 不触发 style.load 且可能丢自定义层/源），
    // styledata 触发时若我们的 data-points 层被清掉且本地还有图层记录，强制重建。
    if (mountMap) mountMap.on('styledata', () => {
      if (mountMap.getLayer('data-points') == null && Object.keys(gisSeen.current).length > 0) {
        void rebuildAfterStyleLoad(mountMap)
      }
    })

    // 图层同步器（从本组件拆出，ref 原样注入；见 layer-sync.ts）。
    const layerSync = createLayerSync({
      gisSeen, dataCache, renderCache, clusterLayerIds, styleRebuildPending, datasetSeen,
      overlaysRef, deckRef, mapRef, sessionRef,
      ensureDeck: ensureDeckForMap,
      restoreMeasure: () => measure.restoreIfActive(),
      loadDataset,
      lastLayersRef,
    })
    const syncLayers = async (map: MapLibreMap, summaries: LayerSummary[], force = false): Promise<void> => {
      await layerSync.syncLayers(map, summaries, force)
    }
    const rebuildAfterStyleLoad = (map: MapLibreMap): Promise<void> => layerSync.rebuildAfterStyleLoad(map)
    const poll = async (): Promise<void> => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(sessionUrl(sessionRef.current, '/webgis/state'), { cache: 'no-store' })
        if (!res.ok) return
        const st = (await res.json()) as StateResponse
        if (cancelled) return
        const map = mapRef.current
        if (!map) return

        // AI 出图请求（webgis_export_map）：见新 seq → 预填出图弹窗并打开（用户确认后导出回传）。
        if (st.exportRequest && st.exportRequest.seq !== lastExportSeq.current) {
          lastExportSeq.current = st.exportRequest.seq
          const p = st.exportRequest.params
          openExport(p
            ? { title: p.title, layerIds: p.layerIds, legend: p.legend, north: p.north, scale: p.scale, note: p.note, extent: p.extent }
            : {})
        }

        // AI 底图要素导出（webgis_export_basemap）：见新 seq → 按当前视窗从矢量瓦片提取并回传。
        // 纯内存读取，无需用户确认，也就没有弹窗。
        if (st.basemapRequest && st.basemapRequest.seq !== lastBasemapSeq.current) {
          lastBasemapSeq.current = st.basemapRequest.seq
          void runBasemapExtract(map, st.basemapRequest)
        }

        stBaseTileUrlRef.current = st.baseTileUrl
        // 状态没变 → 整轮跳过（图层同步/导航/捕获全由状态驱动，相同就没有可做的工作）。
        // 长时间挂机时每 1s 轮询只做一次 JSON 序列化比较，不再触发 syncLayers/重渲染/重复请求处理，
        // 内存与 CPU 几乎零开销；SSE `sync` 消息只在状态真变化时才推，那时 fp 才会变。
        const fp = JSON.stringify({ b: st.baseTileUrl, ds: st.dataset, nav: st.navigate, cap: st.capture, ls: st.layers })
        if (fp === pollFpRef.current) return
        pollFpRef.current = fp
        // 仅默认底图才跟随 host 的 baseTileUrl 换瓦片；用户选了别的底图（Esri 影像/矢量样式）不被顶掉。
        if (baseMapRef.current.id === 'default') {
          const baseSource = map.getSource('base') as RasterTileSource | undefined
          const tiles = baseSource?.tiles ?? []
          if (tiles.length > 0 && tiles[0] !== st.baseTileUrl) {
            baseSource?.setTiles([st.baseTileUrl])
          }
        }

        if (st.dataset && st.dataset.name !== datasetSeen.current) {
          datasetSeen.current = st.dataset.name
          try {
            await loadDataset(map)
          } catch {
            // 数据集加载失败忽略，下一轮重试
          }
        } else if (!st.dataset && datasetSeen.current) {
          // 数据集被移除（layer-action remove）：清空 data-points 的要素，地图不再显示。
          datasetSeen.current = ''
          delete dataCache.current.dataset
          const source = map.getSource('data') as GeoJSONSource | undefined
          if (source) source.setData(EMPTY_COLLECTION)
          // 清理 dataset 平面/蜂窝模式下残留的渲染层/源
          for (const suffix of ALL_RENDER_SUFFIXES) {
            const r = RID('dataset', suffix)
            if (map.getLayer(r)) map.removeLayer(r)
          }
          if (map.getSource(SRC('dataset'))) map.removeSource(SRC('dataset'))
          if (map.getSource(SRC_HEX('dataset'))) map.removeSource(SRC_HEX('dataset'))
          deckRef.current?.removeOut('dataset')
        }

        // 结果图层注册表同步（dataset 层由 data-points 处理；此处只渲染 result_* 层）
        // ⚠️ 底图样式整体替换兜底：setStyle 对已存在样式走 maplibre diff（不触发 style.load，也不一定触发 styledata），
        // 我们的自定义层/源会被清掉。只要「本地还有图层记录但 data-points 层已消失」即强制重建（每 1s poll 检查）。
        // 线/面数据集走 gis-dataset-* 层（非 data-points）——diff 后 data-points 可能仍在但 gis-dataset-line/fill 已丢，
        // 单独判缺失强制重建（deck 渲染走 raw 层不在此列，由 controller.syncLayers 恢复）。
        const dsSummary = (st.layers ?? []).find((l) => l.id === 'dataset')
        const dsKinds = dsSummary ? renderKinds(dsSummary.geometryTypes ?? []).filter((k) => k !== 'circle') : []
        const dsMissing = !!dsSummary && dsKinds.length > 0
          && dsSummary.renderer !== 'deck'
          && dsKinds.some((k) => !map.getLayer(RID('dataset', k)))
        if ((Object.keys(gisSeen.current).length > 0 && !map.getLayer('data-points')) || dsMissing) {
          await rebuildAfterStyleLoad(map)
        }
        if (st.layers) {
          await syncLayers(map, st.layers)
          lastLayersRef.current = st.layers
          setLayers(st.layers)
        }

        // 叠加地图服务轮询（~3s 节流）：变化时同步光栅叠加层。
        if (!lastServicesFetch.current || Date.now() - lastServicesFetch.current > 3000) {
          lastServicesFetch.current = Date.now()
          fetch(sessionUrl(sessionRef.current, '/webgis/services'), { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((data: { services?: OverlayService[] } | null) => {
              if (!data?.services) return
              overlaysRef.current = data.services
              syncOverlays(map, data.services)
            })
            .catch(() => {})
        }

        // 蜂窝热力图需俯视才见柱高：有可见蜂窝层 → 自动俯仰 60°；全关后恢复平视。
        // 用 map.isMoving() 守卫，不打断 navigate / fitBounds 等飞行。
        const anyHexVisible = st.layers.some(
          (l) => l.visible && (l.mode ?? 'points') === 'hex' && l.geometryTypes.some((t) => t.includes('Point')),
        )
        if (!map.isMoving()) {
          const pitch = map.getPitch()
          if (anyHexVisible && pitch !== 60) map.setPitch(60, { duration: 500 })
          else if (!anyHexVisible && pitch !== 0) map.setPitch(0, { duration: 500 })
        }

        if (st.navigate && st.navigate.id !== lastNavigateId.current) {
          lastNavigateId.current = st.navigate.id
          const zoom = st.navigate.zoom ?? Math.max(map.getZoom(), 5)
          map.flyTo({ center: [st.navigate.lng, st.navigate.lat], zoom, duration: 1200 })
        }

        // host 请求「捕获当前视图」（用户没点击、直接问"这里是什么地方/图上有什么"）：截当前地图，
        // 提取中心要素 + 关联 captureSeq 上报，供等待中的 webgis_get_pick 消费。
        // ⚠️ 这里**不落图钉、不画红点**：本次没有"用户指定的位置"，红点只会让模型把画面中心
        // 当成关注点（实测它还会去比对两个来源不同的红点、量形状和质心，纯属干扰）。
        // 红点只属于一种情形：用户手动点击底图。
        if (st.capture && st.capture.seq !== lastCaptureSeq.current) {
          lastCaptureSeq.current = st.capture.seq
          // 若上一条 navigate 的飞行还没落定，先等地图 idle，避免截到飞行中间帧（中心坐标偏）。
          if (map.isMoving()) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 3000)
              map.once('idle', () => { clearTimeout(timer); resolve() })
            })
          }
          const center = map.getCenter()
          const lng = center.lng
          const lat = center.lat
          closePopup()
          // 清掉上一次点击留下的图钉：本次捕获没有关注点，留着会让屏幕上的红点与
          // 上报的坐标（画面中心）对不上。
          markerRef.current?.remove()
          markerRef.current = null
          const features = queryFeatures(map, map.project(center))
          recordPick(map, lng, lat, features, st.capture.seq, sessionRef.current, false)
        }
      } catch {
        // 网络/解析错误忽略，下一轮重试
      } finally {
        inFlight = false
      }
    }

    // SSE 状态推送订阅：host 写状态 → 即时触发一轮 poll（交互秒达，主通道）。
    // 1s 心跳轮询只作掉线/SSE 不可用/配置项(baseTileUrl)变更的兜底（EventSource 断线自动重连；
    // 指纹短路让空转心跳几乎零成本）。切回前台立即补一轮，避免隐藏期被浏览器节流的更新滞后。
    let eventSource: EventSource | null = null
    if (typeof EventSource !== 'undefined') {
      try {
        eventSource = new EventSource(sessionUrl(sessionRef.current, '/webgis/events'))
        eventSource.addEventListener('message', () => { void poll() })
      } catch {
        eventSource = null
      }
    }
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisible)
    const timer = setInterval(poll, 1000)
    poll()
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      eventSource?.close()
    }
  }, [])

  return (
    <div className={styles.mapView}>
      <div ref={containerRef} className={styles.mapViewCanvas} />
      <div className={styles.mapBottomLeft}>
        <button
          type="button"
          className={`${styles.measureBtn}${measure.measuring ? ` ${styles.measureBtnActive}` : ''}`}
          title={t('measure.titleHint')}
          onClick={measure.toggle}
        >
          {t('measure.title')}
        </button>
        <BasemapSwitcher
          baseMap={baseMap}
          onSwitch={async (def) => {
            setBaseMap(def)
            const map = mapRef.current
            if (map) await applyBaseMap(map, def, [stBaseTileUrlRef.current])
          }}
          t={t}
        />
      </div>
      {(measure.measuring || measure.measureDone) && (
        <div className={styles.measureReadout} role="status">
          {measure.measuring && (
            <div className={styles.measureHint}>
              {measure.vertexCount() === 0 ? t('measure.hintStart') : t('measure.hintEnd')}
            </div>
          )}
          {measure.measureClosed && measure.vertexCount() >= 3 ? (
            // 闭合为面：给周长 + 面积
            <>
              <div className={styles.measureSegRow}>
                {t('measure.perimeter')} <b className={styles.measureAmber}>{measure.perimeterText()}</b>
              </div>
              <div className={styles.measureTotal}>
                {t('measure.area')} <b>{measure.areaText()}</b>
              </div>
            </>
          ) : (
            // 开环折线：逐段 + 累计长度（测量中带实时预览段）
            <>
              {measure.measureSegs.length > 0 && (
                <div className={styles.measureSegs}>
                  {measure.measureSegs.map((m, i) => (
                    <div key={i} className={styles.measureSegRow}>
                      {t('measure.seg', { n: i + 1 })} {formatDistance(m)}
                    </div>
                  ))}
                </div>
              )}
              {measure.lengthText() !== '' && (
                <div className={styles.measureTotal}>
                  {t('measure.total')} <b>{measure.lengthText()}</b>
                  <span ref={measure.previewEl} className={styles.measurePreview} />
                </div>
              )}
            </>
          )}
        </div>
      )}
      {viewInfo && (
        <div className={styles.mapViewportInfo} title={t('mapinfo.title')}>
          <span className={styles.mapInfoItem}>
            {t('mapinfo.zoom')} <b>{viewInfo.zoom.toFixed(1)}</b>
          </span>
          <span className={styles.mapInfoItem}>
            {t('mapinfo.lng')} {fmtCoord(viewInfo.w, viewInfo.zoom)} ~ {fmtCoord(viewInfo.e, viewInfo.zoom)}
          </span>
          <span className={styles.mapInfoItem}>
            {t('mapinfo.lat')} {fmtCoord(viewInfo.s, viewInfo.zoom)} ~ {fmtCoord(viewInfo.n, viewInfo.zoom)}
          </span>
        </div>
      )}
      <LayerPanel
        layers={layers}
        sessionId={sessionId}
        t={t}
        onShowAttributes={setAttrLayer}
        mapRef={mapRef}
        onDrawingActive={(active) => { drawingActiveRef.current = active }}
        onExportMap={() => openExport(null)}
      />
      {attrLayer && <AttributeDrawer layer={attrLayer} sessionId={sessionId} t={t} onClose={() => setAttrLayer(null)} />}
      {ExportDialogComp && (
        <ExportDialogComp
          open={exportOpen}
          onClose={() => closeExport()}
          layers={layers}
          mapRef={mapRef}
          t={t}
          prefill={exportPrefill}
          onExported={(dataUrl, width, height, title) => void postExportImage(dataUrl, width, height, title)}
        />
      )}
    </div>
  )
}
