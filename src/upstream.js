/**
 * Free-lane transport and request adaptation (glue layer).
 *
 * The wire contract itself lives in `src/o2a/`, carried over verbatim from
 * dsh-our-free-model (MIT): session encoding (`o2a/identity.js`), the v2
 * header set (`o2a/headers.js`), and the request shaping pass — official
 * prompt, official tool set, reversible tool renames (`o2a/official-*.js`,
 * `o2a/tool-*.js`, `o2a/gateway-body.js`). That module is self-contained and
 * proven against the live gateway; this layer only adapts it to the plugin:
 * per-conversation session persistence, the chat-wire entry points, and the
 * response-side name restoration.
 *
 * @module src/upstream.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveDataDir } from './store.js'
import {
  CANONICAL_SESSION_RE,
  DESCENDING_TIME_RE,
  canonicalSessionID,
  phaseAgeMs,
  sessionPhaseMs,
} from './o2a/identity.js'
import { gatewayHeaders } from './o2a/headers.js'
import { ensureChatUsage, ensureV2CompletionLimit } from './o2a/gateway-body.js'
import { injectOfficialPrompt } from './o2a/official-prompt.js'
import { officialTool, renamableToolName } from './o2a/official-tools.js'
import { ToolRenameMap } from './o2a/tool-renames.js'
import { renameAndCompleteTools } from './o2a/toolshape.js'

export { gatewayHeaders }

const MAX_SESSION_LENGTH = 256

/** Models served by /responses instead of /chat/completions. */
const RESPONSES_MODELS = new Set(['muse-spark-1.2-contributor-free', 'muse-spark-1.3-contributor-free'])
/** Models served by the Anthropic-shaped /messages endpoint. */
const MESSAGES_MODELS = new Set(['union-alpha'])

export const SESSION_RE = CANONICAL_SESSION_RE

/** Whether `id` is a session the upstream free tier will accept as-is. */
export function isCanonicalSession(id) {
  return typeof id === 'string' && SESSION_RE.test(id.trim()) && DESCENDING_TIME_RE.test(id.trim().slice(4, 16))
}

/**
 * Re-encode any session signal into the canonical layout the gate accepts,
 * keeping one signal on one session for the life of the process
 * (`o2a/identity.canonicalSessionID`): official sessions pass through, and a
 * synthesized one carries a slow-clock timestamp inside the window the
 * upstream accepts, salted per process so a restart re-mints.
 */
export function canonicalizeSession(signal) {
  return canonicalSessionID(signal)
}

// ── model ids and endpoints ──────────────────────────────────────────────────

/** Strip a trailing "(level)" thinking suffix so lookups hit the base id. */
export function baseModelId(model) {
  return String(model ?? '').replace(/\([^()]+\)\s*$/, '').trim()
}

function isMuseSpark(modelId) {
  const clean = baseModelId(modelId)
  const base = clean.includes('/') ? clean.split('/').pop() : clean
  return /^muse[-_]?spark(?:$|[-_:. ])/i.test(base)
}

export function isResponsesModel(modelId) {
  return RESPONSES_MODELS.has(baseModelId(modelId)) || isMuseSpark(modelId)
}

export function isMessagesModel(modelId) {
  return MESSAGES_MODELS.has(baseModelId(modelId))
}

/**
 * Which upstream path serves this model.
 *
 * The 2.1 client groups `/inference` routes by provider family, so the family
 * segment sits between the origin and the protocol path. Anthropic endpoints
 * additionally carry the beta query the client appends.
 */
export function endpointFor(modelId) {
  if (isResponsesModel(modelId)) return '/inference/openai/v1/responses'
  if (isMessagesModel(modelId)) return '/inference/anthropic/v1/messages?beta=true'
  return '/inference/openai/v1/chat/completions'
}

/** The wire shape one endpoint speaks; drives request encoding and response parsing. */
export function wireFor(modelId) {
  if (isResponsesModel(modelId)) return 'responses'
  if (isMessagesModel(modelId)) return 'messages'
  return 'chat'
}

// ── per-conversation session persistence ─────────────────────────────────────

/**
 * The phase age a kept session may carry. The wire's time part is a 36-bit
 * millisecond phase (~795-day cycle, see o2a/identity.js), and the slow clock
 * mints phases at most 30 days old; a 60-day ceiling accepts every id this
 * lane mints while re-minting anything that has left the window.
 */
const SESSION_PLAUSIBILITY_MS = 60 * 24 * 60 * 60 * 1000

const SESSION_MAP_FILE = 'session-map.json'
let sessions

function sessionStorePath() {
  try { return path.join(resolveDataDir(), SESSION_MAP_FILE) } catch { return undefined }
}

