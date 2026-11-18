/**
 * Harness message vocabulary -> upstream wire shapes, plus the SSE fold that
 * turns provider events back into service-level chunks.
 *
 * The plugin speaks the Chat wire (OpenAI Chat Completions) on both lanes; the
 * free lane's `responses`/`messages`-shaped ids are skipped at catalog time
 * because their event vocabulary is a different wire, not a different model.
 *
 * @module src/wire.js
 */

import crypto from 'node:crypto'
import { restoreToolName } from './upstream.js'

/** Content types an image lane can carry, matched against the verified media type. */
const IMAGE_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const REASONING_FIELDS = ['reasoning', 'reasoning_content', 'reasoning_text', 'thinking']

/** Text of a content block list, joining every text-bearing block. */
function textOf(blocks) {
  const parts = []
  for (const block of blocks ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Normalise a message's content into a block list. The harness always supplies
 * blocks, but a bare string is tolerated defensively.
 */
function blocksOf(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }]
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return { type: 'text', text: part }
      if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') return { type: 'text', text: String(part.text ?? '') }
      return part
    }).filter(block => block !== null && typeof block === 'object')
  }
  return []
}

/** A user image block's data URL, or undefined when it cannot travel. */
function imageDataUrl(block, resolveImage) {
  if (block?.offloaded === true) return undefined
  return resolveImage?.(block.attachment) ?? (typeof block.attachment?.url === 'string' ? block.attachment.url : undefined)
}

/**
 * The tool results one message carries, in whichever vocabulary the kernel
 * wrote it. dsh changed shape between session formats: before V4 a tool answer
 * was a `user` message whose content held a `tool-result` wrapper block, and
 * V4 made it a first-class `tool` message whose content *is* the result. Both
 * generations are installed in the field, and a projector that reads only one
 * of them ships every tool-using turn upstream with its results missing —
 * which the model cannot notice, so it re-issues the same call until the user
 * stops it.
 */
function toolResultsOf(message) {
  if (message?.role === 'tool') {
    const id = callIdOf(message)
    return id === null ? [] : [{ callId: id, content: blocksOf(message.content), isError: message.isError === true }]
  }
  const out = []
  for (const block of blocksOf(message?.content)) {
    if (block?.type !== 'tool-result') continue
    const id = String(block.toolCallId ?? message?.source?.callId ?? '')
    if (id === '') continue
    out.push({ callId: id, content: blocksOf(block.content), isError: block.isError === true })
  }
  return out
}

function callIdOf(message) {
  const id = String(message?.toolCallId ?? message?.source?.callId ?? '')
  return id === '' ? null : id
}

/**
 * Drop tool calls that were never answered, and answers with no call.
 *
 * Every supported wire enforces that a tool call is followed by its result,
 * and a turn interrupted between the two — the tool failed to start, the user
 * aborted, the harness crashed — leaves exactly that in the durable history.
 * Replaying it is not merely untidy: the free lane answers `400
 * [invalid_request_error]`, which then fails every later turn in that session,
 * not just the one that broke. Repairing here covers the whole history at once.
 */
