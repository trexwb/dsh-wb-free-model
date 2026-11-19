/** Plugin state: catalog snapshot, probe results, preferences. Persisted atomically at 0600. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyFailure } from './auto.js'
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
    // Free-lane quota breaker, persisted so a DSH restart does not reset the
    // window and immediately hammer an egress the gateway already limited.
    // The rest of the breaker (laneLockedMessage) stays per-session.
    quotaUntil: 0,
    quotaMessage: '',
    disabled: [],
    // Models moved to the recycle bin (system suggestion confirmed by the
    // user, or direct action): unpublished, unprobed, restorable. Kept as a
    // separate list from `disabled` so the two exclusion reasons never blur:
    // recycled is system-driven with evidence attached and a one-click
    // restore, disabled is the user's plain veto. Entries are not pruned when
    // a model leaves the catalog — if it comes back it is still recycled.
    recycled: [],
  }
}

/** disabled ∪ recycled — no publication, probe queue or auto pick may touch these ids. */
export function excludedIds(state) {
  return new Set([
    ...(Array.isArray(state.disabled) ? state.disabled : []),
    ...(Array.isArray(state.recycled) ? state.recycled : []),
  ])
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
        recycled: Array.isArray(parsed.recycled) ? parsed.recycled : [],
      }
      this.backfillHealthStates()
    } catch {
      // Keep the unreadable file around for diagnosis instead of silently
      // destroying it on the next write.
      try { fs.renameSync(this.file, `${this.file}.bad`) } catch { /* leave as is */ }
      this.logger?.warn?.(`${DATA_DIR_NAME}: state.json is corrupt; kept as state.json.bad and starting empty`)
    }
  }

  /**
   * One-time backfill for records written before the health state machine
   * existed: without it, pre-upgrade failures (region locks, timeouts, 5xx)
   * read as stateless in the snapshot forever. Mirrors the lazy `at`
   * migration in checkedAtOf: classification reuses classifyFailure, so a
   * legacy failure carries the same state a fresh one would — and a
   * null-classified failure (transport / lane-level refusal) stays stateless,
   * exactly like a fresh record. checkFails is deliberately NOT backfilled: the
   * recycle counter means "consecutive 24h-cadence failures", which legacy
   * records never measured. The backfill is persisted immediately so it
   * never runs twice.
   */
  backfillHealthStates() {
    let touched = false
    for (const result of Object.values(this.state.results)) {
      if (result === null || typeof result !== 'object') continue
      // New records always carry at least one of the two keys (a
      // null-classified failure writes failStreak without a state) — skip them.
      if (result.state !== undefined || result.failStreak !== undefined) continue
      if (result.ok === true) {
        result.state = 'ok'
        result.failStreak = 0
        touched = true
        continue
      }
      if (result.ok === false) {
        const classification = classifyFailure({ code: result.code, message: result.message, status: result.status })
        if (classification !== null) result.state = classification
        result.failStreak = 1
        touched = true
      }
    }
    if (touched) this.schedule()
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
