import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDownCircle, ArrowLeftRight, Container, FolderOpen, History, KeyRound, Layers, Lock, Server, Settings, ShieldCheck, Sparkles, SquareTerminal, X } from 'lucide-react'
import type { ActiveForward, EditorFileInfo, EditorRequest, HostSummary, SshKeySummary, TerminalTarget, UpdateState, VaultState } from '@shared/types'
import { api, on, type UiSettings } from './api'
import { DockerView } from './components/DockerView'
import { FilesView } from './components/FilesView'
import { editorSessions } from './editor/registry'
import { HostsPage } from './components/HostsPage'
import { LockScreen } from './components/LockScreen'
import { Logo } from './components/Logo'
import { McpPage } from './components/McpPage'
import { ActivityPage, KeysPage, KnownHostsPage, SettingsPage } from './components/Pages'
import { PromptHost } from './components/PromptHost'
import { StatusDot, TerminalView, type ConnState } from './components/TerminalView'
import { IconButton, useConfirm, useToast, type IconType } from './ui'
import { keys as shortcutLabel, mod } from './platform'

type Page = 'hosts' | 'keys' | 'known' | 'ai' | 'activity' | 'settings'

interface Session {
  id: string
  kind: 'terminal' | 'files' | 'docker'
  host: HostSummary
  state: ConnState
  /** a terminal that shows something else than a login shell: a screen, a container log, a shell in a container */
  target?: { target: TerminalTarget; name: string }
  /** files with unsaved changes in this session's editor */
  unsaved: number
}

const LIBRARY: { page: Page; label: string; icon: IconType; tile: string }[] = [
  { page: 'hosts', label: 'Hosts', icon: Server, tile: 'blue' },
  { page: 'keys', label: 'Keys', icon: KeyRound, tile: 'amber' },
  { page: 'known', label: 'Known Hosts', icon: ShieldCheck, tile: 'green' }
]

