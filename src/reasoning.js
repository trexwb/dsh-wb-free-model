/** OpenCode variant ↔ reasoning-effort mapping (ported from wbBridge `reasoning.rs`). */

import { DEFAULT_EFFORTS, EFFORT_LEVELS } from './constants.js'

/**
 * `{ [effort]: variant }` for one catalog entry. Only enabled variants whose
 * `reasoningEffort` is a legal level count; a later duplicate overwrites the
 * value while keeping the first position, matching Object.fromEntries.
 */
export function reasoningEfforts(entry) {
  const efforts = new Map()
  if (entry?.reasoning !== true) return efforts
  const variants = entry?.variants
  if (variants === null || typeof variants !== 'object' || Array.isArray(variants)) return efforts
  for (const [variant, options] of Object.entries(variants)) {
    if (options?.disabled === true) continue
    const effort = options?.reasoningEffort
    if (typeof effort === 'string' && EFFORT_LEVELS.includes(effort)) efforts.set(effort, variant)
  }
  return efforts
}

/** Declared thinking levels in DSH's preferred order; `off` is never declared. */
export function declaredLevels(entry) {
  const efforts = reasoningEfforts(entry)
  return DEFAULT_EFFORTS.filter(level => efforts.has(level))
}

/** DSH `LlmModelReasoningInfo` shape, or undefined when the model cannot be steered. */
export function reasoningInfo(entry) {
  if (entry?.reasoning !== true) return undefined
  const efforts = declaredLevels(entry)
  if (efforts.length === 0) return undefined
  return {
    efforts: efforts.map(id => ({ id, name: id })),
  }
}

/**
 * Requested effort acceptability, mirroring wbBridge's three judgments:
 * the model must declare reasoning; a variant model accepts only covered
 * levels; a fixed-reasoning model with no variants accepts DEFAULT_EFFORTS.
 */
export function acceptsEffort(entry, effort) {
  if (typeof effort !== 'string' || effort === '') return false
  if (entry?.reasoning !== true) return false
  const efforts = reasoningEfforts(entry)
  if (efforts.has(effort)) return true
  return efforts.size === 0 && DEFAULT_EFFORTS.includes(effort)
}

/** OpenCode `variant` for a requested effort, or undefined to let the provider default apply. */
export function variantFor(entry, effort) {
  if (typeof effort !== 'string' || effort === '') return undefined
  return reasoningEfforts(entry).get(effort)
}
