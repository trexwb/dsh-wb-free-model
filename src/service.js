/**
 * Model lane: discovery, WB · auto selection, completion, probe queue.
 *
 * Both keyless lanes are reached directly over HTTPS from this process —
 * there is no runtime binary, child process or local port anywhere. That is
 * what lets the lane work on hosts that cannot spawn programs (iOS among
 * them), and it is the architecture dsh-our-free-model proved on this lane.
 *
 * Tool execution still happens exclusively on the DSH side: the upstream
 * gateways are pure inference endpoints, and the only tool calls in play are
 * the ones their models emit as JSON, which the adapter hands to the harness.
 */

import { selectModel, allWeightsExhausted, nextWeight, weightOf, autoLevels } from './auto.js'
import { buildCatalog, buildKiloCatalog, parseListing } from './catalog.js'
import {
  DEFAULT_MAX_TOKENS,
  FALLBACK_MAX_TOKENS,
  LANE_QUOTA_DEFAULT_MS,
  LISTING_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  UPSTREAM_LISTING_PATH,
} from './constants.js'
import { CODE, getJson, postStreamed, UpstreamError } from './http.js'
import { fetchKiloListing, postKiloStreamed } from './kilo.js'
import { probeModel, PROBE_TOOLS, probeMessages } from './probe.js'
import { acceptsEffort, effortPatchFor, reasoningInfo } from './reasoning.js'
import { applyFingerprint, endpointFor, sessionForConversation } from './upstream.js'
import { feedChat, finishReason as finishReasonOf, repairToolPairing, StreamFold, toChatMessages, toToolDefs } from './wire.js'

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

