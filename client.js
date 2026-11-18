/**
 * WB Free Model — browser half.
 *
 * One settings section listing every discovered free model with its probe
 * state, plus the plugin's own switches. Data comes from the host half's
 * same-origin `/api/wb-free-model/*` routes; no typed binding is assumed so the
 * page mounts on every DSH kernel line this plugin targets.
 */

window.__ModuleLoader__.load({
  id: 'dsh-wb-free-model',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback } = React

    const inject = ['slots', 'locale']
    const API = (() => {
      try { return new URL('api/wb-free-model', document.baseURI).pathname } catch { return '/api/wb-free-model' }
    })()

    async function api(path, options) {
      const { timeout = 15_000, ...fetchOptions } = options ?? {}
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: controller.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) {
          const error = new Error(payload?.error ?? `HTTP ${response.status}`)
          error.status = response.status
          throw error
        }
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

    /**
     * Retry the failed models one POST at a time. The server caps single-model
     * probes at `probeConcurrency`, so a burst larger than that must wait for a
     * free slot instead of piling into 409s and aborting mid-list. A 409 that
     * still slips through a race gets one delayed retry.
     */
    async function retryFailedModels(ids, { post, getStatus, limit = 2, waitMs = 500, maxWaits = 40 }) {
      for (const id of ids) {
        let waits = 0
        for (;;) {
          const status = await getStatus().catch(() => undefined)
          const busy = Number(status?.probeSlotsBusy)
          if (!Number.isFinite(busy) || busy < limit || waits >= maxWaits) break
          await delay(waitMs)
          waits += 1
        }
        try {
          await post('/probe', { id })
        } catch (error) {
          if (error?.status !== 409) throw error
          await delay(800)
          await post('/probe', { id })
        }
      }
    }

    const COLORS = {
      text: 'var(--vscode-foreground, #1f2328)',
      muted: 'var(--vscode-descriptionForeground, #656d76)',
      border: 'var(--vscode-panel-border, rgba(128,128,128,0.28))',
      panel: 'var(--vscode-sideBar-background, transparent)',
      accent: 'var(--vscode-button-background, #2563eb)',
      accentText: 'var(--vscode-button-foreground, #fff)',
      ok: 'var(--vscode-testing-iconPassed, #1a7f37)',
      warn: 'var(--vscode-editorWarning-foreground, #9a6700)',
      bad: 'var(--vscode-errorForeground, #cf222e)',
    }

    function Tag({ label, tone }) {
      const color = tone === 'ok' ? COLORS.ok : tone === 'warn' ? COLORS.warn : tone === 'bad' ? COLORS.bad : COLORS.muted
      return h('span', {
        style: {
          display: 'inline-block', padding: '1px 6px', marginRight: 6, borderRadius: 4,
          border: `1px solid ${COLORS.border}`, color, fontSize: 11, whiteSpace: 'nowrap',
        },
      }, label)
    }

    function Button({ children, onClick, disabled, primary }) {
      return h('button', {
        type: 'button',
        onClick,
        disabled,
        style: {
          padding: '4px 10px', marginRight: 8, borderRadius: 5, cursor: disabled ? 'default' : 'pointer',
          border: `1px solid ${primary ? COLORS.accent : COLORS.border}`,
          background: primary ? COLORS.accent : 'transparent',
          color: primary ? COLORS.accentText : COLORS.text,
          opacity: disabled ? 0.55 : 1, fontSize: 12,
        },
      }, children)
    }

    function availability(model) {
      const result = model.result
      if (result?.ok === true && result?.chatOnly === true) return { label: '仅对话', tone: 'warn' }
      if (result?.ok === true) return { label: '可用', tone: 'ok' }
      if (result?.source === 'probe' && result?.ok === false) return { label: '探测失败', tone: 'bad' }
      if (result?.ok === false) return { label: '最近请求失败', tone: 'warn' }
      return { label: '未探测', tone: 'muted' }
    }

    function modelDetail(model) {
      const result = model.result
      if (result?.ok === true) return result.chatOnly === true ? '经纯对话兜底发布' : `${result.ms ?? '?'} ms`
      if (result?.ok === false) return result.message ?? result.code ?? '未知原因'
      return '运行「检测全部」或点这一行的重试'
    }

    function Row({ model, busy, onProbe }) {
      const state = availability(model)
      const capabilities = []
      if (model.toolcall === true) capabilities.push(h(Tag, { key: 't', label: '工具' }))
      if (model.images === true) capabilities.push(h(Tag, { key: 'i', label: '图像' }))
      if (model.reasoning === true) capabilities.push(h(Tag, { key: 'r', label: '推理' }))
      return h('div', {
        style: {
          display: 'grid', gridTemplateColumns: 'minmax(180px, 1.3fr) minmax(120px, 1fr) auto',
          gap: 10, alignItems: 'center', padding: '7px 0', borderTop: `1px solid ${COLORS.border}`,
        },
      },
        h('div', null,
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, model.name),
          h('div', { style: { fontSize: 11, color: COLORS.muted, fontFamily: 'ui-monospace, monospace' } }, model.id),
          h('div', { style: { marginTop: 3 } }, ...capabilities,
            model.efforts?.length > 0 ? h(Tag, { label: `档位 ${model.efforts.join('/')}` }) : null)),
        h('div', null,
          h('div', null, h(Tag, { label: state.label, tone: state.tone }), h('span', { style: { fontSize: 11, color: COLORS.muted } }, `权重 ${model.weight ?? 100}`)),
          h('div', { style: { fontSize: 11, color: COLORS.muted, marginTop: 2, wordBreak: 'break-word' } }, modelDetail(model))),
        h(Button, { onClick: () => onProbe(model.id), disabled: busy }, busy ? '检测中…' : '重试'),
      )
    }

    function useStatus() {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const load = useCallback(async () => {
        try {
          const data = await api('/status')
          setState({ status: 'ready', data, error: '' })
        } catch (error) {
          setState({ status: 'error', data: undefined, error: String(error?.message ?? error) })
        }
      }, [])
      useEffect(() => {
        let alive = true
        let timer
        const tick = async () => {
          try {
            const data = await api('/status')
            if (alive) setState({ status: 'ready', data, error: '' })
          } catch (error) {
            if (alive) setState(current => current.data === undefined
              ? { status: 'error', data: undefined, error: String(error?.message ?? error) }
              : { ...current, error: String(error?.message ?? error) })
          } finally {
            if (alive) timer = setTimeout(tick, 5000)
          }
        }
        void tick()
        return () => { alive = false; clearTimeout(timer) }
      }, [])
      return { ...state, reload: load }
    }

    function SettingsSection() {
      const { status, data, error, reload } = useStatus()
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState(null)

      const run = useCallback(async (key, action, done = '') => {
        setBusy(key)
        setNote(null)
        try {
          await action()
          if (done !== '') setNote({ text: done, tone: 'ok' })
          await reload()
        } catch (cause) {
          const message = String(cause?.message ?? cause)
          const interrupted = /abort|timeout|timed out|network/i.test(message)
          setNote({
            text: interrupted
              ? `失败：请求超时或被中断（${message}）。后台任务不受影响，状态会自动刷新。`
              : `失败：${message}`,
            tone: 'bad',
          })
          // Even a failed action may have changed server state; refresh anyway.
          await reload().catch(() => {})
        } finally {
          setBusy('')
        }
      }, [reload])

      const laneEnabled = data?.enabled !== false
      const models = data?.models ?? []
      const failed = models.filter(model => model.result?.source === 'probe' && model.result?.ok === false)
      const refreshing = data?.refreshing === true
      const quotaActive = Number(data?.laneQuotaUntil ?? 0) > Date.now()
      const runtimeLine = (() => {
        if (data === undefined) return '正在读取插件状态…'
        if (!laneEnabled) return '车道已停用，模型已从选择器移除'
        if (quotaActive) return `免费车道配额窗口中（至 ${new Date(data.laneQuotaUntil).toLocaleTimeString()}）· Kilo 车道不受影响`
        if (data.runtime?.ready === true) return '直连上游网关就绪 · 无需下载运行时'
        return data.lastError || '尚未拉到模型清单，点「刷新目录」开始'
      })()

      return h('div', { style: { color: COLORS.text, fontSize: 13, lineHeight: 1.5, maxWidth: 860 } },
        h('h3', { style: { margin: '0 0 4px' } }, 'WB Free Model'),
        h('div', { style: { color: COLORS.muted, marginBottom: 10 } },
          '免费模型由插件进程直连上游免费网关（OpenCode 的免密免费车道与 Kilo 公共池），不需要登录、注册或填写任何 API Key，也不下载任何运行时。选「WB · auto」会按耗时权重自动挑一个当前可用的模型。'),
        data !== undefined && !laneEnabled
          ? h('div', {
              style: {
                padding: '8px 10px', marginBottom: 10, borderRadius: 6,
                border: `1px solid ${COLORS.border}`, background: COLORS.panel,
                fontSize: 12, color: COLORS.muted,
              },
            },
            'WB Free Model 已停用：全部模型（含 WB · auto）已从模型选择器移除，探测与目录刷新已暂停，重启后也不会自动拉起。勾选下方「启用 WB Free Model 车道」即可重新开启。')
          : null,
        data !== undefined && laneEnabled && quotaActive
          ? h('div', {
              style: {
                padding: '8px 10px', marginBottom: 10, borderRadius: 6,
                border: `1px solid ${COLORS.warn}`, fontSize: 12, color: COLORS.warn,
              },
            },
            `免费车道（OC · 前缀）触发了上游的出口配额：${data.laneQuotaMessage || '上游按出口 IP 计免费配额'}。窗口结束前免费车道的请求会在本地直接拒绝，不会去撞墙；Kilo 车道（KL · 前缀）不受影响。切换网络出口后可用「刷新目录」重新探测。`)
          : null,
        data !== undefined && laneEnabled && data.laneLocked
          ? h('div', {
              style: {
                padding: '8px 10px', marginBottom: 10, borderRadius: 6,
                border: `1px solid ${COLORS.bad}`, fontSize: 12, color: COLORS.bad,
              },
            },
            `上游网关拒绝了本插件的客户端指纹：${data.laneLocked}。等待或重试无法解除，通常需要等待上游放开，或反馈到插件仓库。`)
          : null,
        h('div', { style: { fontSize: 12, color: error !== '' ? COLORS.bad : COLORS.muted, marginBottom: 10 } },
          error !== '' ? `状态读取失败：${error}（下面仍显示最后一次成功的数据）` : runtimeLine),
        laneEnabled && data?.lastError
          ? h('div', { style: { fontSize: 12, color: COLORS.warn, marginBottom: 10 } }, `最近一次清单/上游错误：${data.lastError}`)
          : null,
        h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
          h(Button, {
            primary: true,
            disabled: busy !== '' || refreshing || !laneEnabled,
            onClick: () => run('refresh', () => post('/refresh'), '目录刷新已开始，状态会自动更新'),
          }, refreshing || busy === 'refresh' ? '刷新中…' : '刷新目录'),
          h(Button, {
            disabled: busy !== '' || !laneEnabled || data?.runtime?.ready !== true || data?.probing === true,
            onClick: () => run('probe', () => post('/probe'), '已开始检测，结果会逐个出现'),
          }, data?.probing === true && data?.probeProgress !== undefined ? '检测中…' : '检测全部'),
          h(Button, {
            disabled: busy !== '' || !laneEnabled || failed.length === 0,
            onClick: () => run('retry', () => retryFailedModels(
              failed.map(model => model.id),
              { post, getStatus: () => api('/status'), limit: data?.probeConcurrency ?? 2 },
            ), `已开始重试 ${failed.length} 个失败模型，结果会逐个出现`),
          }, `重试失败（${failed.length}）`),
          h(Button, { disabled: busy !== '', onClick: () => run('reload', reload) }, '重新读取'),
          data?.probing === true && data.probeProgress !== undefined
            ? h('span', { style: { fontSize: 12, color: COLORS.muted } }, `探测 ${data.probeProgress.done}/${data.probeProgress.total}`)
            : null,
          refreshing && data?.probing !== true
            ? h('span', { style: { fontSize: 12, color: COLORS.muted } }, '目录刷新中…')
            : null),
        note !== null && note.text !== ''
          ? h('div', { style: { fontSize: 12, color: note.tone === 'bad' ? COLORS.bad : COLORS.ok, marginBottom: 6 } }, note.text)
          : null,
        h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', margin: '8px 0 12px', fontSize: 12 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: laneEnabled,
              disabled: busy !== '',
              onChange: event => run('enabled', () => post('/settings', { enabled: event.target.checked }), '设置已保存'),
            }),
            '启用 WB Free Model 车道'),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: data?.probeOnBoot !== false,
              disabled: busy !== '',
              onChange: event => run('boot', () => post('/settings', { probeOnBoot: event.target.checked }), '设置已保存'),
            }),
            '启动时自动检测模型')),
        data?.catalogAt && laneEnabled ? h('div', { style: { fontSize: 11, color: COLORS.muted, marginBottom: 4 } },
          `目录更新于 ${new Date(data.catalogAt).toLocaleString()} · 共 ${models.length} 个免费模型`) : null,
        status === 'loading' ? h('div', { style: { color: COLORS.muted } }, '加载中…') : null,
        models.length === 0 && status === 'ready' && laneEnabled
          ? h('div', { style: { color: COLORS.warn, marginTop: 8 } }, '还没有发现免费模型。点「刷新目录」重试；若持续失败，看上面的状态说明。')
          : null,
        models.length > 0 && data?.auto !== undefined
          ? h('div', { style: { marginTop: 8, padding: '7px 0', borderTop: `1px solid ${COLORS.border}` } },
              h('div', { style: { fontSize: 13, fontWeight: 600 } }, data.auto.name),
              h('div', { style: { fontSize: 11, color: COLORS.muted } },
                data.auto.efforts?.length > 0
                  ? `自动挑选可用免费模型 · 支持档位 ${data.auto.efforts.join('/')}`
                  : '自动挑选可用免费模型'))
          : null,
        ...models.map(model => h(Row, {
          key: model.id,
          model,
          // probingIds covers single-model probes, which never set probeProgress;
          // it keeps the row busy so a retry cannot be double-clicked into a
          // duplicate concurrent probe.
          busy: busy === `probe:${model.id}` || data?.probeProgress !== undefined
            || (Array.isArray(data?.probingIds) && data.probingIds.includes(model.id)),
          onProbe: id => run(`probe:${id}`, () => post('/probe', { id }), '已开始重试，几秒后刷新状态'),
        })),
        models.length > 0 ? h('div', { style: { fontSize: 11, color: COLORS.muted, marginTop: 12 } },
          '工具调用的执行始终发生在 DSH 这一侧；上游网关只生成文本与动作请求，不会执行任何本地操作。') : null,
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-wb-free-model',
        order: 45,
        label: () => 'WB Free Model',
        locale: 'settings.wbFreeModel',
      }, () => h(SettingsSection)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'dsh-wb-free-model'
    exports.__test = { SettingsSection, availability, modelDetail, API, retryFailedModels }
    return module.exports
  },
})
