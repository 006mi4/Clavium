import { useCallback, useEffect, useState } from 'react'
import { ArrowDownCircle, ArrowLeftRight, FolderOpen, History, KeyRound, Lock, Server, Settings, ShieldCheck, Sparkles, SquareTerminal, X } from 'lucide-react'
import type { ActiveForward, HostSummary, SshKeySummary, UpdateState, VaultState } from '@shared/types'
import { api, on, type UiSettings } from './api'
import { FilesView } from './components/FilesView'
import { HostsPage } from './components/HostsPage'
import { LockScreen } from './components/LockScreen'
import { Logo } from './components/Logo'
import { McpPage } from './components/McpPage'
import { ActivityPage, KeysPage, KnownHostsPage, SettingsPage } from './components/Pages'
import { PromptHost } from './components/PromptHost'
import { StatusDot, TerminalView, type ConnState } from './components/TerminalView'
import { IconButton, useToast, type IconType } from './ui'

type Page = 'hosts' | 'keys' | 'known' | 'ai' | 'activity' | 'settings'

interface Session {
  id: string
  kind: 'terminal' | 'files'
  host: HostSummary
  state: ConnState
}

const LIBRARY: { page: Page; label: string; icon: IconType; tile: string }[] = [
  { page: 'hosts', label: 'Hosts', icon: Server, tile: 'blue' },
  { page: 'keys', label: 'Keys', icon: KeyRound, tile: 'amber' },
  { page: 'known', label: 'Known Hosts', icon: ShieldCheck, tile: 'green' }
]

