/**
 * DuckDB host 引擎（:memory: 懒建 + 连接/建表/查询/Arrow IPC/抽样）。
 * 拆分自 src/duckdb.ts；类型见 ./types.js、几何与行转换见 ./geometry.js。
 */
import type { DuckColumn, DuckDbConn, DuckDbCtor, DuckDbHandle, DuckDbOptions, DuckDbRow, VectorTableInfo } from './types.js'
import { DUCK_RID, detectGeomColumn, detectGeomFormat, quoteIdent } from './geometry.js'

/**
 * DuckDB host 引擎：本地 CSV 的秒级加载 / 筛选 / 列式分析（方案见 D:\dsh webgis\DuckDB实现方案.md）。
 *
 * - 懒建 `:memory:` 库：首次真正查询才初始化，插件未用 DuckDB 时不占任何资源。
 * - 原生模块经 createRequire 加载（与阶段 0 基准脚本一致，避免 ESM/CJS 互操作坑）。
 * - 单条查询 Promise.race 兜底超时，防乱写 SQL 卡死宿主。
 * - LRU 总行数清理：超出 maxTotalRows 自动 DROP 最久未用的表。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Feature, FeatureCollection } from 'geojson'

const require = createRequire(import.meta.url)
// duckdb npm 包导出带 .Database 属性的构造函数（CJS）。用结构类型最小化依赖其 .d.ts 形状。

/**
 * duckdb 原生绑定缺失时的给 AI/用户的排障指引：pnpm(>=10) 默认拦截依赖 build 脚本，
 * duckdb.node 不会随插件自动生成；这几步放行并重建后无需重启即可重试（本进程不缓存失败）。
 */
const DUCKDB_SETUP_HINT =
  'duckdb 原生绑定未就绪。请在 DSH profile 目录（Windows 形如 C:\\Users\\<用户名>\\.dsh\\profiles\\web）执行：\n'
  + '  1) pnpm approve-builds   （勾选/确认 duckdb）\n'
  + '  2) pnpm rebuild duckdb\n'
  + '  3) pnpm install\n'
  + '若 pnpm rebuild 无效：进入 node_modules\\duckdb 目录执行 npm run install（需能访问 npm.duckdb.org）。完成后重试即可。'

