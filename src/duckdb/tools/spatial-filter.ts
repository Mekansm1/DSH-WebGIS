/**
 * DuckDB 工具注册：webgis_spatial_filter（全表空间筛选）（自 src/duckdb-tools.ts 拆分）。
 */
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BBox, Feature, FeatureCollection } from 'geojson'
import type { GisLayer } from '../../geo-processing.js'
import {
  buildGeomSelect, DUCK_RID, friendlyDuckError, geometryRowsToGeoJSON, normalizeValue, quoteIdent, rowsToGeoJSON,
  type DuckColumn, type DuckGeomFormat, type DuckGeomSpec, type VectorTableInfo,
} from '../../duckdb.js'
import {
  bboxPredText, combineWhereText, duckTableFullBBox, geomExprFor, haversinePredText,
  pointLonLatExprOf, qref, rowGeomExprOf, tableBBoxOf,
} from '../geometry.js'
import {
  buildEqualityClause, buildFilterClause, buildPolygonClause, eqClauseText, escIdent,
  finiteInt, geojsonToWkt, inlineValue, num, sanitizeRows,
} from '../filters.js'
import {
  duckGeomSourceOf, fenceWktText, requirePointableLonLat, runDuckRetry, text, type DuckToolDeps,
} from '../tools-shared.js'
import { duckGeomFamiliesOf, geomFamiliesOf, geomFamiliesOfWkb, geometrySampleRows, type GeomFamily } from '../sampling.js'
import { csvLoadError, loadCsvSourceData, loadVectorSourceData } from '../ingestion.js'
import { toCsv, toGeoJSON } from '../../geo-export.js'
import { effectiveCluster, resolveClusterMode, validateSql, type ClusterParam } from '../../postgis.js'
import { detectCoordColumns, detectGeomColumn, detectGeomFormat } from '../geometry.js'
import type { DuckGeomSource } from '../types.js'
import { DECK_FROM } from '../../render-policy.js'

