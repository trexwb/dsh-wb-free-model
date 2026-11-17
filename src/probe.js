/** Per-model probe (ported from wbBridge `probe.rs`). */

import crypto from 'node:crypto'
import { PROBE_TIMEOUT_MS } from './constants.js'

export const PROBE_TOOLS = [
  {
    name: 'Read',
    description: 'Read a file from the external working directory.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string', description: 'Absolute path of the file to read' } },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write a file in the external working directory.',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Bash',
    description: 'Run a shell command on the external machine.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  },
  {
    name: 'Glob',
    description: 'List files matching a pattern.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
]

export function probeMessages(token) {
  return [{
    id: `probe-${token}`,
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: `Read /external/probe-${token}.txt and report its contents.` }],
  }]
}

export function judgeProbe(reply, token) {
  if (reply.calls.length === 0) {
    return { ok: false, code: 'no_action', message: '模型只返回了文本，没有产生任何动作', content: reply.content }
  }
  const first = reply.calls[0]
  const path = first?.arguments?.file_path
  if (reply.calls.length !== 1 || first?.name !== 'Read' || typeof path !== 'string' || !path.includes(token)) {
    const received = reply.calls.map(call => call?.name ?? '未命名').join('、')
    return { ok: false, code: 'probe_mismatch', message: `模型返回的动作与探测请求不符（收到 ${received}）` }
  }
  return { ok: true }
}

export function toolCallUnsupported(message) {
  const text = String(message ?? '')
  const works = /(?:function|tool)[_ -]?(?:calls?|calling|choice|choices|use)/i.test(text)
  const refused = /not\s+(?:supported|allowed|enabled|available|implemented)|unsupported|does\s+not\s+(?:support|allow)|no\s+(?:support|implementation)/i.test(text)
  const onlyAuto = /only.{0,10}auto.{0,40}supported.{0,20}tool_choice/i.test(text)
  return (works && refused && text.length < 500) || onlyAuto
}

export function formatUnsupported(error) {
  if (error?.code === 'invalid_model_output' || error?.code === 'invalid_tool_call') return true
  return toolCallUnsupported(error?.message)
}

function chatOnlyConfirmed(error) {
  return toolCallUnsupported(error?.message) || error?.code === 'tools_not_supported'
}

/**
 * Run one probe with a per-model 60s deadline. `run` performs one bridge
 * completion and returns `{content, calls}`; it must honor `signal`.
 *
 * Outcome matches wbBridge: a text-only reply is published as chat-only, a
 * format/function-call refusal degrades to chat-only, everything else fails.
 */
export async function probeModel({ run, outerSignal }) {
  const token = crypto.randomBytes(8).toString('hex')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('probe timeout')), PROBE_TIMEOUT_MS)
  timer.unref?.()
  const signal = outerSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, outerSignal])
  const started = Date.now()
  try {
    let reply
    try {
      reply = await run({ token, chatOnly: false, signal })
    } catch (error) {
      if (signal.aborted === true) {
        return { ok: false, code: 'timeout', message: '探测超时（60 秒）', ms: Date.now() - started }
      }
      if (formatUnsupported(error)) {
        try {
          const chat = await run({ token, chatOnly: true, signal })
          if (typeof chat?.content === 'string' && chat.content.trim() !== '') {
            return {
              ok: true,
              chatOnly: true,
              note: '模型不支持函数调用，已按仅对话发布',
              ms: Date.now() - started,
            }
          }
          return { ok: false, code: 'empty_response', message: '纯对话兜底也没有返回文本', ms: Date.now() - started }
        } catch (chatError) {
          if (signal.aborted === true) {
            return { ok: false, code: 'timeout', message: '探测超时（60 秒）', ms: Date.now() - started }
          }
          if (chatOnlyConfirmed(chatError)) {
            return {
              ok: true,
              chatOnly: true,
              note: '模型不支持函数调用，已按仅对话发布（chat-only 兜底同样被网关拒绝）',
              ms: Date.now() - started,
            }
          }
          return {
            ok: false,
            code: chatError?.code ?? 'SERVER',
            message: chatError?.message ?? 'chat-only 兜底失败',
            ms: Date.now() - started,
          }
        }
      }
      return { ok: false, code: error?.code ?? 'SERVER', message: error?.message ?? String(error), ms: Date.now() - started }
    }
    const judged = judgeProbe(reply, token)
    if (judged.ok === true) return { ok: true, ms: Date.now() - started }
    if (judged.code === 'no_action') {
      return { ok: true, chatOnly: true, note: '探测时只返回文本、未产生动作；已按仅对话发布', ms: Date.now() - started }
    }
    return { ok: false, code: judged.code, message: judged.message, ms: Date.now() - started }
  } finally {
    clearTimeout(timer)
  }
}
