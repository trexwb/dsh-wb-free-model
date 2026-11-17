/** Free-model discovery from the hosted runtime's `/provider` catalog. */

import { ANCHOR_MODEL_KEY, NAMESPACES } from './constants.js'

function isZero(value) {
  return value === 0
}

function costIsFree(cost) {
  if (cost === null || typeof cost !== 'object') return false
  return isZero(cost.input) && isZero(cost.output)
    && isZero(cost.cache?.read) && isZero(cost.cache?.write)
}

/**
 * `freeModels(providers, namespace)` — every zero-cost, text-output, active
 * model in one namespace, normalized to the shape the rest of the plugin uses.
 */
export function freeModelsIn(providers, namespace) {
  const all = Array.isArray(providers?.all) ? providers.all : []
  const provider = all.find(item => item?.id === namespace)
  if (provider === undefined || provider?.models === null || typeof provider?.models !== 'object') return []
  const prefix = NAMESPACES.find(item => item.id === namespace)?.prefix ?? namespace.slice(0, 2).toUpperCase()
  const models = []
  for (const [key, model] of Object.entries(provider.models)) {
    if (key === ANCHOR_MODEL_KEY) continue
    if (!costIsFree(model?.cost)) continue
    if (model?.capabilities?.output?.text === false) continue
    if (model?.status === 'deprecated') continue
    models.push({
      id: `${namespace}/${key}`,
      namespace,
      key,
      name: `${prefix} · ${typeof model?.name === 'string' && model.name !== '' ? model.name : key}`,
      context: model?.limit?.context,
      input: model?.limit?.input,
      output: model?.limit?.output,
      images: model?.capabilities?.input?.image === true,
      toolcall: model?.capabilities?.toolcall === true,
      reasoning: model?.capabilities?.reasoning === true,
      variants: model?.variants !== null && typeof model?.variants === 'object' ? model.variants : {},
    })
  }
  models.sort((left, right) => left.id.localeCompare(right.id))
  return models
}

/** Every keyless namespace's free models, in a stable order. */
export function discoverModels(providers) {
  return NAMESPACES.flatMap(namespace => freeModelsIn(providers, namespace.id))
}
