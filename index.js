/**
 * WB Free Model — DSH plugin entry (Host half).
 *
 * One isolated OpenCode 1.19.6 runtime hosts this machine's keyless free
 * models. The plugin owns no user credential: it discovers what the runtime
 * offers, publishes only zero-cost models, probes them on boot (ported from
 * wbBridge), and serves one extra weighted virtual model, `WB · auto`.
 *
 * Bridge semantics are wbBridge's: the hosted model never executes DSH tools.
 * It returns a `{content, calls}` envelope; the adapter validates it and emits
 * ordinary DSH tool-call blocks for the harness to execute.
 *
 * @module index.js
 */

import fs from 'node:fs'
import { ROUTE, ROUTE_LABEL, AUTO_MODEL_ID, AUTO_MODEL_NAME } from './src/constants.js'
import { WbFreeModelAdapter } from './src/adapter.js'
import { ModelService, ModelError } from './src/service.js'
import { Runtime } from './src/runtime.js'
import { Store, resolveDataDir } from './src/store.js'

export const name = 'dsh-wb-free-model'
export const inject = ['llm']
export { ROUTE, ROUTE_LABEL, AUTO_MODEL_ID, AUTO_MODEL_NAME }

const API_PREFIX = '/api/wb-free-model'

function settingsNamespace(ctx) {
  return ctx.fiber?.entry?.options?.id ?? name
}

function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * DSH image blocks carry only an attachment id; this turns one into a data URL
 * for the provider request. The service is looked up per call because a plugin
 * may load before `attachments` is provided.
 */
