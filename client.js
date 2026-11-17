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
      const [note, setNote] = useState('')

      const run = useCallback(async (key, action, done = '') => {
        setBusy(key)
        setNote('')
        try {
          await action()
          setNote(done)
          await reload()
        } catch (cause) {
          setNote(`失败：${cause?.message ?? cause}`)
        } finally {
          setBusy('')
        }
      }, [reload])

      const models = data?.models ?? []
      const failed = models.filter(model => model.result?.source === 'probe' && model.result?.ok === false)
      const runtimeLine = (() => {
        if (data === undefined) return '正在读取插件状态…'
        if (data.runtime?.ready === true) return `运行时 ${data.runtime.version || ''} 已就绪 · 端口 ${data.runtime.port}`
        if (data.runtime?.starting === true) return '运行时正在启动（首次启动会下载 OpenCode）…'
        return data.lastError || '运行时未启动'
      })()

      return h('div', { style: { color: COLORS.text, fontSize: 13, lineHeight: 1.5, maxWidth: 860 } },
        h('h3', { style: { margin: '0 0 4px' } }, 'WB Free Model'),
        h('div', { style: { color: COLORS.muted, marginBottom: 10 } },
          '免费模型由本机隔离的 OpenCode 运行时提供，不需要登录、注册或填写任何 API Key。选「WB · auto」会按耗时权重自动挑一个当前可用的模型。'),
        h('div', { style: { fontSize: 12, color: error !== '' ? COLORS.bad : COLORS.muted, marginBottom: 10 } },
          error !== '' ? `状态读取失败：${error}（下面仍显示最后一次成功的数据）` : runtimeLine),
        h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 } },
          h(Button, {
            primary: true,
            disabled: busy !== '',
            onClick: () => run('refresh', () => post('/refresh'), '目录已刷新'),
          }, busy === 'refresh' ? '刷新中…' : '刷新目录'),
          h(Button, {
            disabled: busy !== '' || data?.runtime?.ready !== true || data?.probing === true,
            onClick: () => run('probe', () => post('/probe'), '已开始检测，结果会逐个出现'),
          }, data?.probing === true && data?.probeProgress !== undefined ? '检测中…' : '检测全部'),
          h(Button, {
            disabled: busy !== '' || failed.length === 0,
            onClick: () => run('retry', async () => { await post('/retry'); return post('/probe') }, '已开始重新检测'),
          }, `重试失败（${failed.length}）`),
          h(Button, { disabled: busy !== '', onClick: () => run('reload', reload) }, '重新读取'),
          data?.probing === true && data.probeProgress !== undefined
            ? h('span', { style: { fontSize: 12, color: COLORS.muted } }, `探测 ${data.probeProgress.done}/${data.probeProgress.total}`)
            : null),
        note !== '' ? h('div', { style: { fontSize: 12, color: COLORS.warn, marginBottom: 6 } }, note) : null,
        h('div', { style: { display: 'flex', gap: 18, flexWrap: 'wrap', margin: '8px 0 12px', fontSize: 12 } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('input', {
              type: 'checkbox',
              checked: data?.enabled !== false,
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
        data?.catalogAt ? h('div', { style: { fontSize: 11, color: COLORS.muted, marginBottom: 4 } },
          `目录更新于 ${new Date(data.catalogAt).toLocaleString()} · 共 ${models.length} 个免费模型`) : null,
        status === 'loading' ? h('div', { style: { color: COLORS.muted } }, '加载中…') : null,
        models.length === 0 && status === 'ready'
          ? h('div', { style: { color: COLORS.warn, marginTop: 8 } }, '还没有发现免费模型。点「刷新目录」重试；若运行时未就绪，先看上面的状态说明。')
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
          busy: busy === `probe:${model.id}` || data?.probeProgress !== undefined,
          onProbe: id => run(`probe:${id}`, () => post('/probe', { id }), '已开始重试，几秒后刷新状态'),
        })),
        models.length > 0 ? h('div', { style: { fontSize: 11, color: COLORS.muted, marginTop: 12 } },
          '工具调用的执行始终发生在 DSH 这一侧；托管模型只返回 JSON 动作请求，不会在 OpenCode 里执行本地命令。') : null,
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
    exports.__test = { SettingsSection, availability, modelDetail, API }
    return module.exports
  },
})
