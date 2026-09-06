import { useCallback, useEffect, useRef, useState } from 'react'
import type { Map as MapLibreMap } from 'maplibre-gl'
import styles from './webgis.module.css'
import { legendItemsFromLayers, exportFilename } from './export-layout.js'
import { captureMapRaster, composeExportImage, canvasToDataUrl, waitMapIdle, type ExportComposeOpts } from './map-export.js'
import type { WebgisT } from './webgis-i18n.js'

/** 出图弹窗输入图层摘要（结构兼容 MapView LayerSummary 所需字段）。 */
interface ExportLayerSummary {
  id: string
  name: string
  color?: string
  fillColor?: string
  geometryTypes?: string[]
  visible?: boolean
  materialized?: boolean
  featureCount?: number
  totalCount?: number
  bbox?: [number, number, number, number] | null
}

type SizeMode = 'window' | '1920' | '4k'

/** host 出图请求预填（webgis_export_map 参数；结构兼容 session ExportRequestParams）。 */
export interface ExportPrefill {
  title?: string
  layerIds?: string[]
  legend?: boolean
  north?: boolean
  scale?: boolean
  note?: string
  extent?: 'view' | 'all'
}

function metersPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
}

function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  const a = document.createElement('a')
  canvas.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  }, 'image/png')
}

/**
 * 出图弹窗：选择标题/图层/图例/指北针/比例尺/注记/范围/尺寸/2×，预览与导出 PNG。
 * 导出会临时 fit 到「全部可见图层」范围（若选 all）并恢复相机。
 */
