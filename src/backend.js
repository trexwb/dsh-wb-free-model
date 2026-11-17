/** Loopback HTTP client for the hosted OpenCode server (Basic auth, no redirects). */

import { OPENCODE_SERVER_USERNAME } from './constants.js'

export class BackendError extends Error {
  constructor(message, { status = 502, code = 'SERVER', cause } = {}) {
    super(message)
    this.name = 'BackendError'
    this.status = status
    this.code = code
    this.cause = cause
  }
}

function messageOf(payload) {
  const data = payload?.data
  return (typeof data?.message === 'string' && data.message !== '' && data.message)
    || (typeof payload?.message === 'string' && payload.message !== '' && payload.message)
    || (typeof payload?.name === 'string' && payload.name !== '' && payload.name)
    || 'OpenCode request failed'
}

function codeOf(payload) {
  const data = payload?.data
  return (typeof data?.code === 'string' && data.code)
    || (typeof payload?.code === 'string' && payload.code)
    || 'SERVER'
}

export class Backend {
  constructor({ baseURL, password, logger }) {
    this.baseURL = baseURL
    this.password = password
    this.logger = logger
    this.authorization = `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString('base64')}`
  }

  async request(path, { method = 'GET', body, signal, timeoutMs = 30_000, expectJSON = true } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response
    try {
      response = await fetch(`${this.baseURL}${path}`, {
        method,
        redirect: 'error',
        headers: {
          authorization: this.authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: combined,
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (timeout.aborted) throw new BackendError('OpenCode request timed out', { code: 'TIMEOUT', cause: error })
      throw new BackendError(`OpenCode transport failure: ${error?.message ?? error}`, { code: 'TRANSPORT', cause: error })
    }
    const text = await response.text()
    let payload
    if (text !== '' && expectJSON) {
      try { payload = JSON.parse(text) } catch {
        throw new BackendError('OpenCode returned a malformed response', { status: response.status, code: 'MALFORMED_RESPONSE' })
      }
    }
    if (!response.ok) {
      throw new BackendError(messageOf(payload), {
        status: response.status,
        code: response.status === 401 ? 'AUTH' : codeOf(payload),
      })
    }
    return payload
  }

  async health(timeoutMs = 1_000) {
    const payload = await this.request('/global/health', { timeoutMs })
    return payload?.healthy === true ? payload : undefined
  }

  providers(timeoutMs = 60_000) {
    return this.request('/provider', { timeoutMs })
  }

  async createSession(timeoutMs = 15_000) {
    const payload = await this.request('/session', {
      method: 'POST',
      body: { title: 'WB Free Model', permission: permissionList() },
      timeoutMs,
    })
    const id = payload?.id
    if (typeof id !== 'string' || id === '') throw new BackendError('OpenCode session response has no session id', { code: 'MALFORMED_RESPONSE' })
    return id
  }

  prompt(sessionId, payload, { signal, timeoutMs = 300_000 } = {}) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: payload,
      signal,
      timeoutMs,
    })
  }

  abortSession(sessionId) {
    return this.request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: 'POST', timeoutMs: 5_000 })
  }

  deleteSession(sessionId) {
    return this.request(`/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE', timeoutMs: 5_000 })
  }

  permissions() {
    return this.request('/permission', { timeoutMs: 5_000 })
  }

  replyPermission(id, reply, message) {
    const requestId = typeof id === 'string' ? id : id?.id
    if (typeof requestId !== 'string' || requestId === '') return Promise.resolve()
    return this.request(`/permission/${encodeURIComponent(requestId)}/reply`, {
      method: 'POST',
      body: { reply, ...(message === undefined ? {} : { message }) },
      timeoutMs: 5_000,
    })
  }
}

/** `/session` permission entries, in wbBridge's order. */
export function permissionList() {
  return [
    { permission: '*', pattern: '*', action: 'ask' },
    { permission: 'question', pattern: '*', action: 'deny' },
    { permission: 'websearch', pattern: '*', action: 'deny' },
    { permission: 'codesearch', pattern: '*', action: 'deny' },
    { permission: 'webfetch', pattern: '*', action: 'deny' },
    { permission: 'task', pattern: '*', action: 'deny' },
    { permission: 'plan_enter', pattern: '*', action: 'deny' },
    { permission: 'plan_exit', pattern: '*', action: 'deny' },
    { permission: 'todowrite', pattern: '*', action: 'deny' },
  ]
}
