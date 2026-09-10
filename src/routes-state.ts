/**
 * 会话状态类路由：state/status/plugin-config/dataset/gis-result/arrow/arrow-attr/arrow-rid。
 * 拆分自 src/index.ts 的 HTTP 路由大 handler；行为零变化。
 */
import { summarize } from './geo-processing.js'
import { json, jsonError, notFound, readBody } from './http-utils.js'
import { isPluginEnabled, savePluginEnabled, setPluginEnabled } from './enabled.js'
import {
  arrowViewportWhere,
  buildGeomExpr, DUCK_RID, getDuckDb, normalizeValue, quoteIdent,
  type ArrowBbox,
} from './duckdb.js'
import { pointsToGeoArrowFromIpc, pointsToGeoArrowTable, tableToIpc, wkbRowsToGeoArrowTable } from './geoarrow.js'
import { arrowCacheGet, arrowCacheSet } from './arrow-cache.js'
import type { RouteApi, RouteHandler } from './route-shared.js'

export const handleState: RouteHandler = (_req, res, _url, _pathname, _sessionId, state, api) => {
  const datasetLayer = state.layers.find((l) => l.id === 'dataset')
  json(res, {
    baseTileUrl: api.config.baseTileUrl,
    dataset: state.dataset
      ? {
          name: state.dataset.name,
          featureCount: state.dataset.featureCount,
          visible: datasetLayer?.visible ?? true,
        }
      : null,
    // 图层摘要（不含 geojson，避免 1s 轮询传全量数据）；变更检测靠每层 rev。
    layers: state.layers.map(summarize),
    navigate: state.navigate,
    capture: state.capture,
    // 出图请求（AI 工具置；客户端见新 seq 打开弹窗预填）与最近一次出图元信息（不含附件 ref，客户端不需要）。
    exportRequest: state.exportRequest,
    exportImage: state.exportImage
      ? { id: state.exportImage.id, width: state.exportImage.width, height: state.exportImage.height, title: state.exportImage.title }
      : null,
  })
}

export const handleStatus: RouteHandler = (_req, res, _url, _pathname, _sessionId, _state) => {
  // 启停状态：客户端（GisSurface / 设置卡片）轮询用；关闭时也常驻可用。
  json(res, { enabled: isPluginEnabled() })
}