export class ModelService {
  constructor({ store, config, logger, resolveImage }) {
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
    // The free lane's quota is accounted per egress IP; a burned exit answers
    // every request with 429 and a Retry-After of hours. The breaker records
    // that window once, from real traffic, and refuses locally until it ends.
    this.quotaUntil = 0
    this.quotaMessage = ''
    this.laneLockedMessage = ''
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
      // A disabled lane never talks to the upstreams — not even for a stale or
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
    // instead of pulling both listings twice during startup.
    if (this.refreshing !== undefined) return this.refreshing
    const task = (async () => {
      try {
        const errors = []
        const catalog = []
        // Free lane: the listing names ids only; the capability table fills
        // in the rest. One failed lane must not hide the other lane's models.
        try {
          const listing = await getJson(UPSTREAM_LISTING_PATH, {
            session: sessionForConversation('catalog:wb-free-model'),
          })
          const free = buildCatalog(parseListing(listing))
          if (free.length > 0) catalog.push(...free)
          else errors.push('免费车道清单没有可用模型')
        } catch (error) {
          errors.push(`免费车道清单失败：${error?.message ?? error}`)
        }
        try {
          const payload = await fetchKiloListing({ timeoutMs: LISTING_TIMEOUT_MS })
          const rows = Array.isArray(payload?.data) ? payload.data : []
          catalog.push(...buildKiloCatalog(rows))
        } catch (error) {
          errors.push(`Kilo 清单失败：${error?.message ?? error}`)
        }
        const seen = new Set()
        const merged = []
        for (const entry of catalog) {
          if (seen.has(entry.id)) continue
          seen.add(entry.id)
          merged.push(entry)
        }
        if (merged.length === 0) {
          throw new ModelError(`上游清单不可用（${errors.join('；')}）`, { code: 'EMPTY_RESPONSE' })
        }
        if (errors.length > 0) {
          this.logger?.warn?.(`dsh-wb-free-model: partial listing refresh (${errors.join('; ')})`)
        }
        this.store.setCatalog(merged)
        await this.store.flush()
        this.lastError = ''
        this.logger?.info?.(`dsh-wb-free-model: discovered ${merged.length} free models`)
        return merged
      } catch (error) {
        // Surface catalog-level failures on the settings page. A disable is
        // not a failure worth reporting.
        if (error?.code !== 'CONFIG_DISABLED') this.lastError = error?.message ?? String(error)
        throw error
      }
    })()
    this.refreshing = task.finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  /** Stop-the-lane side effects: abort probes. There is no child to reap. */
  async deactivate() {
    for (const controller of this.probeControllers) {
      try { controller.abort(new Error('WB Free Model 已关闭')) } catch { /* ignore */ }
    }
    this.probeControllers.clear()
    this.logger?.info?.('dsh-wb-free-model: lane deactivated; probes aborted')
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
        defaultMaxTokens: FALLBACK_MAX_TOKENS,
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
        defaultMaxTokens: FALLBACK_MAX_TOKENS,
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
      defaultMaxTokens: entry.output && entry.output > 0 ? Math.min(entry.output, DEFAULT_MAX_TOKENS) : FALLBACK_MAX_TOKENS,
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
   * One completion. Adapter and probe share this path.
   * Returns `{content, calls, chatOnly, usage, finish, modelId, elapsed}`.
   */
  async complete({ modelId, messages, system, tools, effort, signal, sessionId, timeoutMs = REQUEST_TIMEOUT_MS }) {
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
    // failure and revive a request here. Re-check everything that may have
    // changed while we awaited.
    if (this.disposed) throw new ModelError('WB Free Model 插件已卸载', { code: 'CONFIG_DISABLED', status: 409 })
    if (!this.enabled) throw new ModelError('WB Free Model 已在设置里关闭', { code: 'CONFIG_DISABLED', status: 409 })
    if (signal?.aborted === true) throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
    const targetId = modelId === 'auto' ? this.autoModelId({ messages, tools, effort }) : modelId
    if (targetId === undefined) throw new ModelError('没有可用的免费模型；请先刷新目录或运行探测', { code: 'MODEL_UNAVAILABLE' })
    const entry = this.resolveEntry(targetId)
    if (entry === undefined) throw new ModelError(`WB Free Model 不服务 "${targetId}"`, { code: 'MODEL_NOT_FOUND', status: 404 })

    const state = this.store.get()
    const chatOnlyModel = state.results[entry.id]?.chatOnly === true
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
    if (entry.lane !== 'kilo' && Date.now() < this.quotaUntil) {
      const minutes = Math.max(1, Math.round((this.quotaUntil - Date.now()) / 60_000))
      throw new ModelError(
        `免费车道配额窗口中（约 ${minutes} 分钟后重试）：${this.quotaMessage || '上游按出口 IP 计免费配额，当前出口的窗口尚未结束'}`,
        { code: 'RATE_LIMIT', status: 429 },
      )
    }

    // ── project the harness conversation onto the Chat wire ────────────────────
    const warnings = []
    const chat = toChatMessages(repairToolPairing(messages), this.resolveImage, warnings)
    if (warnings.includes('image-dropped')) {
      this.logger?.warn?.('dsh-wb-free-model: one or more image attachments were dropped (unreadable as inline base64)')
    }
    const toolDefs = chatOnlyModel ? [] : toToolDefs(tools)
    const payload = {
      model: entry.lane === 'kilo' ? entry.id.slice('kilo/'.length) : entry.id,
      messages: typeof system === 'string' && system !== ''
        ? [{ role: 'system', content: system }, ...chat]
        : chat,
      stream: true,
      max_tokens: Math.max(1, Math.trunc(Math.min(entry.output > 0 ? entry.output : DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS))),
    }
    if (toolDefs.length > 0) payload.tools = toolDefs
    if (effort !== undefined) {
      const patch = effortPatchFor(entry, effort)
      if (patch !== null) Object.assign(payload, patch)
    }

    // The free lane's requests carry the v2 fingerprint shaping (official
    // prompt, official tool set, reversible renames, usage/completion
    // defaults) on every non-title body, tools or not; the Kilo lane has no
    // gate and sees the caller's tools exactly as declared.
    const renameMap = entry.lane === 'kilo' ? undefined : applyFingerprint(payload, false)
    const fold = new StreamFold(() => {}, renameMap)
    const onData = raw => {
      let frame
      try { frame = JSON.parse(raw) } catch { return }
      try { feedChat(fold, frame) } catch { /* one malformed frame must not kill the turn */ }
    }

    const started = Date.now()
    try {
      if (entry.lane === 'kilo') {
        await postKiloStreamed({ body: payload, signal, onData, timeoutMs })
      } else {
        await postStreamed({
          path: endpointFor(entry.id),
          body: payload,
          session: sessionForConversation(sessionId),
          signal,
          onData,
          timeoutMs,
        })
      }
    } catch (error) {
      if (error instanceof UpstreamError) {
        if (entry.lane !== 'kilo') this.noteFreeLaneOutcome(false, error)
        const aborted = error.code === CODE.aborted || signal?.aborted === true
        if (!aborted && this.enabled && !this.disposed) {
          this.recordOutcome(entry.id, {
            ok: false,
            ms: Date.now() - started,
            source: 'request',
            code: error.code,
            message: error.message,
          })
        }
        if (aborted) throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
        throw new ModelError(error.message, { code: error.code, status: error.status })
      }
      throw error
    }
    if (signal?.aborted === true) throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })

    fold.closeAll()
    if (entry.lane !== 'kilo') this.noteFreeLaneOutcome(true, undefined)
    // A stream that never reached a terminal frame was closed by something
    // other than the model running out; a broken tool call (cut mid-JSON, or
    // nameless) downgrades the whole turn to max-tokens so the harness prunes
    // the unexecutable call instead of looping on it.
    let finish = fold.finishToken === undefined
      ? (fold.sawToolCall ? 'tool-calls' : 'stop')
      : finishReasonOf(fold.finishToken)
    if (fold.brokenToolCall) finish = 'max-tokens'

    const content = fold.answerText
    if (chatOnlyModel && String(content).trim() === '') {
      throw new ModelError('Model returned no text', { code: 'EMPTY_RESPONSE' })
    }

    // Only a tool the caller actually declared may reach the harness: anything
    // else is the fingerprint gate's decoy speaking, or the model inventing a
    // tool — dropped with a warning either way.
    const declared = new Set((tools ?? []).map(tool => tool?.name).filter(name => typeof name === 'string' && name !== ''))
    const calls = []
    for (const call of fold.calls) {
      if (typeof call.name !== 'string' || call.name === '') continue
      if (!declared.has(call.name)) {
        this.logger?.warn?.(`dsh-wb-free-model: dropped a tool call to "${call.name}" — not one of the supplied tools`)
        continue
      }
      let args
      try { args = JSON.parse(call.arguments === '' ? '{}' : call.arguments) } catch { continue }
      if (args === null || typeof args !== 'object' || Array.isArray(args)) continue
      // The provider id rides along: replaying history sends the same id back
      // to the upstream, which keeps its own tool-call accounting consistent.
      calls.push({ id: typeof call.id === 'string' && call.id !== '' ? call.id : undefined, name: call.name, arguments: args })
    }

    const elapsed = Date.now() - started
    this.recordOutcome(entry.id, { ok: true, ms: elapsed, source: 'request' })
    return {
      content,
      calls,
      chatOnly: chatOnlyModel,
      usage: fold.usage,
      finish,
      modelId: entry.id,
      elapsed,
    }
  }

