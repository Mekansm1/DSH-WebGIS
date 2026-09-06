/**
 * dsh-webgis 客户端 bundle 构建配置（复刻 DSH 仓库 tsdown.client.ts 的 clientConfig）。
 * 产物为 CJS closure-factory：window.__ModuleLoader__.load({ id, factory })
 * externals 全部来自 DSH shell 冻结的模块表；其余依赖（maplibre-gl 等）内联进 bundle。
 *
 * 按需加载（多 chunk）：shell（id dsh-webgis，lib/client.js）启动即 load；懒 chunk
 * （gis/deck/draw/export）各自独立 cfg、outDir=assets、运行时由 shell 注入 <script> 二次 load。
 * 所有 cfg 保持 clean:false（clean 会清掉 tsc 逐文件产物与 assets/ 下 check-in 文件）。
 *
 * node 内置模块 shim 写法约定：各 shim 必须是「单个自包含对象 + default + 每属性具名导出」。
 * rolldown 会把「export default {…} 引用模块内具名函数」改成惰性 __esmMin，并把只被 default
 * 引用的具名函数判为未用剪掉 → 惰性体内留下悬空简写，模块一初始化就 ReferenceError（如 os.freemem）。
 * 自包含对象的方法体不引用任何模块级绑定，default 引用对象整体，剪谁都不悬空。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = 'dsh-webgis'

/** DSH shell 冻结的平台模块表（packages/client/web/src/platform.ts）。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** 文档化的临时豁免：runtime store 引擎。 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** 可内联的 @deepseek-ai wire/type 层（无共享运行时身份）。 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
/** 转售给 @deepseek-ai scope 的普通库（无共享身份，直接内联）。 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Node 内置模块的浏览器 shim（值即虚拟模块源码）。只保证加载 + 顶层执行不炸，深度用法不触发。 */
const NODE_SHIMS: Record<string, string> = {
  worker_threads: [
    '// threads / @loaders.gl Node 分支空实现（浏览器环境，见 tsdown.config.ts）',
    'export const Worker = class Worker { terminate() {} };',
    'export const parentPort = null;',
  ].join('\n'),
  events: [
    '// node:events 空实现（threads node 分支顶层仅 require，EventEmitter 用法在 worker/earcut 路径不触发）',
    'const _obj = {',
    '  EventEmitter: class {',
    '    constructor() { this._events = Object.create(null) }',
    '    on(ev, fn) { (this._events[ev] ??= []).push(fn); return this }',
    '    addListener(ev, fn) { return this.on(ev, fn) }',
    '    once(ev, fn) { return this.on(ev, fn) }',
    '    prependListener(ev, fn) { return this.on(ev, fn) }',
    '    prependOnceListener(ev, fn) { return this.on(ev, fn) }',
    '    off() { return this }',
    '    removeListener() { return this }',
    '    removeAllListeners() { return this }',
    '    emit() { return false }',
    '    listeners() { return [] }',
    '    rawListeners() { return [] }',
    '    listenerCount() { return 0 }',
    '    eventNames() { return Object.keys(this._events) }',
    '    setMaxListeners() { return this }',
    '    getMaxListeners() { return 10 }',
    '  },',
    '};',
    'export default _obj;',
    'export const EventEmitter = _obj.EventEmitter;',
  ].join('\n'),
  os: [
    '// node:os 空实现（threads node 分支顶层 `os.cpus().length`，需 cpus() 返回数组）',
    'const _obj = {',
    '  EOL: "\\n",',
    '  cpus: () => [],',
    '  platform: () => "browser",',
    '  homedir: () => "/",',
    '  tmpdir: () => "/",',
    '  arch: () => "x64",',
    '  type: () => "Browser",',
    '  release: () => "",',
    '  hostname: () => "localhost",',
    '  freemem: () => 0,',
    '  totalmem: () => 0,',
    '};',
    'export default _obj;',
    'export const EOL = _obj.EOL;',
    'export const cpus = _obj.cpus;',
    'export const platform = _obj.platform;',
    'export const homedir = _obj.homedir;',
    'export const tmpdir = _obj.tmpdir;',
    'export const arch = _obj.arch;',
    'export const type = _obj.type;',
    'export const release = _obj.release;',
    'export const hostname = _obj.hostname;',
    'export const freemem = _obj.freemem;',
    'export const totalmem = _obj.totalmem;',
  ].join('\n'),
  path: [
    '// node:path 空实现（threads node 分支 __importStar(require("path")) 顶层遍历导出）',
    'function _norm(p) { return String(p == null ? "" : p).replace(/\\\\/g, "/") }',
    'const _obj = {',
    '  sep: "/",',
    '  delimiter: ":",',
    '  join() { return Array.prototype.filter.call(arguments, (a) => a != null && a !== "").join("/").replace(/\\/+/g, "/") || "/" },',
    '  resolve() { return Array.prototype.filter.call(arguments, (a) => a != null && a !== "").join("/").replace(/\\/+/g, "/") || "/" },',
    '  normalize(p) { return _norm(p) },',
    '  dirname(p) { const s = _norm(p).split("/"); s.pop(); return s.join("/") || "." },',
    '  basename(p, ext) { const b = _norm(p).split("/").pop() || ""; return ext && b.endsWith(String(ext)) ? b.slice(0, -String(ext).length) : b },',
    '  extname(p) { const b = _norm(p).split("/").pop() || ""; const i = b.lastIndexOf("."); return i > 0 ? b.slice(i) : "" },',
    '  isAbsolute(p) { return /^\\//.test(String(p)) },',
    '};',
    'export default _obj;',
    'export const sep = _obj.sep;',
    'export const delimiter = _obj.delimiter;',
    'export const join = _obj.join;',
    'export const resolve = _obj.resolve;',
    'export const normalize = _obj.normalize;',
    'export const dirname = _obj.dirname;',
    'export const basename = _obj.basename;',
    'export const extname = _obj.extname;',
    'export const isAbsolute = _obj.isAbsolute;',
  ].join('\n'),
  url: [
    '// node:url 空实现（threads node 分支顶层仅 require，URL 用法在 worker 路径不触发）',
    'const _obj = {',
    '  URL: class {',
    '    constructor(href = "") { this.href = String(href) }',
    '    toString() { return this.href }',
    '  },',
    '  fileURLToPath(u) { const s = String(u); return s.startsWith("file://") ? s.slice(7) : s },',
    '  pathToFileURL(p) { return { href: "file://" + String(p), toString() { return this.href } } },',
    '};',
    'export default _obj;',
    'export const URL = _obj.URL;',
    'export const fileURLToPath = _obj.fileURLToPath;',
    'export const pathToFileURL = _obj.pathToFileURL;',
  ].join('\n'),
  util: [
    '// node:util 空实现（debug 包 node 分支 require，浏览器里仅兜底）',
    'const _obj = {',
    '  inspect(v) { try { return JSON.stringify(v) } catch { return String(v) } },',
    '  format(f) { if (typeof f !== "string") return String(f); return f.replace(/%[sdjifoO%]/g, (m) => m === "%%" ? "%" : String(arguments[1 + [].slice.call(arguments, 1).indexOf(undefined)] ?? "")) },',
    '  isArray(a) { return Array.isArray(a) },',
    '  inherits(c, s) { Object.setPrototypeOf(c.prototype, s.prototype) },',
    '  promisify() {},',
    '  types: { isAnyArrayBuffer() { return false } },',
    '  TextEncoder: class {},',
    '  TextDecoder: class {},',
    '};',
    'export default _obj;',
    'export const inspect = _obj.inspect;',
    'export const format = _obj.format;',
    'export const isArray = _obj.isArray;',
    'export const inherits = _obj.inherits;',
    'export const promisify = _obj.promisify;',
    'export const types = _obj.types;',
    'export const TextEncoder = _obj.TextEncoder;',
    'export const TextDecoder = _obj.TextDecoder;',
  ].join('\n'),
  tty: [
    '// node:tty 空实现（debug 包 node 分支 require，浏览器恒非终端）',
    'const _obj = {',
    '  isatty() { return false },',
    '};',
    'export default _obj;',
    'export const isatty = _obj.isatty;',
  ].join('\n'),
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** 把 tsc 产物的 lib/ 路径回退到源码 src/（保留子路径）。 */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolve(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolve(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

/** Node 内置模块 shim 插件（同一逻辑多 cfg 复用）。 */
function makeNodeShimPlugin() {
  return {
    name: 'dsh-webgis-node-builtin-shims',
    resolveId(source: string) {
      const id = NODE_SHIMS[source]
      return id ? `\0dsh-shim:${source}` : null
    },
    load(id: string) {
      const name = id.startsWith('\0dsh-shim:') ? id.slice('\0dsh-shim:'.length) : null
      return name ? NODE_SHIMS[name] : null
    },
  }
}

/** bundle 纯度门插件（平台模块 external；wire/类型层内联；其余 @deepseek-ai 值导入即构建错误）。 */
function makePurityPlugin() {
  return {
    name: 'dsh-webgis-client-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source)) return null
      if (VENDORED_LIBRARY.test(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" is not a platform module, inline-safe wire layer, `
        + 'or generated /remote contribution — cross-plugin value imports are forbidden',
      )
    },
  }
}

/** CSS Modules 内联插件（lightningcss 编译 + <style data-plugin> 注入 + class map；同一逻辑多 cfg 复用）。 */
function makeCssInlinePlugin() {
  return {
    name: 'dsh-webgis-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      const tagId = `${PLUGIN_ID}/${basename(fileId)}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
        `  const tag = document.createElement('style');`,
        `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/**
 * 产物 intro：把 loader 下发给本 factory 的 require 挂到 async 注册表。
 * chunk 运行时二次 load 后，shell 用这个捕获的 require 解析 `dsh-webgis/<name>` 即可
 * 触发 chunk factory 执行（其中顶层 require('react') 从 loader 模块表解析，共享单 React）并取回 exports。
 */
const INTRO = `var module = { exports: {} }; var exports = module.exports;`
  + ` (function (g) { if (!g.__dshWebgisAsync) g.__dshWebgisAsync = { _m: {}, _p: {}, _r: null };`
  + ` if (typeof require === 'function') g.__dshWebgisAsync._r = require; })(typeof window !== 'undefined' ? window : globalThis);`

type ChunkOpts = {
  name: string
  entry: Record<string, string>
  outDir: 'lib' | 'assets'
  outFile: string
  id: string
}

function makeClientConfig(o: ChunkOpts): UserConfig {
  return {
    name: o.name,
    entry: o.entry,
    outDir: o.outDir,
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: false,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [makeNodeShimPlugin(), makePurityPlugin(), makeCssInlinePlugin()],
    outputOptions: {
      entryFileNames: o.outFile,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(o.id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: INTRO,
    },
  }
}

const configs: UserConfig[] = [
  // shell：DSH 启动即 load 的主 bundle（出口 lib/client.js 由 package exports `./client` 指向）。
  makeClientConfig({
    name: `${PLUGIN_ID}/client`,
    entry: { client: 'lib/client/index.js' },
    outDir: 'lib',
    outFile: 'client.js',
    id: PLUGIN_ID,
  }),
  // 懒 chunk：运行时注入 <script> 二次 load（详见 src/client/chunk-loader.ts）。文件直写 assets/ 供 serveAsset 下发。
  makeClientConfig({
    name: `${PLUGIN_ID}/gis`,
    entry: { gis: 'lib/client/chunks/gis.js' },
    outDir: 'assets',
    outFile: 'gis.js',
    id: `${PLUGIN_ID}/gis`,
  }),
  makeClientConfig({
    name: `${PLUGIN_ID}/deck`,
    entry: { deck: 'lib/client/chunks/deck.js' },
    outDir: 'assets',
    outFile: 'deck.js',
    id: `${PLUGIN_ID}/deck`,
  }),
  makeClientConfig({
    name: `${PLUGIN_ID}/draw`,
    entry: { draw: 'lib/client/chunks/draw.js' },
    outDir: 'assets',
    outFile: 'draw.js',
    id: `${PLUGIN_ID}/draw`,
  }),
  makeClientConfig({
    name: `${PLUGIN_ID}/export`,
    entry: { export: 'lib/client/chunks/export.js' },
    outDir: 'assets',
    outFile: 'export.js',
    id: `${PLUGIN_ID}/export`,
  }),
]

export default configs