export const handlePluginConfig: RouteHandler = (req, res, _url, _pathname, _sessionId, _state, api) => {
  // 启停开关：写内存 + 持久化（~/.dsh/webgis-enabled.json），立即生效。
  return void (async () => {
    try {
      const raw = await readBody(req, 4 * 1024)
      const data = JSON.parse(raw) as { enabled?: unknown }
      const next = data.enabled === true
      setPluginEnabled(next)
      await savePluginEnabled(next).catch((err: unknown) => {
        api.ctx.logger.warn('[webgis] 启停配置持久化失败: %s', err instanceof Error ? err.message : String(err))
      })
      json(res, { ok: true, enabled: next })
    } catch (err) {
      return void jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}

export const handleDataset: RouteHandler = (_req, res, _url, _pathname, _sessionId, state) => {
  if (!state.dataset) return void notFound(res, 'no dataset loaded')
  json(res, state.dataset.geojson)
}

export const handleGisResult: RouteHandler = (_req, res, url, _pathname, _sessionId, state) => {
  // 客户端按 rev 变更拉取某个结果图层的全量 GeoJSON。
  const id = url.searchParams.get('id') ?? ''
  const layer = state.layers.find((l) => l.id === id)
  if (!layer) return void notFound(res, 'unknown gis layer')
  json(res, layer.geojson)
}

/** 属性表单页可取的最大行数（防一次响应过大）。 */
const ATTR_PAGE_MAX = 500

export const handleLayerAttrs: RouteHandler = (_req, res, url, _pathname, _sessionId, state) => {
  // 属性抽屉分页取数：按 offset/limit 只返回一页属性行 + 全部列并集。
  // 不再走 gis-result 整层 GeoJSON——几万行图层整层序列化 + 客户端 JSON.parse 会卡 3~5s，
  // 而表格其实每屏只看 ~200 行。数据在宿主内存里就是 features 数组，切片零成本。
  const id = url.searchParams.get('id') ?? ''
  const layer = state.layers.find((l) => l.id === id)
  if (!layer) return void notFound(res, 'unknown gis layer')
  const feats = (layer.geojson?.features ?? []) as Array<{ properties?: Record<string, unknown> }>
  const offsetRaw = Number(url.searchParams.get('offset'))
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
  const limitRaw = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(ATTR_PAGE_MAX, Math.floor(limitRaw)) : 200
  // 列并集跨页稳定：每页都扫一遍 keys（几万行 JS 对象取键 <10ms）；行数才是主要负载，只切一页返回。
  const keys = new Set<string>()
  for (const f of feats) {
    const p = f.properties
    if (!p) continue
    for (const k of Object.keys(p)) keys.add(k)
  }
  const rows = feats.slice(offset, offset + limit).map((f) => f.properties ?? {})
  json(res, { total: feats.length, offset, limit, keys: [...keys], rows })
}

/** 渲染轻量 GeoJSON 里每个要素带的稳定行号属性名（指向 layer.geojson.features 数组下标）。 */
export const LAYER_RENDER_ROW_KEY = '__i'

/** 渲染轻量 GeoJSON 里标记所属图层 id 的属性名（客户端点击据此调 /webgis/layer-row）。 */
export const LAYER_RENDER_ID_KEY = '__layer'

export const handleLayerRender: RouteHandler = (_req, res, url, _pathname, _sessionId, state) => {
  // maplibre 显示的「渲染版」GeoJSON：只带几何 + 稳定行号 __i + 图层标记 __layer，**不带任何属性**。
  // 属性极重的大图层（dbf 动辄上百 MB）若整层下发，下载+JSON.parse+maplibre 建源会卡数秒甚至卡死；
  // 地图画几何不需要属性——点开属性/点击浮窗按 __i 走 /webgis/layer-row 按行取。
  const id = url.searchParams.get('id') ?? ''
  const layer = state.layers.find((l) => l.id === id)
  if (!layer) return void notFound(res, 'unknown gis layer')
  const feats = (layer.geojson?.features ?? []) as Array<{ geometry: unknown }>
  const out = {
    type: 'FeatureCollection',
    features: feats.map((f, i) => ({
      type: 'Feature',
      geometry: f.geometry,
      properties: { [LAYER_RENDER_ROW_KEY]: i, [LAYER_RENDER_ID_KEY]: id },
    })),
  }
  json(res, out)
}

export const handleLayerRow: RouteHandler = (_req, res, url, _pathname, _sessionId, state) => {
  // 按行号取整行属性（与 arrow-rid 同思路，面向 maplibre 渲染轻量图层）。row = layer.geojson.features 下标。
  const id = url.searchParams.get('id') ?? ''
  const rowRaw = Number(url.searchParams.get('row'))
  const layer = state.layers.find((l) => l.id === id)
  if (!layer) return void notFound(res, 'unknown gis layer')
  const feats = (layer.geojson?.features ?? []) as Array<{ properties?: Record<string, unknown> }>
  if (!Number.isInteger(rowRaw) || rowRaw < 0 || rowRaw >= feats.length) {
    return void jsonError(res, 400, `行号非法（0 ≤ row < ${feats.length}）`)
  }
  json(res, { ok: true, id, name: layer.name, attrs: feats[rowRaw]?.properties ?? {} })
}

export const handleArrow: RouteHandler = (req, res, url, _pathname, sessionId, state) => {
  // 大文件点图层 → GeoArrow IPC 二进制（deck.gl 原始点渲染的传输路径；只有带 duckTable 的图层有）。
  // 点图层：engine 拉全表 → 直接拼 interleaved Point 表（免 spatial）；几何图层：ST_AsWKB → objex-utils。
  // 视口裁剪（高 zoom）：客户端带 bbox=west,south,east,north 时，先按视野过滤再取 max cap——
  // 高 zoom 不再无差别抽全表（60 万），只拉「当前视野内」再套上限抽样（见 arrowViewportWhere）。
  return void (async () => {
    try {
      const id = url.searchParams.get('id') ?? ''
      const layer = state.layers.find((l) => l.id === id)
      if (!layer) return void notFound(res, 'unknown gis layer')
      if (!layer.duckTable) return void jsonError(res, 400, '该图层无 Arrow 数据，请走 /webgis/gis-result')
      const engine = getDuckDb()
      // 缩放分级密度：客户端按 zoom 传 max（目标条数），低缩放抽样显示、放大逐级加密度、高缩放全量；
      // 点(duckCoords)/线/面(duckGeom) 共用。带 bbox 时 max 表示「视野内 cap」。
      const maxRaw = Number(url.searchParams.get('max'))
      const max = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 0
      // 视口裁剪参数：bbox=west,south,east,north。缺省 = 旧全量/抽样行为；非法给 400。
      const bboxInfo = parseArrowBbox(url.searchParams.get('bbox'))
      if (bboxInfo && 'error' in bboxInfo) return void jsonError(res, 400, bboxInfo.error)
      const bbox = bboxInfo ? bboxInfo.bbox : null
      // 分档 IPC 缓存（0=全量）：会话+图层+档位维度——同档秒回、抽样稳定，且不同会话的同名图层不串数据。
      // ⚠️ 带 bbox 的请求视野键难缓存，一律不读也不写缓存；缓存只在无 bbox 分档路径使用。
      const sKey = sessionId ?? 'anon'
      let bytes = bbox ? undefined : arrowCacheGet(sKey, id, max)
      if (!bytes) {
        // ⚠️ 只拉几何坐标，不拉任何属性列：deck 原始点/线渲染 pickable=false，属性全无用。
        // 早期用 SELECT * 把全部字符串属性（如 22 列 CSV 的 16 个字符串列）拉成 JS 对象，
        // 1.68M 行 × 16 字符串列把宿主堆撑爆（FATAL ERROR: JavaScript heap out of memory）。
        // 带 bbox：FROM 子查询先 WHERE 视野再抽样（filtered<cap 时 DuckDB 自然返回全部）；
        // 无 bbox：保持旧路径（全表 / 全表 USING SAMPLE）。
        const duckTable = layer.duckTable // 已判非空；闭包内属性访问不保留 narrowing，先抽成 const
        const arrowFrom = (where: string | null): string => {
          const base = where ? `(SELECT * FROM ${duckTable} WHERE ${where}) __v` : duckTable
          return max > 0 ? `${base} USING SAMPLE ${max} ROWS` : base
        }
        if (layer.duckCoords) {
          const sel = `${quoteIdent(layer.duckCoords.lon)}, ${quoteIdent(layer.duckCoords.lat)}`
          const where = bbox ? arrowViewportWhere({ coords: layer.duckCoords }, bbox) : null
          const from = arrowFrom(where)
          // 原生 Arrow IPC 只在无 bbox 路径用：arrow 扩展的 arrowIPCAll 对「空结果」会让 duckdb 原生段崩溃
          // （实测 SELECT ... WHERE 恒假 → 进程 EXIT 127 无 JS 错误），而视野裁剪常见空窗（视野内无要素），
          // 必须先避开。bbox 视野子集通常远小于全表，走 JS 行路径（只取 lon/lat 两列）足够。
          if (!bbox) {
            const native = await engine.arrowIpc(`SELECT ${sel} FROM ${from}`)
            if (native) {
              const t = pointsToGeoArrowFromIpc(native, layer.duckCoords.lon, layer.duckCoords.lat)
              if (t) bytes = tableToIpc(t)
            }
          }
          if (!bytes) {
            const rows = await engine.run(`SELECT ${sel} FROM ${from}`)
            // 视野内无点 / 全表空 → rows=[]，pointsToGeoArrowTable 产出合法空 arrow（0 行）。
            bytes = tableToIpc(pointsToGeoArrowTable(rows, layer.duckCoords.lon, layer.duckCoords.lat, []))
          }
        } else if (layer.duckGeom) {
          if (!(await engine.ensureSpatial())) {
            return void jsonError(res, 500, '几何列 Arrow 需要 DuckDB spatial 扩展（首次需联网 INSTALL，之后本地缓存）')
          }
          const g = layer.duckGeom
          const where = bbox ? arrowViewportWhere({ geom: g }, bbox) : null
          const from = arrowFrom(where)
          // 只带几何 + 稳定行号 __rid（建表时 row_number 写入，DuckDB 无 rowid() 伪列）：
          // 点击命中行后按 __rid 回查整行属性（/webgis/arrow-rid）。不同 zoom 分档抽样子集不同，
          // 坐标/索引都不稳定，__rid 才跨档稳定。
          const rows = await engine.run(
            `SELECT ST_AsWKB(${buildGeomExpr(g.column, g.format, g.sourceCrs)}) AS __wkb, ${DUCK_RID} FROM ${from}`,
          )
          const table = wkbRowsToGeoArrowTable(rows, '__wkb', [DUCK_RID])
          if (!table) {
            // 视野内无几何要素（bbox 空窗）：返回合法空 arrow（0 行 geoarrow.point），不 500——
            // 客户端拿空表渲染空、下一轮视野变化再拉；无 bbox 的全空图层仍报错（与旧行为一致）。
            if (bbox) bytes = tableToIpc(pointsToGeoArrowTable([], 'lon', 'lat', []))
            else return void jsonError(res, 500, '没有可编码的几何要素')
          } else {
            bytes = tableToIpc(table)
          }
        } else {
          return void jsonError(res, 400, '该图层无 Arrow 数据，请走 /webgis/gis-result')
        }
        if (!bbox) arrowCacheSet(sKey, id, max, bytes)
      }
      res.writeHead(200, {
        'content-type': 'application/vnd.apache.arrow.stream',
        'cache-control': 'no-store',
      })
      res.end(bytes)
    } catch (err) {
      jsonError(res, 500, `Arrow 编码失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

/**
 * 解析 /webgis/arrow 的 bbox=west,south,east,north：
 * - 缺省（null/空串）→ 返回 null（调用方走无 bbox 旧路径）；
 * - 非法（非 4 个有限数 / west>east / south>north）→ 返回 { error }（调用方给 400）。
 */
function parseArrowBbox(raw: string | null): { bbox: ArrowBbox } | { error: string } | null {
  if (!raw) return null
  const parts = raw.split(',')
  if (parts.length !== 4) return { error: 'bbox 参数需为 west,south,east,north 四个数值（逗号分隔）' }
  const nums = parts.map((x) => {
    const t = x.trim()
    return t === '' ? NaN : Number(t)
  })
  if (nums.some((v) => !Number.isFinite(v))) {
    return { error: 'bbox 参数需为四个数值（west,south,east,north）' }
  }
  const [west, south, east, north] = nums as [number, number, number, number]
  if (west > east) return { error: 'bbox 参数非法：west 需 ≤ east' }
  if (south > north) return { error: 'bbox 参数非法：south 需 ≤ north' }
  return { bbox: { west, south, east, north } }
}

export const handleArrowAttr: RouteHandler = (req, res, url, _pathname, _sessionId, state) => {
  // 原始点图层点击属性查询：arrow 只传坐标（防大图层爆内存），点击时按坐标查 duck 内存表那一行的全部属性。
  return void (async () => {
    try {
      const id = url.searchParams.get('id') ?? ''
      const lon = Number(url.searchParams.get('lon'))
      const lat = Number(url.searchParams.get('lat'))
      const layer = state.layers.find((l) => l.id === id)
      if (!layer) return void notFound(res, 'unknown gis layer')
      if (!layer.duckTable || !layer.duckCoords) {
        return void jsonError(res, 400, '该图层无坐标属性查询数据（仅 duckTable 点图层支持）')
      }
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return void jsonError(res, 400, '坐标参数非法')
      const engine = getDuckDb()
      const qlon = quoteIdent(layer.duckCoords.lon)
      const qlat = quoteIdent(layer.duckCoords.lat)
      // 1) 精确匹配：箭头链路与查询读同一 duck 列，同一 DOUBLE 值，等值应命中。
      //    lon/lat 已通过 Number.isFinite 校验，内联为数字字面量（duckdb 1.4.4 的 conn.all params 绑定有 bug，项目统一内联）。
      let rows = await engine.run(
        `SELECT * FROM ${layer.duckTable} WHERE ${qlon} = ${lon} AND ${qlat} = ${lat} LIMIT 1`,
      )
      // 2) 兜底：±1e-5 度（≈1m）最近邻，吸收子像素/浮点舍入差异。
      if (rows.length === 0) {
        rows = await engine.run(
          `SELECT * FROM ${layer.duckTable} WHERE abs(${qlon} - ${lon}) < 1e-5 AND abs(${qlat} - ${lat}) < 1e-5 ORDER BY abs(${qlon} - ${lon}) + abs(${qlat} - ${lat}) LIMIT 1`,
        )
      }
      const row = rows[0]
      if (!row) {
        // 诊断：报告全表最近距离，区分「精度差」与「index 错位（坐标差很远）」。
        const probe = await engine.run(`SELECT min(abs(${qlon} - ${lon}) + abs(${qlat} - ${lat})) AS d FROM ${layer.duckTable}`)
        const d = probe[0]?.d
        return void json(res, {
          ok: false,
          message: `未命中该坐标的要素（点击坐标 ${lon},${lat}，全表最近距离 ${d != null ? `${d}°` : '未知'}）`,
        })
      }
      const attrs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        if (k === layer.duckCoords.lon || k === layer.duckCoords.lat || k === DUCK_RID) continue
        attrs[k] = normalizeValue(v)
      }
      json(res, { ok: true, id, name: layer.name, attrs })
    } catch (err) {
      jsonError(res, 500, `坐标属性查询失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}

export const handleArrowRid: RouteHandler = (req, res, url, _pathname, _sessionId, state) => {
  // Arrow 几何列图层（点/线/面，duckGeom）点击属性查询：arrow 只带几何 + 稳定行号 rowid()，
  // 点击命中行的 __rid 回查整行属性（跨 zoom 分档稳定，不像坐标/索引会错位）。响应形状与 arrow-attr 一致。
  return void (async () => {
    try {
      const id = url.searchParams.get('id') ?? ''
      const ridRaw = Number(url.searchParams.get('rid'))
      const layer = state.layers.find((l) => l.id === id)
      if (!layer) return void notFound(res, 'unknown gis layer')
      if (!layer.duckTable || !layer.duckGeom) {
        return void jsonError(res, 400, '该图层无行号属性查询数据（仅 duckGeom 几何列图层支持）')
      }
      if (!Number.isInteger(ridRaw)) return void jsonError(res, 400, 'rid 参数非法')
      const engine = getDuckDb()
      const g = layer.duckGeom
      // 同时取回该行几何（ST_AsGeoJSON，已归一到 4326）：客户端用它做「与 maplibre 图层一致」的点击高亮。
      let geomSql: string
      try {
        geomSql = `ST_AsGeoJSON(${buildGeomExpr(g.column, g.format, g.sourceCrs)}) AS __geometry`
      } catch {
        geomSql = `ST_AsGeoJSON(${quoteIdent(g.column)}) AS __geometry`
      }
      const rows = await engine.run(
        `SELECT ${geomSql}, * FROM ${layer.duckTable} WHERE ${DUCK_RID} = ${ridRaw} LIMIT 1`,
      )
      const row = rows[0]
      if (!row) return void json(res, { ok: false, message: `未命中行号 ${ridRaw}（图层数据可能已变更）` })
      const attrs: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row)) {
        // 跳过几何列、保留行号列与内部取回的几何串（几何/内部列不进属性浮窗）
        if (k === g.column || k === DUCK_RID || k === '__geometry') continue
        attrs[k] = normalizeValue(v)
      }
      let geometry: unknown = null
      const rawGeom = row.__geometry
      if (typeof rawGeom === 'string' && rawGeom) {
        try { geometry = JSON.parse(rawGeom) } catch { geometry = null }
      }
      json(res, { ok: true, id, name: layer.name, attrs, ...(geometry ? { geometry } : {}) })
    } catch (err) {
      jsonError(res, 500, `行号属性查询失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}
