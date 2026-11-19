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

import { autoLevels, checkedAtOf, classifyFailure, nextWeight, probeWeight, selectModel, stateOf, weightOf } from './auto.js'
import { buildCatalog, buildKiloCatalog, parseListing } from './catalog.js'
import {
  CHECK_BATCH,
  CHECK_INTERVAL_MS,
  CHECK_SPREAD_MS,
  DEFAULT_MAX_TOKENS,
  FALLBACK_MAX_TOKENS,
  LANE_QUOTA_DEFAULT_MS,
  LISTING_TIMEOUT_MS,
  RECYCLE_THRESHOLD,
  REQUEST_TIMEOUT_MS,
  UPSTREAM_LISTING_PATH,
} from './constants.js'
import { CODE, getJson, postStreamed, UpstreamError } from './http.js'
import { fetchKiloListing, postKiloStreamed } from './kilo.js'
import { probeModel, PROBE_TOOLS, probeMessages } from './probe.js'
import { acceptsEffort, effortPatchFor, reasoningInfo } from './reasoning.js'
import { excludedIds } from './store.js'
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
    // 24h maintenance cadence: one armed timer, `checkAt` is the target arm
    // point (kept separately so busy-time deferrals are explicit).
    this.checkTimer = undefined
    this.checkAt = undefined
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
        // A refresh can swap brand-new models in (the hourly stale-refresh on
        // the adapter path and every complete() do this silently): re-arm so a
        // fresh model is due immediately and picked up within the spread
        // window instead of waiting for the previous arm point (~24h worst case).
        this.ensureCheckTimer()
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

  /** Stop-the-lane side effects: disarm the cadence, abort in-flight probes. */
  async deactivate() {
    this.clearCheckTimer()
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
    const excluded = excludedIds(state)
    return state.catalog
      .filter(model => !excluded.has(model.id))
      .filter(model => !(state.results[model.id]?.source === 'probe' && state.results[model.id]?.ok === false))
      .map(model => ({
        model,
        entry: {
          provider: 'wbbridge',
          id: model.id,
          name: model.name,
          description: this.describe(model),
          inputModalities: model.images === true ? ['text', 'image'] : ['text'],
        },
      }))
      // Publication order mirrors the auto pick: weight descending, ties keep
      // catalog order (Array#sort is stable since ES2019).
      .sort((left, right) =>
        weightOf(right.model, state.results[right.model.id]) - weightOf(left.model, state.results[left.model.id]))
      .map(item => item.entry)
  }

  describe(model) {
    const result = this.store.get().results[model.id]
    if (result?.ok === true && result?.chatOnly === true) return '仅对话（不支持工具调用）'
    if (result?.ok === true) return '可用'
    if (result?.ok === false && result?.source === 'probe') return `探测失败：${result.message ?? result.code ?? '未知原因'}`
    if (result?.ok === false) {
      // The state is display-only guidance: the model stays published and
      // selectable — one failure is not proof the model is gone.
      if (result?.state === 'limited') return '最近请求被限流，稍后自动恢复'
      if (result?.state === 'down') return '最近请求失败，模型可能暂不可用'
      return '最近一次请求失败，仍可重试'
    }
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
    const excluded = excludedIds(state)
    const usable = state.catalog.filter(model => !excluded.has(model.id)
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
   * `origin` says who initiated it: 'request' (default, adapter streams) gets
   * its outcome recorded; 'probe' skips recording entirely — the probe is the
   * sole owner of its evidence and writes the record itself (otherwise one
   * probe failure would be written twice: once as a fake request failure here,
   * once as the probe result, double-counting every streak).
   * Returns `{content, calls, chatOnly, usage, finish, modelId, elapsed}`.
   */
  async complete({ modelId, messages, system, tools, effort, signal, sessionId, timeoutMs = REQUEST_TIMEOUT_MS, origin = 'request' }) {
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
        // A probe-initiated completion is not request evidence at all.
        if (origin !== 'probe' && !aborted && this.enabled && !this.disposed) {
          this.recordOutcome(entry.id, {
            ok: false,
            ms: Date.now() - started,
            source: 'request',
            code: error.code,
            message: error.message,
            status: error.status,
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
    if (origin !== 'probe') {
      this.recordOutcome(entry.id, { ok: true, ms: elapsed, source: 'request' })
    }
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

  /**
   * Write one request outcome as the model's new result record. setResult is
   * a whole-record replacement, so every branch spreads the prior record and
   * overrides only the keys it owns — dropping weight/chatOnly/checkedAt here
   * would silently reset the model's published state (weight to the default,
   * an immediate "due", a lost chat-only mark).
   */
  recordOutcome(modelId, { ok, ms, source, code, message, status }) {
    const prior = this.store.get().results[modelId]
    if (ok === true) {
      this.store.setResult(modelId, {
        ...prior,
        ok: true,
        state: 'ok',
        failStreak: 0,
        checkFails: 0,
        // A success is valid health evidence: it advances the 24h schedule
        // (the model's weight refreshes from today's usage statistics).
        checkedAt: Date.now(),
        // Only a probe may declare a model chat-only; a request without tools
        // is not evidence about the model's function-calling ability.
        chatOnly: prior?.chatOnly === true,
        weight: nextWeight(prior === undefined ? undefined : weightOf(undefined, prior), true, source, ms),
        ms,
        code,
        message,
        // Requests carry no probe trigger — drop whatever an earlier probe wrote.
        trigger: undefined,
        source,
        status,
      })
      // The success advances checkedAt and can empty the due set: recompute.
      this.ensureCheckTimer()
      return
    }
    // A real request failure is evidence about the model, but only as much as
    // the classification says: null-classified failures (the lane or this
    // machine's transport failing below the models) only flip the displayed
    // failure — they count neither the streak nor a state.
    const classification = classifyFailure({ code, message, status })
    this.store.setResult(modelId, {
      ...prior,
      ok: false,
      state: classification ?? prior?.state,
      failStreak: classification !== null ? (prior?.failStreak ?? 0) + 1 : prior?.failStreak ?? 0,
      // Request failures never feed the recycle counter (scheduled probes only).
      checkFails: prior?.checkFails ?? 0,
      // Keep the last real health-evidence time: a request failure must not
      // manufacture one, or the 24h cadence would silently skip the model
      // ("checked" without a check). checkedAt ?? 0 also keeps legacy records
      // (no checkedAt yet) immediately due instead of inheriting `at`.
      checkedAt: prior?.checkedAt ?? 0,
      chatOnly: prior?.chatOnly === true,
      // Failure keeps the weight: one bad request must not erase what the
      // model has proven. The state/streak carries the signal instead.
      weight: prior?.weight,
      ms,
      code,
      message,
      trigger: undefined,
      source,
      status,
    })
  }

  /**
   * Probe queue with `concurrency` workers. `trigger` labels who started the
   * batch ('scheduled' failures feed the streak counters; 'manual' ones do
   * not), `models` restricts the batch to those ids, `dueOnly` keeps only
   * currently-due models. Recycled/disabled models never enter the queue and
   * are re-checked when a worker takes the head (a mid-batch /recycle must
   * not keep probing its model this round).
   */
  async startProbes({ signal, concurrency = this.config.probeConcurrency ?? 2, trigger = 'manual', dueOnly = false, models } = {}) {
    if (this.probing) return { started: false }
    if (!this.enabled) return { started: false, reason: 'disabled' }
    this.probing = true
    const controller = new AbortController()
    this.probeControllers.add(controller)
    const startedAt = Date.now()
    const state = this.store.get()
    const excluded = excludedIds(state)
    let queue = state.catalog.filter(model => !excluded.has(model.id)
      && (models === undefined || models.includes(model.id)))
    if (dueOnly === true) {
      const due = new Set(this.dueModels().map(model => model.id))
      queue = queue.filter(model => due.has(model.id))
    }
    const total = queue.length
    let done = 0
    const worker = async () => {
      // Re-check enabled and the batch's own signal on every turn: switching
      // the lane off mid-run must stop the queue quietly instead of persisting
      // CONFIG_DISABLED failures.
      while (queue.length > 0 && !this.disposed && this.enabled && !controller.signal.aborted) {
        const model = queue.shift()
        if (excludedIds(this.store.get()).has(model.id) || this.probingIds.has(model.id)) { done += 1; continue }
        this.probingIds.add(model.id)
        try {
          await this.runProbe(model, signal ?? controller.signal, { trigger })
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
    const excluded = excludedIds(this.store.get())
    if (excluded.has(model.id)) {
      throw new ModelError(
        this.store.get().recycled.includes(model.id)
          ? '该模型已移入回收站，请先恢复再检测'
          : '该模型已被禁用，无法检测',
        { code: this.store.get().recycled.includes(model.id) ? 'RECYCLED' : 'DISABLED', status: 409 },
      )
    }
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

  async runProbe(model, signal, { trigger = 'manual' } = {}) {
    if (!this.enabled || this.disposed) return undefined
    // Snapshot the prior record before probing: the probe's own completion
    // travels through complete(), and the streaks/checked time must be
    // computed from the pre-probe state, never from whatever an intermediate
    // write left behind.
    const prior = this.store.get().results[model.id]
    let result
    try {
      result = await probeModel({
        outerSignal: signal,
        run: async ({ token, chatOnly, signal: probeSignal }) => this.complete({
          modelId: model.id,
          messages: probeMessages(token),
          // A catalog that already declares no tool support gets the plain-chat
          // probe, so it publishes as chat-only instead of failing the request.
          // A model already PUBLISHED as chat-only is re-probed the same way:
          // sending it tools would trip complete()'s own capability gate (400
          // before the model is ever contacted), turning every daily re-probe
          // into a manufactured failure that hides a working chat model.
          tools: chatOnly || model.toolcall !== true || prior?.chatOnly === true ? [] : PROBE_TOOLS,
          signal: probeSignal,
          timeoutMs: 60_000,
          // The probe owns its evidence: complete() must not also record the
          // probe's request as a request outcome (double streaks, wrong weight).
          origin: 'probe',
        }),
      })
    } catch (error) {
      result = { ok: false, code: error?.code ?? 'SERVER', message: error?.message ?? String(error), ms: 0 }
    }
    // A lane switched off mid-probe (or teardown) owns the outcome: drop it
    // instead of persisting a CONFIG_DISABLED "probe failure" that would hide
    // the model from the selector until a manual retry.
    if (!this.enabled || this.disposed || result?.code === 'CONFIG_DISABLED') return result
    if (result.ok === true) {
      this.store.setResult(model.id, {
        ...prior,
        ok: true,
        state: 'ok',
        failStreak: 0,
        checkFails: 0,
        checkedAt: Date.now(),
        weight: probeWeight(result.ms),
        chatOnly: result.chatOnly === true || prior?.chatOnly === true,
        note: result.note,
        code: result.code,
        message: result.message,
        status: result.status,
        ms: result.ms,
        source: 'probe',
        trigger,
      })
      // The success can empty the due set: recompute the arm point.
      this.ensureCheckTimer()
      return result
    }
    const classification = classifyFailure({ code: result.code, message: result.message, status: result.status })
    const scheduled = trigger === 'scheduled'
    this.store.setResult(model.id, {
      ...prior,
      ok: false,
      state: classification ?? prior?.state,
      // Only scheduled probes feed the streaks: a manual probe is the user's
      // own action, not a cadence failure, and must not fast-track the
      // hysteresis filter or the recycle counter.
      failStreak: scheduled ? (prior?.failStreak ?? 0) + 1 : prior?.failStreak ?? 0,
      checkFails: scheduled ? (prior?.checkFails ?? 0) + 1 : prior?.checkFails ?? 0,
      // A scheduled probe just produced (negative) evidence: that was a check.
      // A manual one is not — never advance the checked time, and never derive
      // it from `at` (which this very write overwrites): a never-checked
      // model's manual failure would otherwise look "checked" for 24h.
      checkedAt: scheduled ? Date.now() : prior?.checkedAt ?? 0,
      weight: 0,
      chatOnly: prior?.chatOnly === true,
      note: result.note,
      code: result.code,
      message: result.message,
      status: result.status,
      ms: result.ms,
      source: 'probe',
      trigger,
    })
    // Scheduled failures leave the due set (checkedAt=now); manual ones keep
    // it (an already-due model gets its trickle re-check). Recompute anyway:
    // idempotent when the set did not change.
    this.ensureCheckTimer()
    return result
  }

  dispose() {
    this.disposed = true
    this.clearCheckTimer()
    for (const controller of this.probeControllers) {
      try { controller.abort(new Error('WB Free Model 插件已卸载')) } catch { /* ignore */ }
    }
  }

  // ── 24h maintenance cadence ────────────────────────────────────────────────
  //
  // Each model is auto-checked at most once per 24h. Due models trickle in
  // CHECK_BATCH per armed check, armed CHECK_SPREAD_MS out; a manual probe
  // batch occupying the queue defers the check to the next arm point — it is
  // never skipped, only pushed to the next slot.

  /** Models whose health evidence is missing or older than CHECK_INTERVAL_MS. */
  dueModels(now = Date.now()) {
    const state = this.store.get()
    const excluded = excludedIds(state)
    return state.catalog.filter(model => {
      if (excluded.has(model.id)) return false
      const result = state.results[model.id]
      // "No result entry at all" is due immediately — freshly discovered
      // models never wait a full interval for their first check.
      if (result === undefined) return true
      return now - checkedAtOf(result, now) >= CHECK_INTERVAL_MS
    })
  }

  /**
   * (Re)arm the maintenance timer. Idempotent and cheap — every write that
   * can change the due set (and every catalog swap) calls this.
   *
   * Arm-point rules:
   * - due models exist → arm at min(current arm, now + CHECK_SPREAD_MS): the
   *   arm point is only ever pulled EARLIER. Steady request traffic recomputes
   *   this constantly and must not push an already-armed check further out.
   * - nothing due → REPLACE the arm with min(clamped checkedAt) + interval
   *   over every non-excluded model: the old arm was computed for models that
   *   have since been checked (or excluded), so keeping it would only produce
   *   no-op wakeups. An empty candidate set (empty catalog, or every model
   *   recycled/disabled) leaves the timer disarmed — min() over an empty set
   *   would be NaN/Infinity.
   * - disabled or disposed → disarm entirely.
   */
  ensureCheckTimer() {
    if (!this.enabled || this.disposed) {
      this.clearCheckTimer()
      return
    }
    const now = Date.now()
    // A spent arm (already fired) must not anchor the due-branch min below.
    const currentArm = typeof this.checkAt === 'number' && this.checkAt > now ? this.checkAt : Number.POSITIVE_INFINITY
    const due = this.dueModels(now)
    let checkAt
    if (due.length > 0) {
      checkAt = Math.min(currentArm, now + CHECK_SPREAD_MS)
    } else {
      const state = this.store.get()
      const excluded = excludedIds(state)
      const times = state.catalog
        .filter(model => !excluded.has(model.id))
        .map(model => checkedAtOf(state.results[model.id], now))
      if (times.length === 0) {
        this.clearCheckTimer()
        return
      }
      checkAt = Math.min(...times) + CHECK_INTERVAL_MS
    }
    this.checkAt = checkAt
    clearTimeout(this.checkTimer)
    this.checkTimer = setTimeout(() => { void this.runDueChecks() }, Math.max(0, checkAt - Date.now()))
    this.checkTimer.unref?.()
  }

  /** Fire the armed check: probe up to CHECK_BATCH due models, then re-arm. */
  async runDueChecks() {
    // The arm fired — treat it as spent so the re-arm computes fresh instead
    // of anchoring on a point in the past (which would spin).
    this.checkTimer = undefined
    this.checkAt = undefined
    if (!this.enabled || this.disposed) return
    if (this.probing) {
      // A manual batch occupies the queue: retry at the next arm point.
      this.ensureCheckTimer()
      return
    }
    const due = this.dueModels().slice(0, CHECK_BATCH)
    if (due.length === 0) {
      this.ensureCheckTimer()
      return
    }
    try {
      await this.startProbes({ trigger: 'scheduled', models: due.map(model => model.id), concurrency: 1 })
    } catch (error) {
      this.logger?.warn?.(`dsh-wb-free-model: scheduled check failed: ${error?.message ?? error}`)
    } finally {
      // Whether the batch started or was pre-empted, re-derive the arm from
      // the due set: this is what makes the trickle "deferred, never skipped".
      this.ensureCheckTimer()
    }
  }

  clearCheckTimer() {
    clearTimeout(this.checkTimer)
    this.checkTimer = undefined
    this.checkAt = undefined
  }

  snapshot() {
    const state = this.store.get()
    const enabled = state.enabled !== false
    const now = Date.now()
    // A disabled lane publishes nothing: the settings page mirrors the empty
    // selector instead of listing models the harness can no longer route.
    const models = enabled
      ? state.catalog
          // Recycled models have left the published set entirely — exactly
          // like the selector sees them. They render only from
          // snapshot.recycled (the bin block with the restore button).
          .filter(model => !state.recycled.includes(model.id))
          .map(model => ({ model, result: state.results[model.id] }))
          // Same order the selector sees: weight descending, ties keep catalog
          // order (stable sort). Probe-failed and disabled rows stay visible —
          // they carry the retry UI.
          .sort((left, right) => weightOf(right.model, right.result) - weightOf(left.model, left.result))
          .map(({ model, result }) => ({
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
            // Always false here (recycled entries are filtered out above);
            // kept so the entry shape stays stable.
            recycled: state.recycled.includes(model.id),
            state: stateOf(result),
            failStreak: result?.failStreak ?? 0,
            checkFails: result?.checkFails ?? 0,
            lastCheckAt: checkedAtOf(result, now),
            // 0 = no health evidence at all → "待检测" (due immediately).
            nextCheckAt: checkedAtOf(result, now) > 0 ? checkedAtOf(result, now) + CHECK_INTERVAL_MS : 0,
            result,
            weight: weightOf(model, result),
          }))
      : []
    const due = this.dueModels(now)
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
      models,
      auto: enabled ? {
        id: 'auto',
        name: 'WB · auto',
        efforts: autoLevels(state.catalog),
      } : undefined,
      // 24h maintenance metadata (the trickle that keeps weights and states fresh).
      maintenance: {
        intervalMs: CHECK_INTERVAL_MS,
        batchSize: CHECK_BATCH,
        due: due.length,
        running: this.probing === true,
        nextCheckAt: this.checkAt,
      },
      // Arm-point is only "armed" while it can actually fire: disabled or
      // disposed lanes report false even before deactivate() clears the timer.
      checkArmed: enabled && !this.disposed && this.checkTimer !== undefined,
      recycleThreshold: RECYCLE_THRESHOLD,
      recycleSuggestions: state.catalog
        .filter(model => !state.recycled.includes(model.id)
          && Number(state.results[model.id]?.checkFails ?? 0) >= RECYCLE_THRESHOLD)
        .map(model => {
          const result = state.results[model.id]
          return {
            id: model.id,
            name: model.name,
            checkFails: result?.checkFails ?? 0,
            failStreak: result?.failStreak ?? 0,
            message: result?.message ?? result?.code ?? '连续自动检测失败',
            at: result?.at,
          }
        }),
      // Only catalog entries are returned so every item is renderable; the
      // underlying list is not pruned, so a model that left and returns keeps
      // its recycled state. Returned even when the lane is disabled — the bin
      // is viewable and restorable while stopped.
      recycled: state.catalog
        .filter(model => state.recycled.includes(model.id))
        .map(model => {
          const result = state.results[model.id]
          return {
            id: model.id,
            name: model.name,
            failStreak: result?.failStreak ?? 0,
            message: result?.message ?? result?.code ?? '已移入回收站',
            at: result?.at,
          }
        }),
    }
  }
}