function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) {
        logger.warn?.(`dsh-wb-free-model: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`)
        return undefined
      }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`dsh-wb-free-model: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJSON(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new ModelError('request body too large', { code: 'INVALID_REQUEST', status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ModelError('request body is not valid JSON', { code: 'INVALID_REQUEST', status: 400 })
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const dataDir = resolveDataDir()
  const store = new Store({ dataDir, logger })
  const runtime = new Runtime({ dataDir, config, logger })
  const service = new ModelService({ runtime, store, config, logger, resolveImage: imageResolver(ctx, logger) })
  const adapter = new WbFreeModelAdapter({ service, logger })
  let disposed = false

  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    logger.warn?.(`dsh-wb-free-model: could not prepare ${dataDir} (${error?.message ?? error})`)
  }

  const registration = ctx.llm.registerAdapter([ROUTE], adapter)
  const directoryEntries = [{
    provider: ROUTE,
    displayName: ROUTE_LABEL,
    settingsNs: settingsNamespace(ctx),
    settingsPath: [],
  }]
  const directory = ctx.llm.registerConfigurableProviders?.(directoryEntries)
  ctx.llm.registerModelDiscovery?.(settingsNamespace(ctx), async (request, signal) => {
    // This hook is the settings page's "interrogate one endpoint" offer (dsh-llm
    // calls `discover(request, signal)` with a draft endpoint description) — it
    // is NOT the selector's publication channel; that is adapter.listModels().
    if (signal?.aborted === true) return []
    if (!service.enabled) return []
    try {
      await service.refreshCatalog()
    } catch (error) {
      if (store.get().catalog.length === 0) throw error
      logger.warn?.(`dsh-wb-free-model: discovery refresh failed, using the cached catalog (${error?.message ?? error})`)
    }
    const state = store.get()
    return [
      { id: AUTO_MODEL_ID, name: AUTO_MODEL_NAME, contextWindow: 131_072, maxTokens: 8_192 },
      ...state.catalog.map(model => ({
        id: model.id,
        name: model.name,
        contextWindow: model.context > 0 ? model.context : 131_072,
        maxTokens: model.output > 0 ? Math.min(model.output, 32_768) : 8_192,
        inputModalities: model.images === true ? ['text', 'image'] : ['text'],
      })),
    ]
  })

  /**
   * Re-announce both registrations after a lane toggle. dsh-llm publishes
   * `llm/adapters-updated` on every `replace`, "exactly like a first
   * registration", which makes the harness re-query adapter.listModels() —
   * that is how withdrawn models actually disappear from the selector.
   */
  function broadcast() {
    try { registration.replace([ROUTE]) } catch (error) {
      logger.warn?.(`dsh-wb-free-model: adapter re-announce failed: ${error?.message ?? error}`)
    }
    try { directory?.replace?.(directoryEntries) } catch (error) {
      logger.warn?.(`dsh-wb-free-model: provider directory re-announce failed: ${error?.message ?? error}`)
    }
  }
  ctx.on?.('loader/volatile-update', () => {
    try { registration.replace([ROUTE]) } catch { /* a disposed registration means teardown */ }
  })

  // ── browser-facing settings API ──────────────────────────────────────────────
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    const handler = async (req, res) => {
      try {
        if (!isLoopback(req)) return sendJSON(res, 403, { error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const route = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : url.pathname
        if (req.method === 'GET' && route === '/status') {
          return sendJSON(res, 200, service.snapshot())
        }
        if (req.method !== 'POST') return sendJSON(res, 405, { error: 'method not allowed' })
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          return sendJSON(res, 415, { error: 'application/json required' })
        }
        const body = await readJSON(req)
        const disabled = () => sendJSON(res, 409, {
          started: false,
          reason: 'disabled',
          error: 'WB Free Model 已在设置里关闭',
          code: 'CONFIG_DISABLED',
          ...service.snapshot(),
        })
        if (route === '/refresh') {
          if (!service.enabled) return disabled()
          // Fire-and-forget like /probe: a cold start can legitimately take
          // minutes (runtime download), far beyond any client's patience, and
          // the connection must not decide whether the refresh finishes.
          // Failures land in snapshot.lastError; clients poll /status.
          void service.refreshCatalog()
            .then(() => {
              if (body.probe === true) return service.startProbes({ concurrency: body.concurrency })
            })
            .catch(() => {})
          return sendJSON(res, 202, { started: true, ...service.snapshot() })
        }
        if (route === '/probe') {
          if (!service.enabled) return disabled()
          if (typeof body.id === 'string' && body.id !== '') {
            if (service.isProbingModel(body.id)) {
              return sendJSON(res, 409, { started: false, reason: 'in-flight', id: body.id, error: '该模型正在检测中', code: 'PROBE_IN_PROGRESS', ...service.snapshot() })
            }
            if (!service.canStartSingleProbe()) {
              return sendJSON(res, 409, { started: false, reason: 'busy', id: body.id, error: '单模型检测并发已满，请稍后再试', code: 'PROBE_BUSY', ...service.snapshot() })
            }
            void service.probeOne(body.id).catch(error => {
              logger.warn?.(`dsh-wb-free-model: single probe failed: ${error?.message ?? error}`)
            })
            return sendJSON(res, 202, { started: true, id: body.id, ...service.snapshot() })
          }
          if (service.probing) {
            return sendJSON(res, 409, {
              started: false,
              reason: 'probing',
              error: '已有检测在进行中，请等当前检测完成',
              code: 'PROBE_IN_PROGRESS',
              ...service.snapshot(),
            })
          }
          void service.startProbes({ concurrency: body.concurrency }).catch(() => {})
          return sendJSON(res, 202, { started: true, ...service.snapshot() })
        }
        if (route === '/retry') {
          if (!service.enabled) return disabled()
          if (typeof body.id === 'string' && body.id !== '') {
            store.dropResult(body.id)
            store.update({ disabled: store.get().disabled.filter(id => id !== body.id) })
          } else {
            for (const model of store.get().catalog) store.dropResult(model.id)
            store.update({ disabled: [] })
          }
          await store.flush()
          return sendJSON(res, 200, { ok: true, ...service.snapshot() })
        }
        if (route === '/settings') {
          const patch = {}
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          if (typeof body.probeOnBoot === 'boolean') patch.probeOnBoot = body.probeOnBoot
          const wasEnabled = store.get().enabled !== false
          store.update(patch)
          await store.flush()
          const isEnabled = store.get().enabled !== false
          if (typeof body.enabled === 'boolean' && wasEnabled !== isEnabled) {
            await toggleLane(isEnabled)
          }
          return sendJSON(res, 200, { ok: true, ...service.snapshot() })
        }
        return sendJSON(res, 404, { error: 'not found' })
      } catch (error) {
        logger.warn?.(`dsh-wb-free-model: API ${req.method} ${req.url} failed: ${error?.message ?? error}`)
        sendJSON(res, error?.status ?? 500, { error: error?.message ?? String(error), code: error?.code ?? 'SERVER' })
      }
    }
    scoped.effect(() => server.register({ kind: 'prefix', path: API_PREFIX, handler }), 'dsh-wb-free-model: settings API')
    logger.info?.(`dsh-wb-free-model: settings API mounted at ${API_PREFIX}`)
  })

  // ── lifecycle ────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    void boot()
    return async () => {
      disposed = true
      service.dispose()
      store.dispose()
      await runtime.stop()
      // The reversible stop keeps the process-exit hook armed for crashes;
      // teardown is final, so release the hook (keeps reloads from stacking them).
      runtime.dispose()
    }
  }, 'dsh-wb-free-model: lifecycle')

  async function boot() {
    try {
      // A disabled lane stays fully down across restarts: no runtime child, no
      // catalog refresh, no probes, until the user re-enables it.
      if (!service.enabled) {
        logger.info?.('dsh-wb-free-model: lane is disabled in settings; runtime stays down until re-enabled')
        return
      }
      await startLane()
    } catch (error) {
      logger.warn?.(`dsh-wb-free-model: startup incomplete: ${error?.message ?? error}`)
    }
  }

  /** The existing start path, shared by boot and re-enabling: refresh → probes → publish. */
  async function startLane() {
    await service.refreshCatalog()
    if (disposed || !service.enabled) return
    if (store.get().probeOnBoot === false) {
      logger.info?.('dsh-wb-free-model: boot probe disabled in settings')
      return
    }
    // Freshness counts probe outcomes only: a request success from a previous
    // session must not mask models that were never (or adversely) probed.
    const probed = Object.values(store.get().results).filter(result => result?.source === 'probe')
    const newest = probed.length === 0 ? 0 : Math.max(...probed.map(result => Number(result?.at ?? 0)))
    const fresh = probed.length > 0 && Date.now() - newest < 12 * 60 * 60 * 1000
    const anyPassed = probed.some(result => result?.ok === true)
    if (fresh && anyPassed) return
    // Probes are sequential, rate-limited completions; two workers keep the
    // boot responsive without hammering either gateway.
    void service.startProbes({ concurrency: config.probeConcurrency ?? 2 }).catch(error => {
      logger.warn?.(`dsh-wb-free-model: boot probe failed: ${error?.message ?? error}`)
    })
  }

  // Toggle side effects run one at a time so rapid double-toggles can never
  // race a stop against a fresh boot.
  let toggleChain = Promise.resolve()
  function toggleLane(enable) {
    const task = toggleChain.then(() => enable ? enableLane() : disableLane())
    toggleChain = task.catch(() => {})
    return task
  }

  async function disableLane() {
    broadcast()
    await service.deactivate()
    logger.info?.('dsh-wb-free-model: lane disabled; models withdrawn and runtime stopped')
  }

  function enableLane() {
    broadcast()
    // The start path runs in the background: a cold boot may download the
    // runtime, and the settings response must not wait on it. /status reflects
    // progress (runtime.starting, refreshing, models appearing).
    void startLane().catch(error => {
      logger.warn?.(`dsh-wb-free-model: lane start failed: ${error?.message ?? error}`)
    })
  }
}
