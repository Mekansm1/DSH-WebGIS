// 构建后把 maplibre 的 CSS 与 worker 脚本复制到 assets/，由 host 白名单路由提供。
// 避免在 client bundle 里打包 CSS/worker 的复杂问题。
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))

// 从 node_modules/maplibre-gl/dist 解析（maplibre-gl 是 devDependency，构建期可用）
const distDir = resolve(dirname(require.resolve('maplibre-gl/package.json')), 'dist')

const targets = [
  ['maplibre-gl.css', join(root, 'assets', 'maplibre-gl.css')],
  ['maplibre-gl-csp-worker.js', join(root, 'assets', 'maplibre-gl-csp-worker.js')],
]

for (const [name, out] of targets) {
  mkdirSync(dirname(out), { recursive: true })
  copyFileSync(join(distDir, name), out)
  console.log(`copied ${name} -> ${out}`)
}

// GeoArrow earcut worker（面图层百万级并行三角剖分）。geoarrow-js 的 dist 子路径被 exports 挡住，
// 走入口解析定位包根 dist 目录。缺失不阻断构建（面 earcut 回落主线程）。
try {
  const gjsEntry = require.resolve('@geoarrow/geoarrow-js')
  const worker = join(dirname(gjsEntry), 'earcut-worker.min.js')
  const out = join(root, 'assets', 'earcut-worker.min.js')
  mkdirSync(dirname(out), { recursive: true })
  copyFileSync(worker, out)
  console.log('copied earcut-worker.min.js')
} catch (err) {
  console.warn('earcut worker 未找到（@geoarrow/geoarrow-js 缺失），面图层 earcut 走主线程兜底')
}