/** 惰性加载 duckdb：只在首次真正建引擎时才 require 原生模块（缺 binding 不阻断插件启动）。 */
let duckCtorCache: DuckDbCtor | null = null
function loadDuckdb(): DuckDbCtor {
  if (duckCtorCache) return duckCtorCache
  try {
    duckCtorCache = require('duckdb') as DuckDbCtor
    return duckCtorCache
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/duckdb\.node|Cannot find module|binding/i.test(msg)) {
      throw new Error(`${msg}。${DUCKDB_SETUP_HINT}`)
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
}


interface TableRef {
  rows: number
  lastUsed: number
}



/** 大表建表/灌表（read_csv/ST_Read/子集 CTAS）的内部超时：千万级 × 几十列可能远超 30s 默认，放宽到 5 分钟。 */
const INGEST_TIMEOUT_MS = 300_000

export class DuckDbEngine {
  private db: DuckDbHandle | null = null
  private conn: DuckDbConn | null = null
  private readonly tables = new Map<string, TableRef>()
  private seq = 0
  private ingestSeq = 0
  private readonly opts: Required<DuckDbOptions>
  private spatialLoaded = false
  private spatialTried = false
  /** arrow 扩展（community 仓）：惰性加载；arrowIpc 失败回退调用方（JS 行路径）。 */
  private arrowLoaded = false
  private arrowTried = false

  constructor(opts: DuckDbOptions = {}) {
    this.opts = {
      papaparseThreshold: opts.papaparseThreshold ?? 50000,
      maxTotalRows: opts.maxTotalRows ?? 20_000_000,
      memoryLimit: opts.memoryLimit ?? '2GB',
      timeoutMs: opts.timeoutMs ?? 30_000,
    }
  }

  /** 小文件「常规加载」阈值（工具用它决定是否保留内存表）。 */
  get threshold(): number {
    return this.opts.papaparseThreshold
  }

  /** spatial 扩展是否已加载（in-polygon 等几何函数可用）。 */
  get hasSpatial(): boolean {
    return this.spatialLoaded
  }

  private init(): void {
    if (this.conn) return
    this.db = new (loadDuckdb().Database)(':memory:')
    this.conn = this.db.connect()
    // 可写 temp 目录：DuckDB 超出 memory_limit 需要 spill 落盘时，默认写到进程 CWD——宿主 CWD 常不可写，
    // 大表建表（如 168 万×22 列 union）会报「无法创建 .tmp」。显式指到 OS temp 并确保目录存在。
    const tmpDir = join(tmpdir(), 'dsh-webgis-duckdb').replace(/\\/g, '/')
    try { mkdirSync(tmpDir, { recursive: true }) } catch { /* 失败则交给 DuckDB 默认行为 */ }
    void this.exec(`SET temp_directory='${tmpDir}'`).catch(() => {})
    // 内存兜底防 OOM；失败不影响后续（继续尝试真实查询）。
    void this.exec(`SET memory_limit='${this.opts.memoryLimit.replace(/'/g, '')}'`).catch(() => {})
  }

  /**
   * 惰性加载 spatial 扩展（`INSTALL spatial` 首次需联网下载，之后本地缓存）。
   * 离线失败不抛（hasSpatial=false），由调用方决定降级；只试一次。
   */
  async ensureSpatial(): Promise<boolean> {
    if (this.spatialLoaded) return true
    if (this.spatialTried) return false
    this.spatialTried = true
    try {
      await this.exec('INSTALL spatial')
      await this.exec('LOAD spatial')
      this.spatialLoaded = true
      return true
    } catch {
      return false
    }
  }

  /** arrow 扩展是否已加载（原生 Arrow IPC 导出可用）。 */
  get hasArrow(): boolean {
    return this.arrowLoaded
  }

  /**
   * 惰性加载 arrow 扩展（community 仓：`INSTALL arrow FROM community`，1.2+ 起 arrow 从核心迁出）。
   * 首次需联网，之后本地缓存；离线/缺失失败不抛（arrowIpc 回退 null → 调用方走 JS 行路径），只试一次。
   */
  async ensureArrow(): Promise<boolean> {
    if (this.arrowLoaded) return true
    if (this.arrowTried) return false
    this.arrowTried = true
    try {
      await this.exec('INSTALL arrow FROM community')
      await this.exec('LOAD arrow')
      this.arrowLoaded = true
      return true
    } catch {
      return false
    }
  }

  /**
   * DuckDB 原生 Arrow IPC 导出：SQL → 单个 IPC 字节流（不经 JS 行对象）。
   * 供大点图层 /webgis/arrow 的 duckCoords 路径提速（省掉 conn.all 的 N 行 JS 物化）。
   * arrow 扩展不可用 / 超时 / 失败一律返回 null，调用方回退现有路径。
   */
  async arrowIpc(sql: string): Promise<Uint8Array | null> {
    if (!(await this.ensureArrow())) return null
    const conn = this.conn as DuckDbConn | null
    if (!conn?.arrowIPCAll) return null
    return new Promise<Uint8Array | null>((resolve) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        resolve(null) // 超时视作不可用，回退调用方
      }, this.opts.timeoutMs)
      try {
        conn.arrowIPCAll!(sql, (err, buffers) => {
          if (done) return
          done = true
          clearTimeout(timer)
          if (err || !buffers || buffers.length === 0) return resolve(null)
          if (buffers.length === 1) return resolve(buffers[0]!)
          const total = buffers.reduce((s, b) => s + b.byteLength, 0)
          const out = new Uint8Array(total)
          let offset = 0
          for (const b of buffers) {
            out.set(b, offset)
            offset += b.byteLength
          }
          resolve(out)
        })
      } catch {
        if (!done) {
          done = true
          clearTimeout(timer)
        }
        resolve(null)
      }
    })
  }

  /** 下一个表名（进程内递增，跨会话全局唯一）。 */
  nextTableName(): string {
    return `duckdb_${++this.seq}`
  }

  /** 当前引擎里还活着的表名（诊断/测试用）。 */
  tableNames(): string[] {
    return [...this.tables.keys()]
  }

  /** 单条 SQL → 行数组。Promise.race 兜底超时。 */
  run(sql: string, params?: unknown[]): Promise<DuckDbRow[]> {
    this.init()
    const conn = this.conn as DuckDbConn
    return new Promise<DuckDbRow[]>((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        reject(new Error(`DuckDB 查询超时（>${this.opts.timeoutMs}ms）：${sql.slice(0, 120)}`))
      }, this.opts.timeoutMs)
      const cb = (err: Error | null, rows: DuckDbRow[]): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve(rows)
      }
      if (params && params.length > 0) conn.all(sql, params, cb)
      else conn.all(sql, cb)
    })
  }

  /** 执行无结果语句（CREATE/DROP/SET），用默认超时兜底。 */
  exec(sql: string): Promise<void> {
    return this.execTimed(sql, this.opts.timeoutMs)
  }

  /** 带指定超时（ms）的无结果语句；大表建表/灌表（read_csv/ST_Read/子集 CTAS）用长超时防误掐。 */
  private execTimed(sql: string, timeoutMs: number): Promise<void> {
    this.init()
    const conn = this.conn as DuckDbConn
    return new Promise<void>((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        reject(new Error(`DuckDB 语句超时（>${timeoutMs}ms）：${sql.slice(0, 120)}`))
      }, timeoutMs)
      const cb = (err: Error | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      conn.exec(sql, cb)
    })
  }

  /**
   * 从 CSV 建内存表（read_csv 一次扫描，之后查询走内存表毫秒级）。
   * table 必须是 nextTableName() 产出的新名字。返回总行数 + 列名。
   */
  async createTableFromCsv(table: string, csvPath: string): Promise<{ count: number; columns: string[] }> {
    // 首列加稳定行号 __rid（源文件行序，row_number 一次定序，表生命周期内不变）：
    // arrow 几何列点击回查属性靠它（DuckDB 无 rowid() 伪列）；用户列里若恰好叫 __rid 会撞名，视为保留名。
    await this.execTimed(`CREATE TABLE ${table} AS SELECT row_number() OVER () - 1 AS ${DUCK_RID}, * FROM read_csv(${sqlString(csvPath)}, header=true, auto_detect=true, sample_size=-1, union_by_name=true)`, INGEST_TIMEOUT_MS)
    const info = await this.tableInfo(table)
    this.tables.set(table, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    return info
  }

  /**
   * 从 JS 解析的 GeoJSON 要素灌内存表（SHP/GeoJSON/上传共用：统一走 DuckDB + arrow 管道）。
   * 写临时 .geojson → spatial `ST_Read`（GEOMETRY 列自动识别，attrs 保类型），读完删临时文件。
   * 返回行数 + 列名 + 几何列名。table 必须是 nextTableName() 产出的新名字。
   */
  async createTableFromGeoJson(
    table: string,
    fc: FeatureCollection,
  ): Promise<{ count: number; columns: string[]; geomColumn: string | null }> {
    const path = join(tmpdir(), `dsh-webgis-import-${process.pid}-${++this.ingestSeq}.geojson`)
    try {
      writeFileSync(path, JSON.stringify(fc), 'utf8')
      if (!(await this.ensureSpatial())) throw new Error('空间扩展未加载（ST_Read 需要 DuckDB spatial）')
      await this.execTimed(`CREATE TABLE ${table} AS SELECT row_number() OVER () - 1 AS ${DUCK_RID}, * FROM ST_Read(${sqlString(path)})`, INGEST_TIMEOUT_MS)
    } finally {
      try { rmSync(path, { force: true }) } catch { /* 清理失败忽略 */ }
    }
    const desc = await this.describe(table)
    const geomColumn = desc.find((c) => c.type.startsWith('GEOMETRY'))?.name ?? null
    const info = await this.tableInfo(table)
    this.tables.set(table, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    return { count: info.count, columns: desc.map((c) => c.name), geomColumn }
  }

  /**
   * 从本地矢量文件（.shp/.gdb/.gpkg/.kml/.tab/.mif，GDAL 支持）直接建内存表：spatial `ST_Read` 一次扫描，
   * 之后查询走内存表。不再先经 shpjs 把全量要素物化成 JS geojson（超大 .shp 优化路径）。
   * opts.layer：GDB/GPKG 等多图层源可选 GDAL 图层名（duckdb ≥1.4 命名参数 `layer =>`）；找不到该图层抛中文错误。
   * 几何列经 detectGeomColumn/detectGeomFormat 判定（GEOMETRY 或 WKB BLOB），列名常见 geom/wkb_geometry。
   * 返回总行数 + 列名 + 几何列名 + 格式。table 必须是 nextTableName() 产出的新名字。
   */
  async createTableFromVector(
    table: string,
    path: string,
    opts: { layer?: string } = {},
  ): Promise<VectorTableInfo> {
    if (!(await this.ensureSpatial())) {
      throw new Error('矢量文件（shp/gdb/gpkg/kml/tab/mif）读取需要 DuckDB spatial 扩展（首次需联网 INSTALL spatial，之后本地缓存）')
    }
    const layer = typeof opts.layer === 'string' && opts.layer.trim() ? opts.layer.trim() : ''
    const plainSrc = `ST_Read(${sqlString(path)})`
    const createFrom = (src: string): Promise<void> =>
      this.execTimed(`CREATE TABLE ${table} AS SELECT row_number() OVER () - 1 AS ${DUCK_RID}, * FROM ${src}`, INGEST_TIMEOUT_MS)

    if (layer) {
      const withLayer = `ST_Read(${sqlString(path)}, layer => '${layer.replace(/'/g, "''")}')`
      try {
        await createFrom(withLayer)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/could not be found in dataset|layer\s*'[^']*'\s*could not be found/i.test(msg)) {
          throw new Error(
            `矢量数据源「${path}」中找不到图层「${layer}」（多图层如 .gdb/.gpkg 需传 GDAL 图层名，缺省读第一层）`,
          )
        }
        if (/parser error|syntax error|unexpected token/i.test(msg)) {
          // 旧版 duckdb 不支持 layer => 命名参数：退化读默认层。
          await createFrom(plainSrc)
        } else {
          throw this.vectorOpenError(err, path)
        }
      }
    } else {
      try {
        await createFrom(plainSrc)
      } catch (err) {
        throw this.vectorOpenError(err, path)
      }
    }

    const info = await this.tableInfo(table)
    this.tables.set(table, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    const desc = await this.describe(table)
    const geomName = detectGeomColumn(desc)
    const geomCol = geomName ? desc.find((c) => c.name === geomName) ?? null : null
    const geomFormat = geomCol ? detectGeomFormat(geomCol) : null
    return {
      count: info.count,
      columns: desc.map((c) => c.name),
      geomCol: geomCol ? geomCol.name : null,
      geomFormat,
    }
  }

  /** ST_Read 打开失败的 IO 错误 → 中文可懂（.shp/.tab 需兄弟文件，.gdb 是目录）。 */
  private vectorOpenError(err: unknown, path: string): Error {
    const msg = err instanceof Error ? err.message : String(err)
    if (/IO Error|Cannot open|could not open|No such file|not found|无法打开|系统找不到/i.test(msg)) {
      return new Error(
        `无法打开矢量文件「${path}」：请确认路径存在且文件完整（.shp/.tab 需同目录的 .dbf/.shx/.prj 等配套文件；.gdb 是文件夹需指到目录本身）`,
      )
    }
    return err instanceof Error ? err : new Error(String(err))
  }

  /**
   * 从 base 表 + WHERE 子句物化新表（筛选结果，链式筛选用）。whereClause 已内联转义
   * （engine 侧不绑定参数，DDL 场景 exec 不支持参数化）。返回新表行数。
   */
  async createFilterTable(newTable: string, baseTable: string, whereClause: string): Promise<number> {
    await this.execTimed(`CREATE TABLE ${newTable} AS SELECT * FROM ${baseTable} ${whereClause}`, INGEST_TIMEOUT_MS)
    const info = await this.tableInfo(newTable)
    this.tables.set(newTable, { rows: info.count, lastUsed: Date.now() })
    await this.evictLru()
    return info.count
  }

  /** 表的信息：总行数 + 列名（DESCRIBE）。 */
  async tableInfo(table: string): Promise<{ count: number; columns: string[] }> {
    const rows = await this.run(`SELECT count(*) AS count FROM ${table}`)
    const desc = await this.describe(table)
    return {
      count: Number(rows[0]?.count ?? 0),
      columns: desc.map((c) => c.name),
    }
  }

  /** DESCRIBE 列定义（含类型文本，几何列识别用）。 */
  async describe(table: string): Promise<DuckColumn[]> {
    const desc = await this.run(`DESCRIBE ${table}`)
    return desc.map((r) => ({
      name: String(r.column_name ?? r.name),
      type: String(r.column_type ?? r.type ?? ''),
    }))
  }

  /** 检出 GEOMETRY 列里全部非零 SRID（去重）；ST_SRID 不可用/出错返回 []。 */
  async detectSrids(table: string, column: string): Promise<number[]> {
    try {
      const rows = await this.run(
        `SELECT DISTINCT ST_SRID(${quoteIdent(column)}) AS srid FROM ${table} `
        + `WHERE ${quoteIdent(column)} IS NOT NULL AND ST_SRID(${quoteIdent(column)}) <> 0`,
      )
      const out: number[] = []
      for (const r of rows) {
        const s = Number(r.srid)
        if (Number.isFinite(s) && s > 0) out.push(s)
      }
      return [...new Set(out)]
    } catch {
      return [] // ST_SRID 不可用 → 按 WGS84 处理
    }
  }

  /** 自动检出 GEOMETRY 列的源坐标系：混合 SRID（>1 个非零）→ mixed=true 且 crs=null（拒绝整列自动重投影）。
   *  单一非 4326 → crs=`EPSG:n`；0/4326/无 → crs=null。 */
  async detectSourceCrs(table: string, column: string): Promise<{ crs: string | null; mixed: boolean; srids: number[] }> {
    const srids = await this.detectSrids(table, column)
    if (srids.length === 0) return { crs: null, mixed: false, srids }
    if (srids.length > 1) return { crs: null, mixed: true, srids }
    const srid = srids[0]!
    return { crs: srid === 4326 ? null : `EPSG:${srid}`, mixed: false, srids }
  }

  /** 触摸表（更新 LRU 时间戳；后续筛选工具使用前调用）。 */
  touch(table: string): void {
    const ref = this.tables.get(table)
    if (ref) {
      ref.lastUsed = Date.now()
      this.tables.set(table, ref)
    }
  }

  /** 随机抽样 n 行（reservoir，DuckDB `USING SAMPLE`，大文件显示子集用）。 */
  async sampleRows(table: string, n: number, where?: { clause: string; params: unknown[] }): Promise<DuckDbRow[]> {
    this.touch(table)
    const src = where?.clause ? `(SELECT * FROM ${table} ${where.clause})` : table
    return this.run(`SELECT * FROM ${src} USING SAMPLE ${Math.max(1, Math.floor(n))} ROWS`, where?.params)
  }

  /** 普通查询：SELECT * FROM <table> <suffix>（suffix 如 "WHERE ... LIMIT n"）。 */
  async query(table: string, suffix: string, params?: unknown[]): Promise<DuckDbRow[]> {
    this.touch(table)
    return this.run(`SELECT * FROM ${table} ${suffix}`, params)
  }

  /** 删除表并释放内存。表不存在时静默。 */
  async dropTable(table: string): Promise<void> {
    this.tables.delete(table)
    if (!this.conn) return
    try {
      await this.exec(`DROP TABLE IF EXISTS ${table}`)
    } catch {
      // 表可能已被清/不存在，忽略。
    }
  }

  /** 关闭引擎（插件卸载/进程退出）。 */
  async close(): Promise<void> {
    this.tables.clear()
    if (this.db) {
      const db = this.db
      this.db = null
      this.conn = null
      await new Promise<void>((resolve) => db.close(() => resolve()))
    }
  }

  /** LRU：总行数超上限时按最久未用优先 DROP，直到达标。 */
  private async evictLru(): Promise<void> {
    let total = 0
    for (const ref of this.tables.values()) total += ref.rows
    if (total <= this.opts.maxTotalRows) return
    const order = [...this.tables.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (const [name, ref] of order) {
      if (total <= this.opts.maxTotalRows) break
      await this.dropTable(name)
      total -= ref.rows
    }
  }
}

/** 进程级懒单例（插件多次加载共享同一引擎）。测试注入独立引擎走 registerDuckDbTools 的 opts.engine。 */
let engine: DuckDbEngine | null = null

export function getDuckDb(opts?: DuckDbOptions): DuckDbEngine {
  if (!engine) engine = new DuckDbEngine(opts)
  return engine
}

/** SQL 字符串字面量：反斜杠归一化为正斜杠 + 单引号翻倍转义。 */
function sqlString(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, "''")}'`
}
