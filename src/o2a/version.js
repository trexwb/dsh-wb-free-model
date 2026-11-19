/** Historical compatibility markers and wire defaults; see SYNC.md.
 * These markers identify the pre-rewrite reference, not the current implementation.
 * @module src/o2a/version.js
 */
export const O2A_VERSION = '1.4.7'
export const O2A_COMMIT = 'b296a61d0e3ef93b4df58e298be2c4e34e397322'
export const O2A_REFERENCE = 'https://github.com/jasonxu114514/opencode2api'

// Preserve the existing gateway wire contract while replacing local implementation.
export const V2_CLIENT_VERSION = '2.2.3'
// `opencode/<cli> ai-sdk/provider-utils/<sdk> runtime/bun/<bun>` is the runtime
// line a real 1.19.6 CLI sends (captured from a working install). Keeping it is
// still correct wire hygiene, but NOTE: a byte-identical request answered 429
// through both node and Bun transports, so this line does NOT select a quota
// bucket — see the credential note below.
export const REAL_RUNTIME_CLI = '1.19.6'
export const REAL_RUNTIME_SDK = '4.0.23'
export const CLIENT_UA = `opencode/${REAL_RUNTIME_CLI} ai-sdk/provider-utils/${REAL_RUNTIME_SDK} runtime/bun/${process.env.WB_FREE_MODEL_BUN_VERSION ?? '1.4.4'}`
export const V2_COMPLETION_LIMIT = 32000

/**
 * `public` is the gateway's one and only anonymous credential. Every anonymous
 * caller worldwide shares a single quota pool that resets at UTC midnight; when
 * it is spent, ALL of them get 429 with the same Retry-After, regardless of
 * transport fingerprint, UA, session, project, model or egress IP. Verified by
 * a variable-isolation matrix (fresh ids, no auth, changed client/UA, Bun relay
 * — all 429; a random Bearer answers 401).
 *
 * A signed-in OpenCode client uses its own credential instead and is not in
 * that shared pool. Setting WB_FREE_MODEL_CREDENTIAL to such a token is the
 * only supported way to keep the OC lane working while the anonymous pool is
 * exhausted; leave it unset to stay anonymous.
 */
export const ANONYMOUS_CREDENTIAL = (process.env.WB_FREE_MODEL_CREDENTIAL ?? '').trim() || 'public'