function loadSessions() {
  if (sessions !== undefined) return sessions
  sessions = new Map()
  try {
    const file = sessionStorePath()
    if (file === undefined) return sessions
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const [seed, id] of Object.entries(parsed?.sessions ?? {})) {
      if (typeof id === 'string' && SESSION_RE.test(id)) sessions.set(seed, id)
    }
  } catch { /* first run or unreadable store: start empty */ }
  return sessions
}

function rememberSession(seed, id) {
  loadSessions().set(seed, id)
  try {
    const file = sessionStorePath()
    if (file === undefined) return
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.tmp`
    fs.writeFileSync(temp, JSON.stringify({ version: 2, at: Date.now(), sessions: Object.fromEntries(sessions) }, undefined, 2))
    fs.renameSync(temp, file)
  } catch { /* non-fatal: the id still works, it just will not survive a restart */ }
}

/**
 * Whether a canonical session's embedded time phase is inside the accepted
 * window. The wire carries a 36-bit millisecond phase, not an absolute date,
 * so plausibility is "dated within the last month of the current phase
 * cycle" — exactly what the slow clock mints.
 */
function plausibleSession(id) {
  const phase = sessionPhaseMs(id)
  return phase !== null && phaseAgeMs(phase) < SESSION_PLAUSIBILITY_MS
}

/**
 * Map one downstream conversation onto one stable upstream session.
 *
 * Mint once and persist the result. Never rotate IDs on retries or model
 * errors. A caller's canonical OC ID is kept. Free-tier quota is accounted
 * per session, so a fresh id per request exhausts it and surfaces as 429
 * with growing retry-after.
 */
export function sessionForConversation(sessionId) {
  if (typeof sessionId === 'string' && isCanonicalSession(sessionId)) return sessionId.trim()
  const seed = typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : 'global'
  const remembered = loadSessions().get(seed)
  if (remembered !== undefined && isCanonicalSession(remembered) && plausibleSession(remembered)) return remembered
  const minted = canonicalizeSession(seed)
  rememberSession(seed, minted)
  return minted
}

function truncateSession(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > MAX_SESSION_LENGTH ? trimmed.slice(0, MAX_SESSION_LENGTH) : trimmed
}

export { truncateSession }

// ── request shaping (chat wire) ──────────────────────────────────────────────

function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') return fn.name.trim()
  return ''
}

/** The shape name one `style` argument speaks. */
function shapeOf(style) {
  return style === true ? 'flat' : style === 'claude' ? 'claude' : 'chat'
}

/**
 * The request shapes the free tier reads as a conversation-title generator
 * (`title.IsTitleRequest`, opencode2api v1.4.7): no tools declared, one to
 * three turns, no assistant/tool/function turn, and a title marker in the
 * system or leading text. The reference stopped shaping these bodies with a
 * measured reason: the free tier answers an agent-shaped tool list on a
 * toolless title call with 403/429. A title request ships as the caller
 * wrote it — no prompt injection, no tool append, no renames.
 */
const TITLE_MARKERS = /generate a title|write a title|create a title|come up with a title|title (?:for|of) (?:this|the) (?:conversation|chat|session|exchange|request)|conversation title|summarize (?:this|the) conversation/i

export function isTitleRequest(body, style) {
  if (!body || typeof body !== 'object') return false
  if (body.tool_choice !== undefined || (Array.isArray(body.tools) && body.tools.length)
    || (Array.isArray(body.functions) && body.functions.length)) return false
  const shape = shapeOf(style)
  const rows = shape === 'flat' ? body.input : body.messages
  if (!Array.isArray(rows)) return false
  const containsTitle = value => {
    if (typeof value === 'string') return TITLE_MARKERS.test(value)
    if (!Array.isArray(value)) return false
    return TITLE_MARKERS.test(value.map(block => block?.text ?? '').join('\n'))
  }
  let matches = containsTitle(shape === 'flat' ? body.instructions : shape === 'claude' ? body.system : '')
  let count = 0
  for (const row of rows) {
    if (!row || typeof row !== 'object' || (shape === 'flat' && typeof row.role !== 'string')) continue
    if (++count > 3 || !['user', 'system', 'developer'].includes(row.role)) return false
    matches = containsTitle(row.content) || matches
  }
  return count > 0 && matches
}

/** Where a tool's description and parameter schema sit for one wire shape. */
function definitionOf(entry, shape) {
  if (!entry || typeof entry !== 'object') return null
  const wrapper = shape === 'chat' ? entry.function : entry
  if (wrapper === null || wrapper === undefined || typeof wrapper !== 'object') return null
  const schema = shape === 'claude' ? wrapper.input_schema : wrapper.parameters
  return { description: wrapper.description, schema }
}

/** Does this entry carry the verbatim official definition for `name`?
 *
 * Compared against the **rendered** official tool — the shell description is
 * platform-aware (`v2ShellDescription`), so on a Windows host a verbatim
 * official shell says powershell while the raw asset says bash. */
function carriesOfficialDefinition(entry, name, shape) {
  const own = definitionOf(entry, shape)
  if (own === null) return false
  const rendered = officialTool(shape, name)
  const wrapper = shape === 'chat' ? rendered.function : rendered
  if (!wrapper) return false
  return own.description === wrapper.description
    && JSON.stringify(own.schema) === JSON.stringify(wrapper.parameters)
}

/**
 * The note appended when official tools had to be injected.
 *
 * v2 的定义是**真工具**（描述与 schema 都来自官方客户端），模型会真的去调它。
 * 本插件的宿主并不实现官方工具集，注入项必须用提示词压住。措辞是参考实现实测
 * 选出来的：写成「不可用」会让模型连调用方自己的 `Read`/`Bash` 也一起拒绝；
 * 「占位、请用别的工具」才既压住注入项、又不误伤调用方的工具。
 */
function placeholderNote(names) {
  const list = names.map(name => `\`${name}\``).join(', ')
  return `The tools ${list} are part of the host CLI's own toolset and are placeholders in this session; they do nothing here. Use the other tools you have been given instead.`
}