export function ExportMapDialog(props: {
  open: boolean
  onClose: () => void
  layers: ExportLayerSummary[]
  mapRef: { current: MapLibreMap | null }
  t: WebgisT
  /** 导出并给 AI 看时回调（dataUrl PNG + 尺寸 + 标题）。 */
  onExportToAi?: (dataUrl: string, width: number, height: number, title: string) => void
  /** host 出图请求预填（webgis_export_map）。 */
  prefill?: ExportPrefill | null
}): JSX.Element | null {
  const { t } = props
  const [title, setTitle] = useState('')
  const visibleIds = useRef<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showLegend, setShowLegend] = useState(true)
  const [showNorth, setShowNorth] = useState(true)
  const [showScale, setShowScale] = useState(true)
  const [note, setNote] = useState(() => t('export.attribution'))
  /** 版权注记是否为「未显式提供」状态：默认值跟随语言切换，AI 显式 note 不覆盖。 */
  const notePristineRef = useRef(true)
  const [extent, setExtent] = useState<'view' | 'all'>('view')
  const [sizeMode, setSizeMode] = useState<SizeMode>('window')
  const [scale2, setScale2] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const previewRef = useRef<HTMLCanvasElement | null>(null)

  // 语言切换：版权注记仍是默认值时跟着换语言（显式 note 由 AI 提供，不覆盖）。
  useEffect(() => {
    if (notePristineRef.current) setNote(t('export.attribution'))
  }, [t])

  // 打开时默认全选可见图层；有 host 预填（AI 工具参数）则按预填初始化
  useEffect(() => {
    if (!props.open) return
    const ids = props.layers.filter((l) => l.visible !== false).map((l) => l.id)
    visibleIds.current = ids
    const p = props.prefill
    const chosen = p?.layerIds && p.layerIds.length ? ids.filter((id) => p.layerIds!.includes(id)) : ids
    setSelected(new Set(chosen))
    setErr('')
    setTitle(p?.title ?? '')
    setShowLegend(p?.legend ?? true)
    setShowNorth(p?.north ?? true)
    setShowScale(p?.scale ?? true)
    const hasNote = p?.note != null && p.note.trim() !== ''
    notePristineRef.current = !hasNote
    setNote(hasNote ? p.note! : t('export.attribution'))
    setExtent(p?.extent ?? 'view')
  }, [props.open, props.layers, props.prefill, t])

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const items = legendItemsFromLayers(props.layers, { ids: [...selected], t })

  /** 若选 all：把相机临时 fit 到选中层并集 bbox；返回恢复函数。 */
  const prepareExtent = async (map: MapLibreMap): Promise<() => void> => {
    if (extent !== 'all') return () => {}
    const chosen = props.layers.filter((l) => selected.has(l.id) && l.bbox)
    const west = Math.min(...chosen.map((l) => l.bbox![0]))
    const south = Math.min(...chosen.map((l) => l.bbox![1]))
    const east = Math.max(...chosen.map((l) => l.bbox![2]))
    const north = Math.max(...chosen.map((l) => l.bbox![3]))
    const cam = map.getCenter()
    const zoom0 = map.getZoom()
    const bearing0 = map.getBearing()
    const pitch0 = map.getPitch()
    const restore = (): void => {
      map.jumpTo({ center: [cam.lng, cam.lat], zoom: zoom0, bearing: bearing0, pitch: pitch0 })
    }
    if (chosen.length === 0 || !Number.isFinite(west) || west >= east || south >= north) return restore
    map.fitBounds([[west, south], [east, north]], { padding: 60, duration: 600, maxZoom: 16 })
    await waitMapIdle(map)
    return restore
  }

  /** 组装 PNG（预览或导出共用），返回画布。 */
  const build = useCallback(async (): Promise<HTMLCanvasElement | null> => {
    const map = props.mapRef.current
    if (!map) return null
    setErr('')
    try {
      const restore = await prepareExtent(map)
      try {
        const raster = await captureMapRaster(map, scale2 ? 2 : 1)
        if (!raster) throw new Error(t('export.captureFailed'))
        const lat = map.getCenter().lat
        const zoom = map.getZoom()
        const opts: ExportComposeOpts = {
          title: title.trim() || undefined,
          legend: showLegend,
          north: showNorth,
          scale: showScale,
          note: note.trim() || undefined,
          metersPerPixel: metersPerPixel(lat, zoom),
        }
        const mode: Record<SizeMode, { w: number; h: number }> = {
          window: { w: raster.width, h: raster.height },
          '1920': { w: 1920, h: 1080 },
          '4k': { w: 3840, h: 2160 },
        }
        const m = mode[sizeMode]
        const out = composeExportImage({ raster, outW: m.w, outH: m.h, items, opts })
        return out
      } finally {
        restore()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [extent, selected, title, showLegend, showNorth, showScale, note, sizeMode, scale2, items, props.layers, props.mapRef, t])

  const runPreview = async (): Promise<void> => {
    if (!previewRef.current) return
    const canvas = await build()
    if (!canvas) return
    const ctx = previewRef.current.getContext('2d')
    const maxW = 480
    const s = Math.min(1, maxW / canvas.width)
    previewRef.current.width = Math.round(canvas.width * s)
    previewRef.current.height = Math.round(canvas.height * s)
    ctx?.drawImage(canvas, 0, 0, previewRef.current.width, previewRef.current.height)
  }

  const runExport = async (toAi: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const canvas = await build()
      if (!canvas) return
      if (toAi) {
        if (props.onExportToAi) {
          props.onExportToAi(canvasToDataUrl(canvas), canvas.width, canvas.height, title)
        } else {
          downloadCanvas(canvas, exportFilename(title))
        }
      } else {
        downloadCanvas(canvas, exportFilename(title))
      }
    } finally {
      setBusy(false)
    }
  }

  if (!props.open) return null
  return (
    <div className={styles.exportOverlay} onPointerDown={props.onClose}>
      <div className={styles.exportCard} onPointerDown={(e) => e.stopPropagation()}>
        <div className={styles.exportHead}>
          <span>{t('export.title')}</span>
          <button className={styles.exportClose} onClick={props.onClose} title={t('export.close')}>×</button>
        </div>
        <div className={styles.exportBody}>
          <label className={styles.exportField}>
            <span className={styles.exportLabel}>{t('export.titleLabel')}</span>
            <input className={styles.exportInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('export.titlePh')} />
          </label>
          <div className={styles.exportField}>
            <span className={styles.exportLabel}>{t('export.layersLabel')}</span>
            <div className={styles.exportLayerList}>
              {props.layers.filter((l) => l.visible !== false).map((l) => (
                <label key={l.id} className={styles.exportLayerItem}>
                  <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                  <span className={styles.exportSwatch} style={{ background: l.fillColor ?? l.color }} />
                  {l.name}
                </label>
              ))}
            </div>
          </div>
          <div className={styles.exportField}>
            <span className={styles.exportLabel}>{t('export.componentsLabel')}</span>
            <label className={styles.exportCheck}><input type="checkbox" checked={showLegend} onChange={(e) => setShowLegend(e.target.checked)} />{t('export.legend')}</label>
            <label className={styles.exportCheck}><input type="checkbox" checked={showNorth} onChange={(e) => setShowNorth(e.target.checked)} />{t('export.north')}</label>
            <label className={styles.exportCheck}><input type="checkbox" checked={showScale} onChange={(e) => setShowScale(e.target.checked)} />{t('export.scale')}</label>
          </div>
          <label className={styles.exportField}>
            <span className={styles.exportLabel}>{t('export.extentLabel')}</span>
            <label className={styles.exportCheck}><input type="radio" name="extent" checked={extent === 'view'} onChange={() => setExtent('view')} />{t('export.extentView')}</label>
            <label className={styles.exportCheck}><input type="radio" name="extent" checked={extent === 'all'} onChange={() => setExtent('all')} />{t('export.extentAll')}</label>
          </label>
          <label className={styles.exportField}>
            <span className={styles.exportLabel}>{t('export.sizeLabel')}</span>
            <label className={styles.exportCheck}><input type="radio" name="size" checked={sizeMode === 'window'} onChange={() => setSizeMode('window')} />{t('export.sizeWindow')}</label>
            <label className={styles.exportCheck}><input type="radio" name="size" checked={sizeMode === '1920'} onChange={() => setSizeMode('1920')} />1920×1080</label>
            <label className={styles.exportCheck}><input type="radio" name="size" checked={sizeMode === '4k'} onChange={() => setSizeMode('4k')} />4K</label>
          </label>
          <label className={styles.exportField}>
            <span className={styles.exportLabel}>{t('export.qualityLabel')}</span>
            <label className={styles.exportCheck}><input type="checkbox" checked={scale2} onChange={(e) => setScale2(e.target.checked)} />{t('export.quality2x')}</label>
          </label>
          {err && <div className={styles.exportErr}>{err}</div>}
          <canvas ref={previewRef} className={styles.exportPreview} hidden={items.length === 0} />
          <div className={styles.exportActions}>
            <button className={styles.exportBtn} disabled={busy} onClick={() => void runPreview()}>{t('export.preview')}</button>
            <button className={styles.exportBtn} disabled={busy} onClick={() => void runExport(false)}>{busy ? t('export.exporting') : t('export.exportPng')}</button>
            <button className={styles.exportBtnPrimary} disabled={busy} onClick={() => void runExport(true)}>{t('export.exportToAi')}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
