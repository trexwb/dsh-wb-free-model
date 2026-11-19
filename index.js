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
import { ModelService } from './src/service.js'
import { Store, resolveDataDir } from './src/store.js'
import { createActions } from './src/actions.js'

export const name = 'dsh-wb-free-model'
export const inject = ['llm']
export { ROUTE, ROUTE_LABEL, AUTO_MODEL_ID, AUTO_MODEL_NAME }

// Keep this in sync with src/native.js. It lives here as a plain string so the
// host half never has to statically import native.js: that module imports
// `@deepseek-ai/schemastery`, a peer the host normally supplies, but a
// symlink-installed plugin resolves peers from its real path (the workspace),
// where the package is absent. A static import there would fail the whole
// module graph — including this entry and the settings API — before apply()
// ever runs. The native surfaces are optional, so they load asynchronously
// and degrade alone (see apply()'s tail).
const SETTINGS_NS = 'dsh-wb-free-model'

const API_PREFIX = '/api/wb-free-model'

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

// DSH's connection layer expects each HTTP route's `fetch(request)` to return
// a standard Response (the same contract the host's own plugins use). JSON
// answers all go through here so status/errors keep one shape.
function jsonResponse(status, payload) {
  return Response.json(payload, { status, headers: { 'cache-control': 'no-store' } })
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const dataDir = resolveDataDir()
  const store = new Store({ dataDir, logger })
  const service = new ModelService({ store, config, logger, resolveImage: imageResolver(ctx, logger) })
  const adapter = new WbFreeModelAdapter({ service, logger })
  // One implementation for every lane action (src/actions.js), shared by the web
  // API and the Host-side surfaces; only the presentation differs.
  const ACTION_ROUTES = new Set(['refresh', 'probe', 'retry', 'recycle', 'restore', 'settings'])
  // Which optional entry points this composition mounted. Each fiber flips its
  // own bit and every answer reports the record, so a host that lacks one can
  // explain the missing control instead of showing nothing.
  const surfaces = { settings: false, tools: false, commands: false, api: false }
  let setPreferences
  const actions = createActions({
    service,
    store,
    logger,
    broadcast,
    surfaces,
    setPreferences: patch => setPreferences(patch),
  })
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
  // DSH serves plugin HTTP routes through the connection layer's `fetch`
  // registry, NOT through a `webServer.register({ kind: 'prefix' })` handler —
  // that older contract silently mounts nothing on the current host, which is
  // why /status kept answering 404 "not found". Each route follows the same
  // shape the host's own plugins use:
  //   { path, methods, requestBody, fetch(request) -> Response }
  // Owner authentication (loopback / session) is enforced by the connection
  // layer before our `fetch` runs, so no local isLoopback check is needed here.
  ctx.inject(['connection'], scoped => {
    const fetchRoutes = scoped.connection?.fetch
    if (typeof fetchRoutes?.register !== 'function') {
      logger.warn?.('dsh-wb-free-model: connection.fetch registry unavailable; the web settings API will not mount')
      return
    }

    const handle = async (request, action) => {
      try {
        if (action === 'status') return jsonResponse(200, service.snapshot())
        if (typeof request.json !== 'function') return jsonResponse(415, { error: 'application/json required' })
        const body = await request.json().catch(() => ({}))
        // Refresh and probe start in the background and answer 202; clients
        // poll /status, because an open connection must not decide whether the
        // work finishes.
        const { status, payload } = await actions.run(action, body)
        return jsonResponse(status, payload)
      } catch (error) {
        logger.warn?.(`dsh-wb-free-model: API ${action} failed: ${error?.message ?? error}`)
        return jsonResponse(error?.status ?? 500, { error: error?.message ?? String(error), code: error?.code ?? 'SERVER' })
      }
    }

    const routes = [
      { path: `${API_PREFIX}/status`, methods: ['GET'], requestBody: 'buffered', fetch: request => handle(request, 'status') },
      ...[...ACTION_ROUTES].map(action => ({
        path: `${API_PREFIX}/${action}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handle(request, action),
      })),
    ]
    for (const route of routes) {
      scoped.effect(() => fetchRoutes.register(route), `dsh-wb-free-model: ${route.path}`)
    }
    surfaces.api = true
    logger.info?.(`dsh-wb-free-model: settings API mounted at ${API_PREFIX} via connection.fetch (${routes.length} routes)`)
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

  /**
   * The existing start path, shared by boot and re-enabling: refresh → arm →
   * probes per probeOnBoot → publish.
   */
  async function startLane() {
    try {
      await service.refreshCatalog()
    } finally {
      // Arming must not depend on the refresh succeeding: a failed start
      // throws into boot/enableLane's catch (which swallows it), and without
      // this the 24h maintenance would never arm for the session.
      if (!disposed && service.enabled) service.ensureCheckTimer()
    }
    if (disposed || !service.enabled) return
    // probeOnBoot=false: no immediate probes at all — the armed cadence picks
    // due models up within the spread window (≤15 minutes).
    if (store.get().probeOnBoot === false) {
      logger.info?.('dsh-wb-free-model: boot probe disabled in settings; the 24h cadence takes over')
      return
    }
    // First boot for this state (no probe evidence anywhere): probe everything
    // right now so the selector is populated immediately instead of trickling
    // in over hours. Failures count as scheduled evidence, same as the
    // cadence; the boot round advances checkedAt like any scheduled check.
    const probed = Object.values(store.get().results).filter(result => result?.source === 'probe')
    if (probed.length === 0) {
      void service.startProbes({ concurrency: config.probeConcurrency ?? 2, trigger: 'scheduled' }).catch(error => {
        logger.warn?.(`dsh-wb-free-model: boot probe failed: ${error?.message ?? error}`)
      })
      return
    }
    // Otherwise arm only: due models enter the trickle (2 per 15 minutes)
    // instead of a full re-probe on every restart. Log the throttle decision —
    // no probe fires on this path, so without a line here the behavior is
    // only visible through the status API.
    const dueCount = service.dueModels().length
    const totalCount = store.get().catalog.length
    const nextAt = typeof service.checkAt === 'number' ? new Date(service.checkAt).toISOString() : 'none'
    logger.info?.(`dsh-wb-free-model: boot maintenance armed: ${totalCount - dueCount} fresh, ${dueCount} due; next check at ${nextAt}`)
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
  // native form, tools it can call in chat, and `/wb-free` in the composer. All
  // three drive `src/actions.js`, the same rules the routes above use, and the
  // settings namespace owns the preference write.
  //
  // Loaded dynamically on purpose: native.js needs the schemastery peer, which
  // a symlink install resolves from the wrong node_modules. These surfaces are
  // optional (the web API and the model lane are already live above), so a
  // missing peer must cost only them — never the whole plugin and its /status
  // route. Keep setPreferences callable even before the async load finishes.
  setPreferences = patch => {
    store.update(patch)
    return store.flush()
  }
  void import('./src/native.js').then(module => {
    if (disposed) return
    setPreferences = module.installNativeSurface(ctx, { store, config, logger, actions, surfaces, toggleLane }).setPreferences
  }).catch(error => {
    logger.warn?.(`dsh-wb-free-model: native surfaces unavailable (${error?.message ?? error}); the lane and the web API remain active`)
  })
}
