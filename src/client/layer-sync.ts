/**
 * 图层注册表 → maplibre/deck 渲染同步（自 MapView.tsx 拆分）：
 * 移除已消失的图层、按 rev/形态变更拉数据并建 source+layer、纯可见性切换不重拉；
 * 以及切底图/样式重建后的整轮重建（rebuildAfterStyleLoad）。
 *
 * 组件级绑定全部经 {@link LayerSyncHost} 注入（ref 对象原样传入，语义与拆分前一致）。
 */
import { useEffect, useRef, useState, type ComponentType } from 'react'
import maplibregl from 'maplibre-gl'
import type { MutableRefObject } from 'react'
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
import { EMPTY_COLLECTION, baseStyle, fmtCoord, ensureDataLayers, ensureMeasureLayers, syncOverlays } from './map-style.js'
import { useMapMeasure } from './use-map-measure.js'
import { SEL_SRC, ensureSelLayers, clearMapSelection, setMapSelection } from './map-highlight.js'
import { isScalar, scalarRows, featureTitle, fmtCell, makeAttrTable, buildPopupContent } from './map-popup.js'
import { queryFeatures, collectCoords, captureMapScreenshot, drawPin, fitToGeoJSON, clearPick, recordPick } from './map-pick.js'
import type { ScreenshotPayload } from './map-pick.js'
import { renderKinds, makeRenderLayer, darkenHex, maxDensityOf, hexHeightFor, makeHeatLayer, makeHexLayer, CLUSTER_BASE_RADIUS, shadeColor, clusterColorFor, clusterRadius, makeClusterLayer, makeClusterCountLayer, LAYER_KINDS, ALL_RENDER_SUFFIXES, RENDER_ROW_KEY, RENDER_LAYER_KEY, DECK_MODES, SRC, RID, SRC_HEX, layerShapeKey } from './map-render-spec.js'
import type { RenderKind, RenderStyle } from './map-render-spec.js'

/** 同步器所需的组件绑定（均为 MapView 里的 ref/回调，保持引用稳定）。 */
export interface LayerSyncHost {
  gisSeen: MutableRefObject<Record<string, { rev: number; visible: boolean; mode: DisplayMode; color?: string; params?: string; style?: string; shape?: string }>>
  dataCache: MutableRefObject<Record<string, FeatureCollection>>
  renderCache: MutableRefObject<Record<string, FeatureCollection>>
  clusterLayerIds: MutableRefObject<Set<string>>
  styleRebuildPending: MutableRefObject<boolean>
  datasetSeen: MutableRefObject<string>
  overlaysRef: MutableRefObject<OverlayService[]>
  deckRef: MutableRefObject<DeckController | null>
  mapRef: MutableRefObject<MapLibreMap | null>
  sessionRef: MutableRefObject<string | undefined>
  /** 懒建 deck controller（首个 deck 图层出现时）。 */
  ensureDeck: (map: MapLibreMap) => Promise<DeckController | null>
  /** 样式重建后还原测量几何（useMapMeasure.restoreIfActive）。 */
  restoreMeasure: () => void
  /** 数据集重载（底图/样式重建后补挂 data 源）。 */
  loadDataset: (map: MapLibreMap, fit?: boolean) => Promise<void>
  /** 最近一轮图层摘要（重建时整轮 force 同步用）。 */
  lastLayersRef: MutableRefObject<LayerSummary[]>
}

export interface LayerSync {
  syncLayers: (map: MapLibreMap, summaries: LayerSummary[], force?: boolean) => Promise<void>
  rebuildAfterStyleLoad: (map: MapLibreMap) => Promise<void>
}

