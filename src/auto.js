/** `WB · auto` weighted selection (ported from wbBridge `auto.rs`). */

import { DEFAULT_EFFORTS, DEFAULT_WEIGHT, PROBE_WEIGHT_PENALTY, PROBE_WEIGHT_SLOW_MS } from './constants.js'
import { acceptsEffort, reasoningEfforts } from './reasoning.js'

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
  if (source === 'request') return decayedWeight(current ?? DEFAULT_WEIGHT, durationMs)
  return current
}

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
 * Pick one fully-qualified model id. Prefers models whose last probe/request
 * succeeded; before any probe exists the whole catalog is eligible.
 */
export function selectModel({ models, results, images = false, tools = false, effort, random = Math.random }) {
  if (models.length === 0) return undefined
  const validated = models.filter(model => results[model.id]?.ok === true)
  const domain = candidates(validated.length > 0 ? validated : models, results, { images, tools, effort })
  if (domain.length === 0) return undefined
  const max = Math.max(...domain.map(model => weightOf(model, results[model.id])))
  const top = domain.filter(model => weightOf(model, results[model.id]) === max)
  return top[Math.min(top.length - 1, Math.floor(random() * top.length))]?.id
}

/** DSH efforts supported by at least one free model (union for the auto entry). */
export function autoLevels(models) {
  return DEFAULT_EFFORTS.filter(level => models.some(model => reasoningEfforts(model).has(level)))
}
