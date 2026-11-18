/**
 * WB Free Model — DSH plugin entry (Host half).
 *
 * Two keyless free-model lanes are reached directly over HTTPS from this
 * process: the Zen gateway behind opencode.ai (the same pooled anonymous lane
 * the OpenCode client speaks to) and Kilo AI's public gateway. There is no
 * runtime binary, child process or local port anywhere, which is what makes
 * the lane usable from hosts that cannot spawn programs — iOS among them.
 * The plugin publishes only free models, probes them on boot (ported from
 * wbBridge), and serves one extra weighted virtual model, `WB · auto`.
 *
 * Tool semantics stay wbBridge's where it matters: the upstream gateways are
 * pure inference endpoints and never execute anything. The only tool calls in
 * play are the ones their models emit as JSON; the adapter emits ordinary DSH
 * tool-call blocks for the harness to execute, with its own permission system.
 *
 * @module index.js
 */

import fs from 'node:fs'
import { ROUTE, ROUTE_LABEL, AUTO_MODEL_ID, AUTO_MODEL_NAME } from './src/constants.js'
import { WbFreeModelAdapter } from './src/adapter.js'
import { ModelService, ModelError } from './src/service.js'
import { Store, resolveDataDir } from './src/store.js'
import { createActions } from './src/actions.js'
import { SETTINGS_NS, installNativeSurface } from './src/native.js'

export const name = 'dsh-wb-free-model'
export const inject = ['llm']
export { ROUTE, ROUTE_LABEL, AUTO_MODEL_ID, AUTO_MODEL_NAME }

const API_PREFIX = '/api/wb-free-model'

/** POST routes of the settings API; each maps to one shared lane action. */
const ACTION_ROUTES = new Set(['refresh', 'probe', 'retry', 'settings'])

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
  const service = new ModelService({ store, config, logger, resolveImage: imageResolver(ctx, logger) })
  const adapter = new WbFreeModelAdapter({ service, logger })
  // `setPreferences` belongs to the native surface installed at the end of this
  // function. Every caller of it runs from a request or a tool call, never
  // during loading, so the dispatcher can be built first.
  let setPreferences
  const actions = createActions({ service, store, logger, setPreferences: patch => setPreferences(patch) })
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
    settingsNs: SETTINGS_NS,
    settingsPath: [],
  }]
  const directory = ctx.llm.registerConfigurableProviders?.(directoryEntries)
  ctx.llm.registerModelDiscovery?.(SETTINGS_NS, async (request, signal) => {
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
        const action = route.slice(1)
        if (!ACTION_ROUTES.has(action)) return sendJSON(res, 404, { error: 'not found' })
        // Refresh and probe start in the background and answer 202; clients
        // poll /status, because an open connection must not decide whether the
        // work finishes.
        const { status, payload } = await actions.run(action, body)
        return sendJSON(res, status, payload)
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
    }
  }, 'dsh-wb-free-model: lifecycle')

  async function boot() {
    try {
      // A disabled lane stays fully down across restarts: no upstream request,
      // no catalog refresh, no probes, until the user re-enables it.
      if (!service.enabled) {
        logger.info?.('dsh-wb-free-model: lane is disabled in settings; nothing talks to the upstreams until re-enabled')
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
    logger.info?.('dsh-wb-free-model: lane disabled; models withdrawn and probes stopped')
  }

  function enableLane() {
    broadcast()
    // The start path runs in the background: the settings response must not
    // wait on it. /status reflects progress (refreshing, models appearing).
    void startLane().catch(error => {
      logger.warn?.(`dsh-wb-free-model: lane start failed: ${error?.message ?? error}`)
    })
  }

  // ── surfaces a browser-less host can reach ───────────────────────────────────
  // Fish Pocket runs this half and never runs `client.js`, so the switches and
  // the actions exist here too: one settings namespace the app renders as a
  // native form, and tools it can call in chat. Both drive `src/actions.js`,
  // the same rules the routes above use, and both own the preference write.
  setPreferences = installNativeSurface(ctx, { store, config, logger, actions, toggleLane }).setPreferences
}
