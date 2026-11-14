import { useCallback, useEffect, useState } from 'react'
import type { HostSummary, SshKeySummary, VaultState } from '@shared/types'
import { api, on, type UiSettings } from './api'
import { FilesView } from './components/FilesView'
import { HostsPage } from './components/HostsPage'
import { LockScreen } from './components/LockScreen'
import { Logo } from './components/Logo'
import { McpPage } from './components/McpPage'
import { ActivityPage, ForwardsPage, KeysPage, KnownHostsPage, SettingsPage } from './components/Pages'
import { PromptHost } from './components/PromptHost'
import { TerminalView, type ConnState } from './components/TerminalView'
import { Icon, useToast } from './ui'

type Page = 'hosts' | 'keys' | 'known' | 'forwards' | 'mcp' | 'activity' | 'settings'

interface SessionTab {
  id: string
  kind: 'terminal' | 'files'
  host: HostSummary
  state: ConnState
}

const NAV: { page: Page; label: string; icon: string }[] = [
  { page: 'hosts', label: 'Hosts', icon: 'server' },
  { page: 'keys', label: 'Keychain', icon: 'key' },
  { page: 'known', label: 'Known hosts', icon: 'shield' },
  { page: 'forwards', label: 'Port forwarding', icon: 'forward' },
  { page: 'mcp', label: 'AI / MCP', icon: 'ai' },
  { page: 'activity', label: 'Activity', icon: 'list' },
  { page: 'settings', label: 'Settings', icon: 'gear' }
]

export function App() {
  const toast = useToast()
  const [vault, setVault] = useState<VaultState | null>(null)
  const [page, setPage] = useState<Page>('hosts')
  const [active, setActive] = useState<string>('home')
  const [tabs, setTabs] = useState<SessionTab[]>([])
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [keys, setKeys] = useState<SshKeySummary[]>([])
  const [settings, setSettings] = useState<UiSettings | null>(null)

  const reloadHosts = useCallback(() => void api.hosts.list().then(setHosts, toast.error), [])
  const reloadKeys = useCallback(() => void api.keys.list().then(setKeys, toast.error), [])

  useEffect(() => {
    void api.vault.state().then(setVault)
    void api.settings.get().then(setSettings)
    const offVault = on('vault:changed', (s: VaultState) => setVault(s))
    const offSettings = on('settings:changed', (s: UiSettings) => setSettings(s))
    return () => {
      offVault()
      offSettings()
    }
  }, [])

  useEffect(() => {
    if (vault === 'unlocked') {
      reloadHosts()
      reloadKeys()
    }
  }, [vault])

  const openTab = (kind: SessionTab['kind'], host: HostSummary): void => {
    const id = `${kind}-${host.id}-${Date.now()}`
    setTabs((t) => [...t, { id, kind, host, state: 'connecting' }])
    setActive(id)
  }
  const closeTab = (id: string): void => {
    setTabs((t) => {
      const idx = t.findIndex((x) => x.id === id)
      const next = t.filter((x) => x.id !== id)
      if (active === id) setActive(next[Math.max(0, idx - 1)]?.id ?? 'home')
      return next
    })
  }
  const setTabState = (id: string, state: ConnState): void =>
    setTabs((t) => t.map((x) => (x.id === id && x.state !== state ? { ...x, state } : x)))

  // Ctrl+Tab / Ctrl+W
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const ids = ['home', ...tabs.map((t) => t.id)]
        const i = ids.indexOf(active)
        setActive(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length])
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w' && active !== 'home') {
        e.preventDefault()
        closeTab(active)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabs, active])

  if (vault === null || settings === null) return null
  if (vault !== 'unlocked') {
    return <LockScreen state={vault} onDone={() => void api.vault.state().then(setVault)} />
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Logo size={28} /> Clavium
        </div>
        {NAV.map((n) => (
          <button
            key={n.page}
            className={`nav-item ${active === 'home' && page === n.page ? 'active' : ''}`}
            onClick={() => {
              setPage(n.page)
              setActive('home')
            }}
          >
            <Icon name={n.icon} /> {n.label}
            {n.page === 'mcp' && settings.mcpEnabled && <span className="badge ok">on</span>}
          </button>
        ))}
        <div className="spacer" />
        <button className="nav-item" onClick={() => void api.vault.lock()}>
          <Icon name="lock" /> Lock
        </button>
      </aside>

      <main className="main">
        <div className="tabbar">
          <div className={`tab ${active === 'home' ? 'active' : ''}`} onClick={() => setActive('home')}>
            <Icon name="server" size={14} /> <span className="title">{NAV.find((n) => n.page === page)?.label}</span>
          </div>
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tab ${active === t.id ? 'active' : ''}`}
              onClick={() => setActive(t.id)}
              onAuxClick={(e) => e.button === 1 && closeTab(t.id)}
              title={`${t.host.username}@${t.host.hostname}`}
            >
              <span className={`dot ${t.state === 'connected' ? 'on' : t.state === 'error' ? 'err' : ''}`} />
              <Icon name={t.kind === 'terminal' ? 'terminal' : 'folder'} size={14} />
              <span className="title">{t.host.name}</span>
              <button
                className="close"
                aria-label="Close tab"
                onClick={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <div className="views">
          <div className={`view ${active === 'home' ? '' : 'hidden'}`}>
            {page === 'hosts' && (
              <HostsPage
                hosts={hosts}
                keys={keys}
                reload={reloadHosts}
                openTerminal={(h) => openTab('terminal', h)}
                openFiles={(h) => openTab('files', h)}
              />
            )}
            {page === 'keys' && <KeysPage keys={keys} reload={reloadKeys} />}
            {page === 'known' && <KnownHostsPage />}
            {page === 'forwards' && <ForwardsPage hosts={hosts} />}
            {page === 'mcp' && <McpPage hosts={hosts} settings={settings} reloadHosts={reloadHosts} />}
            {page === 'activity' && <ActivityPage />}
            {page === 'settings' && <SettingsPage settings={settings} />}
          </div>
          {tabs.map((t) => (
            <div key={t.id} className={`view ${active === t.id ? '' : 'hidden'}`}>
              {t.kind === 'terminal' ? (
                <TerminalView
                  host={t.host}
                  active={active === t.id}
                  fontSize={settings.terminalFontSize}
                  onState={(s) => setTabState(t.id, s)}
                />
              ) : (
                <FilesView host={t.host} onState={(s) => setTabState(t.id, s)} />
              )}
            </div>
          ))}
        </div>
      </main>
      <PromptHost />
    </div>
  )
}
