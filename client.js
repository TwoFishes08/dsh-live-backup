window.__ModuleLoader__.load({
  id: 'dsh-backup',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-backup'
    const STATE_ROUTE = '/api/dsh-backup/state'
    const ACTION_ROUTE = '/api/dsh-backup/action'
    const STYLE_ID = 'dsh-backup-settings-style'

    const zh = {
      'section.title': '备份与云同步',
      'title': '备份与云同步',
      'subtitle': '对话记录 · 工作区文件 · 插件与应用配置',
      'status.idle': '尚未备份',
      'status.running': '正在备份',
      'status.success': '备份完成',
      'status.error': '备份失败',
      'label.status': '备份状态',
      'label.latest': '最近备份',
      'label.today': '今日备份',
      'label.location': '备份位置',
      'label.contents': '备份内容',
      'label.duration': '耗时',
      'label.rule': '备份规则',
      'rule.value': '同一天只保留一份备份，再次备份会直接覆盖当天的旧备份。',
      'unit.sessions': '个对话',
      'unit.workspaces': '个工作区',
      'unit.files': '个文件',
      'cloud.title': '云盘同步',
      'cloud.provider': '云盘类型',
      'cloud.autoBackup': '启动 DSH 时自动备份',
      'cloud.autoBackupHint': '每次打开 DSH 后自动备份一次；当天再次备份会覆盖旧备份。',
      'cloud.switchHint': '切换云盘会自动把备份位置切换到该云盘的同步目录；若未检测到该云盘目录，可用“更改备份文件夹”手动指定。',
      'action.backup': '立即备份',
      'action.backupBusy': '正在备份…',
      'action.pickFolder': '更改备份文件夹',
      'folder.manual': '手动填写路径',
      'folder.manualLabel': '备份文件夹路径',
      'folder.placeholder': '例如 C:\\Users\\<用户名>\\OneDrive\\DeepSeek Harness备份',
      'action.applyPath': '保存路径',
      'action.cancelPath': '取消',
      'action.openRoot': '打开备份文件夹',
      'action.openLatest': '打开最近备份',
      'action.refresh': '刷新',
      'empty.loading': '正在读取备份状态…',
      'empty.none': '还没有备份记录',
      'error.prefix': '操作失败：',
      'error.unavailable': '备份服务尚未就绪，暂时读不到备份状态，正在自动重试。若长时间如此，请在插件管理里把 dsh-backup 关闭再启用，或重启 DSH。',
      'provider.custom': '自定义文件夹',
      'status.unknown': '未知状态',
      'footer': '备份先写入本地云盘文件夹；云盘客户端运行时自动上传，关闭时显示为“待同步”。',
    }

    const en = {
      'section.title': 'Backup & Cloud Sync',
      'title': 'Backup & Cloud Sync',
      'subtitle': 'Conversations · Workspace files · Plugin and app configuration',
      'status.idle': 'No backup yet',
      'status.running': 'Backing up',
      'status.success': 'Backup complete',
      'status.error': 'Backup failed',
      'label.status': 'Status',
      'label.latest': 'Latest backup',
      'label.today': 'Today',
      'label.location': 'Location',
      'label.contents': 'Contents',
      'label.duration': 'Duration',
      'label.rule': 'Rule',
      'rule.value': 'Only one backup per day: a new backup overwrites the same day’s earlier copy.',
      'unit.sessions': 'conversations',
      'unit.workspaces': 'workspaces',
      'unit.files': 'files',
      'cloud.title': 'Cloud sync',
      'cloud.provider': 'Cloud provider',
      'cloud.autoBackup': 'Back up automatically when DSH starts',
      'cloud.autoBackupHint': 'Runs once after each DSH launch; a later backup the same day replaces it.',
      'cloud.switchHint': 'Switching moves the backup folder into that provider’s sync folder when detected; otherwise pick a folder manually.',
      'action.backup': 'Back up now',
      'action.backupBusy': 'Backing up…',
      'action.pickFolder': 'Change backup folder',
      'folder.manual': 'Type a path',
      'folder.manualLabel': 'Backup folder path',
      'folder.placeholder': 'e.g. C:\\Users\\<user>\\OneDrive\\DeepSeek Harness备份',
      'action.applyPath': 'Save path',
      'action.cancelPath': 'Cancel',
      'action.openRoot': 'Open backup folder',
      'action.openLatest': 'Open latest backup',
      'action.refresh': 'Refresh',
      'empty.loading': 'Reading backup status…',
      'empty.none': 'No backup recorded yet',
      'error.prefix': 'Action failed: ',
      'error.unavailable': 'The backup service is not ready yet, so status cannot be read. Retrying automatically; if this persists, toggle dsh-backup off and on in the plugin manager, or restart DSH.',
      'provider.custom': 'Custom folder',
      'status.unknown': 'Unknown',
      'footer': 'Backups are written to the cloud-drive folder first; the provider client uploads them automatically, otherwise the state stays “pending”.',
    }

    const fallbackT = (key, vars) => {
      let text = zh[key] || en[key] || key
      if (vars && typeof vars === 'object') {
        text = text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
      }
      return text
    }

    /**
     * The Host API always answers with JSON, but while the panel loads before
     * the Host half has registered its routes the connection layer replies with
     * a plain-text "not found". Parse defensively so the panel can show a
     * friendly retry hint instead of a raw JSON.parse error.
     */
    const readJson = async (response) => {
      const text = await response.text()
      try {
        return text ? JSON.parse(text) : null
      } catch {
        const snippet = text.trim().slice(0, 80) || `HTTP ${response.status}`
        const error = new Error(snippet)
        error.notJson = true
        error.status = response.status
        throw error
      }
    }

    const CSS = `
.dshb-root{display:flex;flex-direction:column;gap:14px;max-width:820px;padding:4px 2px 28px;box-sizing:border-box}
.dshb-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:14px;padding:16px 18px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box}
.dshb-head{flex-direction:row;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.dshb-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#111827);line-height:1.3}
.dshb-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#6b7280);line-height:1.4;margin-top:3px}
.dshb-section-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#111827);display:flex;align-items:center;gap:8px}
.dshb-row{display:grid;grid-template-columns:96px minmax(0,1fr);gap:10px;align-items:start;font-size:13px;line-height:1.5}
.dshb-row__label{color:var(--dsw-alias-label-tertiary,#6b7280)}
.dshb-row__value{color:var(--dsw-alias-label-primary,#111827);min-width:0;word-break:break-all}
.dshb-muted{color:var(--dsw-alias-label-tertiary,#6b7280)}
.dshb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.dshb-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:12px;line-height:1.2;white-space:nowrap;border:1px solid transparent}
.dshb-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.dshb-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.dshb-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:13px;line-height:1;padding:9px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#f8fafc);color:var(--dsw-alias-label-primary,#111827);cursor:pointer;transition:background .15s ease,border-color .15s ease,opacity .15s ease}
.dshb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eef2f7)}
.dshb-btn:disabled{opacity:.55;cursor:default}
.dshb-btn--primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-label-primary-foreground,#fff)}
.dshb-btn--primary:hover:not(:disabled){filter:brightness(1.07)}
.dshb-btn--ghost{background:transparent}
.dshb-select{font:inherit;font-size:13px;padding:8px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);min-width:170px;cursor:pointer}
.dshb-select:disabled{opacity:.55;cursor:default}
.dshb-switch{position:relative;width:40px;height:22px;border-radius:999px;border:none;cursor:pointer;background:var(--dsw-alias-border-l2,#d1d5db);transition:background .15s ease;flex:0 0 auto;padding:0}
.dshb-switch[aria-checked="true"]{background:var(--dsw-alias-state-business-primary,#2563eb)}
.dshb-switch:disabled{opacity:.55;cursor:default}
.dshb-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}
.dshb-switch[aria-checked="true"]::after{transform:translateX(18px)}
.dshb-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary,#111827)}
.dshb-progress{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#e5e7eb);overflow:hidden;position:relative}
.dshb-progress__bar{height:100%;border-radius:999px;background:var(--dsw-alias-state-business-primary,#2563eb);transition:width .35s ease}
.dshb-progress--indeterminate .dshb-progress__bar{width:35%;animation:dshb-slide 1.1s ease-in-out infinite}
@keyframes dshb-slide{0%{transform:translateX(-110%)}100%{transform:translateX(320%)}}
.dshb-banner{border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.55;border:1px solid transparent}
.dshb-banner--error{background:var(--dsw-alias-bg-layer-2,#fef2f2);border-color:var(--dsw-alias-state-error-primary,#ef4444);color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dshb-banner--notice{background:var(--dsw-alias-bg-layer-2,#eff6ff);border-color:var(--dsw-alias-state-business-primary,#2563eb);color:var(--dsw-alias-label-secondary,#1e40af)}
.dshb-footer{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#6b7280);padding:0 2px}
.dshb-pathbox{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dshb-input{flex:1 1 320px;min-width:0;font:inherit;font-size:12.5px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:9px 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111827);box-sizing:border-box}
.dshb-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#2563eb)}
.dshb-spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2,#d1d5db);border-top-color:var(--dsw-alias-state-business-primary,#2563eb);animation:dshb-rotate .8s linear infinite;flex:0 0 auto}
@keyframes dshb-rotate{to{transform:rotate(360deg)}}
`

    // ------------------------------------------------------------------ utils
    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—'
      if (bytes < 1024) return `${bytes} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let value = bytes / 1024
      let index = 0
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024
        index += 1
      }
      return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
    }

    function fmtTime(ms) {
      if (!ms) return '—'
      try {
        const date = new Date(ms)
        const now = new Date()
        const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
        const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
        return sameDay ? `今天 ${time}` : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`
      } catch {
        return '—'
      }
    }

    function fmtDuration(ms) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '—'
      if (ms < 1000) return `${ms} ms`
      if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.round((ms % 60000) / 1000)
      return `${minutes} 分 ${seconds} 秒`
    }

    function Badge(props) {
      const tone = props.tone || 'neutral'
      const tones = {
        neutral: { bg: 'var(--dsw-alias-bg-layer-2,#f3f4f6)', fg: 'var(--dsw-alias-label-secondary,#4b5563)', dot: 'var(--dsw-alias-label-tertiary,#9ca3af)' },
        success: { bg: 'var(--dsw-alias-bg-layer-2,#ecfdf5)', fg: 'var(--dsw-alias-state-success-primary,#047857)', dot: 'var(--dsw-alias-state-success-primary,#10b981)' },
        warn: { bg: 'var(--dsw-alias-bg-layer-2,#fffbeb)', fg: 'var(--dsw-alias-state-warn-primary,#b45309)', dot: 'var(--dsw-alias-state-warn-primary,#f59e0b)' },
        error: { bg: 'var(--dsw-alias-bg-layer-2,#fef2f2)', fg: 'var(--dsw-alias-state-error-primary,#b91c1c)', dot: 'var(--dsw-alias-state-error-primary,#ef4444)' },
        info: { bg: 'var(--dsw-alias-bg-layer-2,#eff6ff)', fg: 'var(--dsw-alias-state-business-primary,#1d4ed8)', dot: 'var(--dsw-alias-state-business-primary,#3b82f6)' },
      }
      const palette = tones[tone] || tones.neutral
      return h('span', { className: 'dshb-badge', style: { background: palette.bg, color: palette.fg } },
        h('span', { className: 'dshb-dot', style: { background: palette.dot } }),
        props.children,
      )
    }

    function Row(props) {
      return h('div', { className: 'dshb-row' },
        h('div', { className: 'dshb-row__label' }, props.label),
        h('div', { className: 'dshb-row__value' },
          props.mono ? h('span', { className: 'dshb-mono' }, props.children) : props.children),
      )
    }

    function BackupIcon(props) {
      const size = props.size || 44
      return h('svg', { viewBox: '0 0 64 64', width: size, height: size, 'aria-hidden': true, style: { flex: '0 0 auto', display: 'block' } },
        h('defs', null,
          h('linearGradient', { id: 'dshb-g1', x1: '0', y1: '0', x2: '1', y2: '1' },
            h('stop', { offset: '0', stopColor: '#3b82f6' }),
            h('stop', { offset: '1', stopColor: '#7c3aed' }))),
        h('rect', { x: 2, y: 2, width: 60, height: 60, rx: 16, fill: 'url(#dshb-g1)' }),
        h('path', { d: 'M21.5 41.5h21a8.5 8.5 0 0 0 1.1-16.9 11.5 11.5 0 0 0-21.7-2.1 7.4 7.4 0 0 0-.4 19z', fill: '#eaf2ff' }),
        h('path', { d: 'M32 34v12', stroke: '#3b5bdb', strokeWidth: 3.2, strokeLinecap: 'round' }),
        h('path', { d: 'M26.6 40.8 32 46.4l5.4-5.6', fill: 'none', stroke: '#3b5bdb', strokeWidth: 3.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('circle', { cx: 46.5, cy: 17.5, r: 7, fill: '#22c55e' }),
        h('path', { d: 'M43.2 17.6l2.3 2.3 4-4.2', fill: 'none', stroke: '#fff', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    // -------------------------------------------------------------- component
    function BackupSection(props) {
      const t = props.t || fallbackT
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [manualOpen, setManualOpen] = React.useState(false)
      const [pathDraft, setPathDraft] = React.useState('')
      const alive = React.useRef(true)

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(STATE_ROUTE, { method: 'GET', credentials: 'same-origin', cache: 'no-store' })
          const body = await readJson(response)
          if (!alive.current) return
          if (body && body.ok === false) {
            setError(body.error || 'status unavailable')
            return
          }
          setSnapshot(body)
          setError(null)
        } catch (cause) {
          if (!alive.current) return
          if (cause && cause.notJson) {
            setError(t('error.unavailable'))
            return
          }
          setError(String((cause && cause.message) || cause))
        }
      }, [])

      React.useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(() => {
          if (!document.hidden) load()
        }, 3000)
        const onVisible = () => {
          if (!document.hidden) load()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive.current = false
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load])

      const act = React.useCallback(async (op, payload) => {
        setBusy(op)
        setError(null)
        setNotice(null)
        try {
          const response = await fetch(ACTION_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ op, payload: payload || {} }),
          })
          const body = await readJson(response)
          if (body && body.snapshot) setSnapshot(body.snapshot)
          if (!body || body.ok === false) {
            setError((body && body.error) || 'action failed')
          } else if (body.message) {
            setNotice(body.message)
          }
          await load()
          return body
        } catch (cause) {
          if (alive.current) {
            setError(cause && cause.notJson ? t('error.unavailable') : String((cause && cause.message) || cause))
          }
          return null
        } finally {
          setBusy(null)
        }
      }, [load])

      const applyPath = React.useCallback(async () => {
        const result = await act('setFolder', { path: pathDraft })
        if (result && result.ok) {
          setManualOpen(false)
          setPathDraft('')
        }
      }, [act, pathDraft])

      if (!snapshot) {
        return h('div', { className: 'dshb-root' },
          h('div', { className: 'dshb-card' },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
              h('span', { className: 'dshb-spin' }),
              h('span', { className: 'dshb-muted', style: { fontSize: 13 } }, t('empty.loading'))),
            error ? h('div', { className: 'dshb-banner dshb-banner--error' }, `${t('error.prefix')}${error}`) : null),
        )
      }

      const status = snapshot.status || {}
      const settings = snapshot.settings || {}
      const cloud = snapshot.cloud || {}
      const folder = snapshot.folder || {}
      const latest = folder.latest || null
      const result = status.result || null
      const counts = (result && result.counts) || (latest && latest.counts) || null
      const running = status.state === 'running'
      const autoOn = settings.autoBackup !== false

      const statusTone = status.state === 'success' ? 'success'
        : status.state === 'error' ? 'error'
          : running ? 'info'
            : 'neutral'
      const statusText = running ? t('status.running')
        : status.state === 'success' ? t('status.success')
          : status.state === 'error' ? t('status.error')
            : t('status.idle')
      const statusColor = statusTone === 'success' ? 'var(--dsw-alias-state-success-primary,#047857)'
        : statusTone === 'error' ? 'var(--dsw-alias-state-error-primary,#b91c1c)'
          : statusTone === 'info' ? 'var(--dsw-alias-state-business-primary,#1d4ed8)'
            : 'var(--dsw-alias-label-tertiary,#6b7280)'

      const cloudTone = cloud.syncState === 'synced' ? 'success'
        : cloud.syncState === 'pending' ? 'warn' : 'neutral'

      const providerOptions = (snapshot.providers || []).map((provider) =>
        h('option', { key: provider.id, value: provider.id }, provider.name))

      const contentsText = counts
        ? `${counts.sessions != null ? counts.sessions : '—'} ${t('unit.sessions')} · ${counts.workspaces != null ? counts.workspaces : '—'} ${t('unit.workspaces')} · ${counts.files != null ? counts.files : '—'} ${t('unit.files')} · ${fmtBytes(counts.bytes)}`
        : (snapshot.sessions ? `${snapshot.sessions.count} ${t('unit.sessions')}` : t('empty.none'))

      const latestText = latest
        ? `${latest.name}${latest.createdAt ? `（${fmtTime(latest.createdAt)}）` : ''}`
        : t('empty.none')

      const todayText = latest && latest.isToday
        ? `${folder.todayName} ✓`
        : (folder.todayName || '—')

      const disableAll = !!busy
      const progressPercent = running && status.progress && status.progress.files
        ? Math.min(95, 10 + status.progress.files * 1.2)
        : 35

      return h('div', { className: 'dshb-root' },

        // Header
        h('div', { className: 'dshb-card dshb-head' },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 } },
            h(BackupIcon, { size: 46 }),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'dshb-title' }, t('title')),
              h('div', { className: 'dshb-sub' }, t('subtitle')))),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            running ? h('span', { className: 'dshb-spin' }) : null,
            h(Badge, { tone: statusTone }, statusText))),

        // Status
        h('div', { className: 'dshb-card' },
          h('div', { className: 'dshb-section-title' },
            h('span', { style: { width: 8, height: 8, borderRadius: 4, background: statusColor, display: 'inline-block' } }),
            t('label.status')),
          running
            ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { className: 'dshb-progress dshb-progress--indeterminate' },
                h('div', { className: 'dshb-progress__bar', style: { width: `${progressPercent}%` } })),
              h('div', { className: 'dshb-muted', style: { fontSize: 12 } },
                `${status.stageLabel || t('status.running')}` +
                (status.progress && status.progress.files ? ` · ${status.progress.files} ${t('unit.files')} · ${fmtBytes(status.progress.bytes)}` : '')))
            : null,
          h(Row, { label: t('label.latest') }, latestText),
          h(Row, { label: t('label.today') }, todayText),
          h(Row, { label: t('label.location'), mono: true }, settings.backupRoot || '—'),
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } },
            h('button', {
              type: 'button',
              className: 'dshb-btn dshb-btn--ghost',
              disabled: disableAll,
              onClick: () => {
                setPathDraft(settings.backupRoot || '')
                setManualOpen((value) => !value)
              },
            }, manualOpen ? t('action.cancelPath') : t('folder.manual'))),
          manualOpen
            ? h('div', { className: 'dshb-pathbox' },
              h('input', {
                className: 'dshb-input',
                value: pathDraft,
                placeholder: t('folder.placeholder'),
                spellCheck: false,
                onChange: (event) => setPathDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') void applyPath()
                },
                'aria-label': t('folder.manualLabel'),
              }),
              h('button', {
                type: 'button',
                className: 'dshb-btn dshb-btn--primary',
                disabled: disableAll || !pathDraft.trim(),
                onClick: () => void applyPath(),
              }, busy === 'setFolder' ? '…' : t('action.applyPath')))
            : null,
          h(Row, { label: t('label.contents') }, contentsText),
          h(Row, { label: t('label.duration') },
            status.durationMs != null ? fmtDuration(status.durationMs) : fmtDuration(status.finishedAt && status.startedAt ? status.finishedAt - status.startedAt : null)),
          h(Row, { label: t('label.rule') }, h('span', { className: 'dshb-muted' }, t('rule.value'))),
          status.lastError ? h('div', { className: 'dshb-banner dshb-banner--error' }, status.lastError) : null,
          error ? h('div', { className: 'dshb-banner dshb-banner--error' }, `${t('error.prefix')}${error}`) : null,
          notice ? h('div', { className: 'dshb-banner dshb-banner--notice' }, notice) : null),

        // Cloud
        h('div', { className: 'dshb-card' },
          h('div', { className: 'dshb-section-title' },
            t('cloud.title'),
            h(Badge, { tone: cloudTone }, cloud.label || t('status.unknown'))),
          h('div', { className: 'dshb-muted', style: { fontSize: 12.5, lineHeight: 1.6 } }, cloud.detail || ''),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { className: 'dshb-muted', style: { fontSize: 13 } }, t('cloud.provider')),
            h('select', {
              className: 'dshb-select',
              value: settings.provider || 'huawei',
              disabled: disableAll,
              onChange: (event) => act('setProvider', { provider: event.target.value }),
              'aria-label': t('cloud.provider'),
            }, providerOptions)),
          h('div', { className: 'dshb-switch-row' },
            h('div', null,
              h('div', null, t('cloud.autoBackup')),
              h('div', { className: 'dshb-muted', style: { fontSize: 12, marginTop: 3 } }, t('cloud.autoBackupHint'))),
            h('button', {
              type: 'button',
              className: 'dshb-switch',
              role: 'switch',
              'aria-checked': autoOn ? 'true' : 'false',
              'aria-label': t('cloud.autoBackup'),
              disabled: disableAll,
              onClick: () => act('setAutoBackup', { enabled: !autoOn }),
            })),
          h('div', { className: 'dshb-actions' },
            h('button', {
              type: 'button',
              className: 'dshb-btn dshb-btn--primary',
              disabled: disableAll || running,
              onClick: () => act('backup'),
            }, busy === 'backup' || running ? t('action.backupBusy') : t('action.backup')),
            h('button', {
              type: 'button',
              className: 'dshb-btn',
              disabled: disableAll,
              onClick: () => act('pickFolder'),
            }, busy === 'pickFolder' ? '…' : t('action.pickFolder')),
            h('button', {
              type: 'button',
              className: 'dshb-btn dshb-btn--ghost',
              disabled: disableAll,
              onClick: () => act('openFolder', { which: 'root' }),
            }, t('action.openRoot')),
            h('button', {
              type: 'button',
              className: 'dshb-btn dshb-btn--ghost',
              disabled: disableAll || !latest,
              onClick: () => act('openFolder', { which: 'latest' }),
            }, t('action.openLatest')),
            h('button', {
              type: 'button',
              className: 'dshb-btn dshb-btn--ghost',
              disabled: disableAll,
              onClick: () => load(),
            }, t('action.refresh')))),
        h('div', { className: 'dshb-footer' }, t('footer')))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : null)
        if (!slots) return

        let t = fallbackT
        try {
          const loc = ctx.locale || (typeof ctx.get === 'function' ? ctx.get('locale') : null)
          if (loc && typeof loc.bind === 'function') {
            const install = () => {
              try {
                if (typeof loc.register === 'function') loc.register(NS, { zh, en })
                else if (typeof loc.provide === 'function') loc.provide(NS, { zh, en })
              } catch {
                // dictionary registration is optional
              }
            }
            if (typeof ctx.effect === 'function') ctx.effect(install, 'dsh-backup:dictionaries')
            else install()
            const bound = loc.bind(NS)
            if (typeof bound === 'function') t = bound
          }
        } catch {
          // keep fallback translator
        }

        const installCss = () => {
          try {
            if (document.getElementById(STYLE_ID)) return () => {}
            const element = document.createElement('style')
            element.id = STYLE_ID
            element.textContent = CSS
            document.head.appendChild(element)
            return () => {
              try {
                element.remove()
              } catch {
                // ignore
              }
            }
          } catch {
            return () => {}
          }
        }
        if (typeof ctx.effect === 'function') ctx.effect(installCss, 'dsh-backup:styles')
        else installCss()

        ctx.effect(() => {
          const dispose = slots.inject('settings.section', () => slots.register({
            name: 'settings.section',
            id: 'dsh-backup',
            order: 45,
            label: () => t('section.title'),
            locale: NS,
            inject: () => ({ t }),
          }, BackupSection))
          return () => {
            try {
              dispose && dispose()
            } catch {
              // ignore
            }
          }
        }, 'dsh-backup:settings-section')
      },
    }
  },
})