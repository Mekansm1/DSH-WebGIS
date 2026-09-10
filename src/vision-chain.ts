/**
 * 视觉委托链：给 webgis_get_pick 的截图分析提供「原生适配器 / 直连 HTTP(OpenAI 兼容)」双通道，
 * **仅走用户显式配置的后端**：主模型已具备视觉能力时整条链不会被调用（见 index.ts 的 modelSupportsImage 分流）；
 * 只有主模型是文本模型、且用户配了视觉端点时才作为兜底通路。未配置 = 明确失败，不做任何匿名转发。
 *
 * ⚠️ 曾有「内置 OVH 匿名免费端点」作为最后兜底，已删除：它会把用户的地图截图默认发往第三方端点，
 * 属于未经用户配置的外发行为，且每 IP 有严格限额、失败原因隐蔽。
 *
 * 移植自社区插件 @deepseek-ai 生态的 dsh-vision-router（MIT）：transport、失败分类、
 * 共享时间预算的写法与之同源，但裁剪为仅本插件需要的部分，未引入其熔断/图片记忆等机制。
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'

/** index.ts 的 PickState 的最小结构（避免与 index.ts 循环依赖）。 */
interface VisionPick {
  lng: number
  lat: number
}

/** index.ts 的 ScreenshotMeta 的最小结构。 */
interface VisionShot {
  width: number
  height: number
  pin: { x: number; y: number }
  /** 图上是否画了红点（仅用户手动点击底图）。决定提示词提不提「红点」。 */
  pinned?: boolean
}

/** 直连 HTTP 的 OpenAI 兼容视觉端点描述。 */
export interface HttpVisionProvider {
  name: string
  baseURL: string
  model: string
  /** DSH 凭据引用 / 环境变量名；空 = 免 Key 直连（如内置 OVH 免费端点）。 */
  apiKeyEnv?: string
  maxTokens?: number
}

/** 一次视觉任务（整条链共享）的总时间预算。 */
export const DEFAULT_VISION_TASK_TIMEOUT_MS = 45000
/** 单次后端调用的最长等待（公平份额上限；留给后续兜底时间）。 */
export const MAX_SINGLE_CALL_MS = 30000
/** 视觉答案的最大 token（提示词要求 200 字内，600 足够且快）。 */
export const VISION_MAX_TOKENS = 600

/** 视觉失败分类：给工具结果一个「不要改措辞重试」的信号。 */
export type VisionFailureKind =
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'SERVER'
  | 'INVALID_REQUEST'
  | 'NETWORK'
  | 'QUOTA'
  | 'OTHER'

const KIND_BY_PATTERN: Array<[VisionFailureKind, RegExp[]]> = [
  ['AUTH', [/\b401\b/, /\b403\b/, /unauthorized/i, /invalid api[ -]?key/i, /forbidden/i, /authentication/i]],
  ['RATE_LIMIT', [/\b429\b/, /rate.?limit/i, /too many requests/i]],
  ['TIMEOUT', [/abort/i, /timeout/i, /etimedout/i, /timed ?out/i, /deadline exceeded/i]],
  ['SERVER', [/\b500\b/, /\b502\b/, /\b503\b/, /\b504\b/, /bad gateway/i, /service unavailable/i]],
  ['INVALID_REQUEST', [/\b400\b/, /\b404\b/, /\b422\b/, /does not support image/i, /invalid model/i, /model not exist/i]],
  ['NETWORK', [/econn/i, /enotfound/i, /network/i, /fetch failed/i, /socket/i, /connection reset/i, /dns/i]],
  ['QUOTA', [/\b402\b/, /insufficient/i, /balance/i, /credits/i]],
]

/** 把一次后端失败归类到稳定 taxonomy（按 HTTP 状态码优先，其次错误文本）。 */
export function classifyVisionFailure(error: unknown): VisionFailureKind {
  const status = (error as { status?: number } | null)?.status
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 402) return 'QUOTA'
  if (status === 400 || status === 404 || status === 422) return 'INVALID_REQUEST'
  if (status !== undefined && status >= 500 && status <= 599) return 'SERVER'
  const message = String((error && (error as Error).message) ?? error ?? '')
  for (const [kind, regexes] of KIND_BY_PATTERN) {
    if (regexes.some((re) => re.test(message))) return kind
  }
  return 'OTHER'
}

/**
 * 共享时间预算：整条链共用一个 deadline，每个后端只拿「当前剩余」的一部分，
 * 挂死的后端不会把整条链的时间全部耗光、饿死后续兜底。
 */
export function createDeadline(totalMs: number) {
  const started = Date.now()
  return {
    remaining(): number {
      return Math.max(0, totalMs - (Date.now() - started))
    },
    expired(): boolean {
      return Date.now() - started >= totalMs
    },
    signal(): AbortSignal {
      return AbortSignal.timeout(Math.max(1, totalMs - (Date.now() - started)))
    },
  }
}

/** OpenAI 兼容视觉消息：text + base64 image_url。 */
export interface OpenAIVisionMessage {
  role: 'user'
  content: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
}

