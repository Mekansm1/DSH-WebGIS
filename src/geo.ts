// @ts-nocheck —— 本项目启用了 noUncheckedIndexedAccess，纯矩阵运算逐位索引
// 会遍地报 undefined；此模块为无地形相机数学的忠实移植，正确性由
// 独立单测（roundtrip / 与 maplibre 数值对照）保证，导出签名仍被 index.ts 校验。
/**
 * 纯函数投影数学：截图像素 ↔ 经纬度互转（host 侧）。
 *
 * 从 maplibre-gl 的 Transform（src/geo/transform.ts）移植，
 * 只实现无地形（elevation=0）、无中心偏移（centerOffset=[0,0]）的情形，
 * 结果与浏览器里 maplibre 的 map.project / map.unproject 一致。
 */

/** 相机视野角（maplibre 默认，弧度）。 */
const FOV = 0.6435011087932844
/** Web Mercator 有效纬度上限。 */
const MAX_VALID_LATITUDE = 85.051129
/** 世界半径（米），maplibre 默认值。 */
const EARTH_RADIUS = 6371008.8

/** 截图那一刻的地图视口（css 像素尺寸，bearing/pitch 为角度）。 */
export interface GeoViewport {
  /** 地图容器 css 宽度。 */
  width: number
  /** 地图容器 css 高度。 */
  height: number
  zoom: number
  /** 顺时针方向角（度）。 */
  bearing: number
  pitch: number
  centerLng: number
  centerLat: number
}

// ---- Web Mercator ----

function mercatorXfromLng(lng: number): number {
  return (180 + lng) / 360
}

function mercatorYfromLat(lat: number): number {
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360
}

function lngFromMercatorX(x: number): number {
  return x * 360 - 180
}

function latFromMercatorY(y: number): number {
  const y2 = 180 - y * 360
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90
}

function mercatorZfromAltitude(altitude: number, lat: number): number {
  return altitude / (2 * Math.PI * EARTH_RADIUS * Math.cos((lat * Math.PI) / 180))
}

function clampLat(lat: number): number {
  return Math.max(-MAX_VALID_LATITUDE, Math.min(MAX_VALID_LATITUDE, lat))
}

function wrapLng(lng: number): number {
  const r = ((lng + 180) % 360) + 360
  return (r % 360) - 180
}

// ---- 4x4 矩阵（gl-matrix mat4 风格，column-major，Float64Array[16]）----

type Mat4 = Float64Array

function identity(): Mat4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16)
  out[0] = a[0] * b[0] + a[4] * b[1] + a[8] * b[2] + a[12] * b[3]
  out[1] = a[1] * b[0] + a[5] * b[1] + a[9] * b[2] + a[13] * b[3]
  out[2] = a[2] * b[0] + a[6] * b[1] + a[10] * b[2] + a[14] * b[3]
  out[3] = a[3] * b[0] + a[7] * b[1] + a[11] * b[2] + a[15] * b[3]
  out[4] = a[0] * b[4] + a[4] * b[5] + a[8] * b[6] + a[12] * b[7]
  out[5] = a[1] * b[4] + a[5] * b[5] + a[9] * b[6] + a[13] * b[7]
  out[6] = a[2] * b[4] + a[6] * b[5] + a[10] * b[6] + a[14] * b[7]
  out[7] = a[3] * b[4] + a[7] * b[5] + a[11] * b[6] + a[15] * b[7]
  out[8] = a[0] * b[8] + a[4] * b[9] + a[8] * b[10] + a[12] * b[11]
  out[9] = a[1] * b[8] + a[5] * b[9] + a[9] * b[10] + a[13] * b[11]
  out[10] = a[2] * b[8] + a[6] * b[9] + a[10] * b[10] + a[14] * b[11]
  out[11] = a[3] * b[8] + a[7] * b[9] + a[11] * b[10] + a[15] * b[11]
  out[12] = a[0] * b[12] + a[4] * b[13] + a[8] * b[14] + a[12] * b[15]
  out[13] = a[1] * b[12] + a[5] * b[13] + a[9] * b[14] + a[13] * b[15]
  out[14] = a[2] * b[12] + a[6] * b[13] + a[10] * b[14] + a[14] * b[15]
  out[15] = a[3] * b[12] + a[7] * b[13] + a[11] * b[14] + a[15] * b[15]
  return out
}

