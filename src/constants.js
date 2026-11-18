/** Shared constants: routes, the two keyless upstream lanes, timeouts, weights. */

export const PLUGIN_ID = 'dsh-wb-free-model'
export const DATA_DIR_NAME = 'dsh-wb-free-model'
export const ROUTE = 'wbbridge'
export const ROUTE_LABEL = 'WB Free Model'
export const AUTO_MODEL_ID = 'auto'
export const AUTO_MODEL_NAME = 'WB · auto'

/**
 * Free lane (免密): the pooled anonymous lane behind opencode.ai — the same
 * one the OpenCode client itself speaks to. The plugin talks to it directly
 * over HTTPS from its own process, so no runtime binary, child process or
 * local port is involved anywhere; that is what makes the lane usable from
 * hosts that cannot spawn programs (iOS among them). The wire contract and
 * its client fingerprint live in `src/o2a/`, carried over from
 * dsh-our-free-model.
 */
export const UPSTREAM_BASE = (process.env.WB_FREE_MODEL_BASE ?? 'https://opencode.ai').replace(/\/+$/, '')
export const UPSTREAM_LISTING_PATH = '/inference/v1/models'

/**
 * Kilo channel: Kilo AI's public OpenAI-compatible gateway. Its free pool
 * answers with no credential at all; the trade (prompts may be logged
 * upstream) is stated on the gateway's own model cards and in the README.
 */
export const KILO_BASE = (process.env.WB_FREE_MODEL_KILO_BASE ?? 'https://api.kilo.ai/api/gateway').replace(/\/+$/, '')

/** Display prefixes, one per lane: `OC · …` and `KL · …`. */
export const FREE_TAG = 'OC'
export const KILO_TAG = 'KL'

export const LISTING_TIMEOUT_MS = 15_000
/** Probe budget per model (first attempt and one retry share the deadline). */
export const PROBE_TIMEOUT_MS = 60_000
/** One real turn's generous ceiling; free endpoints can be slow. */
export const REQUEST_TIMEOUT_MS = 300_000
/** Idle cap for a live SSE stream: every data frame resets it. */
export const STREAM_IDLE_TIMEOUT_MS = 300_000

/** Output ceiling applied when a model publishes no output limit of its own. */
export const DEFAULT_MAX_TOKENS = 32_768
/** The default resolution when neither the catalog nor the model names one. */
export const FALLBACK_MAX_TOKENS = 8_192

/**
 * The free lane's quota is accounted per egress IP. A real 429 opens a window;
 * when the response carries no usable Retry-After, assume this one rather than
 * re-asking the wall.
 */
export const LANE_QUOTA_DEFAULT_MS = 6 * 60 * 60 * 1000

export const PROBE_WEIGHT_SLOW_MS = 30_000
export const PROBE_WEIGHT_PENALTY = 20
export const DEFAULT_WEIGHT = 100