export function repairToolPairing(messages) {
  const list = messages ?? []
  const answered = new Set()
  for (const message of list) {
    for (const result of toolResultsOf(message)) answered.add(result.callId)
  }

  const keptCalls = new Set()
  const out = []
  for (const message of list) {
    const results = toolResultsOf(message)
    if (results.length > 0) {
      // Resolvable here because a call always precedes its own answer.
      if (message.role === 'tool') {
        if (keptCalls.has(results[0].callId)) out.push(message)
        continue
      }
      const kept = new Set(results.filter(result => keptCalls.has(result.callId)).map(result => result.callId))
      const blocks = blocksOf(message.content)
      const rest = blocks.filter(block => block?.type !== 'tool-result'
        || kept.has(String(block.toolCallId ?? message.source?.callId ?? '')))
      if (rest.length === blocks.length) out.push(message)
      else if (rest.length > 0) out.push({ ...message, content: rest })
      continue
    }
    // A tool answer with no call id to key on answers nothing, and an empty
    // `tool_call_id` on the wire is a 400 for the whole turn.
    if (message?.role === 'tool') continue
    if (message?.role !== 'assistant') {
      out.push(message)
      continue
    }
    const blocks = blocksOf(message.content)
    const toolBlocks = blocks.filter(block => block?.type === 'tool-call')
    // A call with no name is not executable, and one that reached the host was
    // answered `Error: unknown tool ""` — an *answered* call, so the
    // answered-id test alone kept it in the history forever and every later
    // turn 400'd on every model. A nameless call is dropped like an unanswered
    // one; its result then fails the kept-calls test below and goes with it.
    const calls = toolBlocks.filter(block => answered.has(String(block.id ?? '')) && String(block.name ?? '') !== '')
    for (const call of calls) keptCalls.add(String(call.id))
    if (calls.length === toolBlocks.length) {
      // Untouched when nothing was dropped, including the all-text case.
      if (calls.length > 0 || blocks.some(block => block?.type === 'text' && block.text)) out.push(message)
      continue
    }
    if (calls.length === 0) {
      // An assistant turn whose only content was calls that never landed says
      // nothing the model may keep believing. Text does survive — but the dead
      // calls still go, or the wire answers 400 for every later turn too.
      if (blocks.some(block => block?.type === 'text' && block.text)) {
        out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call') })
      }
      continue
    }
    out.push({ ...message, content: blocks.filter(block => block?.type !== 'tool-call' || calls.includes(block)) })
  }

  return out
}

/**
 * Project harness messages onto OpenAI Chat Completions. Tool results are
 * first-class `role: 'tool'` messages keyed by the provider call id they
 * answer; a tool-returned image travels as the user turn after its result —
 * the same split the kernel's own adapter makes.
 */
export function toChatMessages(messages, resolveImage, warnings) {
  const out = []
  const followUp = []
  const flushFollowUp = () => {
    if (followUp.length > 0) out.push({ role: 'user', content: followUp.splice(0) })
  }
  for (const message of messages ?? []) {
    const results = toolResultsOf(message)
    // A parallel call batch spans several V4 tool messages (or V3 wrappers).
    // Every result must precede image/user content, including across messages.
    if (results.length === 0) flushFollowUp()
    let blocks = blocksOf(message.content)
    if (results.length > 0) {
      for (const result of results) {
        const images = []
        for (const block of result.content) {
          if (block?.type !== 'image') continue
          const url = imageDataUrl(block, resolveImage)
          if (url !== undefined) images.push({ type: 'image_url', image_url: { url } })
          else if (warnings) warnings.push('image-dropped')
        }
        const text = textOf(result.content)
        out.push({ role: 'tool', tool_call_id: result.callId, content: text || (images.length > 0 ? '(see attached image)' : '(no output)') })
        if (images.length > 0) {
          followUp.push({ type: 'text', text: `The result of tool call ${result.callId} is ${images.length} image(s), attached below.` }, ...images)
        }
      }
      blocks = blocks.filter(block => block?.type !== 'tool-result')
    }
    switch (message.role) {
      case 'system':
      case 'developer': {
        const text = textOf(blocks)
        if (text) out.push({ role: 'system', content: text })
        break
      }
      case 'user': {
        const parts = []
        for (const block of blocks) {
          if (block?.type === 'text' && block.text) parts.push({ type: 'text', text: block.text })
          else if (block?.type === 'image') {
            const url = imageDataUrl(block, resolveImage)
            if (url !== undefined) parts.push({ type: 'image_url', image_url: { url } })
            else if (warnings) warnings.push('image-dropped')
          }
        }
        if (parts.length === 0) {
          const fallback = textOf(blocks)
          if (fallback) out.push({ role: 'user', content: fallback })
          break
        }
        if (results.length > 0) followUp.push(...parts)
        else out.push({
          role: 'user',
          content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
        })
        break
      }
      case 'assistant': {
        const text = textOf(blocks)
        const calls = []
        for (const block of blocks) {
          if (block?.type === 'tool-call') {
            calls.push({
              id: String(block.id ?? ''),
              type: 'function',
              function: { name: String(block.name ?? ''), arguments: typeof block.arguments === 'string' ? block.arguments : '{}' },
            })
          }
        }
        if (!text && calls.length === 0) break
        const entry = { role: 'assistant', content: text || null }
        if (typeof message.reasoning_content === 'string') entry.reasoning_content = message.reasoning_content
        if (calls.length > 0) entry.tool_calls = calls
        out.push(entry)
        break
      }
      case 'tool': break
      default: break
    }
  }
  flushFollowUp()
  return out
}

