/**
 * Outbound HTTP shared by both lanes: request posting, SSE line extraction,
 * and the classification of gateway refusals into provider-neutral codes.
 *
 * The Zen gateway reports a refusal as a JSON error envelope whose `type` is
 * the machine-readable discriminator. Three of them matter operationally:
 *
 * - `RegionError` — the model exists but this egress country is excluded; it
 *   feeds availability rather than a retry.
 * - `FreeUsageLimitError` / 429 — this client transport's free-tier bucket is
 *   spent (the gateway buckets anonymous quota by transport fingerprint, not
 *   by IP or session; see src/relay.js). Retrying with a fresh session makes
 *   it worse, which is why session ids are stable.
 * - `ModelError` / "Model is unavailable" — the pooled account no longer
 *   routes that id at all.
 *
 * How a 2xx body is read is decided by the body, not by `Content-Type`: this
 * gateway is observed answering 200 with a JSON content type over an SSE frame
 * stream, and believing the header cost the whole turn. The head is sniffed
 * and then replayed into the stream reader, so no token is buffered.
 */

import { UPSTREAM_BASE } from './constants.js'
import { relayFetch } from './relay.js'
import { gatewayHeaders, truncateSession } from './upstream.js'

/** Harness-neutral failure codes; the adapter's retry policy reads these. */
export const CODE = {
  region: 'REGION_BLOCKED',
  quota: 'RATE_LIMIT',
  credential: 'INVALID_CREDENTIAL',
  // The free lane's client gate: the gateway judged *this client* and refused
  // the whole lane (403 FreeTierError). Not a credential, not a model, not
  // retryable — a refusal this install cannot retry away.
  laneLocked: 'LANE_LOCKED',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  server: 'SERVER',
  client: 'CLIENT_ERROR',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
}

export class UpstreamError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * The socket-level facts behind a transport failure, walked off the error's
 * `cause` chain. Node's fetch collapses every DNS, TCP and TLS refusal into
 * `TypeError: fetch failed`; the reason a user could act on lives one or two
 * `cause` links deeper. Walked at most three links deep, deduplicated.
 */
export function transportCause(error) {
  const parts = []
  let node = error
  for (let depth = 0; depth < 3 && node?.cause !== undefined; depth += 1) {
    node = node.cause
    if (node === null || typeof node !== 'object') break
    const code = typeof node.code === 'string' && node.code !== '' ? node.code : ''
    const line = typeof node.message === 'string' ? node.message.split('\n')[0].trim() : ''
    if (line === '' && code === '') continue
    const fact = line === '' || line.includes(code) ? (line === '' ? code : line) : `${line} (${code})`
    if (!parts.includes(fact)) parts.push(fact)
  }
  return parts.length > 0 ? ` — ${parts.join('; ')}` : ''
}

