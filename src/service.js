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
    this.probingIds = new Set()
    this.probeControllers = new Set()
    this.singleProbes = 0
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
    if (!this.enabled) {
      // A disabled lane never starts the runtime — not even for a stale or
      // empty catalog. Callers serve whatever cache exists.
      return this.store.get().catalog
    }
    const state = this.store.get()
    const stale = Date.now() - Number(state.catalogAt ?? 0) > 60 * 60 * 1000
    if (!force && state.catalog.length > 0 && !stale) return state.catalog
    return this.refreshCatalog()
  }

  async refreshCatalog() {
    if (!this.enabled) {
      throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED', status: 409 })
    }
    // Every caller wants fresh data; an in-flight refresh serves them all
    // instead of pulling /provider twice during startup.
    if (this.refreshing !== undefined) return this.refreshing
    const task = (async () => {
      try {
        const backend = await this.runtime.ensure({ shouldRetry: () => this.enabled && !this.disposed })
        // Each await can span a lane switch: a refresh must never write state
        // (or leave a runtime it booted) for a lane that is now disabled.
        if (!this.enabled || this.disposed) {
          throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED', status: 409 })
        }
        const providers = await backend.providers()
        if (!this.enabled || this.disposed) {
          throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED', status: 409 })
        }
        const catalog = discoverModels(providers)
        if (catalog.length === 0) {
          throw new ModelError('OpenCode returned no keyless free models', { code: 'EMPTY_RESPONSE' })
        }
        this.store.setCatalog(catalog)
        await this.store.flush()
        this.lastError = ''
        this.logger?.info?.(`dsh-wb-free-model: discovered ${catalog.length} free models`)
        return catalog
      } catch (error) {
        // Surface catalog-level failures on the settings page (runtime.error
        // alone never covers "runtime ready but /provider failing"). A disable
        // is not a failure worth reporting.
        if (error?.code !== 'CONFIG_DISABLED') this.lastError = error?.message ?? String(error)
        throw error
      }
    })()
    this.refreshing = task.finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** Stop-the-lane side effects: abort probes, then release the runtime child. */
  async deactivate() {
    for (const controller of this.probeControllers) {
      try { controller.abort(new Error('WB Free Model 已关闭')) } catch { /* ignore */ }
    }
    this.probeControllers.clear()
    await this.runtime.stop()
    this.logger?.info?.('dsh-wb-free-model: lane deactivated; runtime stopped')
  }

  isProbingModel(modelId) {
    return this.probingIds.has(modelId)
  }

  /** Whether one more single-model probe may start right now. */
  canStartSingleProbe() {
    return this.singleProbes < Math.max(1, this.config.probeConcurrency ?? 2)
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
    if (!this.enabled) throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED', status: 409 })
    if (signal?.aborted === true) throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
    try {
      await this.ensureCatalog()
    } catch (error) {
      // The cached catalog already passed its probes; a failed refresh must not
      // turn every request into a hard failure while the cache can serve.
      if (this.store.get().catalog.length === 0) throw error
      this.logger?.warn?.(`dsh-wb-free-model: catalog refresh failed, serving the cached catalog (${error?.message ?? error})`)
    }
    // A disable that raced the refresh above must not slip through the swallowed
    // failure and revive the runtime via ensure() below. Re-check everything
    // that may have changed while we awaited.
    if (this.disposed) throw new ModelError('WB Free Model 插件已卸载', { code: 'CONFIG_DISABLED', status: 409 })
    if (!this.enabled) throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED', status: 409 })
    if (signal?.aborted === true) throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
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
    // The retry predicate is evaluated at retry time: a lane disabled while a
    // cancelled boot was pending must never respawn the runtime here.
    const backend = await this.runtime.ensure({
      shouldRetry: () => this.enabled && !this.disposed && signal?.aborted !== true,
    })
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
    } catch (error) {
      // A real request failure is evidence about the model: record it so the
      // weights, auto selection and the settings page can react. User
      // cancellation is not the model's fault, and neither is a lane switched
      // off (or teardown) mid-request killing the runtime under us.
      if (error?.code !== 'ABORTED' && signal?.aborted !== true && this.enabled && !this.disposed) {
        this.recordOutcome(entry.id, {
          ok: false,
          ms: Date.now() - started,
          source: 'request',
          code: error?.code ?? 'SERVER',
          message: error?.message ?? String(error),
        })
      }
      throw error
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
            // Record the callID on sight, not on reply success: the reply may
            // fail because the permission already settled (e.g. another reject
            // settled the whole pending set). The call was still blocked, so
            // complete() must not misjudge its error part as "unexpected".
            if (permission?.callID !== undefined) state.rejected.add(permission.callID)
            try {
              await backend.replyPermission(permission, 'reject', 'WB Free Model blocks native tool execution; return the action as an external tool call.')
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
    const controller = new AbortController()
    this.probeControllers.add(controller)
    const startedAt = Date.now()
    const queue = this.store.get().catalog.filter(model => !this.store.get().disabled.includes(model.id))
    const total = queue.length
    let done = 0
    const worker = async () => {
      // Re-check enabled and the batch's own signal on every turn: switching
      // the lane off mid-run must stop the queue quietly instead of persisting
      // CONFIG_DISABLED failures.
      while (queue.length > 0 && !this.disposed && this.enabled && !controller.signal.aborted) {
        const model = queue.shift()
        if (this.probingIds.has(model.id)) { done += 1; continue }
        this.probingIds.add(model.id)
        try {
          await this.runProbe(model, signal ?? controller.signal)
        } finally {
          this.probingIds.delete(model.id)
        }
        done += 1
      }
    }
    this.probeRun = { startedAt, total, done: () => done }
    try {
      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
    } finally {
      this.probing = false
      this.probeRun = undefined
      this.probeControllers.delete(controller)
      await this.store.flush()
    }
    return { started: true }
  }

  /** Probe one model (settings page retry). */
  async probeOne(modelId, signal) {
    if (!this.enabled) throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED', status: 409 })
    const model = this.resolveEntry(modelId)
    if (model === undefined) throw new ModelError(`未知模型 "${modelId}"`, { code: 'MODEL_NOT_FOUND', status: 404 })
    if (this.probingIds.has(model.id)) {
      throw new ModelError('该模型正在检测中，请等当前检测完成', { code: 'PROBE_IN_PROGRESS', status: 409 })
    }
    const limit = Math.max(1, this.config.probeConcurrency ?? 2)
    if (this.singleProbes >= limit) {
      throw new ModelError('单模型检测并发已满，请稍后再试', { code: 'PROBE_BUSY', status: 409 })
    }
    this.inflight += 1
    this.singleProbes += 1
    const controller = new AbortController()
    this.probeControllers.add(controller)
    this.probingIds.add(model.id)
    try {
      return await this.runProbe(model, signal ?? controller.signal)
    } finally {
      this.inflight -= 1
      this.singleProbes -= 1
      this.probeControllers.delete(controller)
      this.probingIds.delete(model.id)
      await this.store.flush()
    }
  }

  async runProbe(model, signal) {
    if (!this.enabled || this.disposed) return undefined
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
    // A lane switched off mid-probe (or teardown) owns the outcome: drop it
    // instead of persisting a CONFIG_DISABLED "probe failure" that would hide
    // the model from the selector until a manual retry.
    if (!this.enabled || this.disposed || result?.code === 'CONFIG_DISABLED') return result
    this.store.setResult(model.id, {
      ...result,
      weight: result.ok === true ? nextWeight(undefined, true, 'probe', result.ms) : 0,
      source: 'probe',
    })
    return result
  }

  dispose() {
    this.disposed = true
    for (const controller of this.probeControllers) {
      try { controller.abort(new Error('WB Free Model 插件已卸载')) } catch { /* ignore */ }
    }
  }

  snapshot() {
    const state = this.store.get()
    const runtime = this.runtime.status()
    const enabled = state.enabled !== false
    return {
      enabled,
      probeOnBoot: state.probeOnBoot !== false,
      runtime,
      catalogAt: state.catalogAt,
      lastError: this.lastError || runtime.error || '',
      refreshing: this.refreshing !== undefined,
      probing: enabled && (this.probing || this.inflight > 0),
      probeProgress: this.probeRun === undefined ? undefined : { total: this.probeRun.total, done: this.probeRun.done() },
      probingIds: enabled ? [...this.probingIds] : [],
      // Client retry bursts pace themselves against the single-probe limit.
      probeConcurrency: Math.max(1, this.config.probeConcurrency ?? 2),
      probeSlotsBusy: this.singleProbes,
      // A disabled lane publishes nothing: the settings page mirrors the empty
      // selector instead of listing models the harness can no longer route.
      models: enabled ? state.catalog.map(model => ({
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
      })) : [],
      auto: enabled ? {
        id: 'auto',
        name: 'WB · auto',
        efforts: autoLevels(state.catalog),
      } : undefined,
    }
  }
}

function originalSystem(prepared, system) {
  const extra = typeof system === 'string' ? system.trim() : ''
  return extra === '' ? prepared.system : `${extra}\n\n${prepared.system}`
}
