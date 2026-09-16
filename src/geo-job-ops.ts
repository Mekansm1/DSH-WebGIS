/**
 * 隔离计算任务的**定义与执行映射** —— worker 与主线程回退跑的是同一个函数。
 *
 * ## 为什么要把这个 switch 抽出来
 * 原先每个工具调用点是 `runGeoJob ? await runGeoJob(job, 28_000) : opX(...)` ——
 * job→op 的映射因此存在**两份**:一份隐式散在 14 个调用点的 `: opX(...)` 里,
 * 一份在 `geo-worker.ts` 的 switch 里。两份靠人保持一致,迟早分叉。
 *
 * 抽成 `runGeoJobLocal` 之后:
 * - worker 内:解码扁平载荷 → `runGeoJobLocal(job)`
 * - 主线程回退(未注入执行器 / 规模门控判定"不值得隔离"):直接 `runGeoJobLocal(job)`
 * → **两条路必然同语义**,因为它们是同一个函数。
 *
 * ## 边界
 * - 本文件**不依赖 Cordis / 会话状态 / DuckDB** —— worker 里跑得起来是硬要求。
 * - 入参 `GeoWorkerJob` 里的图层部分只带 `geojson`(见 `GeoInput` 的注释),层元数据不进 worker。
 */
import {
  opBuffer, opClip, opDifference, opDissolve, opIntersect, opRegularGrid, opSelectByLocation, opSimplify,
  opSpatialJoin, opUnion, opVoronoi, type GeoInput,
} from './geo-processing.js'
import type { BBox } from 'geojson'
import { opAverageNearestNeighbor, opKernelDensity, opLocalMoranI, opMoranI } from './geo-stats.js'
import { opGetisOrd } from './geo-indices.js'

/** worker 支持的 job kind 字面量(`clip|intersect|difference|union` 共用一个成员)。 */
export type GeoJobKind =
  | 'buffer' | 'dissolve' | 'simplify'
  | 'clip' | 'intersect' | 'difference' | 'union'
  | 'spatialJoin' | 'selectByLocation'
  | 'voronoi' | 'regularGrid'
  | 'kernelDensity' | 'ann' | 'moran' | 'localMoran' | 'getisOrd'

/**
 * 隔离执行的计算任务。
 *
 * 图层型 job 只携带 `GeoInput`(即 `{ geojson }`)—— **不是** `GisLayer`。这是刻意的:
 * worker 里没有层元数据可用,类型上就写不出来,免得有人加了句 `layer.name` 而两边行为分叉。
 */
export type GeoWorkerJob =
  | { kind: 'buffer'; layer: GeoInput; distance: number; unit: string }
  | { kind: 'dissolve'; layer: GeoInput; field?: string }
  | { kind: 'simplify'; layer: GeoInput; tolerance: number; highQuality: boolean }
  | { kind: 'clip' | 'intersect' | 'difference' | 'union'; a: GeoInput; b: GeoInput }
  | { kind: 'spatialJoin'; target: GeoInput; join: GeoInput; relation: 'contains' | 'within' | 'intersects' }
  | { kind: 'selectByLocation'; layer: GeoInput; relation: 'contains' | 'within' | 'intersects'; overlay?: GeoInput; bbox?: [number, number, number, number] }
  | { kind: 'voronoi'; layer: GeoInput; bbox?: BBox }
  /** ⚠️ 唯一**没有几何入参**的 job —— 它的规模由 bbox+cellSize 决定,与图层无关。 */
  | { kind: 'regularGrid'; bbox: BBox; cellSize: number; unit: string }
  | { kind: 'kernelDensity'; geojson: GeoJSON.FeatureCollection; radius: number; cell: number }
  | { kind: 'ann'; geojson: GeoJSON.FeatureCollection }
  | { kind: 'moran' | 'localMoran'; geojson: GeoJSON.FeatureCollection; field: string; options: Record<string, unknown> }
  | { kind: 'getisOrd'; geojson: GeoJSON.FeatureCollection; field: string; options: Record<string, unknown> }

/**
 * 在**当前线程**执行一个 job。worker 内与主线程回退共用本函数 ——
 * 所以"隔离"与"不隔离"只影响在哪个线程跑,不影响算出什么。
 */
export function runGeoJobLocal(job: GeoWorkerJob): unknown {
  switch (job.kind) {
    case 'buffer': return opBuffer(job.layer, job.distance, job.unit)
    case 'dissolve': return opDissolve(job.layer, job.field)
    case 'simplify': return opSimplify(job.layer, job.tolerance, job.highQuality)
    case 'clip': return opClip(job.a, job.b)
    case 'intersect': return opIntersect(job.a, job.b)
    case 'difference': return opDifference(job.a, job.b)
    case 'union': return opUnion(job.a, job.b)
    case 'spatialJoin': return opSpatialJoin(job.target, job.join, job.relation)
    case 'selectByLocation': return opSelectByLocation(job.layer, job.relation, job.overlay, job.bbox)
    case 'voronoi': return opVoronoi(job.layer, job.bbox)
    case 'regularGrid': return opRegularGrid(job.bbox, job.cellSize, job.unit)
    case 'kernelDensity': return opKernelDensity(job.geojson, job.radius, job.cell)
    case 'ann': return opAverageNearestNeighbor(job.geojson)
    case 'moran': return opMoranI(job.geojson, job.field, job.options as never)
    case 'localMoran': return opLocalMoranI(job.geojson, job.field, job.options as never)
    case 'getisOrd': return opGetisOrd(job.geojson, job.field, job.options as never)
  }
}