function invert(a: Mat4): Mat4 | null {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]

  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return null
  det = 1 / det

  const out = new Float64Array(16)
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return out
}

function translate(a: Mat4, v: [number, number, number]): Mat4 {
  const x = v[0], y = v[1], z = v[2]
  const out = new Float64Array(a)
  out[12] = a[0] * x + a[4] * y + a[8] * z + a[12]
  out[13] = a[1] * x + a[5] * y + a[9] * z + a[13]
  out[14] = a[2] * x + a[6] * y + a[10] * z + a[14]
  out[15] = a[3] * x + a[7] * y + a[11] * z + a[15]
  return out
}

function scale(a: Mat4, v: [number, number, number]): Mat4 {
  const x = v[0], y = v[1], z = v[2]
  const out = new Float64Array(16)
  out[0] = a[0] * x; out[1] = a[1] * x; out[2] = a[2] * x; out[3] = a[3] * x
  out[4] = a[4] * y; out[5] = a[5] * y; out[6] = a[6] * y; out[7] = a[7] * y
  out[8] = a[8] * z; out[9] = a[9] * z; out[10] = a[10] * z; out[11] = a[11] * z
  out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15]
  return out
}

function rotateX(a: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad), c = Math.cos(rad)
  const out = new Float64Array(a)
  out[4] = a[4] * c + a[8] * s
  out[5] = a[5] * c + a[9] * s
  out[6] = a[6] * c + a[10] * s
  out[7] = a[7] * c + a[11] * s
  out[8] = a[8] * c - a[4] * s
  out[9] = a[9] * c - a[5] * s
  out[10] = a[10] * c - a[6] * s
  out[11] = a[11] * c - a[7] * s
  out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15]
  return out
}

function rotateZ(a: Mat4, rad: number): Mat4 {
  const s = Math.sin(rad), c = Math.cos(rad)
  const out = new Float64Array(16)
  out[0] = a[0] * c + a[4] * s
  out[1] = a[1] * c + a[5] * s
  out[2] = a[2] * c + a[6] * s
  out[3] = a[3] * c + a[7] * s
  out[4] = a[4] * c - a[0] * s
  out[5] = a[5] * c - a[1] * s
  out[6] = a[6] * c - a[2] * s
  out[7] = a[7] * c - a[3] * s
  out[8] = a[8]; out[9] = a[9]; out[10] = a[10]; out[11] = a[11]
  out[12] = a[12]; out[13] = a[13]; out[14] = a[14]; out[15] = a[15]
  return out
}

function perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan(fovy / 2)
  const out = new Float64Array(16)
  out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0
  out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0
  out[8] = 0; out[9] = 0; out[10] = (far + near) / (near - far); out[11] = -1
  out[12] = 0; out[13] = 0; out[14] = (2 * far * near) / (near - far); out[15] = 0
  return out
}

// ---- 相机矩阵 ----

interface PixelMatrices {
  pixelMatrix: Mat4
  pixelMatrixInverse: Mat4
  worldSize: number
}

