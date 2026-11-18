/**
 * Isolated OpenCode runtime (ported from wbBridge `runtime.rs`).
 *
 * Red lines kept:
 * - the child environment is an explicit allowlist (`ENV_ALLOW`) plus the
 *   isolated XDG roots and the server password — never the host's full env;
 * - all state lives in 0700 directories under the plugin data dir;
 * - only inline `OPENCODE_CONFIG_CONTENT` carries configuration; TLS
 *   verification is never disabled;
 * - the server binds loopback on a random port and is SIGTERM/SIGKILLed with
 *   the plugin fiber.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import {
  ANCHOR_MODEL_KEY,
  ENV_ALLOW,
  HEALTH_ATTEMPTS,
  HEALTH_POLL_MS,
  NATIVE_PERMISSIONS,
  NAMESPACES,
  OPENCODE_SERVER_USERNAME,
  OPENCODE_VERSION,
  SHUTDOWN_GRACE_MS,
} from './constants.js'
import { Backend } from './backend.js'

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const START_CANCELLED_MESSAGE = 'OpenCode startup cancelled by shutdown'

function sleep(ms) {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

/** Shutdown must keep the loop alive while waiting for the child to exit. */
function sleepRef(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function platformPackage() {
  const packages = {
    'darwin-arm64': 'opencode-darwin-arm64',
    'darwin-x64': 'opencode-darwin-x64',
    'linux-x64': 'opencode-linux-x64',
    'linux-arm64': 'opencode-linux-arm64',
    'win32-x64': 'opencode-windows-x64',
  }
  const name = packages[`${process.platform}-${process.arch}`]
  if (name === undefined) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)
  return { name, binary: process.platform === 'win32' ? 'opencode.exe' : 'opencode' }
}

