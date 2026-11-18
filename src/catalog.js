/**
 * Model catalog for both keyless lanes.
 *
 * The free lane's listing (`/inference/v1/models`) is the authoritative set of
 * ids the gateway will currently name, but it discloses an id and nothing else,
 * so ids are merged with a vetted local capability table (context window /
 * vision / reasoning / thinking menu). The Kilo listing carries real rows;
 * only its `isFree` slice becomes catalog entries.
 *
 * Both listings are fetched fresh on every refresh — the plugin keeps no
 * static snapshot of the rosters in its source.
 *
 * @module src/catalog.js
 */

import { FREE_TAG, KILO_TAG } from './constants.js'
import { baseModelId, isMessagesModel, isResponsesModel } from './upstream.js'

/** Free-tier ids the listing does not mark with a `-free` suffix. */
const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free', 'big-pickle'])

/**
 * Local capability baseline for the free lane. `context`/`output` are the
 * provider's published capacities; `images` is what this lane actually
 * accepted under a direct image-input probe, not what a model card claims.
 *
 * An entry that declares `efforts` carries the model's own level menu and its
 * level rides the wire as `reasoning_effort` — the gateway validates that
 * field (an undeclared value answers `400 invalid_value` with the accepted
 * set), so a level outside the menu is not offered. An entry without a menu
 * gets no effort control at all: guessing a rung would be a value the
 * upstream may reject.
 */