export function App() {
  const toast = useToast()
  const confirm = useConfirm()
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
  const open = (kind: Session['kind'], host: HostSummary, show = true, target?: Session['target']): void => {
    const id = `${kind}-${host.id}-${Date.now()}`
    setSessions((s) => [...s, { id, kind, host, state: 'connecting', unsaved: 0, target }])
    if (show) setActive(id)
  }

  // Requests from AI clients (via the MCP server) about the files open in the editor.
  const hostsRef = useRef(hosts)
  hostsRef.current = hosts
  const openRef = useRef(open)
  openRef.current = open
  useEffect(() => {
    const handle = async (r: EditorRequest): Promise<unknown> => {
      if (r.op === 'list') {
        return editorSessions().flatMap((s): EditorFileInfo[] => s.list().map((d) => ({ hostId: s.hostId, path: d.path, name: d.name, unsaved: d.unsaved })))
      }
      if (r.op === 'open') {
        if (editorSessions(r.hostId).length === 0) {
          const host = hostsRef.current.find((h) => h.id === r.hostId)
          if (!host) throw new Error('Host not found.')
          openRef.current('files', host, false) // a new file session in the sidebar, without taking over the window
          for (let i = 0; i < 50 && editorSessions(r.hostId).length === 0; i++) await new Promise((res) => setTimeout(res, 100))
        }
        const session = editorSessions(r.hostId)[0]
        if (!session) throw new Error('Could not open a file session for this host.')
        return session.open(r.path)
      }
      const session = editorSessions(r.hostId).find((s) => s.list().some((d) => d.path === r.path))
      if (!session) throw new Error('This file is not open in the editor. Call editor_open_file first.')
      return r.op === 'read' ? session.read(r.path) : session.edit(r.path, r.edit)
    }
    return on('editor:request', (id: string, request: EditorRequest) => {
      handle(request).then(
        (result) => void api.editor.respond(id, true, result ?? null),
        (e: Error) => void api.editor.respond(id, false, e.message)
      )
    })
  }, [])
  const close = async (id: string): Promise<void> => {
    const s = sessions.find((x) => x.id === id)
    if (s && s.unsaved > 0) {
      const ok = await confirm({
        title: s.unsaved === 1 ? 'Close and Discard Your Changes?' : `Close and Discard Changes to ${s.unsaved} Files?`,
        message: `The editor for “${s.host.name}” has unsaved changes. They are lost if you close this session.`,
        confirmLabel: 'Discard and Close',
        destructive: true
      })
      if (!ok) return
    }
    setSessions((list) => {
      const idx = list.findIndex((x) => x.id === id)
      const next = list.filter((x) => x.id !== id)
      setActive((cur) => (cur === id ? (next[Math.min(idx, next.length - 1)]?.id ?? 'page') : cur))
      return next
    })
  }
  const setUnsaved = (id: string, unsaved: number): void =>
    setSessions((list) => list.map((x) => (x.id === id && x.unsaved !== unsaved ? { ...x, unsaved } : x)))
  const setSessionState = (id: string, state: ConnState): void =>
    setSessions((list) => list.map((x) => (x.id === id && x.state !== state ? { ...x, state } : x)))

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl+Tab switches tabs on both systems; on macOS Cmd+Tab belongs to the system.
      const tab = e.ctrlKey && e.key === 'Tab'
      if ((!mod(e) && !tab) || vault !== 'unlocked') return
      const inTerminal = (e.target as HTMLElement | null)?.closest?.('.xterm, .editor, .find-bar') != null
      const key = e.key.toLowerCase()
      if (tab) {
        if (sessions.length === 0) return
        e.preventDefault()
        const ids = sessions.map((s) => s.id)
        const i = ids.indexOf(active)
        setActive(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length])
      } else if (e.shiftKey && key === 'w' && active !== 'page') {
        e.preventDefault()
        void close(active)
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
  // Locking normally clears the whole interface. If an editor still holds unsaved text, the
  // interface stays alive underneath the lock screen so the text can be saved after unlocking.
  const locked = vault !== 'unlocked'
  const lockScreen = <LockScreen state={vault} onDone={() => void api.vault.state().then(setVault)} />
  if (locked && !sessions.some((s) => s.unsaved > 0)) return lockScreen

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
    <>
    {locked && <div className="lock-cover">{lockScreen}</div>}
    <div className="app" inert={locked}>
      <aside className="sidebar">
        <div className="sidebar-head drag">
          <Logo size={22} />
          <span className="wordmark">Clavium</span>
          <IconButton icon={Lock} label={`Lock Vault (${shortcutLabel('Ctrl+Shift+L')})`} onClick={() => void api.vault.lock()} />
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
                  title={`${s.target ? s.target.name : s.kind === 'terminal' ? 'Terminal' : s.kind === 'docker' ? 'Docker' : 'Files'}: ${s.host.username}@${s.host.hostname}`}
                  onClick={() => setActive(s.id)}
                  onKeyDown={(e) => e.key === 'Enter' && setActive(s.id)}
                  onAuxClick={(e) => e.button === 1 && void close(s.id)}
                >
                  <span className="glyph">
                    {s.kind === 'docker' ? (
                      <Container size={16} />
                    ) : s.target && ('attach' in s.target.target || 'create' in s.target.target) ? (
                      <Layers size={16} />
                    ) : s.kind === 'terminal' ? (
                      <SquareTerminal size={16} />
                    ) : (
                      <FolderOpen size={16} />
                    )}
                  </span>
                  <span className="label">{s.target ? `${s.target.name} · ${s.host.name}` : s.host.name}</span>
                  <span className="trail hide-on-hover">
                    <StatusDot state={s.state} />
                  </span>
                  <button
                    className="close"
                    aria-label={`Close ${s.host.name}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      void close(s.id)
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
                target={s.target}
                onOpenFiles={() => open('files', s.host)}
                onOpenScreen={(screen) => open('terminal', s.host, true, screen)}
                onOpenDocker={() => open('docker', s.host)}
                onClose={() => void close(s.id)}
              />
            ) : s.kind === 'docker' ? (
              <DockerView
                host={s.host}
                active={active === s.id}
                onState={(st) => setSessionState(s.id, st)}
                onOpenTerminal={(tab) => open('terminal', s.host, true, tab)}
                onClose={() => void close(s.id)}
              />
            ) : (
              <FilesView host={s.host} onState={(st) => setSessionState(s.id, st)} onClose={() => void close(s.id)} onUnsaved={(n) => setUnsaved(s.id, n)} />
            )}
          </div>
        ))}
      </main>
      <PromptHost />
    </div>
    </>
  )
}