export function allowedEnvironment(hostEnv = process.env) {
  const env = {}
  for (const key of ENV_ALLOW) {
    const value = hostEnv[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  return env
}

export function isolatedConfig() {
  const providers = {}
  for (const namespace of NAMESPACES) {
    if (namespace.injected !== true) continue
    providers[namespace.id] = {
      npm: namespace.npm,
      options: { baseURL: namespace.baseURL },
      models: { [ANCHOR_MODEL_KEY]: {} },
    }
  }
  return {
    permission: NATIVE_PERMISSIONS,
    autoupdate: false,
    share: 'disabled',
    agent: {
      'buddy-chat': {
        mode: 'primary',
        description: 'Text-only external conversation',
        prompt: 'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.',
        permission: NATIVE_PERMISSIONS,
      },
      'buddy-bridge': {
        mode: 'primary',
        description: 'External client inference only',
        prompt: 'You are the reasoning component of an external assistant. Never invoke native OpenCode tools. Describe external tool calls only in the requested JSON response. The external client owns execution and supplies tool results on the next request.',
        permission: NATIVE_PERMISSIONS,
      },
    },
    ...(Object.keys(providers).length === 0 ? {} : { provider: providers }),
  }
}

function parseOctal(buffer) {
  const text = buffer.toString('ascii').replace(/\0/g, '').trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

function parseString(buffer) {
  const end = buffer.indexOf(0)
  return buffer.subarray(0, end === -1 ? buffer.length : end).toString('utf8')
}

/** Extract one file from an uncompressed ustar archive; only that file is read. */
export function extractFromTar(tar, wanted) {
  let offset = 0
  let longName
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const type = String.fromCharCode(header[156] || 0)
    const size = parseOctal(header.subarray(124, 136))
    const dataStart = offset + 512
    const rawName = parseString(header.subarray(0, 100))
    const prefix = parseString(header.subarray(345, 500))
    if (type === 'L') {
      longName = parseString(tar.subarray(dataStart, dataStart + size))
      offset = dataStart + Math.ceil(size / 512) * 512
      continue
    }
    const name = longName ?? (prefix === '' ? rawName : `${prefix}/${rawName}`)
    longName = undefined
    if ((type === '0' || type === '\0') && (name === wanted || name.endsWith(`/${wanted}`))) {
      return tar.subarray(dataStart, dataStart + size)
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return undefined
}

function probeVersion(file, timeout = 15_000) {
  try {
    const result = spawnSync(file, ['--version'], {
      env: allowedEnvironment(),
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    })
    if (result.status !== 0) return undefined
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
    return text === '' ? undefined : text.split(/\r?\n/)[0].trim()
  } catch {
    return undefined
  }
}

async function fetchBuffer(url, { signal, timeoutMs = 180_000 } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs)
  const response = await fetch(url, {
    redirect: 'follow',
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    headers: { 'user-agent': 'dsh-wb-free-model' },
  })
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function verifyIntegrity(buffer, integrity) {
  if (typeof integrity !== 'string' || !integrity.startsWith('sha512-')) {
    throw new Error('the npm package metadata has no sha512 integrity')
  }
  const expected = integrity.slice('sha512-'.length)
  const actual = crypto.createHash('sha512').update(buffer).digest('base64')
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw new Error('OpenCode tarball failed its sha512 integrity check')
  }
}

async function downloadBinary({ dataDir, logger, signal }) {
  const registry = (process.env.WB_FREE_MODEL_NPM_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/, '')
  const platform = platformPackage()
  const metaURL = `${registry}/${platform.name}/${OPENCODE_VERSION}`
  logger?.info?.(`dsh-wb-free-model: downloading OpenCode ${OPENCODE_VERSION} (${platform.name})`)
  const meta = JSON.parse((await fetchBuffer(metaURL, { signal, timeoutMs: 30_000 })).toString('utf8'))
  const tarballURL = meta?.dist?.tarball
  if (typeof tarballURL !== 'string' || tarballURL === '') throw new Error('npm metadata has no tarball URL')
  const tarball = await fetchBuffer(tarballURL, { signal })
  verifyIntegrity(tarball, meta?.dist?.integrity)
  const tar = zlib.gunzipSync(tarball)
  const binary = extractFromTar(tar, `package/bin/${platform.binary}`)
  if (binary === undefined) throw new Error('npm tarball does not contain package/bin/opencode')

  const dir = path.join(dataDir, 'runtime', `opencode-${OPENCODE_VERSION}-${process.platform}-${process.arch}`, 'bin')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = path.join(dir, platform.binary)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, binary, { mode: 0o700 })
  fs.renameSync(temp, target)
  try { fs.chmodSync(target, 0o755) } catch { /* ignore */ }
  return target
}

/** Locate the pinned runtime: override, cache, PATH, then npm download. */
export async function resolveBinary({ dataDir, config = {}, logger, signal }) {
  const platform = platformPackage()
  const overrides = [config.opencodePath, process.env.WB_FREE_MODEL_OPENCODE, process.env.DSH_WB_FREE_MODEL_BIN]
  for (const candidate of overrides) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    const file = path.resolve(candidate.trim())
    if (fs.existsSync(file)) return { file, version: probeVersion(file) ?? 'unknown', source: 'override' }
  }

  const cached = path.join(
    dataDir, 'runtime', `opencode-${OPENCODE_VERSION}-${process.platform}-${process.arch}`, 'bin', platform.binary,
  )
  if (fs.existsSync(cached)) {
    const version = probeVersion(cached)
    if (version !== undefined && version.startsWith(OPENCODE_VERSION)) return { file: cached, version, source: 'cache' }
    try { fs.rmSync(cached, { force: true }) } catch { /* re-download */ }
  }

  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  for (const dir of pathDirs) {
    const file = path.join(dir, platform.binary)
    if (!fs.existsSync(file)) continue
    const version = probeVersion(file)
    if (version === undefined || !version.startsWith(OPENCODE_VERSION)) continue
    return { file, version, source: 'path' }
  }

  const file = await downloadBinary({ dataDir, logger, signal })
  const version = probeVersion(file)
  if (version === undefined || !version.startsWith(OPENCODE_VERSION)) {
    throw new Error(`downloaded OpenCode did not report ${OPENCODE_VERSION}`)
  }
  return { file, version, source: 'download' }
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : undefined
      server.close(() => port === undefined ? reject(new Error('no loopback port')) : resolve(port))
    })
  })
}

function rotateLog(file, logger) {
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) fs.renameSync(file, `${file}.1`)
  } catch { /* no log yet */ }
}

