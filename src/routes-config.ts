/**
 * 设置卡配置路由：vision-config / postgis-config / postgis-action（GUI 卡片读写）。
 * 拆分自 src/index.ts 的 HTTP 路由大 handler；行为零变化。
 * 密码不落盘：文件只存凭据引用 passwordRef，真实值存 DSH 凭据存储/环境变量（api.ctx.credentials）。
 */
import { writeFile } from 'node:fs/promises'
import { json, jsonError, readBody } from './http-utils.js'
import { configKey, DEFAULT_CLUSTER, type PostgisClusterConfig, type PostgisConfig } from './postgis.js'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { RouteApi, RouteHandler } from './route-shared.js'

export const handleVisionConfigGet: RouteHandler = (_req, res, _url, _pathname, _sessionId, _state, api) => {
  // 读视觉模型配置（GUI 卡片用；优先 GUI 值，其次插件配置）
  const vc = api.visionCfg.get()
  json(res, {
    provider: vc?.provider ?? api.config.vision?.provider ?? '',
    model: vc?.model ?? api.config.vision?.model ?? '',
    baseURL: vc?.baseURL ?? api.config.vision?.baseURL ?? '',
    apiKeyEnv: vc?.apiKeyEnv ?? api.config.vision?.apiKeyEnv ?? '',
  })
}

