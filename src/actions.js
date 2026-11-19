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
import { excludedIds } from './store.js'

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
 * @param deps.store        - persisted state, written directly by the bin actions.
 * @param deps.logger       - where a background probe's failure is reported.
 * @param deps.broadcast    - re-announces the adapter and provider directory. A
 *                            tool caller has no page to refresh the selector, so
 *                            the action that changes publication owns the
 *                            announcement; the HTTP layer gets it for free.
 * @param deps.surfaces     - availability record of the optional entry points
 *                            (`settings` / `tools` / `commands` / `api`), filled in
 *                            as each one mounts and reported with every answer.
 * @param deps.setPreferences - `(patch) => Promise`, owned by the host half so
 *                              that preference storage and its side effects stay
 *                              in one place.
 */
export function createActions({ service, store, logger, broadcast, surfaces, setPreferences }) {
  async function refresh({ probe, concurrency } = {}) {
    if (!service.enabled) return laneOff(service)
    // Fire-and-forget: both upstream listings can be slow on a bad network day,
    // far beyond a client's patience, and the connection must not decide
    // whether the refresh finishes. Failures land in snapshot.lastError.
    void service.refreshCatalog()
      .then(async () => {
        // A refresh can swap models in: re-derive the arm point immediately.
        service.ensureCheckTimer()
        // The listing endpoint is not quota-limited, so only a real completion
        // can prove the shared anonymous pool has reset (UTC midnight). Spend
        // exactly one when the local window says it might still be active.
        // Success clears the window and stale 受限 marks; a fresh 429 keeps it.
        let recovered = false
        if (!service.freeLaneAvailable()) {
          const check = await service.checkQuota()
          recovered = check.ok === true
        }
        if (probe === true || recovered) return service.startProbes({ concurrency, trigger: 'manual' })
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
    // Recycled/disabled models refuse probes with a coded 409. The page's inline
    // retry never sends these; the guard keeps stale clients, hand-typed chat ids
    // and races honest, and it backs the same check inside probeOne.
    if (excludedIds(store.get()).has(modelId)) {
      const recycled = store.get().recycled.includes(modelId)
      return {
        status: 409,
        payload: {
          started: false,
          reason: recycled ? 'recycled' : 'disabled',
          id: modelId,
          error: recycled ? '该模型已移入回收站，请先恢复再检测' : '该模型已被禁用，无法检测',
          code: recycled ? 'RECYCLED' : 'DISABLED',
          ...service.snapshot(),
        },
      }
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
      if (store.get().recycled.includes(id)) {
        return {
          status: 409,
          payload: {
            started: false,
            reason: 'recycled',
            id,
            error: '该模型已移入回收站，请先恢复再重试',
            code: 'RECYCLED',
            ...service.snapshot(),
          },
        }
      }
      store.dropResult(id)
      store.update({ disabled: store.get().disabled.filter(entry => entry !== id) })
    } else {
      // The full clear keeps the recycle bin: a recycled model must not silently
      // re-enter the selector because probe results were reset.
      for (const model of store.get().catalog) store.dropResult(model.id)
      store.update({ disabled: [] })
    }
    await store.flush()
    // Un-disabled models re-enter the selector only via a replace broadcast: the
    // same re-query republishes models whose results just dropped.
    broadcast?.()
    service.ensureCheckTimer()
    return { status: 200, payload: { ok: true, ...service.snapshot() } }
  }

  /**
   * Move one model into the recycle bin — system-driven exclusion, unlike
   * `disabled`, which is the user's plain veto.
   *
   * Deliberately not gated on the lane switch: the bin is viewable and operable
   * while the lane is off (`snapshot.recycled` keeps returning catalog entries).
   * Safety comes from `ensureCheckTimer`, which refuses to arm while disabled, so
   * a restored model is only picked up once the lane starts again.
   */
  async function recycle({ id } = {}) {
    const rejection = knownModel(id)
    if (rejection !== undefined) return rejection
    if (service.isProbingModel(id)) {
      return {
        status: 409,
        payload: {
          started: false,
          reason: 'in-flight',
          id,
          error: '该模型正在检测中，请等当前检测完成',
          code: 'PROBE_IN_PROGRESS',
          ...service.snapshot(),
        },
      }
    }
    store.update({
      recycled: [...store.get().recycled.filter(entry => entry !== id), id],
      disabled: store.get().disabled.filter(entry => entry !== id),
    })
    // The failure evidence stays: the record explains why the model is in the bin
    // and what a restore will clear.
    await store.flush()
    // Selector removal is driven solely by replace broadcasts; without this the
    // recycled model lingers there until the next lane toggle.
    broadcast?.()
    service.ensureCheckTimer()
    return { status: 200, payload: { ok: true, id, ...service.snapshot() } }
  }

  /** Take one model out of the bin and put it back on the probe queue. */
  async function restore({ id } = {}) {
    const rejection = knownModel(id)
    if (rejection !== undefined) return rejection
    store.update({
      recycled: store.get().recycled.filter(entry => entry !== id),
      disabled: store.get().disabled.filter(entry => entry !== id),
    })
    // Back to "never probed": a kept failure record would hide the restored model
    // from the selector (failures are not published) and its stale evidence would
    // pollute the fresh start.
    store.dropResult(id)
    await store.flush()
    broadcast?.()
    service.ensureCheckTimer()
    return { status: 200, payload: { ok: true, id, ...service.snapshot() } }
  }

  /** Both bin actions address one existing catalog entry, whatever the lane state. */
  function knownModel(id) {
    if (typeof id !== 'string' || id === '' || service.resolveEntry(id) === undefined) {
      return {
        status: 404,
        payload: { error: `未知模型 "${typeof id === 'string' ? id : ''}"`, code: 'MODEL_NOT_FOUND', ...service.snapshot() },
      }
    }
    return undefined
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
    const answer = await dispatch(route, body)
    // Every answer says which entry points this host actually mounted, so a
    // surface can explain a missing control instead of showing nothing.
    return { status: answer.status, payload: { ...answer.payload, surfaces } }
  }

  async function dispatch(route, body) {
    if (route === 'status') return { status: 200, payload: service.snapshot() }
    if (route === 'refresh') return refresh(body)
    if (route === 'probe') return probe(body)
    if (route === 'retry') return retry(body)
    if (route === 'recycle') return recycle(body)
    if (route === 'restore') return restore(body)
    if (route === 'settings') return settings(body)
    throw new ModelError(`unknown action "${route}"`, { code: 'NOT_FOUND', status: 404 })
  }

  return { run }
}
