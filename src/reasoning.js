/**
 * Reasoning-effort policy.
 *
 * Both lanes steer thinking with the model's own declared menu: an entry with
 * `efforts` carries the levels its gateway accepts, and the selected level is
 * merged onto the request through the entry's `effortPatch` (`$effort` is the
 * placeholder the level stands in for; the `disabled` rung uses
 * `effortOffPatch` when the lane expresses Off differently). A level outside
 * the menu is refused locally — the upstreams validate the field, and an
 * undeclared value is a guaranteed 400. An entry without a menu offers no
 * effort control at all.
 */

/** DSH's preferred display order for the union menu on `WB · auto`. */
export const CANONICAL_EFFORTS = Object.freeze(['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const EFFORT_NAMES = {
  disabled: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

function instantiatePatch(patch, effort) {
  const walk = value => {
    if (typeof value === 'string') return value === '$effort' ? effort : value
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, inner] of Object.entries(value)) out[key] = walk(inner)
      return out
    }
    return value
  }
  return walk(patch)
}

/** Declared thinking levels in DSH's display order; undefined when unsteerable. */
export function reasoningInfo(entry) {
  const efforts = declaredLevels(entry)
  if (efforts.length === 0) return undefined
  return {
    efforts: efforts.map(id => ({ id, name: EFFORT_NAMES[id] ?? id })),
  }
}

function declaredLevels(entry) {
  const levels = Array.isArray(entry?.efforts) ? entry.efforts : []
  return CANONICAL_EFFORTS.filter(level => levels.includes(level))
    .concat(levels.filter(level => !CANONICAL_EFFORTS.includes(level)))
}

/** Requested effort acceptability: only the model's own declared levels. */
export function acceptsEffort(entry, effort) {
  if (typeof effort !== 'string' || effort === '') return false
  return Array.isArray(entry?.efforts) && entry.efforts.includes(effort)
}

/** The entry's declared default level, or its first level. */
export function defaultEffortFor(entry) {
  const levels = Array.isArray(entry?.efforts) ? entry.efforts : []
  if (levels.length === 0) return undefined
  return levels.includes(entry.effortDefault) ? entry.effortDefault : levels[0]
}

/**
 * The request-body patch a level turns into, or null when the model declares
 * no thinking menu (or the level is not one it declared — callers gate that
 * with {@link acceptsEffort} first).
 */
export function effortPatchFor(entry, effort) {
  if (!Array.isArray(entry?.efforts) || entry.efforts.length === 0) return null
  const chosen = entry.efforts.includes(effort) ? effort : defaultEffortFor(entry)
  if (chosen === undefined || entry.effortPatch === undefined) return null
  if (chosen === 'disabled' && entry.effortOffPatch !== undefined) {
    return instantiatePatch(entry.effortOffPatch, chosen)
  }
  return instantiatePatch(entry.effortPatch, chosen)
}

/** DSH efforts supported by at least one free model (union for the auto entry). */
export function autoLevels(models) {
  const present = new Set()
  for (const model of models) {
    for (const level of model?.efforts ?? []) present.add(level)
  }
  return CANONICAL_EFFORTS.filter(level => present.has(level))
}