function logTail(file, bytes = 2048) {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - bytes)
    const fd = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(stat.size - start)
    fs.readSync(fd, buffer, 0, buffer.length, start)
    fs.closeSync(fd)
    return buffer.toString('utf8').trim()
  } catch {
    return ''
  }
}

export class Runtime {
  constructor({ dataDir, config, logger }) {
    this.dataDir = dataDir
    this.config = config ?? {}
    this.logger = logger
    this.starting = undefined
    this.stopPromise = undefined
    this.startAbort = undefined
    this.child = undefined
    this.logFd = undefined
    this.backend = undefined
    this.version = ''
    this.port = 0
    this.error = ''
    this.stopping = false
    this.exitHook = () => { this.killSync() }
    process.once('exit', this.exitHook)
  }

  status() {
    return {
      ready: this.backend !== undefined,
      starting: this.starting !== undefined,
      version: this.version,
      port: this.port,
      error: this.error,
    }
  }

  /**
   * Idempotent: concurrent callers await the same boot; a stop in flight is
   * awaited first. A boot cancelled by a stop that has since settled may be
   * retried once — but only when the CALLER still wants a boot (`shouldRetry`,
   * evaluated at retry time), so a disable can never respawn through this path.
   */
  ensure({ shouldRetry } = {}) {
    if (this.backend !== undefined) return Promise.resolve(this.backend)
    if (this.starting !== undefined) {
      const joined = this.starting
      return joined.catch(error => this.retryCancelled(error, shouldRetry))
    }
    if (this.stopping) {
      // A stop owns the child slot right now; restarting mid-kill would race
      // the killer, so wait for it to settle and then re-check.
      const settle = this.stopPromise === undefined ? Promise.resolve() : this.stopPromise.then(() => {}, () => {})
      return settle.then(() => this.ensure({ shouldRetry }))
    }
    const started = this.start()
      .finally(() => { this.starting = undefined })
    this.starting = started
    return started.catch(error => this.retryCancelled(error, shouldRetry))
  }

  retryCancelled(error, shouldRetry) {
    // A doomed boot can reject up to one health poll after its stop settled;
    // a caller arriving then expects a real boot. Retry from the caller's
    // context, never from the dying boot itself.
    if (!this.stopping && error?.message === START_CANCELLED_MESSAGE
      && (shouldRetry === undefined || shouldRetry() === true)) {
      return this.ensure({ shouldRetry })
    }
    throw error
  }

  /** Final teardown: stop() keeps the exit hook reversible; dispose removes it. */
  dispose() {
    process.removeListener('exit', this.exitHook)
  }