export function registerSpatialFilterTool(ctx: Context, deps: DuckToolDeps): void {
  const { engine, sess } = deps

  ctx.tools.register(defineTool({
    name: 'webgis_spatial_filter',
    description:
      '在持有 DuckDB 内存表的图层上做「全表空间筛选」→ 新图层或统计（DuckDB 管大表谓词，Turf 只管筛小后的探索）。'
      + '只对含内存表（duckTable）的图层可用，不限来源：既支持 webgis_load_csv 的经纬度点列（duckCoords），'
      + '也支持几何列图层（duckGeom，format geometry/wkb/wkt，sourceCrs 非 4326 自动转 4326）。'
      + 'mode：bbox=经纬度范围（仅点状源）；dwithin=center:{lon,lat}+distanceMeters 半径筛选'
      + '（haversine 球面米，与 filter_layer 半径一致，仅点状源）；'
      + 'within_polygon=polygon(GeoJSON 面) 或 polygonLayer(面图层 id) 作围栏（ST_Intersects，点落内即 true，线/面源也可用）；'
      + 'intersects_layer=otherLayerId 与另一图层几何相交（对方是 duck 内存表直接 join；'
      + '对方仅纯 GeoJSON 且要素 ≤20000 时临时灌表后 join，用完即删；过大/无几何会明确报错）。'
      + 'bbox/dwithin 要求可点化源（经纬度列，或几何族全为 point 的几何列）；线/面/混合几何源请用 within_polygon/intersects_layer'
      + '或先筛出子集再用 Turf。距离语义=haversine 球面米；相交/围栏按 4326 经纬度平面计算（几何源已归 4326）。'
      + '大表空间意图（全表多少个/落在哪/距某点多近/与另一层相交）优先用本工具，不要在抽样子集上跑 Turf 下结论。'
      + 'where 传可选等于筛选（JSON 对象，复用 filter_layer 语义）。output=count_only 只返回统计不建图层；'
      + '缺省 output=layer 建新图层并上图（结果仍保留 duckTable 可继续链式筛选）。'
      + '结果永远带 scope 说明：count_only=full_table（全表算，未上图）；layer 全量上图=filtered；'
      + '命中超过上图阈值只抽样显示=sample_display（会如实说明，不会把抽样说成全量）。'
      + '禁止对百万级几何默认全量 buffer 并宣称已全部上图。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标 DuckDB 图层 id（需含内存表；webgis_list_layers 查看）' },
      mode: {
        type: 'string', required: true, enum: ['bbox', 'dwithin', 'within_polygon', 'intersects_layer'],
        description: '空间筛选模式',
      },
      where: { type: 'json', description: '等于筛选：JSON 对象 {"adname":"天河区"}，多字段取交集（先过滤再空间谓词）' },
      bbox: { type: 'json', description: 'bbox 模式参数：{"west":113,"south":22.8,"east":114,"north":23.5}' },
      center: { type: 'json', description: 'dwithin 模式圆心：{"lon":113.32,"lat":23.11}' },
      distanceMeters: { type: 'number', description: 'dwithin 模式半径（米，haversine 球面距离）' },
      polygon: { type: 'json', description: 'within_polygon 模式围栏：GeoJSON 面几何 {"type":"Polygon","coordinates":[...]}' },
      polygonLayer: { type: 'string', description: 'within_polygon 模式围栏：取指定图层的首个面要素作围栏' },
      otherLayerId: { type: 'string', description: 'intersects_layer 模式：与哪个图层相交（其需可取几何）' },
      output: { type: 'string', enum: ['layer', 'count_only'], description: 'layer=建结果图层上图（默认）；count_only=只返回命中统计' },
      limit: { type: 'integer', description: '上图行数上限（默认：命中≤阈值全量，否则抽样阈值行）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string' },
          output: { type: 'string' },
          scope: { type: 'string' },
          sourceCount: { type: 'integer' },
          resultCount: { type: 'integer' },
          displayedCount: { type: 'integer' },
          count: { type: 'integer' },
          note: { type: 'string' },
          layerId: { type: 'string' },
          name: { type: 'string' },
          featureCount: { type: 'integer' },
          table: { type: 'string' },
          bbox: { type: 'json' },
          message: { type: 'string' },
        },
      },
      render: (_a, v) => text(JSON.stringify(v)),
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const { resolve, pushResult } = sess(exec)
      const layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      const table = layer.duckTable
      if (!table) {
        return { ok: false, message: `图层 ${layer.id} 不是 DuckDB 大文件图层（无内存表；请先用 webgis_load_csv 加载，或对小层用 Turf 工具）` }
      }
      const shape = duckGeomSourceOf(layer)
      if (!shape.coords && !shape.geom) {
        return { ok: false, message: `图层 ${layer.id} 缺 DuckDB 经纬度/几何列信息` }
      }
      const mode = typeof args.mode === 'string' ? args.mode : ''
      if (!['bbox', 'dwithin', 'within_polygon', 'intersects_layer'].includes(mode)) {
        return { ok: false, message: `mode 只支持 bbox/dwithin/within_polygon/intersects_layer，收到 ${mode}` }
      }
      const isCountOnly = args.output === 'count_only'
      try {
        const eq = eqClauseText(args as Record<string, unknown>)

        /** 构造 intersects 结果：返回 count 与物化函数。rid 临时表生命周期内管理。 */
        const buildIntersects = async (): Promise<{ sourceCount: number; resultCount: number; mkTable: () => Promise<string>; dropRid: () => Promise<void> }> => {
          if (!(await engine.ensureSpatial())) {
            throw new Error('intersects_layer 需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）；当前无法加载。')
          }
          const otherId = typeof args.otherLayerId === 'string' && args.otherLayerId ? args.otherLayerId : ''
          if (!otherId) throw new Error('intersects_layer 模式需提供 otherLayerId')
          const other = resolve(otherId)
          if (typeof other === 'string') throw new Error(other)
          let otherTable: string
          let otherShape: DuckGeomSource
          let tempOther: string | null = null
          if (other.duckTable) {
            otherTable = other.duckTable
            otherShape = duckGeomSourceOf(other)
            if (!otherShape.coords && !otherShape.geom) {
              throw new Error(`对方图层 ${other.id} 有内存表但缺经纬度/几何列信息，无法相交`)
            }
          } else {
            // 纯 GeoJSON 图层：要素数在限额内才临时灌表（用完 DROP）。
            if (other.featureCount === 0) throw new Error(`对方图层 ${other.id} 没有要素可相交`)
            if (other.featureCount > SPATIAL_TEMP_MAX) {
              throw new Error(`对方图层 ${other.id} 是纯 GeoJSON（非 duck 内存表）且要素 ${other.featureCount} > ${SPATIAL_TEMP_MAX}：`
                + '过大无法临时灌表。请先对该图层用 webgis_spatial_filter 筛出子集，或用 webgis_load_csv 灌成 duck 内存表后再相交。')
            }
            tempOther = engine.nextTableName()
            const gj = await engine.createTableFromGeoJson(tempOther, other.geojson)
            if (!gj.geomColumn) {
              await engine.dropTable(tempOther).catch(() => {})
              throw new Error(`对方图层 ${other.id} 的 GeoJSON 没有可识别几何列，无法相交`)
            }
            otherTable = tempOther
            otherShape = { geom: { column: gj.geomColumn, format: 'geometry', sourceCrs: null } }
          }
          // 两侧子查询：rid + 几何表达式 + 数值化 bbox（避免触发 DuckDB SPATIAL_JOIN 崩溃/不稳）。
          const bboxSide = (tbl: string, src: DuckGeomSource, whereText: string): string => {
            const g = rowGeomExprOf(src)
            let xs: string; let xe: string; let ys: string; let ye: string
            if (src.coords) {
              const c = src.coords
              xs = `${quoteIdent(c.lon)}`; xe = `${quoteIdent(c.lon)}`
              ys = `${quoteIdent(c.lat)}`; ye = `${quoteIdent(c.lat)}`
            } else {
              xs = `ST_XMin(${g})`; xe = `ST_XMax(${g})`
              ys = `ST_YMin(${g})`; ye = `ST_YMax(${g})`
            }
            return `(SELECT ${quoteIdent(DUCK_RID)} AS ${quoteIdent('__rid')}, ${g} AS __g, `
              + `${xs} AS __x1, ${xe} AS __x2, ${ys} AS __y1, ${ye} AS __y2 FROM ${tbl} ${whereText})`
          }
          const srcSub = bboxSide(table, shape, combineWhereText([eq]))
          const othSub = bboxSide(otherTable, otherShape, '')
          const cond = '__s.__x1 <= __o.__x2 AND __s.__x2 >= __o.__x1 AND __s.__y1 <= __o.__y2 AND __s.__y2 >= __o.__y1 '
            + 'AND ST_Intersects(__s.__g, __o.__g)'
          const ridTable = engine.nextTableName()
          const dropRid = async (): Promise<void> => {
            await engine.dropTable(ridTable).catch(() => {})
          }
          try {
            await engine.exec(`CREATE TABLE ${ridTable} AS SELECT DISTINCT __s.__rid AS rid FROM ${srcSub} __s JOIN ${othSub} __o ON ${cond}`)
            // ridTable 已物化，对方临时表不再需要 → 立即 DROP（防泄漏）。
            if (tempOther) {
              await engine.dropTable(tempOther).catch(() => {})
              tempOther = null
            }
            const cnt = await engine.run(`SELECT count(*) AS c FROM ${ridTable}`)
            const resultCount = Number(cnt[0]?.c ?? 0)
            const srcCnt = await engine.run(`SELECT count(*) AS c FROM ${table}`)
            const sourceCount = Number(srcCnt[0]?.c ?? 0)
            const mkTable = async (): Promise<string> => {
              const resTable = engine.nextTableName()
              await engine.createFilterTable(resTable, table, `WHERE ${quoteIdent(DUCK_RID)} IN (SELECT rid FROM ${ridTable})`)
              await dropRid()
              return resTable
            }
            return { sourceCount, resultCount, mkTable, dropRid }
          } catch (err) {
            await dropRid()
            if (tempOther) await engine.dropTable(tempOther).catch(() => {})
            throw err
          }
        }

        let meta:
          | { kind: 'predicate'; sourceCount: number; resultCount: number; whereText: string }
          | { kind: 'intersects'; sourceCount: number; resultCount: number; mkTable: () => Promise<string>; dropRid: () => Promise<void> }

        if (mode === 'intersects_layer') {
          const b = await buildIntersects()
          meta = { kind: 'intersects', sourceCount: b.sourceCount, resultCount: b.resultCount, mkTable: b.mkTable, dropRid: b.dropRid }
        } else {
          let spatialText: string
          if (mode === 'bbox') {
            const p = await requirePointableLonLat(engine, layer)
            const bb = args.bbox as { west?: unknown; south?: unknown; east?: unknown; north?: unknown } | undefined
            const w = num(bb?.west); const s = num(bb?.south); const e = num(bb?.east); const n = num(bb?.north)
            if (bb == null || w == null || s == null || e == null || n == null) throw new Error('bbox 需提供 west/south/east/north 四个数值')
            if (w > e || s > n) throw new Error('bbox 需满足 west≤east 且 south≤north')
            spatialText = bboxPredText(p.lon, p.lat, { west: w, south: s, east: e, north: n })
          } else if (mode === 'dwithin') {
            const p = await requirePointableLonLat(engine, layer)
            const center = args.center as { lon?: unknown; lat?: unknown } | undefined
            const clon = num(center?.lon); const clat = num(center?.lat)
            const dist = num(args.distanceMeters)
            if (center == null || clon == null || clat == null || dist == null || dist < 0) {
              throw new Error('dwithin 需 center={lon,lat} 与 distanceMeters（≥0 的米数）')
            }
            spatialText = haversinePredText(p.lon, p.lat, clon, clat, dist)
          } else { // within_polygon
            if (!(await engine.ensureSpatial())) {
              throw new Error('within_polygon 需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）；当前无法加载。')
            }
            const wkt = fenceWktText(args as Record<string, unknown>, resolve)
            spatialText = `ST_Intersects(${rowGeomExprOf(shape)}, ST_GeomFromText(${inlineValue(wkt)})::GEOMETRY)`
          }
          const whereText = combineWhereText([eq, spatialText])
          const cnt = await engine.run(`SELECT count(*) AS c FROM ${table} ${whereText}`)
          const resultCount = Number(cnt[0]?.c ?? 0)
          const srcCnt = await engine.run(`SELECT count(*) AS c FROM ${table}`)
          const sourceCount = Number(srcCnt[0]?.c ?? 0)
          meta = { kind: 'predicate', sourceCount, resultCount, whereText }
        }

        const sourceCount = meta.sourceCount
        const resultCount = meta.resultCount
        const noteBase = `全表 ${sourceCount} 行上计算`

        if (isCountOnly) {
          if (meta.kind === 'intersects') await meta.dropRid()
          const message = `${noteBase}，命中 ${resultCount} 行，未上图（output=count_only）。可加更严 where/空间条件缩小，或用 output=layer 上图（超限会自动建议）。`
          return {
            ok: true, status: 'ok', output: 'count_only', scope: 'full_table',
            sourceCount, resultCount, displayedCount: 0, count: resultCount,
            note: `${noteBase}，命中 ${resultCount} 行，未上图（count_only）。`, message,
          }
        }

        const maxLoad = effectiveCluster(undefined).maxLoad
        if (resultCount > maxLoad) {
          if (meta.kind === 'intersects') await meta.dropRid()
          const message = `命中 ${resultCount} 行，超过地图加载上限 ${maxLoad}，未加载。`
            + '建议：1) output=count_only 看规模；2) 加更严的 where/空间条件；3) 分区域多次筛选。'
          return {
            ok: true, status: 'too_many', output: 'layer', scope: 'full_table',
            sourceCount, resultCount, displayedCount: 0, count: resultCount,
            note: `${noteBase}，命中 ${resultCount} 行，超过上限 ${maxLoad} 未加载。`, message,
          }
        }

        // 物化结果表（链式筛选用）
        const resTable = meta.kind === 'intersects' ? await meta.mkTable() : await (async () => {
          const t = engine.nextTableName()
          await engine.createFilterTable(t, table, meta.whereText)
          return t
        })()
        const small = resultCount <= engine.threshold
        const limitArg = finiteInt(args.limit)
        const cap = small
          ? Math.min(resultCount, limitArg ?? resultCount)
          : Math.min(engine.threshold, limitArg ?? engine.threshold)

        let fc: FeatureCollection
        let displayedCount = 0
        if (shape.geom && !shape.coords) {
          const g = shape.geom
          const attrs = (await engine.describe(resTable))
            .filter((c) => c.name !== g.column && c.name !== DUCK_RID).map((c) => c.name)
          const selList = [...attrs.map((c) => quoteIdent(c)), buildGeomSelect(g.column, g.format, g.sourceCrs)].join(', ')
          const rows = small
            ? await engine.run(`SELECT ${selList} FROM ${resTable} LIMIT ${Math.max(1, cap)}`)
            : await engine.run(`SELECT ${selList} FROM ${resTable} USING SAMPLE ${Math.max(1, cap)} ROWS`)
          fc = geometryRowsToGeoJSON(rows, attrs)
        } else {
          const coords = shape.coords as { lon: string; lat: string }
          const rows = small
            ? await engine.query(resTable, `LIMIT ${Math.max(1, cap)}`)
            : await engine.run(`SELECT * FROM ${resTable} USING SAMPLE ${Math.max(1, cap)} ROWS`)
          fc = rowsToGeoJSON(rows, coords.lon, coords.lat)
        }
        displayedCount = fc.features.length
        const scope = small ? 'filtered' : 'sample_display'
        const clustered = !!(shape.coords && !small && resultCount <= DECK_FROM)
        const push = await pushResult(`空间筛选 - ${layer.name}`, fc, {
          cluster: clustered,
          duckTable: resTable,
          ...(shape.coords ? { duckCoords: shape.coords } : {}),
          ...(shape.geom ? { duckGeom: { column: shape.geom.column, format: shape.geom.format, sourceCrs: shape.geom.sourceCrs } } : {}),
          totalCount: resultCount,
        })
        const note = small
          ? `${noteBase}，命中 ${resultCount} 行并全量上图（scope=filtered）；结果表 ${resTable} 已建，可继续筛选。`
          : `${noteBase}，命中 ${resultCount} 行，抽样上图 ${displayedCount} 行（scope=sample_display，显示为抽样非全量）；结果表 ${resTable} 已建，可继续筛选。`
        return {
          ...push,
          status: 'ok', output: 'layer', scope,
          sourceCount, resultCount, displayedCount, count: resultCount,
          table: resTable, note,
          message: `${push.message}（${note}）`,
        }
      } catch (err) {
        return { ok: false, message: `空间筛选失败: ${friendlyDuckError(err)}` }
      }
    },
  }))

/** intersects_layer：对方图层为纯 GeoJSON（无 duckTable）时允许的最大要素数。 */
const SPATIAL_TEMP_MAX = 20000

}