/** 构造 OpenAI 兼容视觉请求体：图钉截图 → base64 data URL + 提问文本。 */
export function buildOpenAIVisionMessages(imageBytes: Uint8Array, mediaType: string, prompt: string): OpenAIVisionMessage[] {
  const base64 = Buffer.from(imageBytes).toString('base64')
  return [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } },
      { type: 'text', text: prompt },
    ],
  }]
}

export interface HttpCallOptions {
  maxTokens?: number
  signal?: AbortSignal
  /** 凭据引用 → 实际值；未提供时回退 process.env。 */
  resolveCredential?: (apiKeyEnv: string) => Promise<string | undefined>
}

/** 一次非流式 OpenAI 兼容 chat completion；apiKeyEnv 为空 = 免 Key 直连。 */
export async function callOpenAICompatible(
  provider: HttpVisionProvider,
  messages: OpenAIVisionMessage[],
  options: HttpCallOptions = {},
): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const apiKeyEnv = provider.apiKeyEnv ?? ''
  if (apiKeyEnv !== '') {
    let key = ''
    if (options.resolveCredential !== undefined) {
      key = (await options.resolveCredential(apiKeyEnv)) ?? ''
    }
    if (key === '' && typeof process !== 'undefined' && process.env) key = process.env[apiKeyEnv] ?? ''
    if (key === '') throw new Error(`http provider "${provider.name}": ${apiKeyEnv} is not set`)
    headers.authorization = `Bearer ${key}`
  }
  const body = {
    model: provider.model,
    messages,
    max_tokens: options.maxTokens ?? provider.maxTokens ?? VISION_MAX_TOKENS,
    stream: false,
  }
  const url = `${provider.baseURL.replace(/\/$/, '')}/chat/completions`
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    const error = new Error(`http provider "${provider.name}": ${response.status} ${detail}`) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown; reasoning?: unknown } }>
  }
  const message = data.choices?.[0]?.message
  // 多段内容（content 为数组）时拼接 text 段；推理模型只回 reasoning（免费 OVH 的
  // Qwen3.5/3.6 常见）时退而取推理文本——总比判失败、烧掉整条链的兜底次数强。
  const content = message?.content
  let finalText = ''
  if (typeof content === 'string') {
    finalText = content
  } else if (Array.isArray(content)) {
    finalText = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
  } else if (typeof message?.reasoning === 'string' && message.reasoning.trim() !== '') {
    finalText = message.reasoning
  }
  if (finalText.trim() === '') throw new Error(`http provider "${provider.name}": unexpected response shape`)
  return finalText.trim()
}

/** 视觉分析的结构化结果：成功给 text；失败给 code + 尝试过的后端 + 原因。 */
export interface VisionAnalysisResult {
  ok: boolean
  text?: string
  code?: string
  attempted: string[]
  reason?: string
}

/** 链上所有后端都失败时，挑一个最说明问题的失败码。 */
export function failureCodeFor(kinds: VisionFailureKind[]): string {
  const set = new Set(kinds)
  if (set.size === 1) {
    const only = [...set][0]
    if (only === 'AUTH') return 'VISION_AUTH_FAILED'
    if (only === 'RATE_LIMIT') return 'VISION_RATE_LIMITED'
    if (only === 'TIMEOUT') return 'VISION_TIMEOUT'
  }
  return 'VISION_BACKEND_UNAVAILABLE'
}

/**
 * 原生适配器路径：把截图块 + 提示词发给 DSH 已注册的视觉 provider/model，
 * 收集 text 流。失败（finish error/aborted 且无输出）抛错，由链上层分类。
 */
async function nativeVisionCall(
  ctx: Context,
  provider: string,
  model: string,
  ref: ImageAttachmentRef,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const imgBlock: ContentBlock = { type: 'image', attachment: ref }
  const message = createUserMessage({
    content: [imgBlock, { type: 'text', text: prompt } as ContentBlock],
    source: { kind: 'plugin', plugin: 'webgis' },
  })
  const chunks = ctx.llm.stream({ provider, model, messages: [message], maxTokens: VISION_MAX_TOKENS, signal })
  let textOut = ''
  let failed = false
  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') textOut += chunk.text
    if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') failed = true
      break
    }
  }
  if (failed && !textOut.trim()) throw new Error('native vision call failed')
  return textOut
}

/** 视觉配置（见 index.ts 的 Config.vision）：原生适配器或直连 HTTP。 */
export interface VisionConfig {
  provider?: string
  model?: string
  baseURL?: string
  apiKeyEnv?: string
}

/** 解析凭据：DSH credentials 服务优先，其次进程环境变量。 */
async function resolveCredentialValue(ctx: Context, apiKeyEnv: string): Promise<string | undefined> {
  try {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined && isCredentialRefName(apiKeyEnv)) {
      const hit = await credentials.resolve(credentialRef(apiKeyEnv))
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    }
  } catch {
    /* fall through to the environment */
  }
  return undefined
}

