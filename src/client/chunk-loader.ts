/**
 * 懒 chunk 加载器（跨 bundle 交换模块对象的唯一通道）。
 *
 * DSH 客户端是自研 `window.__ModuleLoader__.load({ id, factory(require) })` CJS 模块表 loader：
 *  - 运行时对**新 id** 再调 `load()` 会被接受，但 factory **不会同步执行**（store-until-required）；
 *  - 触发 factory 执行并取回 exports 的唯一途径 = loader 的 require（由 bundle 的 intro 捕获到
 *    `window.__dshWebgisAsync._r`，见 tsdown.config.ts 的 INTRO）。
 *
 * 因此按需加载协议：
 *  1. ensure(name) 注入 `<script src="/webgis/<name>.js">`（该文件顶层即 `load({ id:'dsh-webgis/<name>' })`）；
 *  2. 用捕获的 loader require 解析 `dsh-webgis/<name>` → 触发 chunk factory 执行（其顶层 require('react')
 *     从 loader 模块表解析，全页共享单 React）并返回 module.exports；
 *  3. chunk 入口还可额外 `registerChunk(name, api)` 自注册（双通道判重，谁先到用谁）。
 *
 * 所有 bundle（shell / 各 chunk）都会内联本文件一份实现，但共享 `window.__dshWebgisAsync` 单例：
 * 模块无状态、无身份，跨 bundle 复制安全。
 */

/** chunk 入口导出的 API 对象（Phase 5 各 chunk 填入实际组件/工厂）。 */
export type ChunkApi = Record<string, unknown>

interface AsyncRegistry {
  /** 已注册的模块（registerChunk 或 require 返回值缓存）。 */
  _m: Record<string, ChunkApi>
  /** 进行中的 ensure Promise（并发判重）。 */
  _p: Record<string, Promise<ChunkApi>>
  /** 由 bundle intro 捕获的 loader require（`dsh-webgis/<name>` 解析 + 触发 factory）。 */
  _r: ((id: string) => unknown) | null
}

const KEY = '__dshWebgisAsync'

function registry(): AsyncRegistry {
  const g = globalThis as unknown as Record<string, AsyncRegistry | undefined>
  const existing = g[KEY]
  if (existing) return existing
  const created: AsyncRegistry = { _m: {}, _p: {}, _r: null }
  g[KEY] = created
  return created
}

/** 全局单例（供 intro / 调试 / 测试访问同一对象）。 */
export function asyncRegistry(): AsyncRegistry {
  return registry()
}

/** chunk 自注册（可选通道；require 通道优先）。 */
export function registerChunk(name: string, api: ChunkApi): void {
  registry()._m[name] = api
}

/** loader id 与 HTTP 文件名的映射。 */
const CHUNK_FILES: Record<string, string> = {
  gis: 'gis.js',
  deck: 'deck.js',
  draw: 'draw.js',
  export: 'export.js',
}

/**
 * 按需加载一个懒 chunk：注入脚本 → 用捕获的 loader require 触发 factory 并取回模块。
 * 幂等（同名并发共享同一 Promise）；失败可重试（失败后清 _p）。
 * @param name chunk 名（gis/deck/draw/export）
 * @param timeoutMs 超时（默认 15s）
 */
export function ensure(name: string, timeoutMs = 15000): Promise<ChunkApi> {
  const r = registry()
  if (r._m[name]) return Promise.resolve(r._m[name])
  const pending = r._p[name]
  if (pending) return pending

  const file = CHUNK_FILES[name] ?? `${name}.js`
  const id = `dsh-webgis/${name}`
  const p = new Promise<ChunkApi>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    let scriptInjected = false
    let finished = false

    const settle = (fn: () => void): void => {
      if (finished) return
      finished = true
      fn()
    }

    /** 尝试两条通道取模块：registerChunk 已注册 / loader require 解析。 */
    const tryGet = (): ChunkApi | undefined => {
      if (r._m[name]) return r._m[name]
      if (r._r) {
        try {
          const mod = r._r(id)
          if (mod && typeof mod === 'object') {
            const api = mod as ChunkApi
            r._m[name] = api // 缓存，二次 ensure 秒回
            return api
          }
        } catch {
          // 未注册/未就绪：下一拍再试
        }
      }
      return undefined
    }

    const injectScript = (): void => {
      if (scriptInjected) return
      scriptInjected = true
      const s = document.createElement('script')
      s.src = `/webgis/${file}`
      s.async = true
      s.onerror = () => settle(() => reject(new Error(`chunk ${name} 脚本加载失败（${file}）`)))
      document.head.appendChild(s)
    }

    const step = (): void => {
      if (finished) return
      const got = tryGet()
      if (got) return settle(() => resolve(got))
      if (Date.now() >= deadline) return settle(() => reject(new Error(`chunk ${name} 加载超时`)))
      injectScript()
      setTimeout(step, 60)
    }
    step()
  })
  r._p[name] = p
  p.catch(() => {
    // 失败释放占位，允许下次重试
    if (r._p[name] === p) delete r._p[name]
  })
  return p
}

/** 已加载且仍在内存的 chunk 是否就绪（同步查询，用于避免重复 ensure 前的快速路径判断）。 */
export function isChunkLoaded(name: string): boolean {
  return !!registry()._m[name]
}
