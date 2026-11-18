/**
 * The lane surfaces a phone can actually reach.
 *
 * Fish Pocket (the iOS DSH app) runs the Host half in its bundled Node engine
 * and never runs a plugin's browser half, so `client.js` and the
 * `/api/wb-free-model/*` routes are invisible there. Two Host-side channels
 * are native-renderable instead: a settings namespace, which the app draws as a
 * real form from `settings/describe`, and tools, which the model calls when the
 * user asks in chat. Both drive `src/actions.js`, the same rules the web page
 * uses.
 */

import z from '@deepseek-ai/schemastery'
import { LANE_OFF_MESSAGE } from './actions.js'

/** Namespace name; also the provider directory's `settingsNs` in `index.js`. */
export const SETTINGS_NS = 'dsh-wb-free-model'

export const SettingsConfig = z.object({
  enabled: z.boolean().default(true),
  probeOnBoot: z.boolean().default(true),
})

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function seconds(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

function ago(at) {
  if (typeof at !== 'number' || at <= 0) return '从未'
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

/** One snapshot as the lines a chat answer needs; `detail` adds the model table. */
export function renderStatus(snapshot, detail) {
  const lines = []
  lines.push(`车道：${snapshot.enabled === true ? '已启用' : '已停用'}（启动时自动检测：${snapshot.probeOnBoot === false ? '关' : '开'}）`)
  lines.push(`接入方式：插件进程内直连（mode ${snapshot.runtime?.mode ?? 'direct'}），无子进程、无本地端口`)
  lines.push(`目录：${snapshot.enabled === true ? snapshot.models.length : 0} 个模型，最近刷新 ${ago(snapshot.catalogAt)}${snapshot.refreshing === true ? '（正在刷新）' : ''}`)
  if (Array.isArray(snapshot.probingIds) && snapshot.probingIds.length > 0) {
    const progress = snapshot.probeProgress
    lines.push(`检测中：${snapshot.probingIds.length} 个${progress ? `，本批 ${progress.done()}/${progress.total}` : ''}`)
  }
  if (typeof snapshot.laneQuotaUntil === 'number' && snapshot.laneQuotaUntil > Date.now()) {
    lines.push(`免费车道配额窗口：${new Date(snapshot.laneQuotaUntil).toISOString()} 前本地直接拒绝新请求${snapshot.laneQuotaMessage ? `（${snapshot.laneQuotaMessage}）` : ''}`)
  }
  if (snapshot.laneLocked) lines.push(`车道被上游拒绝：${snapshot.laneLocked}`)
  if (snapshot.lastError) lines.push(`最近错误：${snapshot.lastError}`)
  if (detail === 'models' && snapshot.enabled === true) {
    // A chat-only model is a probe *success* with a flag, so the buckets have
    // to be split on both fields or one model counts twice.
    const usable = snapshot.models.filter(model => model.result?.ok === true && model.result?.chatOnly !== true)
    const chatOnly = snapshot.models.filter(model => model.result?.ok === true && model.result?.chatOnly === true)
    const failed = snapshot.models.filter(model => model.result?.ok === false)
    const unprobed = snapshot.models.filter(model => model.result === undefined)
    lines.push(`可调用工具 ${usable.length} / 仅对话 ${chatOnly.length} / 失败 ${failed.length} / 未检测 ${unprobed.length}`)
    for (const model of snapshot.models) {
      const mark = model.result?.ok !== true ? '失败' : model.result?.chatOnly === true ? '仅对话' : '可用'
      const reason = model.result?.ok === false ? `：${model.result.message ?? model.result.code ?? '未知原因'}` : ''
      lines.push(`- ${model.name}（${model.id}） · ${mark} · 权重 ${model.weight ?? 0} · 最近 ${seconds(model.result?.ms)}${reason}`)
    }
  } else if (snapshot.enabled === true) {
    lines.push('如需逐个模型的状态与耗时，用 detail="models" 再查一次。')
  }
  lines.push('完整管理页（含逐个重试按钮）只在 DSH 网页界面里；手机上走「探索 → 网页版」。')
  return lines.join('\n')
}

/**
 * Install the settings namespace and the tools, and hand back the single
 * preference writer both of them (plus the HTTP `/settings` route) use.
 *
 * Preference authority is the settings document when the settings service is
 * present — that is the layer the phone edits — and `state.json` otherwise. The
 * store is always mirrored, so `service.enabled`, `/status` and a settings-less
 * host all read one truth.
 *
 * @param deps.store    - persisted state to mirror into.
 * @param deps.config   - this plugin's composition entry, an input to the settings base layer.
 * @param deps.toggleLane - `(enable: boolean) => Promise`, serialized by the host half.
 */
export function installNativeSurface(ctx, { store, config, logger, actions, toggleLane }) {
  // Base layer for the settings document: an explicit composition value wins
  // over what a previous session persisted, and either way a user's edit in the
  // settings form outranks both. Without this, a lane the old version had
  // stored as disabled in `state.json` would flip itself back on at boot.
  const persisted = store.get()
  const entry = {
    enabled: config?.enabled ?? persisted.enabled !== false,
    probeOnBoot: config?.probeOnBoot ?? persisted.probeOnBoot !== false,
  }
  let preferences = () => entry
  let settingsService

  ctx.inject(['settings'], scoped => {
    settingsService = scoped.settings
    settingsService.installSection(ctx, SETTINGS_NS, SettingsConfig, entry, {
      setSource: source => {
        preferences = source
      },
      onChange: () => {
        syncPreferences()
      },
    })
  })

  /** Mirror the authoritative section into the store and run the flip's effects. */
  function syncPreferences() {
    const section = preferences() ?? {}
    const state = store.get()
    const wasEnabled = state.enabled !== false
    const enabled = section.enabled === undefined ? wasEnabled : section.enabled === true
    const probeOnBoot = section.probeOnBoot === undefined ? state.probeOnBoot !== false : section.probeOnBoot === true
    if (enabled === wasEnabled && probeOnBoot === (state.probeOnBoot !== false)) return
    store.update({ enabled, probeOnBoot })
    void store.flush()
    if (enabled !== wasEnabled) {
      void toggleLane(enabled).catch(error => {
        logger.warn?.(`dsh-wb-free-model: lane toggle failed: ${error?.message ?? error}`)
      })
    }
  }

  async function setPreferences(patch) {
    const wasEnabled = store.get().enabled !== false
    if (settingsService !== undefined) {
      // The committed change re-enters through syncPreferences, which owns the
      // store mirror and the toggle, so a write from any surface behaves alike.
      await settingsService.update(SETTINGS_NS, patch)
      syncPreferences()
      return
    }
    store.update(patch)
    await store.flush()
    if (patch.enabled !== undefined && patch.enabled !== wasEnabled) await toggleLane(patch.enabled)
  }

  const statusTool = {
    name: 'wb_free_model_status',
    description: '查看 WB 免费模型车道的状态：是否启用、模型清单、探测进度、配额窗口与错误。',
    parameters: {
      detail: { type: 'string', description: '"summary"（默认）或 "models"，后者逐个列出模型与耗时。' },
    },
    output: textOutput,
    async execute(args) {
      const { payload } = await actions.run('status')
      return renderStatus(payload, args.detail === 'models' ? 'models' : 'summary')
    },
  }

  const refreshTool = {
    name: 'wb_free_model_refresh',
    description: '重新拉取 WB 免费模型的清单（两条免密车道的上游列表）。异步启动，用 wb_free_model_status 看结果。',
    parameters: {
      probe: { type: 'boolean', description: '刷新完成后是否接着检测全部模型，默认 false。' },
    },
    output: textOutput,
    async execute(args) {
      const { status, payload } = await actions.run('refresh', { probe: args.probe === true })
      if (status === 409) return `未能启动刷新：${payload.error ?? '车道已关闭'}`
      return '已开始刷新清单（后台进行）。稍后用 wb_free_model_status 查看进度。'
    },
  }

  /**
   * Chat has no list to tap, so an id the lane does not serve must be answered
   * as such before anything starts: the routes tolerate a background probe
   * whose failure only ever reaches the settings page, and a tool that replies
   * 「已开始」 to a typo would be lying.
   */
  function unknownId(snapshot, id) {
    return id !== undefined && !snapshot.models.some(model => model.id === id)
      ? `车道里没有 id 为 "${id}" 的模型。用 wb_free_model_status 的 detail="models" 列出可用 id。`
      : undefined
  }

  const probeTool = {
    name: 'wb_free_model_probe',
    description: '检测 WB 免费模型是否真的可用：不给 id 则检测全部，给 id 则只检测该模型。异步启动。',
    parameters: {
      id: { type: 'string', description: '单个模型的 id（wb_free_model_status 的 detail="models" 每行括号里那个）；留空表示全部。' },
    },
    output: textOutput,
    async execute(args) {
      const id = typeof args.id === 'string' && args.id !== '' ? args.id : undefined
      const before = (await actions.run('status')).payload
      if (before.enabled !== true) return `未能启动检测：${LANE_OFF_MESSAGE}`
      const rejection = unknownId(before, id)
      if (rejection !== undefined) return rejection
      const { status, payload } = await actions.run('probe', { id })
      if (status === 409) return `未能启动检测：${payload.error ?? '已有检测在进行中'}`
      return payload.id ? `已开始检测 ${payload.id}（后台进行），用 wb_free_model_status 查看结果。` : '已开始检测全部模型（后台进行），用 wb_free_model_status 查看进度。'
    },
  }

  const retryTool = {
    name: 'wb_free_model_retry',
    description: '清掉 WB 免费模型的失败记录并解禁模型，之后可重新检测。不给 id 则清空全部失败记录。',
    parameters: {
      id: { type: 'string', description: '只重试这一个模型；留空表示全部。' },
    },
    output: textOutput,
    async execute(args) {
      const id = typeof args.id === 'string' && args.id !== '' ? args.id : undefined
      const before = (await actions.run('status')).payload
      if (before.enabled !== true) return `未能清除记录：${LANE_OFF_MESSAGE}`
      const rejection = unknownId(before, id)
      if (rejection !== undefined) return rejection
      const { status, payload } = await actions.run('retry', { id })
      if (status === 409) return `未能清除记录：${payload.error ?? LANE_OFF_MESSAGE}`
      if (id !== undefined) return `已清除 ${id} 的探测记录，用 wb_free_model_probe 带上这个 id 重新检测。`
      const pending = payload.models.filter(model => model.result === undefined).length
      return `已清除全部探测记录并解禁模型（${pending} 个待检测），用 wb_free_model_probe 检测。`
    },
  }

  const settingsTool = {
    name: 'wb_free_model_settings',
    description: '开启或关闭 WB 免费模型车道，或设置启动时是否自动检测。等价于设置页的两个开关。',
    parameters: {
      enabled: { type: 'boolean', description: '车道总开关。关闭会立即撤回全部模型。' },
      probe_on_boot: { type: 'boolean', description: '启动时是否自动探测全部模型。' },
    },
    output: textOutput,
    async execute(args) {
      const body = {}
      if (typeof args.enabled === 'boolean') body.enabled = args.enabled
      if (typeof args.probe_on_boot === 'boolean') body.probeOnBoot = args.probe_on_boot
      if (Object.keys(body).length === 0) return '未提供任何要修改的开关；当前状态见 wb_free_model_status。'
      const { payload } = await actions.run('settings', body)
      return `已保存：车道${payload.enabled === true ? '启用' : '停用'}，启动自动检测${payload.probeOnBoot === false ? '关闭' : '开启'}。`
    },
  }

  ctx.inject(['tools'], scoped => {
    for (const tool of [statusTool, refreshTool, probeTool, retryTool, settingsTool]) scoped.tools.register(tool)
    logger.info?.('dsh-wb-free-model: lane tools registered (status/refresh/probe/retry/settings)')
  })

  return { setPreferences }
}
