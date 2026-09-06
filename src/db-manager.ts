/**
 * PostgreSQL 连接与库结构缓存管理。
 *
 * - 懒建 Pool，配置指纹变化时自动重建（GUI 设置保存新地址/账号后无需重启插件）；
 * - 库结构缓存：内存 + 持久化到 `~/.dsh/webgis-dbschema.json`，`webgis_db_schema`
 *   返回缓存、`clearSchema()` 清除、`ensureSchema(refresh)` 重扫更新——对应配置卡片里的
 *   「清除 / 重新读取库结构」；
 * - 全部 DB 访问串行化（同一时刻至多一次扫描），避免并发大查询打爆连接池。
 */
import { readFile, writeFile } from 'node:fs/promises'
import { Pool } from 'pg'
import type { DbTableInfo, PostgisConfig } from './postgis.js'
import {
  configFingerprint,
  configKey,
  createPool,
  formatSchemaText,
  isConfigured,
  scanSchema,
  testConnection,
} from './postgis.js'

export interface DbManagerDeps {
  /** 返回当前生效的 PostGIS 配置（GUI 设置 / 命名空间 / 插件配置合并后）。 */
  getConfig: () => PostgisConfig
  /** schema 缓存持久化文件路径。 */
  schemaFile: string
  logger: { warn: (msg: string, ...args: unknown[]) => void }
}

export interface DbSchemaSnapshot {
  savedAt: string
  tables: DbTableInfo[]
  /** 连接目标指纹（去敏，不含密码）：缓存只对同一 host/port/database/user 生效，不匹配即作废。 */
  connKey: string
}

export interface DbManager {
  /** 返回当前配置对应的连接池（懒建、配置变更自动重建）。 */
  getPool(): Pool
  isConfigured(): boolean
  getConfig(): PostgisConfig
  /** 测试连接，返回可读结论。 */
  test(): Promise<{ ok: true; message: string } | { ok: false; message: string }>
  /** 返回库结构；refresh=true 强制重扫更新缓存；首次（无缓存）自动扫描。 */
  ensureSchema(refresh?: boolean): Promise<{ tables: DbTableInfo[]; text: string; fromCache: boolean }>
  /** 清除库结构缓存（下次调用自动重扫）。 */
  clearSchema(): Promise<void>
}

export function createDbManager(deps: DbManagerDeps): DbManager {
  let pool: Pool | null = null
  let poolKey: string | null = null
  let cache: DbSchemaSnapshot | null = null
  /** 串行化扫描：进行中的扫描共享同一个 promise。 */
  let scanning: Promise<DbSchemaSnapshot> | null = null
  let ready: Promise<void> | null = null

  /** 启动时读一次持久化缓存（失败静默，不影响插件启动）。缓存带连接指纹，目标变了即作废。 */
  function ensureReady(): void {
    if (ready) return
    ready = readFile(deps.schemaFile, 'utf8')
      .then((raw) => {
        const parsed = JSON.parse(raw) as DbSchemaSnapshot
        if (parsed && Array.isArray(parsed.tables) && parsed.tables.length > 0
          && parsed.connKey === configFingerprint(deps.getConfig())) {
          cache = parsed
        }
      })
      .catch(() => {})
  }

  function getPool(): Pool {
    const cfg = deps.getConfig()
    const key = configKey(cfg)
    if (!pool || poolKey !== key) {
      const old = pool
      pool = createPool(cfg)
      poolKey = key
      if (old) old.end().catch(() => {})
    }
    return pool
  }

  async function ensureSchema(refresh = false): Promise<{
    tables: DbTableInfo[]; text: string; fromCache: boolean
  }> {
    ensureReady()
    await ready
    if (!refresh && cache?.tables && cache.tables.length > 0) {
      return { tables: cache.tables, text: formatSchemaText(cache.tables), fromCache: true }
    }
    const cfg = deps.getConfig()
    if (!isConfigured(cfg)) {
      throw new Error('未配置 PostgreSQL 连接（请在插件设置 → WebGIS 数据库卡片里填写连接信息）')
    }
    if (!scanning) {
      scanning = (async () => {
        const tables = await scanSchema(getPool())
        const snap: DbSchemaSnapshot = {
          savedAt: new Date().toISOString(),
          tables,
          connKey: configFingerprint(cfg),
        }
        cache = snap
        await writeFile(deps.schemaFile, JSON.stringify(snap), 'utf8').catch((err: unknown) => {
          deps.logger.warn('[webgis] 数据库结构缓存持久化失败: %s', err instanceof Error ? err.message : String(err))
        })
        return snap
      })()
    }
    try {
      const snap = await scanning
      const cfgNow = deps.getConfig()
      return {
        tables: snap.tables,
        text: formatSchemaText(snap.tables, { host: cfgNow.host, database: cfgNow.database }),
        fromCache: false,
      }
    } finally {
      scanning = null
    }
  }

  async function clearSchema(): Promise<void> {
    cache = null
    await writeFile(
      deps.schemaFile,
      JSON.stringify({ savedAt: '', tables: [], connKey: '' } satisfies DbSchemaSnapshot),
      'utf8',
    ).catch(() => {})
  }

  async function test(): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
    const cfg = deps.getConfig()
    if (!isConfigured(cfg)) return { ok: false, message: '未配置 PostgreSQL 连接' }
    const r = await testConnection(getPool())
    return r.ok
      ? { ok: true, message: `连接成功。PostGIS: ${r.postgis}` }
      : { ok: false, message: r.message }
  }

  return {
    getPool,
    isConfigured: () => isConfigured(deps.getConfig()),
    getConfig: deps.getConfig,
    test,
    ensureSchema,
    clearSchema,
  }
}
