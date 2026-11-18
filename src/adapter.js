/**
 * Provider adapter for the `wbbridge` route.
 *
 * Written structurally (no base-class import) so it mounts on the DSH kernel
 * line the user has installed, regardless of its exact dsh-llm version. The
 * registry validates by calling these methods, not by `instanceof`.
 *
 * One route carries every free model, because the harness picker groups models
 * by provider id only. `WB · auto` is listed first; every other id is the real
 * `<namespace>/<model>` pair the bridge routes to OpenCode.
 */

import crypto from 'node:crypto'
import { AUTO_MODEL_ID, AUTO_MODEL_NAME, ROUTE, ROUTE_LABEL } from './constants.js'
import { ModelError } from './service.js'

export { AUTO_MODEL_ID, AUTO_MODEL_NAME, ROUTE, ROUTE_LABEL }

function toLlmError(error) {
  if (error instanceof ModelError) return error
  const message = error?.message ?? String(error)
  return new ModelError(message, { code: error?.code ?? 'SERVER', status: error?.status })
}

export class WbFreeModelAdapter {
  constructor({ service, logger }) {
    this.service = service
    this.logger = logger
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /** Resolved policy shape (top-level delays), matching what the kernel reads. */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'MALFORMED_RESPONSE']),
      initialDelayMs: 700,
      maxDelayMs: 8_000,
      jitterRatio: 0.2,
    })
  }

  async listModels() {
    // The selector's catalog comes solely from this method, so a disabled lane
    // withdraws every model — `WB · auto` included — without unregistering the
    // adapter (that would break in-flight streams; the registration stays and
    // a `replace` broadcast makes the harness re-query).
    if (!this.service.enabled) return []
    let models = []
    try {
      await this.service.ensureCatalog()
      models = this.service.listModels()
    } catch (error) {
      // An unreachable runtime must not hide `auto`; the first call retries.
      this.logger?.warn?.(`dsh-wb-free-model: model listing degraded (${error?.message ?? error})`)
    }
    return [
      {
        provider: ROUTE,
        id: AUTO_MODEL_ID,
        name: AUTO_MODEL_NAME,
        description: '按耗时权重自动挑选当前可用的免费模型',
        inputModalities: ['text', 'image'],
      },
      ...models.map(model => ({ ...model, provider: ROUTE })),
    ]
  }

  async resolveModel(provider, model) {
    try {
      return await this.service.resolveModel(model)
    } catch (error) {
      this.logger?.warn?.(`dsh-wb-free-model: model resolution degraded (${error?.message ?? error})`)
      return {
        provider,
        id: model,
        name: model === AUTO_MODEL_ID ? AUTO_MODEL_NAME : model,
        context: { contextWindow: 131_072 },
        defaultMaxTokens: 8_192,
      }
    }
  }

  /**
   * dsh-llm 0.2.x dispatches through the adapter's own preparation hook; the
   * kernel's default exists only on its base class, so expose the same
   * contract structurally (identity is stable, one stream per call).
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: options => this.stream(options),
    }
  }

  async *stream(options) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (options.signal?.aborted === true) {
        throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
      }
      const result = await this.service.complete({
        modelId: options.model,
        messages: options.messages ?? [],
        system: options.system,
        tools: options.tools ?? [],
        effort: options.reasoningEffort,
        signal: controller.signal,
      })

      let index = 0
      if (result.content !== '') {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: result.content }
        yield { type: 'block-end', index, block: { type: 'text', text: result.content } }
        index += 1
      }
      for (const call of result.calls) {
        // Random segment: two concurrent streams can emit their Nth call in the
        // same millisecond, and Date.now+index alone would collide on the id.
        const id = `wb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}_${index}`
        const args = JSON.stringify(call.arguments)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
        index += 1
      }
      yield {
        type: 'usage',
        usage: result.usage ?? { inputTokens: 0, outputTokens: 0 },
      }
      yield {
        type: 'finish',
        // A chat-only reply cut off by the output limit must not masquerade as
        // a clean stop: `max-tokens` is a kernel finish kind (it makes the
        // kernel drop non-executable tool-call blocks).
        reason: result.calls.length > 0
          ? { kind: 'tool-calls' }
          : result.finish === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'stop' },
      }
    } catch (error) {
      const failure = toLlmError(error)
      if (options.signal?.aborted === true && failure.code !== 'ABORTED') {
        throw new ModelError('request aborted', { code: 'ABORTED', status: 499 })
      }
      throw failure
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
    }
  }
}
