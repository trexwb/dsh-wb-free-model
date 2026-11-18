/**
 * Lane actions in one place, because two surfaces drive them: the browser
 * half's `/api/wb-free-model/*` routes and, on hosts that never run a browser
 * half (Fish Pocket on iOS), the chat tools in `src/native.js`. Status codes and
 * payloads are shared, so a rule cannot be fixed on one surface and left stale
 * on the other.
 *
 * Nothing here is HTTP-specific: `run` returns the pair a route sends or a tool
 * renders.
 */

import { ModelError } from './service.js'

/** What every surface says when the lane switch is off. */
export const LANE_OFF_MESSAGE = 'WB Free Model 已在设置里关闭'

/** @returns one 409 body explaining that the lane is switched off. */
function laneOff(service) {
  return {
    status: 409,
    payload: {
      started: false,
      reason: 'disabled',
      error: LANE_OFF_MESSAGE,
      code: 'CONFIG_DISABLED',
      ...service.snapshot(),
    },
  }
}

/**
 * @param deps.service      - the model service every action drives.
 * @param deps.store        - persisted state, written directly by `/retry`.
 * @param deps.logger       - where a background probe's failure is reported.
 * @param deps.setPreferences - `(patch) => Promise`, owned by the host half so
 *                              that preference storage and its side effects stay
 *                              in one place.
 */
export function createActions({ service, store, logger, setPreferences }) {
  async function refresh({ probe, concurrency } = {}) {
    if (!service.enabled) return laneOff(service)
    // Fire-and-forget: both upstream listings can be slow on a bad network day,
    // far beyond a client's patience, and the connection must not decide
    // whether the refresh finishes. Failures land in snapshot.lastError.
    void service.refreshCatalog()
      .then(() => {
        if (probe === true) return service.startProbes({ concurrency })
        return undefined
      })
      .catch(() => {})
    return { status: 202, payload: { started: true, ...service.snapshot() } }
  }

  async function probe({ id, concurrency } = {}) {
    if (!service.enabled) return laneOff(service)
    const modelId = typeof id === 'string' && id !== '' ? id : undefined
    if (modelId === undefined) {
      if (service.probing) {
        return {
          status: 409,
          payload: {
            started: false,
            reason: 'probing',
            error: '已有检测在进行中，请等当前检测完成',
            code: 'PROBE_IN_PROGRESS',
            ...service.snapshot(),
          },
        }
      }
      void service.startProbes({ concurrency }).catch(() => {})
      return { status: 202, payload: { started: true, ...service.snapshot() } }
    }
    if (service.isProbingModel(modelId)) {
      return {
        status: 409,
        payload: {
          started: false,
          reason: 'in-flight',
          id: modelId,
          error: '该模型正在检测中',
          code: 'PROBE_IN_PROGRESS',
          ...service.snapshot(),
        },
      }
    }
    if (!service.canStartSingleProbe()) {
      return {
        status: 409,
        payload: {
          started: false,
          reason: 'busy',
          id: modelId,
          error: '单模型检测并发已满，请稍后再试',
          code: 'PROBE_BUSY',
          ...service.snapshot(),
        },
      }
    }
    void service.probeOne(modelId).catch(error => {
      logger?.warn?.(`dsh-wb-free-model: single probe failed: ${error?.message ?? error}`)
    })
    return { status: 202, payload: { started: true, id: modelId, ...service.snapshot() } }
  }

  async function retry({ id } = {}) {
    if (!service.enabled) return laneOff(service)
    if (typeof id === 'string' && id !== '') {
      store.dropResult(id)
      store.update({ disabled: store.get().disabled.filter(entry => entry !== id) })
    } else {
      for (const model of store.get().catalog) store.dropResult(model.id)
      store.update({ disabled: [] })
    }
    await store.flush()
    return { status: 200, payload: { ok: true, ...service.snapshot() } }
  }

  async function settings(body) {
    const patch = {}
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
    if (typeof body.probeOnBoot === 'boolean') patch.probeOnBoot = body.probeOnBoot
    if (Object.keys(patch).length > 0) await setPreferences(patch)
    return { status: 200, payload: { ok: true, ...service.snapshot() } }
  }

  /**
   * @param route - one of the action names; unknown routes are a caller error,
   *                which the HTTP layer turns into 404 and a tool never sends.
   * @param body  - already-parsed action arguments.
   */
  async function run(route, body = {}) {
    if (route === 'status') return { status: 200, payload: service.snapshot() }
    if (route === 'refresh') return refresh(body)
    if (route === 'probe') return probe(body)
    if (route === 'retry') return retry(body)
    if (route === 'settings') return settings(body)
    throw new ModelError(`unknown action "${route}"`, { code: 'NOT_FOUND', status: 404 })
  }

  return { run }
}
