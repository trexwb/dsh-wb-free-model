/** `WB · auto` weighted selection (ported from wbBridge `auto.rs`). */

import { DEFAULT_WEIGHT, PROBE_WEIGHT_PENALTY, PROBE_WEIGHT_SLOW_MS } from './constants.js'
import { acceptsEffort } from './reasoning.js'

export { autoLevels } from './reasoning.js'

export function probeWeight(durationMs) {
  if (durationMs <= 2_000) return 100
  if (durationMs <= 5_000) return 80
  if (durationMs <= 10_000) return 60
  if (durationMs <= 20_000) return 40
  if (durationMs <= 40_000) return 20
  return 10
}

export function weightOf(model, result) {
  const weight = result?.weight
  return typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 ? weight : DEFAULT_WEIGHT
}

export function decayedWeight(current, durationMs) {
  return durationMs >= PROBE_WEIGHT_SLOW_MS ? Math.max(0, current - PROBE_WEIGHT_PENALTY) : current
}

export function nextWeight(current, ok, source, durationMs) {
  if (!ok) return current
  if (source === 'probe') return probeWeight(durationMs)
  if (source === 'request') {
    // A success is the freshest health evidence there is: keep the better of
    // the decayed use-statistics weight and the probe-grade weight for the
    // measured latency. probeWeight's floor (10) doubles as the recovery
    // floor — a successful request can never leave the model stuck at 0.
    return Math.max(decayedWeight(current ?? DEFAULT_WEIGHT, durationMs), probeWeight(durationMs))
  }
  return current
}

const RATE_LIMIT_PATTERN = /rate[ ._-]?limit|too many requests|quota|429/i
/**
 * Failures that say nothing about the model's health: this machine's transport
 * (TRANSPORT), a protocol break in the upstream exchange (MALFORMED_RESPONSE),
 * and the free lane's client-level refusals (INVALID_CREDENTIAL for the pooled
 * credential, LANE_LOCKED for the fingerprint gate) — those hit every model on
 * the lane alike, so recording them as model downtime would only schedule
 * useless re-probes.
 */
const LANE_CODES = new Set(['TRANSPORT', 'MALFORMED_RESPONSE', 'INVALID_CREDENTIAL', 'LANE_LOCKED'])

/**
 * Map one failure to a health state for the result record:
 * - `'limited'`: rate limit / quota / 429 — the model works, the gateway says wait;
 * - `null`: the evidence says nothing about the model itself (see LANE_CODES);
 *   a real user-visible failure still lands via ok/message;
 * - `'down'`: everything else (TIMEOUT, 401/403/404/5xx, region locks, SERVER).
 *   TIMEOUT counting as down is deliberate — minutes of dead air is model
 *   evidence. Accepted residual risk: a locally wedged network stack lands here
 *   too.
 */
export function classifyFailure({ code, message, status } = {}) {
  const text = `${code ?? ''} ${message ?? ''}`
  if (status === 429 || RATE_LIMIT_PATTERN.test(text)) return 'limited'
  if (LANE_CODES.has(code)) return null
  return 'down'
}

/** The recorded health state of one result, or undefined for "no judgment". */
export function stateOf(result) {
  const state = result?.state
  return state === 'ok' || state === 'limited' || state === 'down' ? state : undefined
}

/**
 * When this model last produced valid health evidence, clamped to `now`.
 * An explicitly written `checkedAt: 0` means "no evidence" (this very record's
 * `at` must not resurrect as one — a never-checked model's manual failure
 * would otherwise look checked for 24h). Records written before `checkedAt`
 * existed migrate lazily: a probe result or a passing request carries its
 * `at` as evidence once; a failure record without `checkedAt` has none.
 */
export function checkedAtOf(result, now = Date.now()) {
  if (result === undefined || result === null) return 0
  const checkedAt = result.checkedAt
  // Nullish semantics: only an ABSENT checkedAt falls through to the legacy
  // `at` migration; an explicit 0 stays 0.
  if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
    return checkedAt <= 0 ? 0 : Math.min(checkedAt, now)
  }
  if (result.ok === true || result.source === 'probe') {
    const at = Number(result.at ?? 0)
    if (Number.isFinite(at) && at > 0) return Math.min(at, now)
  }
  return 0
}

/**
 * Kept for diagnostics/snapshots only: the service no longer fans out a full
 * re-probe when every weight sits at 0. Recovery is driven by request
 * successes re-hanging the weight (nextWeight's request branch) and by due
 * models entering the 24h scheduled check.
 */
export function allWeightsExhausted(models, results) {
  return models.length > 0 && models.every(model => weightOf(model, results[model.id]) === 0)
}

function chatOnly(model, result) {
  return result?.chatOnly === true
}

function fits(model, result, { images, tools }) {
  // A chat-only model may still serve the request, but only when it actually
  // covers the requested modalities: image requests must not land on a
  // chat-only model that lacks image input, or complete() will reject it.
  if (chatOnly(model, result)) return !tools && (!images || model.images === true)
  if (images && tools) return model.images === true && model.toolcall === true
  if (images) return model.images === true
  if (tools) return model.toolcall === true
  return true
}

/**
 * Candidates by capability/effort. Two tiers: when no model matches the
 * capability filters, the pool still comes back as a last resort (complete()
 * then rejects a tools/images mismatch with 400 — pre-existing fallback
 * semantics), but the requested effort is never dropped: a pool that cannot
 * serve the effort yields no candidate at all, and the request fails with
 * MODEL_UNAVAILABLE instead of a misleading per-model 400.
 */
export function candidates(models, results, request) {
  const pool = models.filter(model => model.paid !== true)
  const matching = pool.filter(model => fits(model, results[model.id], request))
    .filter(model => request.effort === undefined || acceptsEffort(model, request.effort))
  if (matching.length > 0) return matching
  return request.effort === undefined ? pool : pool.filter(model => acceptsEffort(model, request.effort))
}

/**
 * Hysteresis for the fallback pool (used when no model has a passing probe or
 * request): a single 5xx/timeout/429 only shows in the UI — auto keeps using
 * the model. Two consecutive failures classified `limited`/`down` remove it
 * from that pool; a pool that would empty out keeps its unfiltered form, so
 * for every input the pick is a superset of the unfiltered behavior.
 */
export function hysteresisPool(models, results) {
  const filtered = models.filter(model => {
    const result = results[model.id]
    if (Number(result?.failStreak ?? 0) < 2) return true
    const state = stateOf(result)
    return state !== 'down' && state !== 'limited'
  })
  return filtered.length > 0 ? filtered : models
}

/**
 * Pick one fully-qualified model id. Prefers models whose last probe/request
 * succeeded; before any probe exists the whole catalog is eligible.
 */
export function selectModel({ models, results, images = false, tools = false, effort, random = Math.random }) {
  if (models.length === 0) return undefined
  const validated = models.filter(model => results[model.id]?.ok === true)
  const domain = candidates(validated.length > 0 ? validated : models, results, { images, tools, effort })
  if (domain.length === 0) return undefined
  // Hysteresis only reshapes the fallback pool: every model in the validated
  // pool has failStreak 0 by construction (any failure writes ok:false), so
  // filtering there could never remove anything.
  const effective = validated.length > 0 ? domain : hysteresisPool(domain, results)
  const max = Math.max(...effective.map(model => weightOf(model, results[model.id])))
  const top = effective.filter(model => weightOf(model, results[model.id]) === max)
  return top[Math.min(top.length - 1, Math.floor(random() * top.length))]?.id
}