  async start() {
    const startAbort = new AbortController()
    this.startAbort = startAbort
    const cancelled = () => startAbort.signal.aborted
    this.error = ''
    const root = path.join(this.dataDir, 'opencode')
    for (const name of ['config', 'data', 'cache', 'state', 'project']) {
      const dir = path.join(root, name)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.chmodSync(dir, 0o700)
    }
    const logs = path.join(this.dataDir, 'logs')
    fs.mkdirSync(logs, { recursive: true, mode: 0o700 })
    const logFile = path.join(logs, 'opencode.log')
    rotateLog(logFile, this.logger)

    let binary
    try {
      binary = await resolveBinary({
        dataDir: this.dataDir, config: this.config, logger: this.logger, signal: startAbort.signal,
      })
    } catch (error) {
      if (cancelled()) throw new Error(START_CANCELLED_MESSAGE)
      this.error = `OpenCode runtime unavailable: ${error?.message ?? error}`
      throw new Error(this.error)
    }
    if (cancelled()) throw new Error(START_CANCELLED_MESSAGE)
    this.version = binary.version
    this.logger?.info?.(`dsh-wb-free-model: using OpenCode ${binary.version} (${binary.source})`)

    const password = crypto.randomBytes(24).toString('hex')
    const port = await freePort()
    const env = allowedEnvironment()
    for (const name of ['config', 'data', 'cache', 'state']) {
      env[`XDG_${name.toUpperCase()}_HOME`] = path.join(root, name)
    }
    env.OPENCODE_SERVER_PASSWORD = password
    env.OPENCODE_SERVER_USERNAME = OPENCODE_SERVER_USERNAME
    env.OPENCODE_DISABLE_AUTOUPDATE = 'true'
    env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
    env.OPENCODE_DISABLE_CLAUDE_CODE = 'true'
    env.OPENCODE_DISABLE_EXTERNAL_SKILLS = 'true'
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(isolatedConfig())

    // A crash-restart cycle reuses this instance: close the previous fd before
    // replacing it, or every crash leaks one descriptor.
    if (this.logFd !== undefined) {
      try { fs.closeSync(this.logFd) } catch { /* ignore */ }
      this.logFd = undefined
    }
    this.logFd = fs.openSync(logFile, 'a', 0o600)
    const child = spawn(binary.file, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: path.join(root, 'project'),
      env,
      stdio: ['ignore', this.logFd, this.logFd],
      windowsHide: true,
    })
    this.child = child
    let exited = false
    child.once('exit', () => { exited = true })
    child.once('error', error => {
      this.error = `OpenCode failed to start: ${error?.message ?? error}`
    })
    const baseURL = `http://127.0.0.1:${port}`
    const backend = new Backend({ baseURL, password, logger: this.logger })
    for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
      if (exited) {
        // Our own shutdown SIGTERMed the boot: surface the cancellation, not a
        // crash, so callers can tell the two apart.
        if (cancelled()) {
          this.killSync()
          throw new Error(START_CANCELLED_MESSAGE)
        }
        this.error = `OpenCode exited during startup. ${logTail(logFile)}`
        this.killSync()
        throw new Error(this.error)
      }
      let health
      try {
        health = await backend.health()
      } catch { /* not ready yet */ }
      if (cancelled()) {
        this.killSync()
        throw new Error(START_CANCELLED_MESSAGE)
      }
      if (health !== undefined) {
        if (health.version !== undefined && String(health.version) !== this.version) {
          this.logger?.warn?.(`dsh-wb-free-model: OpenCode reports ${health.version} but ${this.version} was probed`)
        }
        this.backend = backend
        this.port = port
        child.once('exit', code => {
          if (this.stopping || this.child !== child) return
          this.backend = undefined
          this.port = 0
          this.error = `OpenCode exited unexpectedly (${code ?? 'signal'}). ${logTail(logFile)}`
          this.logger?.warn?.(`dsh-wb-free-model: ${this.error}`)
        })
        this.logger?.info?.(`dsh-wb-free-model: OpenCode ${health.version ?? this.version} is ready on 127.0.0.1:${port}`)
        return backend
      }
      // A ref'd timer on purpose: while a boot is in flight (even one whose
      // child was just killed by a racing stop), it must keep the host process
      // alive until it settles — an unref'd sleep here can let the loop drain
      // and silently drop the boot.
      await sleepRef(HEALTH_POLL_MS)
    }
    this.error = 'OpenCode startup timed out'
    this.killSync()
    throw new Error(this.error)
  }

  killSync() {
    const child = this.child
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    if (this.logFd !== undefined) {
      try { fs.closeSync(this.logFd) } catch { /* ignore */ }
      this.logFd = undefined
    }
    this.child = undefined
  }

  /**
   * Stop the child and release the port. Reversible: `stopping` is reset when
   * the kill settles and the process-exit hook stays registered, so a later
   * `ensure()` boots a child that again has crash cleanup and exit kills.
   * Concurrent calls share one stop; `ensure()` awaits it before respawning.
   */
  stop() {
    if (this.stopping && this.stopPromise !== undefined) return this.stopPromise
    this.stopping = true
    this.stopPromise = this.performStop().finally(() => {
      this.stopping = false
      this.stopPromise = undefined
    })
    return this.stopPromise
  }

  async performStop() {
    // Cancel an in-flight boot first: it must never commit a backend (or leave
    // a spawned child) after the stop below has released the slot.
    this.startAbort?.abort(new Error('OpenCode startup cancelled by shutdown'))
    this.backend = undefined
    const child = this.child
    this.child = undefined
    this.port = 0
    try {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        const deadline = Date.now() + SHUTDOWN_GRACE_MS
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
          await sleepRef(100)
        }
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
        }
      }
    } finally {
      if (this.logFd !== undefined) {
        try { fs.closeSync(this.logFd) } catch { /* ignore */ }
        this.logFd = undefined
      }
      this.error = ''
    }
  }
}