/** Add free-lane context without replacing the caller's system text or blocks. */
function appendSystemContext(body, shape, note) {
  if (shape === 'flat') {
    body.instructions = typeof body.instructions === 'string' && body.instructions.trim() !== ''
      ? `${body.instructions}\n\n${note}`
      : note
    return
  }
  if (shape === 'claude') {
    body.system = Array.isArray(body.system)
      ? [...body.system, { type: 'text', text: note }]
      : typeof body.system === 'string' && body.system !== '' ? `${body.system}\n\n${note}` : note
    return
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const first = messages[0]
  if (first?.role === 'system' && typeof first.content === 'string') {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)]
    return
  }
  if (first?.role === 'system' && Array.isArray(first.content)) {
    body.messages = [{ ...first, content: [...first.content, { type: 'text', text: note }] }, ...messages.slice(1)]
    return
  }
  body.messages = [{ role: 'system', content: note }, ...messages]
}

/** Tell the model the injected officials are placeholders; never replace caller blocks. */
function noteInjectedTools(body, shape, names) {
  appendSystemContext(body, shape, placeholderNote(names))
}

/**
 * Adapt a request to the free-lane wire contract. Rename declarations and
 * references together, then restore names on the response path. Title-only
 * requests keep their original shape.
 *
 * @param {object} body - request body, mutated in place
 * @param {boolean|'claude'} style - Responses, Chat or Messages (this plugin
 *   sends Chat: `false`)
 * @returns {ToolRenameMap} response-name restoration map
 */
export function applyFingerprint(body, style) {
  const shape = shapeOf(style)
  if (!body || typeof body !== 'object') return new ToolRenameMap()

  // 0. Title requests ship unshaped: an agent-shaped tool list on a toolless
  // title call is a 403/429 the reference measured (see isTitleRequest).
  if (isTitleRequest(body, style)) return new ToolRenameMap()

  // 1. Official system prompt (the reference injects before shaping tools).
  injectOfficialPrompt(body, shape)

  // 2.+3. Tool pass: rename client tools, append the official set. Tools that
  // already carry the verbatim official definition are declared officials —
  // kept as-is and not duplicated — so repeated shaping stays a no-op.
  const tools = Array.isArray(body.tools) ? body.tools : []
  const keep = new Set()
  for (const tool of tools) {
    const name = renamableToolName(shape, tool)
    if (name !== null && carriesOfficialDefinition(tool, name, shape)) {
      keep.add(name)
    }
  }
  const { renames, injected } = renameAndCompleteTools(body, shape, { keep })

  // 4b. The injected officials need the placeholder note.
  if (injected.length > 0) noteInjectedTools(body, shape, injected)

  // 5. Never ship tool_choice none; default the Responses wire to auto.
  if (body.tool_choice === 'none'
    || (body.tool_choice !== null && typeof body.tool_choice === 'object' && body.tool_choice.type === 'none')) {
    delete body.tool_choice
  }
  if (shape === 'flat' && !body.tool_choice) body.tool_choice = 'auto'

  // 6. The chat body's own constants.
  ensureChatUsage(body, shape)
  ensureV2CompletionLimit(body, shape)
  return renames
}

/** Restore the caller's tool spelling in a streaming delta or a final payload. */
export function restoreToolName(name, map) {
  if (!map) return name
  if (typeof map.resolve === 'function') return map.resolve(name)
  if (map.size === 0) return name
  return map.get(name) ?? name
}

/** Session-scoped identity used to pick a decoy out of a real tool call. */
export function declaredToolNames(body) {
  const names = new Set()
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    const n = toolNameOf(tool)
    if (n) names.add(n)
  }
  return names
}