/** 按 maplibre Transform._calcMatrices 重建相机矩阵（elevation=0、centerOffset=0）。 */
function calcMatrices(v: GeoViewport): PixelMatrices {
  const { width, height, zoom, bearing, pitch, centerLng, centerLat } = v
  const halfFov = FOV / 2
  const angle = (-bearing * Math.PI) / 180
  const pitchRad = (pitch * Math.PI) / 180
  const worldSize = 512 * 2 ** zoom
  const cameraToCenterDistance = (0.5 / Math.tan(halfFov)) * height
  const pixelPerMeter = mercatorZfromAltitude(1, centerLat) * worldSize

  const cx = mercatorXfromLng(centerLng) * worldSize
  const cy = mercatorYfromLat(clampLat(centerLat)) * worldSize

  // farZ：无地形（elevation=0、minElevation=0）→ lowestPlane = cameraToCenterDistance
  const lowestPlane = cameraToCenterDistance
  const groundAngle = Math.PI / 2 + pitchRad
  const fovAboveCenter = halfFov
  const topHalfSurfaceDistance = (Math.sin(fovAboveCenter) * lowestPlane)
    / Math.sin(clamp(Math.PI - groundAngle - fovAboveCenter, 0.01, Math.PI - 0.01))
  const horizon = Math.tan(Math.PI / 2 - pitchRad) * cameraToCenterDistance * 0.85
  const horizonAngle = Math.atan(horizon / cameraToCenterDistance)
  const topHalfSurfaceDistanceHorizon = (Math.sin(horizonAngle) * lowestPlane)
    / Math.sin(clamp(Math.PI - groundAngle - horizonAngle, 0.01, Math.PI - 0.01))
  const topHalfMinDistance = Math.min(topHalfSurfaceDistance, topHalfSurfaceDistanceHorizon)
  const farZ = (Math.cos(Math.PI / 2 - pitchRad) * topHalfMinDistance + lowestPlane) * 1.01
  const nearZ = height / 50

  // labelPlaneMatrix = scale(width/2, -height/2, 1) · translate(1, -1, 0)
  let m = identity()
  m = scale(m, [width / 2, -height / 2, 1])
  m = translate(m, [1, -1, 0])
  const labelPlaneMatrix = m

  // 相机矩阵（同 maplibre _calcMatrices 顺序）
  m = perspective(FOV, width / height, nearZ, farZ)
  m = scale(m, [1, -1, 1])
  m = translate(m, [0, 0, -cameraToCenterDistance])
  m = rotateX(m, pitchRad)
  m = rotateZ(m, angle)
  m = translate(m, [-cx, -cy, 0])
  m = scale(m, [1, 1, pixelPerMeter])

  const pixelMatrix = multiply(labelPlaneMatrix, m)
  const pixelMatrixInverse = invert(pixelMatrix)!
  return { pixelMatrix, pixelMatrixInverse, worldSize }
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x))
}

// ---- 对外 API ----

/**
 * 经纬度 → 地图容器 css 像素坐标（screenshot 尺度下需再乘 scale）。
 * 结果与 maplibre map.project 一致。
 */
export function projectLngLatToCss(v: GeoViewport, lng: number, lat: number): { x: number; y: number } {
  const { pixelMatrix, worldSize } = calcMatrices(v)
  const mx = mercatorXfromLng(lng) * worldSize
  const my = mercatorYfromLat(clampLat(lat)) * worldSize
  // coordinatePoint(coord, 0)：p = [x, y, 0, 1] · pixelMatrix
  const p = transformMat4(pixelMatrix, [mx, my, 0, 1])
  return { x: p[0] / p[3], y: p[1] / p[3] }
}

/**
 * 地图容器 css 像素坐标 → 经纬度（screenshot 像素需先除以 scale）。
 * 结果与 maplibre map.unproject 一致。
 */
export function unprojectCssToLngLat(v: GeoViewport, x: number, y: number): { lng: number; lat: number } {
  const { pixelMatrixInverse, worldSize } = calcMatrices(v)
  // pointCoordinate：反投影 z=0 与 z=1 两点成射线，求 z=0 交点
  const c0 = transformMat4(pixelMatrixInverse, [x, y, 0, 1])
  const c1 = transformMat4(pixelMatrixInverse, [x, y, 1, 1])
  const w0 = c0[3], w1 = c1[3]
  const x0 = c0[0] / w0, x1 = c1[0] / w1
  const y0 = c0[1] / w0, y1 = c1[1] / w1
  const z0 = c0[2] / w0, z1 = c1[2] / w1
  const t = z0 === z1 ? 0 : -z0 / (z1 - z0)
  const mx = (x0 + (x1 - x0) * t) / worldSize
  const my = (y0 + (y1 - y0) * t) / worldSize
  return { lng: wrapLng(lngFromMercatorX(mx)), lat: latFromMercatorY(my) }
}

/** m · v（gl-matrix transformMat4）。 */
function transformMat4(m: Mat4, v: number[]): number[] {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
    m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
  ]
}
