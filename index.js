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
  ctx.llm.registerConfigurableProviders?.([{
    provider: ROUTE,
    displayName: ROUTE_LABEL,
    settingsNs: settingsNamespace(ctx),
    settingsPath: [],
  }])
  ctx.llm.registerModelDiscovery?.(settingsNamespace(ctx), async () => {
    await service.refreshCatalog({ force: true })
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
        if (route === '/refresh') {
          const catalog = await service.refreshCatalog({ force: true })
          if (body.probe === true) void service.startProbes({ concurrency: body.concurrency }).catch(() => {})
          return sendJSON(res, 200, { ok: true, models: catalog.length, ...service.snapshot() })
        }
        if (route === '/probe') {
          if (typeof body.id === 'string' && body.id !== '') {
            void service.probeOne(body.id).catch(error => {
              logger.warn?.(`dsh-wb-free-model: single probe failed: ${error?.message ?? error}`)
            })
            return sendJSON(res, 202, { started: true, id: body.id, ...service.snapshot() })
          }
          if (service.probing) return sendJSON(res, 409, { started: false, ...service.snapshot() })
          void service.startProbes({ concurrency: body.concurrency }).catch(() => {})
          return sendJSON(res, 202, { started: true, ...service.snapshot() })
        }
        if (route === '/retry') {
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
          store.update(patch)
          await store.flush()
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
    return () => {
      disposed = true
      service.dispose()
      store.dispose()
      return runtime.stop()
    }
  }, 'dsh-wb-free-model: lifecycle')

  async function boot() {
    try {
      await service.refreshCatalog({ force: true })
      if (disposed) return
      if (store.get().probeOnBoot === false) {
        logger.info?.('dsh-wb-free-model: boot probe disabled in settings')
        return
      }
      const results = Object.values(store.get().results)
      const newest = results.length === 0 ? 0 : Math.max(...results.map(result => Number(result?.at ?? 0)))
      const fresh = results.length > 0 && Date.now() - newest < 12 * 60 * 60 * 1000
      const anyPassed = results.some(result => result?.ok === true)
      if (fresh && anyPassed) return
      // Probes are sequential, rate-limited completions; two workers keep the
      // boot responsive without hammering either gateway.
      void service.startProbes({ concurrency: config.probeConcurrency ?? 2 }).catch(error => {
        logger.warn?.(`dsh-wb-free-model: boot probe failed: ${error?.message ?? error}`)
      })
    } catch (error) {
      logger.warn?.(`dsh-wb-free-model: startup incomplete: ${error?.message ?? error}`)
    }
  }
}
