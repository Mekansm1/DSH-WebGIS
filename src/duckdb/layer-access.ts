/** 执行端解析全表/物化图层；临时表由调用者在 finally 释放。 */
import type { GisLayer } from '../geo-processing.js'
import type { DuckDbEngine } from './engine.js'
import { detectCoordColumns, detectGeomColumn, detectGeomFormat } from './geometry.js'

export interface LayerLease { layer: GisLayer & { duckTable: string }; release: () => Promise<void> }

export async function acquireLayer(engine: DuckDbEngine, original: GisLayer): Promise<LayerLease> {
  let layer = { ...original }
  let temporary: string | undefined
  try {
    // 已物化层以当前 GeoJSON 为准（用户可能已写属性，旧表不再权威）。
    if (layer.materialized !== false) {
      temporary = engine.nextTableName()
      const info = await engine.createTableFromGeoJson(temporary, layer.geojson)
      layer = { ...layer, duckTable: temporary, duckCoords: undefined,
        duckGeom: info.geomColumn ? { column: info.geomColumn, format: 'geometry', sourceCrs: null } : undefined }
    } else if (!layer.duckTable) {
      throw new Error('图层只有抽样且完整数据不可用；请重新加载数据，不能在抽样上计算全量结果')
    }
    const table = layer.duckTable!
    if (!layer.duckCoords && !layer.duckGeom) {
      const desc = await engine.describe(table)
      const coords = detectCoordColumns(desc.map(c => c.name))
      if (coords.lon && coords.lat) layer.duckCoords = { lon: coords.lon, lat: coords.lat }
      else {
        const name = detectGeomColumn(desc)
        const col = desc.find(c => c.name === name)
        const format = col ? detectGeomFormat(col) : null
        if (col && format) {
          const crs = format === 'geometry' ? await engine.detectSourceCrs(table, col.name) : null
          if (crs?.mixed) throw new Error('几何列含多个 SRID，请重新加载并指定 sourceCrs')
          layer.duckGeom = { column: col.name, format, sourceCrs: crs?.crs ?? null }
        }
      }
    }
    // 探不出几何/经纬度**不在这里抛** —— 纯属性 where 筛选（filter.ts:96/121 里 coords/geom 是可选的）
    // 在无坐标表上是合法的，拦在这里会误伤它。
    // 但 **0 要素**必须拦：此时 geojson 建出的表连列元数据都没有（只剩一列 geom），
    // 于是上层会报「字段 group 不存在」（其实图层有那列）、「几何族无法确认（需 spatial 扩展）」
    // （其实扩展好着，是图层空）——模型会把这些错因照转给用户。说清真正的原因。
    if (temporary && layer.geojson.features.length === 0) {
      throw new Error(`图层 ${layer.id} 没有要素（0 行），无法在其上做筛选/统计（请先确认筛选条件是否过窄）`)
    }
    return { layer: { ...layer, duckTable: table }, release: async () => { if (temporary) await engine.dropTable(temporary) } }
  } catch (err) {
    if (temporary) await engine.dropTable(temporary).catch(() => {})
    throw err
  }
}