/**
 * Normalize the harness's flat `{name, description, parameters}` tool defs
 * (and anything that already speaks OpenAI) into the Chat wire's wrapped
 * `{type:'function', function:{…}}` shape.
 */
export function toToolDefs(tools) {
  const list = []
  for (const tool of tools ?? []) {
    // Both spellings have to work here: the harness hands over flat defs, but
    // a caller that already speaks OpenAI used to lose every tool to the
    // `if (!name) continue` below.
    const source = tool && typeof tool.function === 'object' && tool.function !== null && !Array.isArray(tool.function)
      ? tool.function
      : tool
    const name = String(source?.name ?? '').trim()
    if (!name) continue
    const parameters = source.parameters && typeof source.parameters === 'object' && !Array.isArray(source.parameters)
      ? source.parameters
      : { type: 'object', properties: {} }
    const description = typeof source.description === 'string' ? source.description : ''
    list.push({ type: 'function', function: { name, description, parameters } })
  }
  return list
}

function mintToolCallId() {
  return `call_${crypto.randomBytes(12).toString('hex')}`
}

/** Is this raw arguments text visibly cut off mid-JSON? */
function argumentsCutMidway(raw) {
  let depth = 0
  let inString = false
  let escaped = false
  for (const ch of raw) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
  }
  // Unbalanced is incomplete in either direction: a negative depth is the
  // lost-prefix fragment shape, which belongs on the retry path, not on the
  // complete-but-invalid one.
  return inString || depth !== 0
}

/** The thinking this frame carries, in whichever spelling it used. */
function reasoningOf(delta) {
  for (const field of REASONING_FIELDS) {
    const value = delta[field]
    if (typeof value === 'string' && value !== '') return value
  }
  if (Array.isArray(delta.reasoning_details)) {
    let text = ''
    for (const part of delta.reasoning_details) if (typeof part?.text === 'string') text += part.text
    if (text !== '') return text
  }
  return undefined
}

/** Upstream usage -> the plugin's usage shape. */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined
  const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const prompt = number(usage.prompt_tokens ?? usage.input_tokens)
  const completion = number(usage.completion_tokens ?? usage.output_tokens)
  const cached = number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens) ?? 0
  const cacheWrite = number(usage.prompt_tokens_details?.cache_write_tokens)
  const reasoning = number(usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  const out = {
    inputTokens: Math.max(0, (prompt ?? 0) - cached),
    outputTokens: completion ?? 0,
  }
  if (cached > 0) out.cacheReadTokens = cached
  if (cacheWrite > 0) out.cacheWriteTokens = cacheWrite
  if (reasoning > 0) out.reasoningTokens = reasoning
  return out
}

/** Wire finish token -> service finish kind. */
export function finishReason(token) {
  if (token === 'tool_calls' || token === 'tool_use' || token === 'function_call') return 'tool-calls'
  if (token === 'length' || token === 'max_tokens' || token === 'max_output_tokens' || token === 'incomplete') return 'max-tokens'
  return 'stop'
}

