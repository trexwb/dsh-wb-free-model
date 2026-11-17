/**
 * Model lane: discovery, WB · auto selection, bridge completion, probe queue.
 * This is the DSH-side equivalent of wbBridge's orchestration + backend.
 */

import { selectModel, allWeightsExhausted, nextWeight, weightOf, autoLevels } from './auto.js'
import { discoverModels } from './catalog.js'
import { REQUEST_TIMEOUT_MS } from './constants.js'
import { decodeEnvelope, prepareBridge, REPAIR_PROMPT, TRUNCATED_PROMPT } from './protocol.js'
import { probeModel, PROBE_TOOLS, probeMessages } from './probe.js'
import { acceptsEffort, reasoningInfo, variantFor } from './reasoning.js'

export class ModelError extends Error {
  constructor(message, { code = 'SERVER', status = 502, cause } = {}) {
    super(message)
    this.name = 'ModelError'
    this.code = code
    this.status = status
    this.cause = cause
    // The LLM service keeps this own `failure` snapshot as the terminal chunk's
    // provider facts, so throwing this plain Error preserves code/status without
    // importing a version-pinned HarnessError.
    this.failure = Object.freeze({
      message: message || 'WB Free Model request failed',
      code,
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    })
  }
}

function sleep(ms) {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

function usageFrom(tokens) {
  if (tokens === null || typeof tokens !== 'object') return undefined
  const input = Number.isFinite(tokens.input) ? tokens.input : 0
  const output = Number.isFinite(tokens.output) ? tokens.output : 0
  const usage = {
    inputTokens: input,
    outputTokens: output,
  }
  if (Number.isFinite(tokens.reasoning) && tokens.reasoning > 0) usage.reasoningTokens = tokens.reasoning
  const read = tokens.cache?.read
  const write = tokens.cache?.write
  if (Number.isFinite(read) && read > 0) usage.cacheReadTokens = read
  if (Number.isFinite(write) && write > 0) usage.cacheWriteTokens = write
  return usage
}

function envelopeFrom(response, chatOnly) {
  const info = response?.info
  const parts = Array.isArray(response?.parts) ? response.parts : []
  const structuredPart = parts.find(part => part?.type === 'tool'
    && part?.tool === 'StructuredOutput'
    && part?.state?.status === 'completed'
    && part?.state?.input !== undefined
    && part?.state?.input !== null)
  const envelope = info?.structured !== undefined && info?.structured !== null
    ? info.structured
    : structuredPart?.state?.input
  if (envelope !== undefined && envelope !== null) return JSON.stringify(envelope)
  return parts
    .filter(part => part?.type === 'text')
    .map(part => part.text ?? '')
    .join('')
}

export class ModelService {
  constructor({ runtime, store, config, logger, resolveImage }) {
    this.runtime = runtime
    this.store = store
    this.config = config ?? {}
    this.logger = logger
    this.resolveImage = resolveImage
    this.refreshing = undefined
    this.probing = false
    this.inflight = 0
    this.probeRun = undefined
    this.disposed = false
    this.lastError = ''
  }

  get enabled() {
    return this.store.get().enabled !== false
  }

  catalog() {
    return this.store.get().catalog
  }

  resolveEntry(modelId) {
    return this.catalog().find(model => model.id === modelId)
  }

  /** Discovery is cached; refresh when empty, stale, or forced. */
  async ensureCatalog({ force = false } = {}) {
    const state = this.store.get()
    const stale = Date.now() - Number(state.catalogAt ?? 0) > 60 * 60 * 1000
    if (!force && state.catalog.length > 0 && !stale) return state.catalog
    return this.refreshCatalog({ force: true })
  }

  refreshCatalog({ force = false } = {}) {
    if (!force && this.refreshing !== undefined) return this.refreshing
    const task = (async () => {
      const backend = await this.runtime.ensure()
      const providers = await backend.providers()
      const catalog = discoverModels(providers)
      if (catalog.length === 0) {
        throw new ModelError('OpenCode returned no keyless free models', { code: 'EMPTY_RESPONSE' })
      }
      this.store.setCatalog(catalog)
      await this.store.flush()
      this.lastError = ''
      this.logger?.info?.(`dsh-wb-free-model: discovered ${catalog.length} free models`)
      return catalog
    })()
    this.refreshing = task.finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** Best-effort background refresh; failures surface through the settings summary. */
  backgroundRefresh() {
    void this.refreshCatalog({ force: true }).catch(error => {
      this.lastError = error?.message ?? String(error)
      this.logger?.warn?.(`dsh-wb-free-model: catalog refresh failed: ${this.lastError}`)
    })
  }

  listModels() {
    const state = this.store.get()
    const disabled = new Set(state.disabled)
    return state.catalog
      .filter(model => !disabled.has(model.id))
      .filter(model => !(state.results[model.id]?.source === 'probe' && state.results[model.id]?.ok === false))
      .map(model => ({
        provider: 'wbbridge',
        id: model.id,
        name: model.name,
        description: this.describe(model),
        inputModalities: model.images === true ? ['text', 'image'] : ['text'],
      }))
  }

  describe(model) {
    const result = this.store.get().results[model.id]
    if (result?.ok === true && result?.chatOnly === true) return '仅对话（不支持工具调用）'
    if (result?.ok === true) return '可用'
    if (result?.ok === false && result?.source === 'probe') return `探测失败：${result.message ?? result.code ?? '未知原因'}`
    if (result?.ok === false) return '最近一次请求失败，仍可重试'
    return '尚未探测'
  }

  async resolveModel(modelId) {
    const catalog = await this.ensureCatalog()
    if (modelId === 'auto') {
      return {
        provider: 'wbbridge',
        id: 'auto',
        name: 'WB · auto',
        description: '按耗时权重自动挑选当前可用的免费模型',
        context: { contextWindow: 131_072 },
        defaultMaxTokens: 8_192,
        ...(autoLevels(catalog).length === 0 ? {} : {
          reasoning: { efforts: autoLevels(catalog).map(id => ({ id, name: id })) },
        }),
      }
    }
    const entry = catalog.find(model => model.id === modelId)
    if (entry === undefined) {
      return {
        provider: 'wbbridge',
        id: modelId,
        name: modelId,
        context: { contextWindow: 131_072 },
        defaultMaxTokens: 8_192,
      }
    }
    const info = reasoningInfo(entry)
    return {
      provider: 'wbbridge',
      id: entry.id,
      name: entry.name,
      description: this.describe(entry),
      inputModalities: entry.images === true ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.context && entry.context > 0 ? entry.context : 131_072 },
      defaultMaxTokens: entry.output && entry.output > 0 ? Math.min(entry.output, 32_768) : 8_192,
      ...(info === undefined ? {} : { reasoning: info }),
    }
  }

  autoModelId({ messages, tools, effort }) {
    const state = this.store.get()
    const disabled = new Set(state.disabled)
    const usable = state.catalog.filter(model => !disabled.has(model.id)
      && !(state.results[model.id]?.source === 'probe' && state.results[model.id]?.ok === false))
    const images = (messages ?? []).some(message => (message?.content ?? []).some(block => block?.type === 'image'))
    return selectModel({
      models: usable,
      results: state.results,
      images,
      tools: (tools ?? []).length > 0,
      effort,
    })
  }

  /**
   * One bridge completion. Adapter and probe share this path.
   * Returns `{content, calls, chatOnly, usage, finish, modelId}`.
   */
  async complete({ modelId, messages, system, tools, effort, signal, timeoutMs = REQUEST_TIMEOUT_MS }) {
    if (!this.enabled) throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED' })
    if (signal?.aborted === true) throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
    await this.ensureCatalog()
    const targetId = modelId === 'auto' ? this.autoModelId({ messages, tools, effort }) : modelId
    if (targetId === undefined) throw new ModelError('没有可用的免费模型；请先刷新目录或运行探测', { code: 'MODEL_UNAVAILABLE' })
    const entry = this.resolveEntry(targetId)
    if (entry === undefined) throw new ModelError(`WB Free Model 不服务 "${targetId}"`, { code: 'MODEL_NOT_FOUND', status: 404 })

    const result = this.store.get().results[entry.id]
    const chatOnlyModel = result?.chatOnly === true
    const wantsTools = (tools ?? []).length > 0
    if (effort !== undefined && !acceptsEffort(entry, effort)) {
      throw new ModelError(`模型 ${entry.name} 不支持推理档位 ${effort}`, { code: 'INVALID_REQUEST', status: 400 })
    }
    if (wantsTools && (chatOnlyModel || entry.toolcall !== true)) {
      throw new ModelError(`模型 ${entry.name} 仅支持普通对话，不支持工具调用`, { code: 'INVALID_REQUEST', status: 400 })
    }
    const hasImages = (messages ?? []).some(message => (message?.content ?? []).some(block => block?.type === 'image'))
    if (hasImages && entry.images !== true) {
      throw new ModelError(`模型 ${entry.name} 不支持图片输入`, { code: 'INVALID_REQUEST', status: 400 })
    }

    const prepared = prepareBridge({ messages, tools, imagesAllowed: entry.images === true, resolveImage: this.resolveImage })
    const chatOnly = prepared.chatOnly
    const backend = await this.runtime.ensure()
    const started = Date.now()
    const sessionId = await backend.createSession()
    const permissionState = { native: false }
    const watcher = this.watchPermissions(backend, sessionId, { chatOnly, state: permissionState })

    const systemText = originalSystem(prepared, system)
    const body = {
      model: { providerID: entry.namespace, modelID: entry.key },
      agent: chatOnly ? 'buddy-chat' : 'buddy-bridge',
      system: chatOnly
        ? systemText
        : `${systemText}\nUse StructuredOutput to return this envelope. All other native tools are forbidden; do not perform the external actions yourself.`,
      parts: [{ type: 'text', text: prepared.text }, ...prepared.images],
    }
    const variant = variantFor(entry, effort)
    if (variant !== undefined) body.variant = variant
    if (!chatOnly) {
      body.format = { type: 'json_schema', retryCount: 0, schema: prepared.envelope }
    }

    const onAbort = () => { void backend.abortSession(sessionId).catch(() => {}) }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      let response
      try {
        response = await backend.prompt(sessionId, body, { signal, timeoutMs })
      } catch (error) {
        if (signal?.aborted === true) throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
        if (error?.code === 'TIMEOUT') throw new ModelError('免费模型请求超时', { code: 'TIMEOUT' })
        if (permissionState.native) {
          throw new ModelError('Chat-only model attempted native tool use; execution blocked', { code: 'INVALID_REQUEST' })
        }
        throw new ModelError(error?.message ?? 'OpenCode 请求失败', { code: error?.code ?? 'SERVER', status: error?.status })
      }
      if (permissionState.native) {
        throw new ModelError('模型尝试调用 OpenCode 原生工具；请求已拒绝', { code: 'INVALID_REQUEST' })
      }

      const info = response?.info
      const parts = Array.isArray(response?.parts) ? response.parts : []
      const unexpected = parts.some(part => part?.type === 'tool'
        && !['StructuredOutput', 'invalid'].includes(part?.tool)
        && !(part?.state?.status === 'error' && permissionState.rejected?.has(part?.callID) === true))
      if (unexpected) throw new ModelError('Unexpected native tool activity; response rejected', { code: 'INVALID_REQUEST' })
      if (info?.error !== undefined && info?.error !== null) {
        const message = info.error?.data?.message || info.error?.message || info.error?.name || 'Model request failed'
        if (!(info.error?.name === 'StructuredOutputError') || chatOnly) {
          throw new ModelError(String(message), { code: 'SERVER', status: info.error?.data?.statusCode ?? 502 })
        }
      }
      const truncated = info?.finish === 'length'
      const text = envelopeFrom(response, chatOnly)
      let reply
      if (chatOnly) {
        if (String(text).trim() === '') throw new ModelError('Model returned no text', { code: 'EMPTY_RESPONSE' })
        reply = { content: String(text), calls: [] }
      } else {
        try {
          if (truncated) throw new ModelError('Model output was truncated', { code: 'MAX_TOKENS' })
          reply = this.decode(text, prepared.tools)
        } catch (error) {
          if (!['invalid_model_output', 'invalid_tool_call', 'MAX_TOKENS'].includes(error?.code)) throw error
          reply = await this.repair({
            backend, sessionId, body, prepared, signal, timeoutMs, error,
          })
        }
      }

      const usage = usageFrom(info?.tokens)
      const elapsed = Date.now() - started
      this.recordOutcome(entry.id, { ok: true, ms: elapsed, source: 'request' })
      const finish = reply.calls.length > 0 ? 'tool-calls' : (info?.finish === 'length' ? 'max-tokens' : 'stop')
      return { content: reply.content, calls: reply.calls, chatOnly, usage, finish, modelId: entry.id, elapsed }
    } finally {
      signal?.removeEventListener('abort', onAbort)
      watcher.stop()
      void backend.deleteSession(sessionId).catch(() => {})
    }
  }

  decode(text, tools) {
    try {
      return decodeEnvelope(text, { tools, parallel: true })
    } catch (error) {
      throw new ModelError(error.message, { code: error.code, status: error.status })
    }
  }

  async repair({ backend, sessionId, body, prepared, signal, timeoutMs, error }) {
    const repairBody = {
      ...body,
      parts: [{
        type: 'text',
        text: error?.code === 'MAX_TOKENS' ? TRUNCATED_PROMPT : REPAIR_PROMPT,
      }],
    }
    let response
    try {
      response = await backend.prompt(sessionId, repairBody, { signal, timeoutMs })
    } catch (cause) {
      throw new ModelError(cause?.message ?? '修复请求失败', { code: cause?.code ?? 'SERVER', status: cause?.status })
    }
    if (response?.info?.finish === 'length') {
      throw new ModelError('Model output was truncated', { code: 'MAX_TOKENS', status: 502 })
    }
    return this.decode(envelopeFrom(response, false), prepared.tools)
  }

  /** Poll `/permission` while one prompt is in flight; reject every native request. */
  watchPermissions(backend, sessionId, { chatOnly, state }) {
    state.rejected = new Set()
    const controller = new AbortController()
    const loop = (async () => {
      while (!controller.signal.aborted) {
        try {
          const pending = await backend.permissions()
          for (const permission of Array.isArray(pending) ? pending : []) {
            if (permission?.sessionID !== undefined && permission.sessionID !== sessionId) continue
            if (chatOnly) state.native = true
            try {
              await backend.replyPermission(permission, 'reject', 'WB Free Model blocks native tool execution; return the action as an external tool call.')
              if (permission?.callID !== undefined) state.rejected.add(permission.callID)
            } catch { /* the request may have settled already */ }
          }
        } catch { /* permission polling is best-effort */ }
        await sleep(250)
      }
    })()
    return {
      stop: () => {
        controller.abort()
        void loop.catch(() => {})
      },
    }
  }

  recordOutcome(modelId, { ok, ms, source, code, message }) {
    const state = this.store.get()
    const prior = state.results[modelId]
    const weight = nextWeight(prior === undefined ? undefined : weightOf(undefined, prior), ok, source, ms)
    this.store.setResult(modelId, {
      ok,
      // Only a probe may declare a model chat-only; a request without tools is
      // not evidence about the model's function-calling ability.
      chatOnly: prior?.chatOnly === true,
      weight,
      ms,
      code,
      message,
      source,
    })
    if (ok && source === 'request' && allWeightsExhausted(this.store.get().catalog, this.store.get().results)) {
      this.startProbes().catch(() => {})
    }
  }

  /** Sequential probe queue with `concurrency` workers. */
  async startProbes({ signal, concurrency = this.config.probeConcurrency ?? 2 } = {}) {
    if (this.probing) return { started: false }
    if (!this.enabled) return { started: false, reason: 'disabled' }
    this.probing = true
    const startedAt = Date.now()
    const queue = this.store.get().catalog.filter(model => !this.store.get().disabled.includes(model.id))
    const total = queue.length
    let done = 0
    const worker = async () => {
      while (queue.length > 0 && !this.disposed) {
        const model = queue.shift()
        await this.runProbe(model, signal)
        done += 1
      }
    }
    this.probeRun = { startedAt, total, done: () => done }
    try {
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
    } finally {
      this.probing = false
      this.probeRun = undefined
      await this.store.flush()
    }
    return { started: true }
  }

  /** Probe one model (settings page retry). */
  async probeOne(modelId, signal) {
    if (!this.enabled) throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED' })
    const model = this.resolveEntry(modelId)
    if (model === undefined) throw new ModelError(`未知模型 "${modelId}"`, { code: 'MODEL_NOT_FOUND', status: 404 })
    this.inflight += 1
    try {
      return await this.runProbe(model, signal)
    } finally {
      this.inflight -= 1
      await this.store.flush()
    }
  }

  async runProbe(model, signal) {
    let result
    try {
      result = await probeModel({
        outerSignal: signal,
        run: async ({ token, chatOnly, signal: probeSignal }) => this.complete({
          modelId: model.id,
          messages: probeMessages(token),
          // A catalog that already declares no tool support gets the plain-chat
          // probe, so it publishes as chat-only instead of failing the request.
          tools: chatOnly || model.toolcall !== true ? [] : PROBE_TOOLS,
          signal: probeSignal,
          timeoutMs: 60_000,
        }),
      })
    } catch (error) {
      result = { ok: false, code: error?.code ?? 'SERVER', message: error?.message ?? String(error), ms: 0 }
    }
    this.store.setResult(model.id, {
      ...result,
      weight: result.ok === true ? nextWeight(undefined, true, 'probe', result.ms) : 0,
      source: 'probe',
    })
    return result
  }

  dispose() {
    this.disposed = true
  }

  snapshot() {
    const state = this.store.get()
    const runtime = this.runtime.status()
    return {
      enabled: state.enabled !== false,
      probeOnBoot: state.probeOnBoot !== false,
      runtime,
      catalogAt: state.catalogAt,
      lastError: this.lastError || runtime.error || '',
      probing: this.probing || this.inflight > 0,
      probeProgress: this.probeRun === undefined ? undefined : { total: this.probeRun.total, done: this.probeRun.done() },
      models: state.catalog.map(model => ({
        id: model.id,
        name: model.name,
        context: model.context,
        output: model.output,
        images: model.images,
        toolcall: model.toolcall,
        reasoning: model.reasoning,
        efforts: (reasoningInfo(model)?.efforts ?? []).map(effort => effort.id),
        disabled: state.disabled.includes(model.id),
        result: state.results[model.id],
        weight: weightOf(model, state.results[model.id]),
      })),
      auto: {
        id: 'auto',
        name: 'WB · auto',
        efforts: autoLevels(state.catalog),
      },
    }
  }
}

function originalSystem(prepared, system) {
  const extra = typeof system === 'string' ? system.trim() : ''
  return extra === '' ? prepared.system : `${extra}\n\n${prepared.system}`
}
