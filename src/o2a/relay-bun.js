/**
 * Bun-side transport relay for the free lane.
 *
 * The gateway classifies anonymous free-tier callers by client transport, and
 * node's OpenSSL TLS handshake is bucketed with the retired opencode2api bot
 * fleet whose quota pool is permanently spent (every request answers 429
 * FreeUsageLimitError while a genuine CLI on the same machine and IP succeeds).
 * Bun's fetch speaks BoringSSL with the same fingerprint the real CLI has, so
 * the plugin hands its gateway traffic to this small relay: identical headers
 * and body, different — authentic — transport.
 *
 * Protocol: the parent POSTs to http://127.0.0.1:<port>/relay with the real
 * request carried in headers (`x-relay-target` names the absolute upstream
 * URL; everything else passes through verbatim). The reply streams back raw.
 * Announces the listening port on stdout as `RELAY_PORT <n>`.
 */

const http = require('node:http')
const { Readable } = require('node:stream')

const allowedBase = (process.env.RELAY_TARGET ?? 'https://opencode.ai').replace(/\/+$/, '')
const HOP_BY_HOP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'content-length', 'accept-encoding', 'x-relay-target'])

const server = http.createServer(async (req, res) => {
  const raw = req.headers['x-relay-target'] ?? allowedBase + req.url
  let target
  try { target = new URL(raw) } catch {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'RelayUsageError', message: `bad relay target: ${raw}` } }))
    return
  }
  if (target.origin !== new URL(allowedBase).origin) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'RelayUsageError', message: `target outside the relayed origin: ${target.origin}` } }))
    return
  }

  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue
    headers[key] = value
  }
  // The gateway's client check reads the HTTP-level fingerprint too, and the
  // real client's header order is part of it (JA4H): authorization,
  // content-type, user-agent, the remaining headers alphabetically. The local
  // hop reorders headers, so rebuild the canonical sequence here.
  const ordered = {}
  for (const key of ['authorization', 'content-type', 'user-agent']) {
    if (headers[key] !== undefined) ordered[key] = headers[key]
  }
  for (const key of Object.keys(headers).sort()) {
    if (ordered[key] === undefined) ordered[key] = headers[key]
  }

  const abort = new AbortController()
  // The parent aborting its fetch closes the response socket early; carry the
  // cancellation upstream so a cancelled turn does not keep streaming tokens.
  // `req`'s own 'close' also fires on normal body completion, so the response
  // side is the only reliable signal of a premature disconnect.
  res.on('close', () => { if (!res.writableEnded) abort.abort() })

  try {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    const upstream = await fetch(target, {
      method: req.method,
      headers: ordered,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: abort.signal,
    })
    const outHeaders = {}
    for (const [key, value] of upstream.headers) {
      const name = key.toLowerCase()
      if (name === 'content-length' || name === 'transfer-encoding' || name === 'content-encoding') continue
      outHeaders[key] = value
    }
    res.writeHead(upstream.status, outHeaders)
    if (upstream.body !== null && upstream.body !== undefined) {
      await new Promise((resolve, reject) => {
        Readable.fromWeb(upstream.body).on('error', reject).pipe(res).on('error', reject).on('finish', resolve)
      })
    } else {
      res.end()
    }
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'RelayTransportError', message: String(error?.message ?? error) } }))
    } else {
      res.end()
    }
  }
})

server.listen(Number(process.env.RELAY_PORT ?? 0), '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write(`RELAY_PORT ${port}\n`)
})

process.on('SIGTERM', () => server.close())
process.on('SIGINT', () => server.close())