const CAPABILITIES = [
  { match: /^mimo.*v2\.6/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
  { match: /^mimo.*v2\.5/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
  { match: /^mimo/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 131072 },
  { match: /^nemotron/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
  { match: /^ling/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
  { match: /^space.?bunny/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },
  { match: /^deepseek/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 },
  { match: /^jev/, vision: false, reasoning: false, contextWindow: 32768, maxOutput: 4096 },
]

/**
 * Per-id overrides for ids the lane actually serves today, where the family
 * pattern above would mis-state the model. Keyed by exact base id, consulted
 * before {@link CAPABILITIES}. The `contextWindow` figures follow the served
 * window where the published one proved to be a floor, and the effort menus
 * are the models' own declared `reasoning_options` — the wire's one
 * expression is `reasoning_effort` and a fabricated rung is a value the
 * upstream may reject.
 */
const FREE_ID_OVERRIDES = {
  'deepseek-v4.1-flash-free': {
    vision: true, contextWindow: 1048576, maxOutput: 384000,
    efforts: ['disabled', 'low', 'high', 'max'], effortDefault: 'high',
    effortPatch: { reasoning_effort: '$effort' },
    effortOffPatch: { reasoning_effort: 'none' },
  },
  // No `none` in the model's own set, and thinking does not switch off in
  // practice, so the menu starts at low.
  'glm-5.3-flash-free': {
    vision: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['low', 'high', 'max'], effortDefault: 'high',
    effortPatch: { reasoning_effort: '$effort' },
  },
  'nemotron-3.5-super-vl-free': {
    vision: true, contextWindow: 1048576, maxOutput: 131072,
    efforts: ['disabled', 'minimal', 'low', 'medium', 'high', 'xhigh'], effortDefault: 'high',
    effortPatch: { reasoning_effort: '$effort' },
    effortOffPatch: { reasoning_effort: 'none' },
  },
  'space-bunny-free': {
    vision: true, contextWindow: 1048576, maxOutput: 524288,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], effortDefault: 'high',
    effortPatch: { reasoning_effort: '$effort' },
  },
  'longcat-2.5-preview-free': {
    vision: false, contextWindow: 1048576, maxOutput: 131072,
  },
  'big-pickle': { vision: true, contextWindow: 262144, maxOutput: 131072 },
}

/** Human-facing display names, so a raw upstream id never reaches the picker. */
const DISPLAY_NAMES = {
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'space-bunny-free': 'Space Bunny',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'deepseek-v4.1-flash-free': 'DeepSeek V4.1 Flash',
  'glm-5.3-flash-free': 'GLM 5.3 Flash',
  'jev-1.13-free': 'Jev 1.13',
}

/**
 * Is this id on the免密 lane? The gateway's listing mixes paid and free ids;
 * only these answer without a per-user key.
 */
export function isFreeLane(modelId) {
  const base = baseModelId(modelId)
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

/** Look up the baseline capacities for one model id. */
export function capabilitiesFor(modelId) {
  const base = baseModelId(modelId)
  const override = FREE_ID_OVERRIDES[base]
  if (override !== undefined) return { reasoning: true, ...override }
  for (const entry of CAPABILITIES) if (entry.match.test(base)) return entry
  return { vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 }
}

/** Title-case a bare upstream id into something a picker can show. */
export function displayModelName(modelId) {
  const base = baseModelId(modelId)
  const known = DISPLAY_NAMES[base]
  if (known !== undefined) return known
  const words = base
    .replace(/[-_.]+/g, ' ')
    .replace(/(\d)\s+/g, '$1 ')
    .trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return words
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Build the free lane's catalog entries from raw listing ids.
 *
 * Ids whose wire is not Chat (`muse-spark` on /responses, `union-alpha` on
 * /messages) are skipped: this plugin speaks the Chat wire only, and
 * publishing a model its own transport cannot carry would be a guaranteed
 * first-request failure.
 */
export function buildCatalog(ids) {
  const seen = new Set()
  const entries = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (id === '' || !isFreeLane(id)) continue
    if (isResponsesModel(id) || isMessagesModel(id)) continue
    const base = baseModelId(id)
    if (seen.has(base)) continue
    seen.add(base)
    const caps = capabilitiesFor(base)
    entries.push({
      id: base,
      name: `${FREE_TAG} · ${displayModelName(base)}`,
      lane: 'free',
      context: number(caps.contextWindow) ?? 131072,
      output: number(caps.maxOutput) ?? 32768,
      images: caps.vision === true,
      // The lane does not advertise tool support per id; the probe decides
      // (tool-capable or chat-only) exactly as it did under the hosted runtime.
      toolcall: true,
      reasoning: caps.reasoning !== false,
      ...Array.isArray(caps.efforts) ? {
        efforts: [...caps.efforts],
        effortDefault: caps.effortDefault,
        effortPatch: caps.effortPatch,
        ...(caps.effortOffPatch === undefined ? {} : { effortOffPatch: caps.effortOffPatch }),
      } : {},
    })
  }
  entries.sort((left, right) => left.id.localeCompare(right.id))
  return entries
}

/** Parse one listing payload's id rows, in whichever shape it arrived. */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : []
  return rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string' && id !== '')
}

export const KILO_CHANNEL = 'kilo'
const KILO_EFFORT_PATCH = { reasoning: { effort: '$effort' } }
const KILO_EFFORT_OFF_PATCH = { reasoning: { enabled: false } }
const KILO_REASONING_MANDATORY = [/^stepfun\//, /^liquid\//, /^thinkingmachines\//]
const KILO_NO_DISABLE_IDS = new Set(['kilo-auto/free', 'openrouter/free'])

/** The declared thinking menu for one listing row, or {} when the row does
 *  not declare reasoning support at all. */
function kiloEffortMenuFor(row) {
  const params = Array.isArray(row?.supported_parameters) ? row.supported_parameters : []
  if (!params.includes('reasoning')) return {}
  const id = String(row?.id ?? '')
  const canDisable = !KILO_REASONING_MANDATORY.some(pattern => pattern.test(id))
    && !KILO_NO_DISABLE_IDS.has(id)
  return {
    efforts: canDisable ? ['disabled', 'low', 'medium', 'high'] : ['low', 'medium', 'high'],
    // Parity with the free lane's menu models: the menu's own default is its top level.
    effortDefault: 'high',
    effortPatch: KILO_EFFORT_PATCH,
    ...canDisable ? { effortOffPatch: KILO_EFFORT_OFF_PATCH } : {},
  }
}

/**
 * Is this raw listing row on Kilo's free pool? Everything else on that gateway
 * is a paid id that answers 401 keyless, and a picker full of guaranteed
 * refusals is worse than a short roster.
 */
export function isKiloFreeRow(row) {
  return row?.isFree === true && typeof row?.id === 'string' && row.id.trim() !== ''
}

/**
 * The picker name: the listing's own name with the vendor prefix and the
 * `(free)` qualifier stripped, under the channel tag — `NVIDIA: Nemotron 3
 * Ultra (free)` → `KL · Nemotron 3 Ultra`. The `org/` prefix is routing
 * detail, never a name the picker shows.
 */
export function kiloDisplayName(row) {
  const raw = typeof row?.name === 'string' ? row.name.trim() : ''
  const bare = (raw !== '' ? raw : String(row?.id ?? ''))
    .replace(/^[^:]{1,40}:\s+/, '')
    .replace(/\s*\(free\)\s*$/i, '')
    .trim()
  const pretty = bare !== '' ? bare : String(row?.id ?? '')
    .replace(/[-_.]+/g, ' ').trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.toUpperCase() === word ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return `${KILO_TAG} · ${pretty}`
}

function kiloEntryOf(row) {
  const context = number(row?.context_length) ?? number(row?.top_provider?.context_length) ?? 131072
  const output = number(row?.top_provider?.max_completion_tokens) ?? 32768
  const modalities = Array.isArray(row?.architecture?.input_modalities) ? row.architecture.input_modalities : []
  const menu = kiloEffortMenuFor(row)
  return {
    // Kilo ids are `org/model`, so the lane prefix keeps them collision-free
    // against the free lane's bare ids.
    id: `kilo/${String(row.id).trim()}`,
    name: kiloDisplayName(row),
    lane: KILO_CHANNEL,
    context,
    output,
    images: modalities.includes('image'),
    toolcall: true,
    reasoning: true,
    ...menu.efforts === undefined ? {} : {
      efforts: [...menu.efforts],
      effortDefault: menu.effortDefault,
      effortPatch: menu.effortPatch,
      ...menu.effortOffPatch === undefined ? {} : { effortOffPatch: menu.effortOffPatch },
    },
  }
}

/**
 * Build the Kilo channel's catalog rows from its raw listing rows.
 * Rows that are not on the free pool, or that repeat an id, are dropped.
 */
export function buildKiloCatalog(rows) {
  const seen = new Set()
  const entries = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isKiloFreeRow(row)) continue
    const entry = kiloEntryOf(row)
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}