export function App() {
  const toast = useToast()
  const [vault, setVault] = useState<VaultState | null>(null)
  const [page, setPage] = useState<Page>('hosts')
  /** 'page' shows the library page, otherwise the id of the visible session */
  const [active, setActive] = useState<string>('page')
  const [sessions, setSessions] = useState<Session[]>([])
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [keys, setKeys] = useState<SshKeySummary[]>([])
  const [tunnels, setTunnels] = useState<ActiveForward[]>([])
  const [settings, setSettings] = useState<UiSettings | null>(null)
  const [selectedHost, setSelectedHost] = useState<string | null>(null)
  const [newHostSignal, setNewHostSignal] = useState(0)
  const [update, setUpdate] = useState<UpdateState | null>(null)

  const reloadHosts = useCallback(() => void api.hosts.list().then(setHosts, toast.error), [])
  const reloadKeys = useCallback(() => void api.keys.list().then(setKeys, toast.error), [])
  const reloadTunnels = useCallback(() => void api.fwd.list().then(setTunnels, () => undefined), [])

  useEffect(() => {
    void api.vault.state().then(setVault)
    void api.settings.get().then(setSettings)
    void api.update.state().then(setUpdate)
    const offs = [
      on('vault:changed', (s: VaultState) => setVault(s)),
      on('settings:changed', (s: UiSettings) => setSettings(s)),
      on('fwd:changed', reloadTunnels),
      on('update:changed', (s: UpdateState) => setUpdate(s))
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    if (vault === 'unlocked') {
      reloadHosts()
      reloadKeys()
      reloadTunnels()
    } else {
      setTunnels([])
    }
  }, [vault])

  const go = (p: Page): void => {
    setPage(p)
    setActive('page')
  }
  const open = (kind: Session['kind'], host: HostSummary): void => {
    const id = `${kind}-${host.id}-${Date.now()}`
    setSessions((s) => [...s, { id, kind, host, state: 'connecting' }])
    setActive(id)
  }
  const close = (id: string): void => {
    setSessions((list) => {
      const idx = list.findIndex((x) => x.id === id)
      const next = list.filter((x) => x.id !== id)
      setActive((cur) => (cur === id ? (next[Math.min(idx, next.length - 1)]?.id ?? 'page') : cur))
      return next
    })
  }
  const setSessionState = (id: string, state: ConnState): void =>
    setSessions((list) => list.map((x) => (x.id === id && x.state !== state ? { ...x, state } : x)))

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || vault !== 'unlocked') return
      const inTerminal = (e.target as HTMLElement | null)?.closest?.('.xterm') != null
      const key = e.key.toLowerCase()
      if (e.key === 'Tab' && sessions.length > 0) {
        e.preventDefault()
        const ids = sessions.map((s) => s.id)
        const i = ids.indexOf(active)
        setActive(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length])
      } else if (e.shiftKey && key === 'w' && active !== 'page') {
        e.preventDefault()
        close(active)
      } else if (e.shiftKey && key === 'l') {
        e.preventDefault()
        void api.vault.lock()
      } else if (!inTerminal && !e.shiftKey && key === 'n') {
        e.preventDefault()
        go('hosts')
        setNewHostSignal((n) => n + 1)
      } else if (!inTerminal && e.key === ',') {
        e.preventDefault()
        go('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessions, active, vault])

  if (vault === null || settings === null) return null
  if (vault !== 'unlocked') return <LockScreen state={vault} onDone={() => void api.vault.state().then(setVault)} />

  const navItem = (p: Page, label: string, Icon: IconType, tile: string, trail?: string) => (
    <button key={p} className={`side-item ${active === 'page' && page === p ? 'active' : ''}`} aria-current={active === 'page' && page === p ? 'page' : undefined} onClick={() => go(p)}>
      <span className={`tile ${tile}`}>
        <Icon size={13} strokeWidth={2.2} />
      </span>
      <span className="label">{label}</span>
      {trail && <span className="trail">{trail}</span>}
    </button>
  )

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head drag">
          <Logo size={22} />
          <span className="wordmark">Clavium</span>
          <IconButton icon={Lock} label="Lock Vault (Ctrl+Shift+L)" onClick={() => void api.vault.lock()} />
        </div>

        <nav className="sidebar-scroll" aria-label="Main">
          {(sessions.length > 0 || tunnels.length > 0) && (
            <>
              <div className="side-title">Open</div>
              {sessions.map((s) => (
                <div
                  key={s.id}
                  role="button"
                  tabIndex={0}
                  className={`side-item ${active === s.id ? 'active' : ''}`}
                  title={`${s.kind === 'terminal' ? 'Terminal' : 'Files'}: ${s.host.username}@${s.host.hostname}`}
                  onClick={() => setActive(s.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setActive(s.id)}
                  onAuxClick={(e) => e.button === 1 && close(s.id)}
                >
                  <span className="glyph">{s.kind === 'terminal' ? <SquareTerminal size={16} /> : <FolderOpen size={16} />}</span>
                  <span className="label">{s.host.name}</span>
                  <span className="trail hide-on-hover">
                    <StatusDot state={s.state} />
                  </span>
                  <button
                    className="close"
                    aria-label={`Close ${s.host.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      close(s.id)
                    }}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              {tunnels.map((t) => {
                const host = hosts.find((h) => h.id === t.hostId)
                return (
                  <div
                    key={`${t.hostId}:${t.forwardId}`}
                    role="button"
                    tabIndex={0}
                    className="side-item"
                    title={`Tunnel 127.0.0.1:${t.localPort} → ${t.remoteHost}:${t.remotePort}`}
                    onClick={() => {
                      setSelectedHost(t.hostId)
                      go('hosts')
                    }}
                  >
                    <span className="glyph">
                      <ArrowLeftRight size={15} />
                    </span>
                    <span className="label">
                      Port {t.localPort} · {host?.name ?? 'Tunnel'}
                    </span>
                    <span className="trail hide-on-hover">
                      <span className="status-dot on" />
                    </span>
                    <button
                      className="close"
                      aria-label={`Stop tunnel on port ${t.localPort}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void api.fwd.stop(t.hostId, t.forwardId)
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )
              })}
            </>
          )}

          <div className="side-title">Library</div>
          {LIBRARY.map((n) => navItem(n.page, n.label, n.icon, n.tile))}

          <div className="side-title">Automation</div>
          {navItem('ai', 'AI Access', Sparkles, 'teal', settings.mcpEnabled ? 'On' : 'Off')}
          {navItem('activity', 'Activity', History, 'gray')}
        </nav>

        <div className="sidebar-foot">
          {(update?.status === 'available' || update?.status === 'ready') && (
            <button className="side-item" onClick={() => go('settings')}>
              <span className="glyph" style={{ color: 'var(--accent)' }}>
                <ArrowDownCircle size={17} />
              </span>
              <span className="label">{update.status === 'ready' ? 'Update Ready' : 'Update Available'}</span>
              <span className="trail">{update.version}</span>
            </button>
          )}
          {navItem('settings', 'Settings', Settings, 'gray')}
        </div>
      </aside>

      <main className="main">
        <div className={`view ${active === 'page' ? '' : 'hidden'}`}>
          {page === 'hosts' && (
            <HostsPage
              hosts={hosts}
              keys={keys}
              mcpEnabled={settings.mcpEnabled}
              selectedId={selectedHost}
              onSelect={setSelectedHost}
              reload={reloadHosts}
              openTerminal={(h) => open('terminal', h)}
              openFiles={(h) => open('files', h)}
              newHostSignal={newHostSignal}
            />
          )}
          {page === 'keys' && <KeysPage keys={keys} reload={reloadKeys} />}
          {page === 'known' && <KnownHostsPage />}
          {page === 'ai' && <McpPage hosts={hosts} settings={settings} reloadHosts={reloadHosts} />}
          {page === 'activity' && <ActivityPage />}
          {page === 'settings' && <SettingsPage settings={settings} />}
        </div>
        {sessions.map((s) => (
          <div key={s.id} className={`view ${active === s.id ? '' : 'hidden'}`}>
            {s.kind === 'terminal' ? (
              <TerminalView
                host={s.host}
                active={active === s.id}
                fontSize={settings.terminalFontSize}
                onState={(st) => setSessionState(s.id, st)}
                onOpenFiles={() => open('files', s.host)}
                onClose={() => close(s.id)}
              />
            ) : (
              <FilesView host={s.host} onState={(st) => setSessionState(s.id, st)} onClose={() => close(s.id)} />
            )}
          </div>
        ))}
      </main>
      <PromptHost />
    </div>
  )
}
