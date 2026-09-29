import type { GisLayer } from '../geo-processing.js'
import type { FullTableAttrFilterOk } from '../geo-tools-runtime.js'
import type { DuckDbEngine } from './engine.js'
import { acquireLayer, type LayerLease } from './layer-access.js'
import { filterDuckLayer } from './attr-filter.js'
import { rowGeomExprOf, duckTableFullBBox, quoteIdent } from './geometry.js'

/** 位置筛选的全表分支：任一侧为抽样时，两侧都使用完整数据。 */
export async function filterFullLocation(engine: DuckDbEngine, layer: GisLayer, relation: string, overlay?: GisLayer, bbox?: number[]): Promise<FullTableAttrFilterOk | { ok: false; message: string }> {
  let source: LayerLease | undefined, other: LayerLease | undefined
  let result: string | undefined
  try {
    if (!(await engine.ensureSpatial())) throw new Error('位置筛选需要 spatial 扩展')
    source = await acquireLayer(engine, layer)
    const shape = { coords: source.layer.duckCoords, geom: source.layer.duckGeom }
    const g = rowGeomExprOf(shape, source.layer.duckTable)
    const predicate = relation === 'contains' ? 'ST_Contains' : relation === 'within' ? 'ST_Within' : 'ST_Intersects'
    let clause: string
    if (overlay) {
      other = await acquireLayer(engine, overlay)
      const h = rowGeomExprOf({ coords: other.layer.duckCoords, geom: other.layer.duckGeom }, '__other')
      clause = `EXISTS (SELECT 1 FROM ${quoteIdent(other.layer.duckTable)} __other WHERE ${predicate}(${g}, ${h}))`
    } else {
      if (!bbox || bbox.length !== 4 || !bbox.every(Number.isFinite) || bbox[0]! > bbox[2]! || bbox[1]! > bbox[3]!) throw new Error('bbox 需合法 [west,south,east,north]')
      clause = `${predicate}(${g}, ST_MakeEnvelope(${bbox.join(',')}))`
    }
    const res = await filterDuckLayer(engine, source.layer, `WHERE ${clause}`)
    if (!res.ok) return res
    result = res.table
    const fullBbox = await duckTableFullBBox(engine, res.table, shape)
    const out: FullTableAttrFilterOk = { ...res, extra: { duckTable: res.table, duckCoords: res.duckCoords, duckGeom: res.duckGeom, totalCount: res.count, fullBbox } }
    result = undefined
    return out
  } catch (err) {
    return { ok: false, message: `位置筛选失败：${err instanceof Error ? err.message : String(err)}` }
  } finally {
    if (result) await engine.dropTable(result).catch(() => {})
    await other?.release()
    await source?.release()
  }
}
