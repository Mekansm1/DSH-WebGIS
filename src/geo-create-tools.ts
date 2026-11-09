import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { featureCollection, lineString, point, polygon } from '@turf/helpers'
import type { Feature, Geometry } from 'geojson'
import { MAX_POINT_BATCH } from './geo-limits.js'
import type { GeoToolRuntime } from './geo-tools-runtime.js'

type LngLat = [number, number]
const MAX_RING_VERTICES = 1000

function isLngLat(value: unknown): value is LngLat {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [lng, lat] = value
  return Number.isFinite(lng) && lng >= -180 && lng <= 180
    && Number.isFinite(lat) && lat >= -90 && lat <= 90
}

function samePosition(a: LngLat, b: LngLat): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function cross(a: LngLat, b: LngLat, c: LngLat): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/** 线段包围盒相交，且两条线段分别跨越对方的延长线。包含相切与共线重叠。 */
function segmentsMeet(a: LngLat, b: LngLat, c: LngLat, d: LngLat): boolean {
  return Math.max(a[0], b[0]) >= Math.min(c[0], d[0]) && Math.max(c[0], d[0]) >= Math.min(a[0], b[0])
    && Math.max(a[1], b[1]) >= Math.min(c[1], d[1]) && Math.max(c[1], d[1]) >= Math.min(a[1], b[1])
    && Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) <= 0
    && Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) <= 0
}

function isSimpleRing(ring: LngLat[]): boolean {
  const edgeCount = ring.length - 1
  for (let i = 0; i < edgeCount; i++) {
    // 相邻边本来就共享顶点。首尾边也相邻。
    const end = i === 0 ? edgeCount - 1 : edgeCount
    for (let j = i + 2; j < end; j++) {
      if (segmentsMeet(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) return false
    }
  }
  return true
}

type BuildFeature = (coordinates: unknown) => Feature<Geometry> | string

const buildPoint: BuildFeature = (coordinates) => isLngLat(coordinates)
  ? point(coordinates)
  : '点坐标必须为 [经度, 纬度]，经度 −180 到 180，纬度 −90 到 90。'

const buildLine: BuildFeature = (coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(isLngLat)) {
    return '线需要至少两个合法的 [经度, 纬度] 坐标。'
  }
  const first = coordinates[0]!
  if (coordinates.every((position) => samePosition(position, first))) return '线需要至少两个不同的点。'
  return lineString(coordinates)
}

const buildPolygon: BuildFeature = (coordinates) => {
  if (!Array.isArray(coordinates) || coordinates.length < 3 || !coordinates.every(isLngLat)) {
    return '面需要至少三个合法的 [经度, 纬度] 顶点。'
  }
  const first = coordinates[0]!
  const vertices = samePosition(first, coordinates.at(-1)!) ? coordinates.slice(0, -1) : coordinates
  if (vertices.length < 3 || vertices.length > MAX_RING_VERTICES) return `面需要 3 到 ${MAX_RING_VERTICES} 个顶点。`
  if (new Set(vertices.map(([lng, lat]) => `${lng},${lat}`)).size !== vertices.length) return '面边界有重复顶点。'
  const ring = [...vertices, first]
  if (!isSimpleRing(ring)) return '面边界存在自相交，请按边界顺序提供顶点。'
  const twiceArea = vertices.reduce((area, vertex, i) => area + cross(first, vertex, ring[i + 1]!), 0)
  if (twiceArea === 0) return '面面积为零，请提供不共线的边界顶点。'
  return polygon([twiceArea > 0 ? ring : ring.reverse()])
}

function namedFeature(build: BuildFeature, coordinates: unknown, name: unknown, properties: unknown, fallbackName: string): Feature<Geometry, Record<string, unknown> & { name: string }> | string {
  if (properties !== undefined && (properties === null || typeof properties !== 'object' || Array.isArray(properties))) {
    return 'properties 必须是 JSON 对象。'
  }
  const feature = build(coordinates)
  if (typeof feature === 'string') return feature
  const attrs = { ...properties } as Record<string, unknown>
  const propertyName = typeof attrs.name === 'string' ? attrs.name.trim() : ''
  return { ...feature, properties: { ...attrs, name: (typeof name === 'string' ? name.trim() : '') || propertyName || fallbackName } }
}

export function registerCreateTools(ctx: Context, rt: GeoToolRuntime): void {
  const tools = [
    { kind: 'point', label: '点', coordinates: '[经度, 纬度]', build: buildPoint },
    { kind: 'line', label: '线', coordinates: '按连线顺序排列的 [[经度, 纬度], ...]，至少两个不同的点', build: buildLine },
    { kind: 'polygon', label: '面', coordinates: `按外边界顺序排列的 [[经度, 纬度], ...]，3 到 ${MAX_RING_VERTICES} 个顶点，自动闭合`, build: buildPolygon },
  ]
  for (const { kind, label, coordinates, build } of tools) {
    ctx.tools.register(defineTool({
      name: `webgis_create_${kind}`,
      description: `用已知的 WGS84 经纬度创建${label}要素并加载为当前会话的新图层。坐标顺序为经度、纬度，坐标未知时不要猜测。`
        + (kind === 'point' ? '单点传 coordinates，多个点传 points。可以直接用 webgis_locate_map_points 返回的 points。' : ''),
      parameters: {
        coordinates: { type: 'json', ...(kind === 'point' ? {} : { required: true as const }), description: coordinates },
        ...(kind === 'point' ? {
          points: { type: 'json', description: `批量点列表（1 到 ${MAX_POINT_BATCH} 项），每项有 coordinates: [经度, 纬度]，可附 name 和 properties。与单点 coordinates 二选一。` } as const,
        } : {}),
        name: { type: 'string', description: '图层名称。创建单个要素时也用作要素名称。' },
        properties: { type: 'json', description: '可选的要素属性 JSON 对象，例如 {"类型":"示意"}' },
      },
      output: { schema: rt.LAYER_RESULT_SCHEMA, render: (_args, value) => rt.text(JSON.stringify(value)) },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (kind === 'point' && args.points !== undefined) {
          if (args.coordinates !== undefined || args.properties !== undefined) {
            return { ok: false, message: '批量创建请只传 points，并将属性放到对应点内。' }
          }
          if (!Array.isArray(args.points) || args.points.length === 0 || args.points.length > MAX_POINT_BATCH) {
            return { ok: false, message: `points 必须包含 1 到 ${MAX_POINT_BATCH} 个点。` }
          }
          const features: Feature<Geometry>[] = []
          for (const [i, entry] of args.points.entries()) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
              return { ok: false, message: `第 ${i + 1} 个点必须是含 coordinates 的对象。` }
            }
            const feature = namedFeature(buildPoint, entry.coordinates, entry.name, entry.properties, `点要素 ${i + 1}`)
            if (typeof feature === 'string') return { ok: false, message: `第 ${i + 1} 个点：${feature}` }
            features.push(feature)
          }
          return rt.sess(exec).pushResult('创建点', featureCollection(features), args.name?.trim() || '点要素')
        }
        const feature = namedFeature(build, args.coordinates, args.name, args.properties, `${label}要素`)
        if (typeof feature === 'string') return { ok: false, message: feature }
        return rt.sess(exec).pushResult(`创建${label}`, featureCollection([feature]), feature.properties.name)
      },
    }))
  }
}
