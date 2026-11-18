/**
 * Provider adapter for the `wbbridge` route.
 *
 * Written structurally (no base-class import) so it mounts on the DSH kernel
 * line the user has installed, regardless of its exact dsh-llm version. The
 * registry validates by calling these methods, not by `instanceof`.
 *
 * One route carries every free model, because the harness picker groups models
 * by provider id only. `WB · auto` is listed first; every other id is the real
 * model id the service routes to one of the two keyless upstream lanes (the
 * free Zen gateway or Kilo's public pool).
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

// ── request-image projection facts ────────────────────────────────────────
//
// dsh-llm resolves image pricing and the request target synchronously per
// route and calls both unguarded on the adapter, so a structural adapter must
// define them: with either missing, compaction over image-bearing history
// dies inside "Cannot switch to …: context compaction failed" as
// "…adapter.imageRequestPricing is not a function". The pricing must always
// answer, too — returning `undefined` makes the meter fall back to the image
// block's structural price only, badly undercounting real visual tokens (so
// compaction under-triggers), and the spill policy throws "no image token
// calculator" for image-bearing tool results. These local helpers replicate
// the kernel's placeholder shapes without importing dsh-llm (which the
// structural contract avoids).

function digestOf(ref) {
  return String(ref?.attachmentId ?? '').slice('sha256:'.length, 'sha256:'.length + 8)
}

function extensionOf(mediaType) {
  switch (mediaType) {
    case 'image/jpeg': return 'jpg'
    case 'image/gif': return 'gif'
    case 'image/webp': return 'webp'
    default: return 'png'
  }
}

/**
 * Mid-market visual-token estimate for one request image. Free-pool upstreams
 * publish no per-image pricing; the area anchor (w·h / 750) sits at or above
 * most providers' charge for mid-size images — the safe direction for
 * compaction planning — with a ceiling for pathological sizes.
 */
function estimateVisualTokens(ref) {
  const width = Number(ref.width)
  const height = Number(ref.height)
  if (!(width > 0) || !(height > 0)) return 0
  return Math.min(Math.ceil((width * height) / 750), 8192)
}

/** Same shape as the kernel's `offloadedImageText` without an access path. */
function offloadedImagePlaceholder(ref) {
  const identity = ref.name === undefined
    ? String(ref.attachmentId)
    : `${JSON.stringify(ref.name)} (${ref.attachmentId})`
  return `[image omitted to fit request image limits; ${identity}. No local normalized image path is available; ask the user to attach it again if needed.]`
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

  // ── request-image surface ──────────────────────────────────────────────

  /**
   * Per-occurrence image pricing for the token meter, compaction estimators
   * and spill policies; resolved synchronously per exact route. Pure: it reads
   * only cached catalog state, never I/O. Returns one price per occurrence,
   * aligned by index with `images`.
   */
  imageRequestPricing(provider, model) {
    return {
      priceImages: images => images.map((block, index) => this.priceImageOccurrence(model, block, index)),
    }
  }

  /**
   * The bridge inlines the normalized source without resizing (its send path
   * only refuses bytes above the resolver ceiling), so the kernel's default
   * "preserve the normalized source" target is exactly right.
   */
  imageRequestTarget(provider, model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  priceImageOccurrence(model, block, index) {
    const ref = block?.attachment
    if (ref === null || typeof ref !== 'object') return { visualTokens: 0, text: '' }
    // An offloaded occurrence reaches the route as placeholder text only.
    if (block.offloaded === true) {
      return { visualTokens: 0, text: offloadedImagePlaceholder(ref) }
    }
    if (!this.acceptsImages(model)) {
      // Same shape the kernel substitutes for text-only routes.
      return { visualTokens: 0, text: `[image omitted because this model accepts text only; attachment sha256:${digestOf(ref)}]` }
    }
    // What the bridge sends at this position: the image as a file part plus a
    // filename marker in the JSON conversation (the message number is not
    // known at pricing time; its token weight is negligible). An image that
    // fails to inline degrades to marker-only text at request time; pricing
    // cannot read files, so it keeps the higher image estimate — the safe
    // direction for compaction decisions.
    return {
      visualTokens: estimateVisualTokens(ref),
      text: `[Attached image: message-1-image-${index + 1}.${extensionOf(ref.mediaType)}]`,
    }
  }

  /** Whether the route can carry an image occurrence right now. */
  acceptsImages(model) {
    // `auto` re-routes image-bearing requests to an image-capable lane.
    if (model === AUTO_MODEL_ID) return true
    return this.service.resolveEntry(model)?.images === true
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
        // The upstream accounts the free lane's quota per session, so the same
        // conversation must always map onto the same canonical upstream
        // session — a fresh id per request burns the allowance into 429s.
        sessionId: typeof options.sessionId === 'string' && options.sessionId.trim() !== ''
          ? options.sessionId.trim()
          : (typeof options.conversationId === 'string' && options.conversationId.trim() !== '' ? options.conversationId.trim() : undefined),
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
        const id = typeof call.id === 'string' && call.id !== '' ? call.id
          : `wb_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}_${index}`
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
