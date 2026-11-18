/** Plugin state: catalog snapshot, probe results, preferences. Persisted atomically at 0600. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR_NAME } from './constants.js'

/** Consecutive refreshes a model must be missing before its result is pruned. */
const RESULT_PRUNE_MISSES = 3

export function resolveDshHome() {
  const override = process.env.DSH_HOME
  return override && override.trim() !== '' ? path.resolve(override) : path.join(os.homedir(), '.dsh')
}

export function resolveDataDir() {
  return path.join(resolveDshHome(), DATA_DIR_NAME)
}

function initialState() {
  return {
    version: 1,
    enabled: true,
    probeOnBoot: true,
    catalog: [],
    catalogAt: 0,
    results: {},
    disabled: [],
  }
}

export class Store {
  constructor({ dataDir, logger }) {
    this.logger = logger
    this.dir = dataDir
    this.file = path.join(dataDir, 'state.json')
    this.state = initialState()
    this.chain = Promise.resolve()
    this.timer = undefined
    this.disposed = false
    // Session-scoped: how many consecutive refreshes a result's model has been
    // missing from the catalog. Transient upstream shrink must not wipe valid
    // probe results; only a persistent departure prunes them.
    this.missingCounts = new Map()
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(dataDir, 0o700) } catch { /* best effort on platforms without POSIX modes */ }
    this.load()
  }

  load() {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const base = initialState()
      this.state = {
        ...base,
        ...parsed,
        results: parsed.results && typeof parsed.results === 'object' ? parsed.results : {},
        catalog: Array.isArray(parsed.catalog) ? parsed.catalog : [],
        disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [],
      }
    } catch {
      // Keep the unreadable file around for diagnosis instead of silently
      // destroying it on the next write.
      try { fs.renameSync(this.file, `${this.file}.bad`) } catch { /* leave as is */ }
      this.logger?.warn?.(`${DATA_DIR_NAME}: state.json is corrupt; kept as state.json.bad and starting empty`)
    }
  }

  get() {
    return this.state
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    this.schedule()
  }

  setCatalog(catalog) {
    // Prune results for models that left the catalog — but only after several
    // consecutive refreshes confirm the departure, so one flaky /provider
    // response cannot discard weights and chat-only marks for models that are
    // back on the next refresh.
    const ids = new Set(catalog.map(model => model.id))
    const results = {}
    for (const [id, result] of Object.entries(this.state.results)) {
      if (ids.has(id)) {
        this.missingCounts.delete(id)
        results[id] = result
        continue
      }
      const missing = (this.missingCounts.get(id) ?? 0) + 1
      this.missingCounts.set(id, missing)
      if (missing < RESULT_PRUNE_MISSES) results[id] = result
    }
    this.state = { ...this.state, catalog, catalogAt: Date.now(), results }
    this.schedule()
  }

  setResult(id, result) {
    this.state = {
      ...this.state,
      results: { ...this.state.results, [id]: { ...result, at: Date.now() } },
    }
    this.schedule()
  }

  dropResult(id) {
    if (this.state.results[id] === undefined) return
    const results = { ...this.state.results }
    delete results[id]
    this.state = { ...this.state, results }
    this.schedule()
  }

  findModel(id) {
    return this.state.catalog.find(model => model.id === id)
  }

  schedule() {
    if (this.disposed) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, 250)
    this.timer.unref?.()
  }

  flush() {
    clearTimeout(this.timer)
    this.timer = undefined
    const snapshot = JSON.stringify(this.state, null, 2)
    this.chain = this.chain
      .then(() => {
        const tmp = `${this.file}.${process.pid}.tmp`
        fs.writeFileSync(tmp, snapshot, { mode: 0o600 })
        fs.renameSync(tmp, this.file)
        try { fs.chmodSync(this.file, 0o600) } catch { /* ignore */ }
      })
      .catch(error => {
        this.logger?.warn?.(`${DATA_DIR_NAME}: could not persist state (${error?.message ?? error})`)
      })
    return this.chain
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.timer = undefined
    try {
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } catch { /* teardown must not throw */ }
  }
}