/**
 * Folds one lane's SSE payloads into service-level blocks.
 *
 * The fold exists so the service and the adapter can share one shape: text and
 * reasoning deltas become ordinary blocks, tool-call fragments accumulate into
 * one call per wire slot (parallel calls included), and every block closes
 * with a lossless snapshot — the harness re-reads chunks through a
 * lossless-JSON view, which rejects an own `undefined` field outright.
 */
export class StreamFold {
  constructor(yieldChunk, renameMap) {
    this.emit = yieldChunk
    this.renameMap = renameMap
    /** @type {Map<string, {index:number, kind:string, text:string, args:string, id:string, name:string, rawName?:string}>} */
    this.open = new Map()
    this.next = 0
    this.usage = undefined
    this.sawUsage = false
    this.sawFinish = false
    this.finishToken = undefined
    this.sawToolCall = false
    this.sawText = false
    this.sawReasoning = false
    this.brokenToolCall = false
    this.lastToolKey = undefined
    /** @type {Array<{id:string, name:string, arguments:string}>} */
    this.calls = []
    /** Concatenated answer text, for the service's final result. */
    this.answerText = ''
  }

  /** Resolve the block a Chat tool delta belongs to. `tool_calls[].index` is
   *  the wire's accumulator key and is what real servers send; keying calls
   *  without one to a constant merged every parallel call into a single
   *  block. The call id — present on exactly the shapes that omit the index —
   *  separates them, and a bare arguments continuation continues the call in
   *  front of it. */
  toolKey(call) {
    if (call.index !== undefined && call.index !== null) {
      this.lastToolKey = `c${call.index}`
      return this.lastToolKey
    }
    if (typeof call.id === 'string' && call.id !== '') {
      for (const [key, block] of this.open) {
        if (block.kind === 'tool-call' && block.id === call.id) { this.lastToolKey = key; return key }
      }
      this.lastToolKey = `cid:${call.id}`
      return this.lastToolKey
    }
    return this.lastToolKey ?? 'c0'
  }

  /** Open (or fetch) the block a given stream slot maps to. */
  slot(key, kind) {
    if (kind === 'tool-call') this.sawToolCall = true
    const existing = this.open.get(key)
    if (existing !== undefined) return existing
    // A tool call without a provider id would come back next turn with an
    // empty toolCallId, which the pairing repair then drops on both sides —
    // the model never sees its own result and re-issues the call forever.
    // Mint a stable stand-in; a provider id arriving later still overrides it.
    const block = { index: this.next++, kind, text: '', args: '', id: kind === 'tool-call' ? mintToolCallId() : '', name: '' }
    this.open.set(key, block)
    this.emit({ type: 'block-start', index: block.index, blockType: kind })
    return block
  }

  text(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    this.sawText = true
    const block = this.slot(key, 'text')
    block.text += delta
    this.answerText += delta
    this.emit({ type: 'text-delta', index: block.index, text: delta })
  }

  reasoning(key, delta) {
    if (delta === undefined || delta === null || delta === '') return
    this.sawReasoning = true
    const block = this.slot(key, 'reasoning')
    block.text += delta
    this.emit({ type: 'reasoning-delta', index: block.index, text: delta })
  }

  toolStart(key, id, name) {
    const block = this.slot(key, 'tool-call')
    if (id) block.id = id
    if (name) block.name = name
  }

  /** Buffer one fragment of a Chat tool call's wire name. Some gateways split
   *  `tool_calls[].function.name` across delta frames — resolving every
   *  fragment on arrival used to fold a half name into a wrong or unknown
   *  tool. The raw name accumulates here and resolves through
   *  {@link resolveRawName} once the call's arguments start or the block
   *  closes; until then the emitted deltas simply carry no name, which
   *  downstream consumers already tolerate. */
  toolNameFragment(key, id, name) {
    const block = this.slot(key, 'tool-call')
    if (id) block.id = id
    block.rawName = (typeof block.rawName === 'string' ? block.rawName : '') + name
  }

