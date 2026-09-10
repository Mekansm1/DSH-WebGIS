/**
 * 图层面板与文件路由：layer-action（显隐/移除）/ import（导入文件为新图层）/ export（图层导出下载）。
 * 拆分自 src/index.ts 的 HTTP 路由大 handler；行为零变化。
 */
import {
  download, exportName, json, jsonError, MAX_IMPORT_BODY, MAX_IMPORT_BYTES,
  MAX_LAYER_ACTION_BODY, notFound, readBody,
} from './http-utils.js'
import { toCsv, toGeoJSON, toShpZip } from './geo-export.js'
import { loadCsvText, parseShapefileBuffer } from './dataset-load.js'
import { makeResultLayer, normalizeFC } from './geo-processing.js'
import { ingestBigGeojson, type IngestBigResult } from './duckdb-tools.js'
import type { FeatureCollection } from 'geojson'
import type { GeoJson } from './session-state.js'
import type { RouteApi, RouteHandler } from './route-shared.js'

export const handleLayerAction: RouteHandler = (req, res, _url, _pathname, _sessionId, state, api) => {
  // 图层面板操作（toggle/set-visible/remove）：语义与 webgis_* 工具一致，visible 原地改不 bump rev。
  return void (async () => {
    try {
      const raw = await readBody(req, MAX_LAYER_ACTION_BODY)
      const data = JSON.parse(raw) as { id?: unknown; action?: unknown; visible?: unknown }
      const id = typeof data.id === 'string' ? data.id : ''
      const action = typeof data.action === 'string' ? data.action : ''
      const layer = state.layers.find((l) => l.id === id)
      if (!layer) return void jsonError(res, 404, `图层 ${id} 不存在`)
      if (action === 'remove') {
        // 联动释放被移除图层引用的外部资源（DuckDB 内存表 DROP，否则右键删除会漏内存）。
        api.dropLayerResources(layer)
        if (id === 'dataset') {
          // 移除基础数据集层 = 清除当前数据集（含地图上的点/要素），result 层保留。
          state.dataset = null
          state.layers = state.layers.filter((l) => l.id !== 'dataset')
        } else {
          state.layers = state.layers.filter((l) => l.id !== id)
        }
        return void json(res, { ok: true, layerId: id, message: `已移除图层 ${id}` })
      }
      if (action === 'toggle' || action === 'set-visible') {
        const visible = action === 'toggle' ? !layer.visible : data.visible === true
        layer.visible = visible
        return void json(res, { ok: true, layerId: id, visible, message: `图层 ${id} ${visible ? '已显示' : '已隐藏'}` })
      }
      return void jsonError(res, 400, `未知操作 ${action}`)
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}

export const handleImport: RouteHandler = (req, res, _url, _pathname, _sessionId, state, api) => {
  // 导入文件为新图层（shp/zip/csv/geojson，base64 上报）：作为 import_<n> 加入，基础数据集保留。
  return void (async () => {
    try {
      const raw = await readBody(req, MAX_IMPORT_BODY)
      const data = JSON.parse(raw) as { name?: unknown; data?: unknown }
      const name = typeof data.name === 'string' && data.name ? data.name : 'import'
      const b64 = typeof data.data === 'string' ? data.data : ''
      if (!b64) return void jsonError(res, 400, '缺少文件内容 data')
      const buf = Buffer.from(b64, 'base64')
      if (buf.byteLength > MAX_IMPORT_BYTES) return void jsonError(res, 400, '文件超过 32MB 上限')
      const cleanName = name.replace(/[\\/:*?"<>|]/g, '_')
      const ext = cleanName.toLowerCase().match(/\.(zip|shp|csv|geojson|json)$/)?.[1] ?? null
      let geojson: GeoJson
      if (ext === 'zip' || ext === 'shp') {
        geojson = await parseShapefileBuffer(buf, ext)
      } else if (ext === 'csv') {
        geojson = loadCsvText(buf.toString('utf8'))
      } else {
        geojson = normalizeFC(JSON.parse(buf.toString('utf8')) as never) as unknown as GeoJson
      }
      const baseName = cleanName.replace(/\.(zip|shp|csv|geojson|json)$/i, '') || 'import'
      // >10 万（任何格式：zip/shp/csv/geojson）统一灌 DuckDB → arrow + zoom 分级；失败回退纯 geojson。
      let big: IngestBigResult | null = null
      try { big = await ingestBigGeojson(geojson as unknown as FeatureCollection) } catch { big = null }
      const layer = makeResultLayer({
        id: `import_${++api.seqs.importSeq}`,
        name: baseName,
        geojson: big?.geojson ?? geojson,
        source: 'import',
        ...(big
          ? {
              duckTable: big.duckTable,
              duckGeom: big.duckGeom,
              totalCount: big.totalCount,
              families: big.families,
              fullBbox: big.fullBbox,
            }
          : {}),
      })
      state.layers = [...state.layers, layer]
      json(res, {
        ok: true,
        layerId: layer.id,
        name: layer.name,
        featureCount: layer.featureCount,
        bbox: layer.bbox,
        message: `导入 ${baseName} 完成：${layer.featureCount} 个要素${big ? `（共 ${big.totalCount}，走 DuckDB arrow）` : ''}`,
      })
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '导入失败')
    }
  })()
}

export const handleExport: RouteHandler = (_req, res, url, _pathname, _sessionId, state) => {
  // 导出图层：format=geojson|csv|shp，附件下载；shp 为 zip 包。
  const id = url.searchParams.get('id') ?? ''
  const format = url.searchParams.get('format') ?? 'geojson'
  const layer = state.layers.find((l) => l.id === id)
  if (!layer) return void notFound(res, 'unknown gis layer')
  if (format === 'geojson') {
    const fn = exportName(layer.name, 'geojson')
    download(res, toGeoJSON(layer.geojson), fn.ascii, fn.utf8enc, 'application/geo+json; charset=utf-8')
  } else if (format === 'csv') {
    const fn = exportName(layer.name, 'csv')
    download(res, toCsv(layer.geojson), fn.ascii, fn.utf8enc, 'text/csv; charset=utf-8')
  } else if (format === 'shp') {
    const fn = exportName(layer.name, 'zip')
    download(res, toShpZip(layer.geojson, fn.asciiBase), fn.ascii, fn.utf8enc, 'application/zip')
  } else {
    return void jsonError(res, 400, `未知导出格式 ${format}（geojson/csv/shp）`)
  }
}