  /**
   * The free lane's breaker, learned passively from real traffic: a success
   * says the lane is open, a 429 opens the retry window the upstream named
   * (or the default one), and a client-gate refusal is recorded for the
   * settings page — waiting cannot clear that one.
   */
  noteFreeLaneOutcome(ok, error) {
    if (ok === true) {
      this.quotaUntil = 0
      this.quotaMessage = ''
      this.laneLockedMessage = ''
      return
    }
    if (error?.code === CODE.quota) {
      const retryAfter = Number(error?.providerRetryAfterMs)
      this.quotaUntil = Number.isFinite(retryAfter) && retryAfter > 0
        ? Date.now() + retryAfter
        : Date.now() + LANE_QUOTA_DEFAULT_MS
      this.quotaMessage = String(error?.message ?? 'free usage limit reached').slice(0, 300)
      this.logger?.warn?.(`dsh-wb-free-model: free-lane quota window opens until ${new Date(this.quotaUntil).toISOString()}`)
      return
    }
    if (error?.code === CODE.laneLocked) {
      this.laneLockedMessage = String(error?.message ?? 'the free tier answers this client only').slice(0, 300)
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
    const enabled = state.enabled !== false
    return {
      enabled,
      probeOnBoot: state.probeOnBoot !== false,
      runtime: {
        // No child process exists anywhere: the lanes are reached directly.
        mode: 'direct',
        ready: enabled && state.catalog.length > 0,
        starting: false,
        version: 'direct',
        port: 0,
        error: this.lastError,
      },
      laneQuotaUntil: this.quotaUntil > Date.now() ? this.quotaUntil : 0,
      laneQuotaMessage: this.quotaMessage,
      laneLocked: this.laneLockedMessage,
      catalogAt: state.catalogAt,
      lastError: this.lastError,
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
        lane: model.lane,
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