  resolveRawName(block) {
    if (block.name || typeof block.rawName !== 'string' || block.rawName === '') return
    block.name = restoreToolName(block.rawName, this.renameMap)
  }

  toolArgs(key, delta) {
    if (!delta) return
    this.sawToolCall = true
    const block = this.slot(key, 'tool-call')
    this.resolveRawName(block)
    block.args += delta
    // Arguments can arrive before the wire has named the call. The harness
    // re-reads every chunk through a lossless-JSON snapshot, which rejects an
    // own `undefined` field outright — so an unknown name is omitted from the
    // delta, never sent as undefined.
    const name = typeof block.name === 'string' && block.name !== '' ? { name: block.name } : {}
    this.emit({ type: 'tool-call-delta', index: block.index, id: block.id ?? '', ...name, argumentsDelta: delta })
  }

  finish(usage, token) {
    if (usage !== undefined) {
      this.sawUsage = true
      this.usage = usage
    }
    if (token === undefined) return
    this.sawFinish = true
    // A terminal frame that names no reason marks the end but must not erase
    // the finish token a status-carrying frame already gave.
    if (token !== undefined) this.finishToken = token
  }

  /** Close every open block with its lossless end snapshot. */
  closeAll() {
    for (const block of this.open.values()) {
      if (block.kind === 'text') {
        if (block.text !== '') this.emit({ type: 'block-end', index: block.index, block: { type: 'text', text: block.text } })
      } else if (block.kind === 'reasoning') {
        if (block.text !== '') this.emit({ type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } })
      } else if (block.kind === 'tool-call') {
        this.resolveRawName(block)
        // Arguments that never parse are an unexecutable call. The gateway
        // reports finish "tool_calls" even when the output ceiling cut the
        // JSON mid-string, so the finish token alone cannot be trusted; the
        // service downgrades such a turn to max-tokens, which makes the
        // harness's assembler prune the call instead of executing it and
        // looping on the model's retry.
        try { JSON.parse(block.args === '' ? '{}' : block.args) } catch { this.brokenToolCall = argumentsCutMidway(block.args) }
        // So is a call that never learned its name: the harness would execute
        // the nameless call as `Error: unknown tool ""` — an *answered* poison
        // pill the pairing repair keeps forever. Downgrade the turn exactly
        // like the unparseable-arguments case above.
        if (typeof block.name !== 'string' || block.name === '') this.brokenToolCall = true
        this.emit({
          type: 'block-end', index: block.index,
          block: { type: 'tool-call', id: block.id ?? '', name: block.name ?? '', arguments: block.args === '' ? '{}' : block.args },
        })
        this.calls.push({ id: block.id ?? '', name: block.name ?? '', arguments: block.args === '' ? '{}' : block.args })
      }
    }
    this.open.clear()
  }
}

/** Fold one Chat-wire SSE payload into the fold. */
export function feedChat(fold, payload) {
  if (payload.usage) fold.finish(mapUsage(payload.usage), undefined)
  for (const choice of payload.choices ?? []) {
    const delta = choice.delta ?? {}
    const reasoning = reasoningOf(delta)
    if (reasoning !== undefined) fold.reasoning('r', reasoning)
    if (typeof delta.content === 'string') fold.text('t', delta.content)
    for (const call of delta.tool_calls ?? []) {
      fold.sawToolCall = true
      const key = fold.toolKey(call)
      const name = call.function?.name
      // The name is buffered, not resolved per fragment: split frames used to
      // fold a half name into a ghost tool.
      if (typeof name === 'string' && name !== '') fold.toolNameFragment(key, call.id ?? '', name)
      else if (call.id) fold.toolStart(key, call.id, '')
      if (call.function?.arguments) fold.toolArgs(key, call.function.arguments)
    }
    if (choice.finish_reason) fold.finish(undefined, choice.finish_reason)
  }
}