export const handleVisionConfigPost: RouteHandler = (req, res, _url, _pathname, _sessionId, _state, api) => {
  // 写视觉模型配置（GUI 卡片保存）：校验并持久化。
  // 未提供的可选字段（baseURL/apiKeyEnv）保留旧值——GUI 卡片只发 provider/model，
  // 不会覆盖手动在配置文件里设的直连端点。
  return void (async () => {
    try {
      const raw = await readBody(req, 16 * 1024)
      const data = JSON.parse(raw) as Record<string, unknown>
      const provider = typeof data.provider === 'string' ? data.provider.trim() : ''
      const model = typeof data.model === 'string' ? data.model.trim() : ''
      const baseURL = typeof data.baseURL === 'string' ? data.baseURL.trim() : ''
      const apiKeyEnv = typeof data.apiKeyEnv === 'string' ? data.apiKeyEnv.trim() : ''
      if (provider.length > 200 || model.length > 200 || apiKeyEnv.length > 200 || baseURL.length > 500) {
        return jsonError(res, 400, '字段过长')
      }
      const cur = api.visionCfg.get()
      if (!provider && !model) {
        api.visionCfg.set(null)
      } else {
        api.visionCfg.set({
          provider,
          model,
          baseURL: baseURL !== '' ? baseURL : cur?.baseURL,
          apiKeyEnv: apiKeyEnv !== '' ? apiKeyEnv : cur?.apiKeyEnv,
        })
      }
      await writeFile(api.visionFile, JSON.stringify(api.visionCfg.get() ?? {}), 'utf8').catch((err: unknown) => {
        api.ctx.logger.warn('[webgis] 视觉模型配置持久化失败: %s', err instanceof Error ? err.message : String(err))
      })
      json(res, { ok: true, provider, model })
    } catch (err) {
      jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}

export const handlePostgisConfigGet: RouteHandler = (_req, res, _url, _pathname, _sessionId, _state, api) => {
  // 读 PostGIS 连接配置（GUI 卡片用；密码不回显，只给是否已设置；阈值给默认值）
  const cfg = api.effectivePostgis()
  json(res, {
    host: cfg.host ?? '',
    port: cfg.port ?? 5432,
    database: cfg.database ?? '',
    user: cfg.user ?? '',
    passwordSet: Boolean(cfg.password),
    cluster: {
      askFrom: cfg.cluster?.askFrom ?? DEFAULT_CLUSTER.askFrom,
      autoClusterFrom: cfg.cluster?.autoClusterFrom ?? DEFAULT_CLUSTER.autoClusterFrom,
      maxLoad: cfg.cluster?.maxLoad ?? DEFAULT_CLUSTER.maxLoad,
    },
  })
}

export const handlePostgisConfigPost: RouteHandler = (req, res, _url, _pathname, _sessionId, _state, api) => {
  // 写 PostGIS 连接配置（GUI 卡片保存）：持久化到 GUI 文件；密码留空 = 保留旧密码。
  return void (async () => {
    try {
      const raw = await readBody(req, 16 * 1024)
      const data = JSON.parse(raw) as Record<string, unknown>
      const host = typeof data.host === 'string' ? data.host.trim() : ''
      const database = typeof data.database === 'string' ? data.database.trim() : ''
      const user = typeof data.user === 'string' ? data.user.trim() : ''
      const password = typeof data.password === 'string' ? data.password.trim() : ''
      const portNum = Number(data.port)
      const port = Number.isInteger(portNum) && portNum > 0 && portNum <= 65535 ? portNum : undefined
      const cluster: PostgisClusterConfig = {}
      for (const key of ['askFrom', 'autoClusterFrom', 'maxLoad'] as const) {
        const n = Number(data[key])
        if (Number.isInteger(n) && n > 0) cluster[key] = n
      }
      if (host.length > 200 || database.length > 200 || user.length > 200 || password.length > 500) {
        return jsonError(res, 400, '字段过长')
      }
      if (!host && !database) return jsonError(res, 400, '至少需要填写 host 与 database')
      const prevKey = configKey(api.effectivePostgis())
      const next: PostgisConfig = { host, database, user, ...(port ? { port } : {}) }
      if (Object.keys(cluster).length > 0) next.cluster = cluster
      const cur = api.postgisCfg.get()
      if (password) {
        // 密码写入 DSH 凭据存储（不落 GUI 配置文件），内存持有解析值用于本次连接。
        await api.ctx.credentials.set(credentialRef(api.postgisPasswordRef), password).catch((err: unknown) => {
          api.ctx.logger.warn('[webgis] PostGIS 密码写入凭据存储失败: %s', err instanceof Error ? err.message : String(err))
        })
        next.password = password
      } else if (cur?.password) {
        next.password = cur.password // 密码留空 = 保留旧密码（内存中）
      }
      api.postgisCfg.set(next)
      // 落盘：只存凭据引用，绝不写明文密码。
      const toFile = { ...next, passwordRef: api.postgisPasswordRef } as Record<string, unknown>
      delete toFile.password
      await writeFile(api.postgisFile, JSON.stringify(toFile), 'utf8').catch((err: unknown) => {
        api.ctx.logger.warn('[webgis] PostGIS 配置持久化失败: %s', err instanceof Error ? err.message : String(err))
      })
      // 连接目标变了 → 库结构缓存作废（避免引用别的库的表）
      if (configKey(api.effectivePostgis()) !== prevKey) await api.db.clearSchema()
      json(res, { ok: true })
    } catch (err) {
      jsonError(res, 400, err instanceof Error ? err.message : '请求体无效')
    }
  })()
}

export const handlePostgisAction: RouteHandler = (req, res, _url, _pathname, _sessionId, _state, api) => {
  // PostGIS 操作：test 测试连接 / scan 重新读取库结构 / clear 清除库结构
  return void (async () => {
    try {
      const raw = await readBody(req, 16 * 1024)
      const data = JSON.parse(raw) as { action?: unknown }
      const action = typeof data.action === 'string' ? data.action : ''
      if (action === 'test') {
        const r = await api.db.test()
        json(res, { ok: r.ok, message: r.message })
      } else if (action === 'scan') {
        const { tables, fromCache } = await api.db.ensureSchema(true)
        json(res, { ok: true, tables: tables.length, fromCache, message: `数据库结构已重新读取：${tables.length} 个表/视图` })
      } else if (action === 'clear') {
        await api.db.clearSchema()
        json(res, { ok: true, message: '数据库结构已清除（下次 AI 查库时会重新扫描）' })
      } else {
        jsonError(res, 400, '未知 action（test / scan / clear）')
      }
    } catch (err) {
      jsonError(res, 400, err instanceof Error ? err.message : '数据库操作失败')
    }
  })()
}