/** Turn a gateway JSON error envelope into a classified failure. */
export function classifyFailure(status, payload, retryAfterMs) {
  const error = payload?.error ?? payload ?? {}
  const type = typeof error.type === 'string' ? error.type : ''
  const raw = typeof error.message === 'string' ? error.message : `upstream HTTP ${status}`
  // A front proxy (the lane's CDN/WAF) answers hard failures with a whole HTML
  // error page. The status alone misfiles it — a WAF's 403 is not a bad
  // credential, its 413 is not a request the user can fix by re-sending.
  const rawHtml = /^\s*<(!doctype|html[\s>])/i.test(raw)
  const isHtmlPage = rawHtml || raw.includes('with an HTML error page')
  const message = rawHtml
    ? `the gateway's front proxy answered HTTP ${status} with an HTML error page — usually a WAF or body-size limit in front of the gateway, not your credentials; if this hit a long conversation, its request size is the likely trigger`
    : raw
  const flat = message.toLowerCase()
  if (type === 'RegionError' || /not available in your country|region/i.test(flat)) {
    return new UpstreamError(message, CODE.region, { status, type })
  }
  if (type === 'insufficient_quota' || error.code === 'insufficient_quota') {
    return new UpstreamError(message, CODE.quota, { status, type })
  }
  if (status === 429 || type === 'FreeUsageLimitError' || /usage limit|rate limit/i.test(flat)) {
    return new UpstreamError(message, CODE.quota, { status, type, providerRetryAfterMs: retryAfterMs })
  }
  // The gateway rejects a signature only when the bytes it received differ
  // from the bytes that were signed — the credential itself is fine. The usual
  // cause is a local proxy rewriting the body after signing: TRANSPORT names
  // the hop that mangled the request.
  if ((status === 401 || status === 403) && /signature rejected|signature mismatch/i.test(flat)) {
    return new UpstreamError(
      'the gateway rejected the request signature — the request body was modified in transit; if a local proxy plugin is installed, disable it for this lane or enable its passthrough for signed requests',
      CODE.transport, { status, type, signatureRejected: true })
  }
  // The free lane's client gate: 403 FreeTierError — "OpenCode's free tier can
  // only be used from within OpenCode" — names the client, not the credential
  // or the model. Its own code keeps it out of the credential branch and the
  // generic 4xx fallthrough, and the probe reads it as a lane-level lock.
  if (type === 'FreeTierError' || /free tier can only be used from within/i.test(flat)) {
    return new UpstreamError(message, CODE.laneLocked, { status, type })
  }
  if ((status === 401 || status === 403) && !isHtmlPage) {
    return new UpstreamError(message, CODE.credential, { status, type })
  }
  if (type === 'ModelError' || /model is unavailable|not supported/.test(flat)) {
    return new UpstreamError(message, CODE.server, { status, type, unavailable: true })
  }
  // 4xx is the request's own fault: replaying the identical body reproduces the
  // identical refusal, so it stays outside the harness's retryable set. 408 and
  // 425 are the carve-out: they name the gateway's own timing trouble, and a
  // re-send can answer differently.
  if (status >= 400 && status < 500 && status !== 408 && status !== 425) {
    return new UpstreamError(message, CODE.client, { status, type })
  }
  return new UpstreamError(message, CODE.server, { status, type })
}

