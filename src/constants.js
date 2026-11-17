/** Shared constants: routes, keyless namespaces, timeouts, red-line allowlists. */

export const PLUGIN_ID = 'dsh-wb-free-model'
export const DATA_DIR_NAME = 'dsh-wb-free-model'
export const ROUTE = 'wbbridge'
export const ROUTE_LABEL = 'WB Free Model'
export const AUTO_MODEL_ID = 'auto'
export const AUTO_MODEL_NAME = 'WB · auto'

/** OpenCode release used to host the free lane. Pinned: the probe surface is version-sensitive. */
export const OPENCODE_VERSION = '1.19.6'

/** Keyless namespaces. `opencode` is built into the runtime; `kilo` is injected with this baseURL. */
export const NAMESPACES = Object.freeze([
  Object.freeze({ id: 'opencode', prefix: 'OC', label: 'OpenCode', injected: false, keyless: true }),
  Object.freeze({
    id: 'kilo',
    prefix: 'KL',
    label: 'Kilo',
    injected: true,
    keyless: true,
    npm: '@ai-sdk/openai-compatible',
    baseURL: 'https://api.kilo.ai/api/gateway',
  }),
])

export const ANCHOR_MODEL_KEY = 'wbbridge-provider-anchor'
export const OPENCODE_SERVER_USERNAME = 'opencode'

/** Probe budget per model (first attempt and one retry share the deadline). */
export const PROBE_TIMEOUT_MS = 60_000
/** One real turn's generous ceiling; free endpoints can be slow. */
export const REQUEST_TIMEOUT_MS = 300_000
export const HEALTH_POLL_MS = 500
export const HEALTH_ATTEMPTS = 120
export const SHUTDOWN_GRACE_MS = 4_000

export const DEFAULT_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
/** `off` is intentionally not declared: an absent effort keeps the upstream's default thinking. */
export const EFFORT_LEVELS = Object.freeze(['none', ...DEFAULT_EFFORTS])

export const PROBE_WEIGHT_SLOW_MS = 30_000
export const PROBE_WEIGHT_PENALTY = 20
export const DEFAULT_WEIGHT = 100

/** Child environment allowlist — never forward the host's other provider credentials. */
export const ENV_ALLOW = Object.freeze([
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'TMPDIR',
  'SHELL',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PATHEXT',
  'COMSPEC',
])

/** Native OpenCode gates: never let the hosted runtime perform local actions. */
export const NATIVE_PERMISSIONS = Object.freeze({
  '*': 'ask',
  question: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  webfetch: 'deny',
  task: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  todowrite: 'deny',
})
