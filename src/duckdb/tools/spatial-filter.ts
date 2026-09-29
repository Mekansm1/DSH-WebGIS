import { acquireLayer, type LayerLease } from '../layer-access.js'
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
    description: '对图层完整数据进行空间筛选，自动识别坐标列、几何列或普通图层。bbox/dwithin 支持点；within_polygon 为与面围栏相交（含边界，点线面均可）；intersects_layer 与另一图层任意要素相交。'
      + 'dwithin 使用 haversine 球面米；相交按 WGS84 平面几何。where 可叠加等值条件。output=count_only 仅统计，默认 layer 生成可继续分析的新图层。返回 scope 和真实命中/显示行数；limit 只限制显示。',
    parameters: {
      layer: { type: 'string', required: true, description: '目标图层 id' },
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
      let layer = resolve(args.layer)
      if (typeof layer === 'string') return { ok: false, message: layer }
      let lease: LayerLease | undefined
      let resultTable: string | undefined
      try {
        lease = await acquireLayer(engine, layer)
        layer = lease.layer
        const table = lease.layer.duckTable
        const shape = duckGeomSourceOf(layer)
        const mode = args.mode
        const isCountOnly = args.output === 'count_only'
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
          // ⚠ 空图层必须先拦：acquireLayer 从 0 要素的 geojson 建表只会得到一列 geom，
          // 既探不出经纬度列也探不出几何列 → join 恒为 0 行 → 工具会返回一个**自信的**
          // `count:0 / scope:full_table`，模型据此向用户断言「两个图层没有任何相交要素」。
          // 那是"看着正常的错答案"，本项目最贵的一类 bug。
          if (other.featureCount === 0) throw new Error(`对方图层 ${other.id} 没有要素可相交`)
          if (!other.duckTable && other.featureCount > SPATIAL_TEMP_MAX) throw new Error(`对方图层 ${other.id} 要素 ${other.featureCount} > ${SPATIAL_TEMP_MAX}，过大无法临时灌表`)
          const otherLease = await acquireLayer(engine, other)
          const otherTable = otherLease.layer.duckTable
          const otherShape = duckGeomSourceOf(otherLease.layer)
          const releaseOther = otherLease.release
          try {
            // 同上：几何源两边都取不到时不能继续（会拼出无意义的 ST_* 表达式）。
            if (!otherShape.coords && !otherShape.geom) {
              throw new Error(`对方图层 ${other.id} 没有可识别的几何列或经纬度列，无法相交`)
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
              const cnt = await engine.run(`SELECT count(*) AS c FROM ${ridTable}`)
              const resultCount = Number(cnt[0]?.c ?? 0)
              const srcCnt = await engine.run(`SELECT count(*) AS c FROM ${table}`)
              const sourceCount = Number(srcCnt[0]?.c ?? 0)
              const mkTable = async (): Promise<string> => {
                const resTable = engine.nextTableName()
                try {
                  await engine.createFilterTable(resTable, table, `WHERE ${quoteIdent(DUCK_RID)} IN (SELECT rid FROM ${ridTable})`)
                  return resTable
                } catch (err) {
                  await engine.dropTable(resTable).catch(() => {})
                  throw err
                } finally { await dropRid() }
              }
              return { sourceCount, resultCount, mkTable, dropRid }
            } catch (err) {
              await dropRid()
              throw err
            }
          } finally { await releaseOther().catch(() => {}) }
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
          resultTable = t
          await engine.createFilterTable(t, table, meta.whereText)
          return t
        })()
        resultTable = resTable
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
        const fullyDisplayed = displayedCount === resultCount
        const scope = fullyDisplayed ? 'filtered' : 'sample_display'
        const clustered = !!(shape.coords && !small && resultCount <= DECK_FROM)
        const push = await pushResult(`空间筛选 - ${layer.name}`, fc, {
          cluster: clustered,
          duckTable: resTable,
          ...(shape.coords ? { duckCoords: shape.coords } : {}),
          ...(shape.geom ? { duckGeom: { column: shape.geom.column, format: shape.geom.format, sourceCrs: shape.geom.sourceCrs } } : {}),
          totalCount: resultCount,
        })
        resultTable = undefined
        const note = fullyDisplayed
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
      } finally {
        if (resultTable) await engine.dropTable(resultTable).catch(() => {})
        await lease?.release()
      }
    },
  }))

/** intersects_layer：对方图层为纯 GeoJSON（无 duckTable）时允许的最大要素数。 */
const SPATIAL_TEMP_MAX = 20000

}