/** Parse `Retry-After` into milliseconds, when the header carries a number. */
function retryAfter(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

/**
 * Classify the beginning of a response body by shape.
 *
 * @param {string} text - the decoded head, possibly a partial stream
 * @returns {'sse'|'json'|'empty'|'unknown'}
 */
export function sniffBody(text) {
  const head = String(text ?? '').replace(/^﻿/, '').trimStart()
  if (head === '') return 'empty'
  if (head.startsWith(':') || /^(?:data|event|id|retry)[ \t]*:/m.test(head.slice(0, 64))) return 'sse'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'unknown'
}

/**
 * Take the first `limit` bytes of a body without losing the rest of it. Stops
 * as soon as the head has said it is a stream: a short answer whose server
 * keeps the connection open would otherwise sit here until the deadline. The
 * bytes spent looking are replayed into the reader, never swallowed.
 */
export async function readHead(stream, limit, { signal, timeoutMs }) {
  const reader = stream.getReader()
  const chunks = []
  // One decoder for the whole body: flushing here would corrupt a multi-byte
  // character whose tail arrives in the next chunk.
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  let done = false
  try {
    while (size < limit) {
      const row = await headRead(reader, signal, Date.now() + timeoutMs)
      if (row.done) { done = true; break }
      if (row.value === undefined) continue
      chunks.push(row.value)
      size += row.value.byteLength ?? 0
      text += decoder.decode(row.value, { stream: true })
      if (sniffBody(text) === 'sse') break
    }
  } catch (error) {
    // Abandoning the body: cancel it so the connection is not held, and do not
    // let a lock-release complaint replace the failure the caller has to
    // classify (a raw TypeError here would reach the harness unclassified).
    await reader.cancel().catch(() => {})
    try { reader.releaseLock?.() } catch { /* mid-teardown */ }
    throw classifyStreamFailure(error, signal)
  }
  return { reader, chunks, done, text, decoder }
}

/**
 * Normalize anything the body reads can throw into an `UpstreamError`. This
 * matters beyond tidiness: aborting a request rejects the pending
 * `reader.read()` with the signal's own `DOMException`, whose `code` is the
 * *numeric* legacy `20`. Anything unrecognized is reported as `TRANSPORT` —
 * a retryable code — which would have the harness retry a turn the user
 * deliberately cancelled.
 */
export function classifyStreamFailure(error, signal) {
  if (error instanceof UpstreamError) return error
  if (signal?.aborted === true || error?.name === 'AbortError') return new UpstreamError('request aborted', CODE.aborted)
  return new UpstreamError(`upstream stream read failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
}

/**
 * One read off the body while deciding what it is, bounded by the same deadline
 * and abort signal `readSse` honours. Without this a connection that accepts
 * the request and then never sends a byte would hang the turn here, in the few
 * lines of code that run before any watchdog exists.
 */
async function headRead(reader, signal, deadline) {
  if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
  let timer
  let onAbort
  const pending = reader.read()
  const halted = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError('upstream sent no bytes before its deadline', CODE.timeout)),
      Math.max(0, deadline - Date.now()))
    timer.unref?.()
    onAbort = () => {
      void reader.cancel().catch(() => {})
      reject(new UpstreamError('request aborted', CODE.aborted))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, halted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    // The losing read settles on its own once the reader is cancelled or
    // closed; its outcome must not surface as a rejection.
    pending.catch(() => {})
  }
}

/** Turn a head that was already read, plus the reader that follows it, back into one byte stream. */
export function replayStream(head) {
  const stream = (async function* () {
    try {
      for (const chunk of head.chunks) yield chunk
      if (head.done) return
      while (true) {
        const row = await head.reader.read()
        if (row.done) return
        if (row.value !== undefined) yield row.value
      }
    } finally {
      if (!head.done) await head.reader.cancel().catch(() => {})
      head.reader.releaseLock?.()
    }
  })()
  // Async-generator return() waits behind an already pending next(). Expose a
  // direct cancel so readSse can close the underlying response immediately.
  stream.cancel = () => head.done ? undefined : head.reader.cancel()
  return stream
}

/**
 * Read an SSE body and dispatch each event's `data:` payload to `onData`, in
 * order. The deadline is idle-based: every chunk resets it, so a long answer
 * is fine but a silent connection is not. Multi-line `data:` fields are joined
 * with newlines; comments and the `event:`/`id:`/`retry:` fields are skipped.
 */
export async function readSse(stream, onData, signal, timeoutMs = 300_000) {
  const decoder = new TextDecoder()
  const iterator = stream[Symbol.asyncIterator]()
  let buffer = ''
  let data = []
  let deadline = Date.now() + timeoutMs
  const dispatch = () => {
    if (data.length === 0) return
    const payload = data.join('\n')
    data = []
    onData(payload)
  }
  const cancel = () => {
    const done = iterator.return?.()
    if (done !== undefined) done.catch(() => {})
    const extra = stream.cancel?.()
    if (extra !== undefined) extra.catch?.(() => {})
  }
  const onAbort = () => cancel()
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer
  try {
    while (true) {
      if (signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
      const pending = iterator.next()
      pending.catch(() => {})
      let row
      try {
        row = await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new UpstreamError('upstream stream went idle past its deadline', CODE.timeout)),
              Math.max(0, deadline - Date.now()))
            timer.unref?.()
          }),
        ])
      } catch (error) {
        cancel()
        throw classifyStreamFailure(error, signal)
      } finally {
        clearTimeout(timer)
      }
      if (row.done) break
      deadline = Date.now() + timeoutMs
      buffer += decoder.decode(row.value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') { dispatch(); continue }
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) {
          const value = line.slice(5)
          data.push(value.startsWith(' ') ? value.slice(1) : value)
        }
      }
    }
    // A final event may lack its terminating blank line.
    buffer += decoder.decode()
    const tail = buffer.replace(/\r$/, '')
    if (tail.startsWith('data:')) {
      const value = tail.slice(5)
      data.push(value.startsWith(' ') ? value.slice(1) : value)
    }
    dispatch()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Read the rest of a body that is not a stream, as text. Continues on the
 * decoder the head used, so a character split across the sniff boundary still
 * decodes.
 */
async function readRemainder(head, signal) {
  let text = head.text
  try {
    if (!head.done) {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
      }
    }
  } catch (error) {
    await head.reader.cancel().catch(() => {})
    throw classifyStreamFailure(error, signal)
  }
  return text + head.decoder.decode()
}

const SNIFF_BYTES = 4096

/**
 * POST one turn to the free lane and stream back decoded SSE `data:` payloads.
 *
 * @param {object} options
 * @param {string} options.path - gateway path for the model's wire
 * @param {object} options.body - JSON request body
 * @param {string} options.session - canonical upstream session id
 * @param {AbortSignal} [options.signal]
 * @param {(payload: string) => void} options.onData - one `data:` payload, in order
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status:number}>}
 */
export async function postStreamed({ path, body, session, signal, onData, timeoutMs = 300_000 }) {
  // The v2 header set (src/o2a/headers.js). The project id derives from the
  // same canonical session, so one conversation's retries and continuations
  // share one upstream quota bucket. `accept` stays the client's wildcard —
  // the v2 fingerprint matches the whole string. The Messages wire carries
  // the 2.x beta header; the path is the only wire signal this layer sees.
  const canonical = truncateSession(session)
  const headers = gatewayHeaders({ session: canonical, project: canonical, anthropic: path.includes('/messages') })
  let response
  try {
    // The relay (Bun transport) restores the genuine client fingerprint the
    // gateway's free-tier buckets key on; it falls back to the direct fetch
    // whenever no Bun is available, so this call site is transport-agnostic.
    response = await relayFetch(`${UPSTREAM_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`upstream request failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  }
  const setRetry = retryAfter(response.headers.get('retry-after'))
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    // An empty 5xx body has no envelope to classify, and `HTTP 502` is not an
    // answer the caller can act on.
    if (text.trim() === '' && response.status >= 500) {
      throw new UpstreamError(`the gateway answered HTTP ${response.status} with an empty body`, CODE.server, { status: response.status })
    }
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('upstream returned no body', CODE.empty)
  // `Content-Type` is a hint, not a verdict: take the first bytes and let the
  // body say what it is. Whatever was spent reading them is replayed in front
  // of the stream, so nothing is buffered away and no frame is dropped.
  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('upstream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }
  const text = head.done ? head.text : await readRemainder(head, signal)
  if (shape !== 'json') {
    // A 200 body of markup is a WAF/CDN page, and replaying the identical
    // request draws it again — one readable line, outside the retryable set.
    if (/^\s*<(!doctype|html[\s>])/i.test(text)) {
      throw new UpstreamError(`the gateway's front proxy answered HTTP ${response.status} with an HTML error page — usually a WAF or body-size limit in front of the gateway`, CODE.client, { status: response.status })
    }
    throw new UpstreamError(`unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError(`unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload.error) throw classifyFailure(response.status, payload, setRetry)
  // A gateway that answered a stream request with one JSON document: fold the
  // whole answer into a single payload for the reader.
  onData(JSON.stringify(payload))
  return { status: response.status }
}

/** Fetch a small JSON document from the gateway with the fingerprint headers. */
export async function getJson(path, { session, signal, timeoutMs = 15_000 } = {}) {
  const canonical = truncateSession(session ?? '')
  const headers = gatewayHeaders({ session: canonical, project: canonical, accept: 'application/json' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  // Which of the two aborted decides the code: this call's own deadline is a
  // retryable timeout, the caller ending the request is not a failure at all.
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await relayFetch(`${UPSTREAM_BASE}${path}`, { headers, redirect: 'error', signal: controller.signal })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 200) } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    return payload
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('upstream GET timed out', CODE.timeout)
    throw new UpstreamError(`upstream GET failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}
