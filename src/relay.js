/**
 * Optional transport relay: route gateway requests through a Bun sidecar.
 *
 * DISABLED BY DEFAULT. This was built on a hypothesis that the gateway buckets
 * anonymous free-tier quota by client transport (node/OpenSSL vs Bun/BoringSSL).
 * A controlled replay later disproved it: byte-identical requests answered 429
 * through BOTH transports, with the same countdown Retry-After, while the model
 * listing answered 200 for both. The real limit is one global anonymous pool
 * (`Bearer public`) reset at UTC midnight. Changing the TLS fingerprint does
 * not change the bucket, so spawning a Bun child per request is pure overhead.
 *
 * Kept behind an explicit opt-in (WB_FREE_MODEL_RELAY=1) in case the gateway's
 * policy ever changes. Failure handling stays soft: no Bun, a failed start or a
 * relay dying mid-flight all fall back to the direct node fetch.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UPSTREAM_BASE } from './constants.js'

// Resolve the relay script lazily, at spawn time — never at module load. Some
// hosts load plugins through a bundle/vm where `import.meta.url` is absent;
// evaluating `new URL('.', import.meta.url)` at the top level would throw
// while http.js imports this module, which takes down the entire plugin
// (service.js → index.js) and leaves the settings API unmounted. Computed
// inside startRelay the failure is caught by its promise and only disables
// the relay, falling back to the direct fetch as designed.
function relayScriptPath() {
  return join(fileURLToPath(new URL('.', import.meta.url)), 'o2a', 'relay-bun.js')
}

const START_TIMEOUT_MS = 15_000
// After a failed start, go direct for this long before trying again — a
// missing or broken Bun must not turn every request into a spawn storm.
const RETRY_BACKOFF_MS = 60_000

const exe = platform() === 'win32' ? 'bun.exe' : 'bun'

function findBun() {
  const configured = process.env.WB_FREE_MODEL_BUN
  if (configured !== undefined && configured !== '') return configured
  const local = join(homedir(), '.bun', 'bin', exe)
  if (existsSync(local)) return local
  return exe
}

let relay = null
let disabledUntil = 0

function relayDisabled() {
  // Opt-in only: the transport-bucket hypothesis was disproved (see file head).
  // Default off so a normal request never spawns an unused Bun child.
  if (process.env.WB_FREE_MODEL_RELAY !== '1') return true
  return Date.now() < disabledUntil
}

async function startRelay(logger) {
  const command = findBun()
  const script = relayScriptPath()
  const child = spawn(command, ['run', script], {
    env: { ...process.env, RELAY_TARGET: UPSTREAM_BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return await new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => finish(new Error(`relay did not announce its port within ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS)
    timer.unref?.()
    const onData = chunk => {
      stdout += chunk.toString()
      const match = /RELAY_PORT (\d+)/.exec(stdout)
      if (match !== null) finish(null, Number(match[1]))
    }
    const onError = error => finish(new Error(`relay spawn failed: ${error?.message ?? error}`))
    const onExit = code => finish(new Error(`relay exited during startup (code ${code})`))
    function finish(error, port) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (error !== null && error !== undefined) {
        child.kill()
        reject(error)
        return
      }
      resolve({ child, port })
    }
    child.stdout.on('data', onData)
    child.on('error', onError)
    child.on('exit', onExit)
    // Startup stderr is diagnostic only; keep it out of the harness's face.
    child.stderr.on('data', chunk => logger?.debug?.(`relay: ${chunk.toString().trim()}`))
  })
}

async function ensureRelay(logger) {
  if (relay !== null && relay.child.exitCode === null) return relay
  relay = null
  const started = await startRelay(logger)
  started.child.on('exit', () => { relay = null })
  relay = started
  return started
}

/**
 * Fetch the free lane's gateway through the Bun relay when one is available,
 * falling back to the direct node fetch otherwise. The arguments and the
 * returned value match global `fetch` exactly, so callers swap the function
 * name and nothing else.
 */
export async function relayFetch(url, { method = 'GET', headers, body, signal, redirect = 'manual' } = {}, logger) {
  if (!relayDisabled()) {
    try {
      const { port } = await ensureRelay(logger)
      const response = await fetch(`http://127.0.0.1:${port}/relay`, {
        method,
        headers: { ...headers, 'x-relay-target': url },
        body,
        redirect,
        signal,
      })
      // A relay that is up but cannot reach the gateway answers 502 with its
      // own envelope; surface that as a transport failure with the direct
      // fetch as a second chance, since the relay is optional by design.
      if (response.status !== 502) return response
      const text = await response.text().catch(() => '')
      if (!text.includes('RelayTransportError')) throw new Error('relay answered 502')
      logger?.warn?.('relay: upstream unreachable through the relay, retrying direct')
    } catch (error) {
      if (signal?.aborted === true) throw error
      relay = null
      disabledUntil = Date.now() + RETRY_BACKOFF_MS
      logger?.warn?.(`relay unavailable, going direct: ${error?.message ?? error}`)
    }
  }
  return fetch(url, { method, headers, body, redirect, signal })
}

/** Test hook / diagnostics: whether a relay process is currently running. */
export function relayActive() {
  return relay !== null && relay.child.exitCode === null ? relay.port : null
}

/** Stop the relay child, if any. Called on plugin teardown. */
export function stopRelay() {
  if (relay !== null) {
    relay.child.kill()
    relay = null
  }
}