/**
 * 走视觉委托链分析地图截图：只认用户配置的那**一个**后端 ——
 * vision.baseURL 存在 → 直连 HTTP；否则 provider/model → DSH 原生适配器；
 * 都没配 → 直接返回「no vision backend configured」，不外发任何请求。
 * 失败按 taxonomy 分类，返回结构化结果（让模型知道别改措辞重试）。
 */
export async function analyzeScreenshotChain(
  ctx: Context,
  vision: VisionConfig | null,
  pick: VisionPick,
  ref: ImageAttachmentRef,
  shot: VisionShot,
): Promise<VisionAnalysisResult> {
  // 红点只有用户手动点击底图时才画；捕获当前视野时图上没有任何标记，
  // 提示词也必须说清楚，否则模型会把画面中心当成用户指定的位置。
  const where = shot.pinned
    ? `图中红色圆点是用户点击的关注位置，位于像素 (${Math.round(shot.pin.x)}, ${Math.round(shot.pin.y)})，`
    : '这张图是当前视野的捕获，**图上没有任何标记**（不要假设有红点或图钉）；'
      + `画面中心位于像素 (${Math.round(shot.pin.x)}, ${Math.round(shot.pin.y)})，`
  const prompt = `这是用户地图的截图（截图上无文字坐标）。截图尺寸 ${shot.width}×${shot.height}px。${where}`
    + `对应经纬度 (${pick.lng.toFixed(5)}, ${pick.lat.toFixed(5)})。`
    + '请用中文描述这张地图截图：这是什么地理区域、图上可见的地名/要素、该位置附近有什么，'
    + '并综合判断这个位置最可能是什么地方。回答控制在 200 字以内。'

  // 读一次图片字节（HTTP 路径需要 base64；原生路径只用 ref）。
  let imageBytes: Uint8Array | null = null
  try {
    const stored = await ctx.attachments.readImage(ref)
    imageBytes = stored.data
  } catch {
    imageBytes = null
  }

  const resolveCredential = (env: string) => resolveCredentialValue(ctx, env)
  const deadline = createDeadline(DEFAULT_VISION_TASK_TIMEOUT_MS)
  const attempted: string[] = []
  const failures: Array<{ label: string; kind: VisionFailureKind }> = []

  /** 组装一条后端调用（label 用于诊断/失败汇总）。 */
  const httpCall = (provider: HttpVisionProvider): (signal: AbortSignal) => Promise<string> => {
    return (signal) => {
      if (imageBytes === null) throw new Error(`http provider "${provider.name}": image bytes unavailable`)
      const msgs = buildOpenAIVisionMessages(imageBytes, ref.mediaType ?? 'image/png', prompt)
      return callOpenAICompatible(provider, msgs, {
        maxTokens: VISION_MAX_TOKENS,
        signal,
        resolveCredential,
      })
    }
  }
  const nativeCall = (provider: string, model: string): (signal: AbortSignal) => Promise<string> => {
    return (signal) => nativeVisionCall(ctx, provider, model, ref, prompt, signal)
  }

  const backends: Array<{ label: string; run: (signal: AbortSignal) => Promise<string> }> = []
  if (vision?.baseURL && vision.model) {
    // 直连 HTTP 优先：baseURL 显式指定时不依赖 DSH 适配器。
    backends.push({
      label: `${vision.provider ?? 'http'}/${vision.model}`,
      run: httpCall({ name: vision.provider ?? 'http', baseURL: vision.baseURL, model: vision.model, apiKeyEnv: vision.apiKeyEnv }),
    })
  } else if (vision?.provider && vision.model) {
    // 原生适配器：provider/model 需在 DSH 里注册过 adapter。
    backends.push({ label: `${vision.provider}/${vision.model}`, run: nativeCall(vision.provider, vision.model) })
  }

  for (const backend of backends) {
    attempted.push(backend.label)
    if (deadline.expired()) {
      failures.push({ label: backend.label, kind: 'TIMEOUT' })
      break
    }
    const callBudget = Math.min(deadline.remaining(), MAX_SINGLE_CALL_MS)
    let textOut = ''
    try {
      textOut = await backend.run(AbortSignal.any([deadline.signal(), AbortSignal.timeout(callBudget)]))
    } catch (err) {
      const kind = classifyVisionFailure(err)
      failures.push({ label: backend.label, kind })
      ctx.logger.warn('[webgis] 视觉后端 %s 失败(%s): %s', backend.label, kind,
        err instanceof Error ? err.message : String(err))
      continue
    }
    if (textOut.trim()) {
      return { ok: true, text: textOut.trim(), attempted }
    }
    failures.push({ label: backend.label, kind: 'INVALID_REQUEST' }) // 空回答：按请求无效处理
  }

  const kinds = failures.map((f) => f.kind)
  return {
    ok: false,
    code: failureCodeFor(kinds),
    attempted,
    reason: failures.length > 0
      ? failures.map((f) => `${f.label}: ${f.kind}`).join('；')
      : 'no vision backend configured',
  }
}