export function createLayerSync(host: LayerSyncHost): LayerSync {
  const {
    gisSeen, dataCache, renderCache, clusterLayerIds, styleRebuildPending, datasetSeen,
    overlaysRef, deckRef, mapRef, sessionRef, ensureDeck, restoreMeasure, loadDataset, lastLayersRef,
  } = host

      // 同步图层注册表：移除消失的层、按 rev 变更拉全量并 addSource/addLayer、
      // 纯可见性切换走 setLayoutProperty（不重拉数据）。dataset 层由现有 data-points 处理。
      const syncLayers = async (map: MapLibreMap, summaries: LayerSummary[], force = false): Promise<void> => {
        const seen = gisSeen.current
        const current = new Set(summaries.map((s) => s.id))
        try {
          // 1) 移除已从注册表消失的层（含聚合层 / 热力层 / 蜂窝层 / deck 出图层）
          for (const id of Object.keys(seen)) {
            if (id === 'dataset' || current.has(id)) continue
            for (const suffix of ALL_RENDER_SUFFIXES) {
              const r = RID(id, suffix)
              if (map.getLayer(r)) map.removeLayer(r)
            }
            if (map.getSource(SRC(id))) map.removeSource(SRC(id))
            if (map.getSource(SRC_HEX(id))) map.removeSource(SRC_HEX(id))
            clusterLayerIds.current.delete(RID(id, 'cluster'))
            deckRef.current?.removeOut(id)
            delete dataCache.current[id]
            delete renderCache.current[id]
            delete seen[id]
          }
          // 2) upsert / 变更 / 可见性
          // ⚠️ 每个图层独立 try/catch：切底图（setStyle）后重建期间某个图层失败不应中断其余图层
          // （此前整体 try/catch 会因一个图层异常静默吞掉整轮，导致 OpenFreeMap 等矢量样式切完后图层全部消失）。
          for (const s of summaries) {
            try {
            const prev = seen[s.id]
            // 内容形态签名：rev 之外还要能感知「同 id 换了数据集/几何/渲染形态」，否则替换 dataset 时常漏变更。
            const shape = layerShapeKey(s)
            if (s.id === 'dataset') {
              // 数据集展示方式：points 且点数据集走 data-points 圆点；线/面数据集不走 data-points——
              // maplibre circle 层会给 LineString/Polygon 的每个顶点画圆（表现为散点），必须按几何渲染。
              // 注意：切底图 setStyle 后 data-points 层可能尚未重建，所有 setLayout/setPaint 调用先判存在，避免抛错中断整轮。
              const dmode: DisplayMode = s.mode ?? 'points'
              const dstyle = JSON.stringify({ r: s.pointRadius, sw: s.pointStrokeWidth, fc: s.fillColor })
              const isPointData = (s.geometryTypes ?? []).length > 0
                && (s.geometryTypes ?? []).every((t) => t === 'Point' || t === 'MultiPoint')
              // data-points 圆点只服务「maplibre 渲染的点数据集」；renderer=deck（>10 万，走 arrow 大数据）的点/线/面
              // 数据集 → 落到下方普通路径走 raw deck / /webgis/arrow（避免 data-points 只画抽样 + 无法分级）。
              if (dmode === 'points' && isPointData && s.renderer !== 'deck') {
                if (map.getLayer('data-points')) {
                  // 恒按 visible 设可见性：从线/面数据集切回点数据集时要恢复显示（此前可能被隐藏）
                  map.setLayoutProperty('data-points', 'visibility', s.visible ? 'visible' : 'none')
                  // 数据集点样式跟随图层（颜色 + 点位大小 + 描边），此前 data-points 写死蓝色、半径 5
                  if (prev?.color !== s.color || prev?.style !== dstyle) {
                    map.setPaintProperty('data-points', 'circle-color', s.fillColor ?? s.color)
                    map.setPaintProperty('data-points', 'circle-radius', s.pointRadius ?? 2)
                    map.setPaintProperty('data-points', 'circle-stroke-width', s.pointStrokeWidth ?? 1)
                    map.setPaintProperty('data-points', 'circle-stroke-color', s.color)
                  }
                }
                // 清理 plane/hex/deck 模式残留的渲染层（gis-dataset-heat / gis-dataset-hex / deck）
                for (const suffix of ALL_RENDER_SUFFIXES) {
                  const r = RID('dataset', suffix)
                  if (map.getLayer(r)) map.removeLayer(r)
                }
                if (map.getSource(SRC('dataset'))) map.removeSource(SRC('dataset'))
                if (map.getSource(SRC_HEX('dataset'))) map.removeSource(SRC_HEX('dataset'))
                deckRef.current?.removeOut('dataset')
                seen[s.id] = { rev: s.rev, visible: s.visible, mode: s.mode, color: s.color, style: dstyle, shape }
                continue
              }
              // 线/面数据集 或 plane/hex：隐藏 data-points（避免线/面顶点被画成圆点），
              // 渲染交给下方普通路径按几何/模式处理（线 → gis-dataset-line、面 → gis-dataset-fill、plane/hex 热力照常）。
              if (map.getLayer('data-points')) {
                map.setLayoutProperty('data-points', 'visibility', 'none')
                if (prev?.color !== s.color || prev?.style !== dstyle) {
                  map.setPaintProperty('data-points', 'circle-color', s.fillColor ?? s.color)
                  map.setPaintProperty('data-points', 'circle-radius', s.pointRadius ?? 2)
                  map.setPaintProperty('data-points', 'circle-stroke-width', s.pointStrokeWidth ?? 1)
                  map.setPaintProperty('data-points', 'circle-stroke-color', s.color)
                }
              }
            }
            const kinds = renderKinds(s.geometryTypes)
            const isPointLayer = kinds.includes('circle')
            // 展示方式：非点图层也可走 deck 出图（弧线/轨迹需线、围墙需面）；plane/hex 仍仅点图层有意义。
            const mode: DisplayMode = (s.mode && (DECK_MODES.has(s.mode) || isPointLayer)) ? s.mode : 'points'
            const isDeckMode = DECK_MODES.has(mode)
            // 仅点要素、且为原始点模式时走 supercluster 聚合。
            const clustered = isPointLayer && s.cluster && mode === 'points'
            // force（换底图/样式重建）：全部当作数据+模式变更重建，但跳过镜头 fit
            const dataChanged = force || !prev || prev.rev !== s.rev || (prev.shape !== undefined && prev.shape !== shape)
            const modeChanged = force || (!!prev && prev.mode !== s.mode)
            const paramsChanged = force || (!!prev && prev.params !== (s.modeParams ? JSON.stringify(s.modeParams) : ''))
            const colorChanged = force || (!!prev && prev.color !== s.color)
            // 样式（点位大小/描边/填充色）变更也要触发重建
            const styleKey = JSON.stringify({ r: s.pointRadius, sw: s.pointStrokeWidth, fc: s.fillColor })
            const styleChanged = force || (!!prev && prev.style !== styleKey)
            const style: RenderStyle = { color: s.color, pointRadius: s.pointRadius, pointStrokeWidth: s.pointStrokeWidth, fillColor: s.fillColor }
            // >10 万点图层走「deck 原始数据」路径（host renderer=deck；mode 为原始点时适用，plane/hex 仍走 maplibre）。
            const isRawDeck = s.renderer === 'deck' && mode === 'points'
            // deck 懒加载：首个「需 deck 渲染」的图层（deck 出图 / raw 原始数据路径）出现时才拉 deck.js 建 controller。
            // 放单图层 try 内：加载失败只跳本图层、不中断其余图层；记 seen 防每轮 poll 反复尝试，下轮由图层状态变更驱动重试。
            if ((isDeckMode || isRawDeck) && !deckRef.current) {
              const d = await ensureDeck(map)
              if (!d) {
                seen[s.id] = prev ?? {
                  rev: s.rev,
                  visible: s.visible,
                  mode: s.mode,
                  color: s.color,
                  params: s.modeParams ? JSON.stringify(s.modeParams) : '',
                  style: styleKey,
                  shape,
                }
                continue
              }
            }
            if (dataChanged || modeChanged || paramsChanged || colorChanged || styleChanged) {
              // 取数策略（数据优先取客户端缓存；首次出现才拉）：
              //  - arrow 原始数据路径：不拉 geojson，直接走 /webgis/arrow 二进制（geojson 仅作失败兜底）。
              //  - maplibre 直接渲染（点/聚合/线/面；非热力非蜂窝）：只画几何 → 拉「渲染轻量」/webgis/layer-render
              //    （几何+__i/__layer，无属性）进 renderCache——属性极重的大图层不再整层拖到浏览器；
              //  - 其余（deck 出图 / raw geojson / plane 热力 / hex 蜂窝：渲染要读属性如 density）→ 仍拉 /webgis/gis-result 全量进 dataCache。
              let geojson: FeatureCollection | null = null
              const useArrow = isRawDeck && s.dataFormat === 'arrow'
              // 面/线图层（无点）直接渲染只画几何 → 走「渲染轻量」；点/热力/蜂窝/deck/raw 仍全量（弹窗/截图要属性）。
              const useRenderLight = !useArrow && !isDeckMode && !isRawDeck && mode !== 'plane' && mode !== 'hex'
                && !kinds.includes('circle') && (kinds.includes('fill') || kinds.includes('line'))
              if (useArrow) {
                // arrow：无需在此拉 geojson（失败兜底由 controller.upsertRaw 自行处理）
              } else if (useRenderLight) {
                const rfc = renderCache.current[s.id]
                if (rfc) {
                  geojson = rfc
                } else {
                  if (!dataChanged) {
                    // 展示方式/样式变了但还没渲染数据（理论不发生）→ 等下一轮再拉
                    continue
                  }
                  const res = await fetch(sessionUrl(sessionRef.current, `/webgis/layer-render?id=${encodeURIComponent(s.id)}`), { cache: 'no-store' })
                  if (!res.ok) continue
                  geojson = await res.json() as FeatureCollection
                  renderCache.current[s.id] = geojson
                }
              } else {
                const cached = dataCache.current[s.id]
                if (cached) {
                  geojson = cached
                } else {
                  if (!dataChanged) {
                    // mode 变了但还没缓存过数据（理论上不会发生）→ 等下一轮再拉
                    continue
                  }
                  const res = await fetch(sessionUrl(sessionRef.current, `/webgis/gis-result?id=${encodeURIComponent(s.id)}`), { cache: 'no-store' })
                  if (!res.ok) continue
                  geojson = await res.json()
                  dataCache.current[s.id] = geojson as FeatureCollection
                }
              }
              // 结构/选项变更（含 cluster 开关 / 展示方式 / 出图参数）→ 整组重建（maplibre 层或 deck 出图层）
              if (isDeckMode) {
                // deck 出图：切形态前清掉同 id 的 raw（arrow/geojson）状态，防止 syncRawTiers 把 raw 层画回 deck 出图之上
                deckRef.current?.clearRaw(s.id)
                // deck 出图：清掉 maplibre 残留层后注册进 deck 注册表
                for (const suffix of ALL_RENDER_SUFFIXES) {
                  const r = RID(s.id, suffix)
                  if (map.getLayer(r)) map.removeLayer(r)
                }
                if (map.getSource(SRC(s.id))) map.removeSource(SRC(s.id))
                if (map.getSource(SRC_HEX(s.id))) map.removeSource(SRC_HEX(s.id))
                clusterLayerIds.current.delete(RID(s.id, 'cluster'))
                deckRef.current?.upsertOut({
                  id: s.id,
                  mode: mode as DeckChartMode,
                  geojson: geojson as FeatureCollection,
                  bbox: s.bbox,
                  color: s.fillColor ?? s.color,
                  visible: s.visible,
                  params: s.modeParams,
                })
              } else if (isRawDeck) {
                // deck 原始数据路径：清掉 maplibre 残留层后注册进 raw deck（Arrow 或 geojson 原始点）。
                // 非数据变更（颜色/样式）用缓存重建，避免重新拉 Arrow；数据变更/首次才拉。
                // ⚠️ 不调 removeOut（controller 里会清掉 raw 表缓存，导致 rebuildRaw 拿不到表）。
                // 切形态前清掉同 id 的 deck 出图注册表（trips 动画等不会把旧形态画回去）。
                deckRef.current?.clearOut(s.id)
                for (const suffix of ALL_RENDER_SUFFIXES) {
                  const r = RID(s.id, suffix)
                  if (map.getLayer(r)) map.removeLayer(r)
                }
                if (map.getSource(SRC(s.id))) map.removeSource(SRC(s.id))
                if (map.getSource(SRC_HEX(s.id))) map.removeSource(SRC_HEX(s.id))
                clusterLayerIds.current.delete(RID(s.id, 'cluster'))
                // 仅当该 id 已有 raw 注册表且本轮只是样式/可见性变化时才用缓存重建；
                // 否则一律 upsert（新增/换数据时旧形态没有 raw 表，rebuild 会空转 → 新层不显示）。
                if (deckRef.current?.hasRaw(s.id) && !dataChanged) {
                  deckRef.current.rebuildRaw(s)
                } else {
                  await deckRef.current?.upsertRaw(s, geojson)
                }
              } else {
                // maplibre 渲染：清掉 deck 出图层残留后重建 source + layers
                if (!geojson) continue // 非 Arrow 路径下 geojson 必然已取到（上面 useArrow=false 分支）
                deckRef.current?.removeOut(s.id)
                for (const suffix of ALL_RENDER_SUFFIXES) {
                  const r = RID(s.id, suffix)
                  if (map.getLayer(r)) map.removeLayer(r)
                }
                if (map.getSource(SRC(s.id))) map.removeSource(SRC(s.id))
                if (map.getSource(SRC_HEX(s.id))) map.removeSource(SRC_HEX(s.id))
                clusterLayerIds.current.delete(RID(s.id, 'cluster'))
                if (mode === 'points') {
                  if (clustered) {
                    map.addSource(SRC(s.id), { type: 'geojson', data: geojson, cluster: true, clusterRadius: 50, clusterMaxZoom: 16 })
                    map.addLayer(makeClusterLayer(RID(s.id, 'cluster'), SRC(s.id), s.color))
                    map.addLayer(makeClusterCountLayer(RID(s.id, 'cluster-count'), SRC(s.id)))
                    clusterLayerIds.current.add(RID(s.id, 'cluster'))
                    map.addLayer(makeRenderLayer(RID(s.id, 'circle'), SRC(s.id), 'circle', style, ['!', ['has', 'point_count']]))
                  } else {
                    map.addSource(SRC(s.id), { type: 'geojson', data: geojson })
                    for (const kind of kinds) {
                      map.addLayer(makeRenderLayer(RID(s.id, kind), SRC(s.id), kind, style))
                    }
                    // 面图层默认叠加外轮廓：fill 内边线与填充同色时边界会看不见，压暗描边让每个图斑可辨。
                    if (kinds.includes('fill')) {
                      map.addLayer({
                        id: RID(s.id, 'outline'), type: 'line', source: SRC(s.id),
                        paint: {
                          'line-color': darkenHex(style.fillColor ?? style.color, 0.55),
                          'line-width': s.pointStrokeWidth ?? 1,
                        },
                      })
                    }
                  }
                } else if (mode === 'plane') {
                  // 平面热力图：maplibre 原生 heatmap 层（GPU 平滑热色，缩放零重算、流畅）
                  map.addSource(SRC(s.id), { type: 'geojson', data: geojson })
                  map.addLayer(makeHeatLayer(RID(s.id, 'heat'), SRC(s.id), maxDensityOf(geojson)))
                  // 立即套用可见性：新层默认可见，若图层处于隐藏态需同步（后续可见性块可能不触发）
                  map.setLayoutProperty(RID(s.id, 'heat'), 'visibility', s.visible ? 'visible' : 'none')
                } else {
                  // 蜂窝热力图：客户端把点归并成六边形（hexbinFC），fill-extrusion 柱渲染
                  const hex = hexbinFC(geojson)
                  map.addSource(SRC_HEX(s.id), { type: 'geojson', data: hex })
                  map.addLayer(makeHexLayer(RID(s.id, 'hex'), SRC_HEX(s.id), maxDensityOf(hex), hexHeightFor(s.bbox)))
                  map.setLayoutProperty(RID(s.id, 'hex'), 'visibility', s.visible ? 'visible' : 'none')
                }
              }
              if (!prev && !force) {
                // 首次出现 fit 到图层范围：Arrow 图层没有 geojson，用摘要 bbox。
                if (geojson) await fitToGeoJSON(map, geojson)
                else if (s.bbox) map.fitBounds(s.bbox, { padding: 60, maxZoom: 16 })
              }
            }
            if (isDeckMode) {
              // deck 出图可见性：更新注册表里的 spec 可见性（deck 层 visible 由图层实例控制）；
              // spec 从当前摘要 + dataCache 重建（与上次 upsert 内容等价，只有变化才重建）。
              const ex = deckRef.current?.outVisibleOf(s.id)
              if (ex !== undefined && ex !== s.visible) {
                deckRef.current?.upsertOut({
                  id: s.id,
                  mode: mode as DeckChartMode,
                  geojson: dataCache.current[s.id] as FeatureCollection,
                  bbox: s.bbox,
                  color: s.fillColor ?? s.color,
                  visible: s.visible,
                  params: s.modeParams,
                })
              }
            } else if (isRawDeck) {
              // deck 原始数据路径可见性：更新 raw spec + 用缓存数据重建
              const rv = deckRef.current?.rawVisibleOf(s.id)
              if (rv !== undefined && rv !== s.visible) {
                deckRef.current?.rebuildRaw(s)
              }
            } else {
              const renderIds = mode === 'points'
                ? (clustered ? [RID(s.id, 'cluster'), RID(s.id, 'cluster-count'), RID(s.id, 'circle')] : kinds.map((k) => RID(s.id, k)))
                : mode === 'plane'
                  ? [RID(s.id, 'heat')]
                  : [RID(s.id, 'hex')]
              if (!prev || prev.visible !== s.visible) {
                for (const r of renderIds) {
                  if (map.getLayer(r)) map.setLayoutProperty(r, 'visibility', s.visible ? 'visible' : 'none')
                }
              }
            }
            seen[s.id] = { rev: s.rev, visible: s.visible, mode: s.mode, color: s.color, params: s.modeParams ? JSON.stringify(s.modeParams) : '', style: styleKey, shape }
            } catch (err) {
              // 单图层失败不中断其余图层；记录错误便于排查（本轮跳过，下轮 poll 会重试）。
              console.warn('[MapView] syncLayers 图层处理失败，跳过', s.id, err)
            }
          }
        } catch (err) {
          // 样式未就绪 / 网络抖动：本轮跳过，下一轮重试
          console.warn('[MapView] syncLayers 整轮失败', err)
        }
      }

      // 复用 dataCache 不重拉数据、跳过 fit 不跳镜头。styleRebuildPending 去重。
      const rebuildAfterStyleLoad = async (map: MapLibreMap): Promise<void> => {
        if (styleRebuildPending.current) return
        styleRebuildPending.current = true
        try {
          ensureDataLayers(map)
          // 测距源/层常驻：切底图整重建后补齐；有已提交顶点/进行中则还原几何与预览。
          ensureMeasureLayers(map)
          restoreMeasure()
          gisSeen.current = {}
          clusterLayerIds.current = new Set()
          syncOverlays(map, overlaysRef.current)
          if (datasetSeen.current) {
            try { await loadDataset(map, false) } catch { /* 数据集加载失败忽略，下一轮 poll 补齐 */ }
          }
          await syncLayers(map, lastLayersRef.current, true)
          // setStyle 后 deck 出图需重新注入（deck 在 styledata 自动重注入，但注册表里的图层要主动推回，
          // 防止矢量底图切换后弧线/轨迹/围墙/辐射等 deck 出图丢失）。
          deckRef.current?.syncLayers()
        } catch (err) {
          // 样式未就绪等：忽略，下一轮 poll 补齐
          console.warn('[MapView] rebuildAfterStyleLoad 失败', err)
        } finally {
          styleRebuildPending.current = false
        }
      }

  return { syncLayers, rebuildAfterStyleLoad }
}
