import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { ArrowDownCircle, ArrowLeftRight, Columns2, Container, ExternalLink, FolderOpen, History, Keyboard, KeyRound, Layers, Lock, PanelsTopLeft, Rows2, Save, Server, Settings, ShieldCheck, Sparkles, SquareTerminal, X } from 'lucide-react'
import type { ActiveForward, EditorFileInfo, EditorRequest, HostSummary, PaneKind, SavedWorkspace, SessionSnapshot, SshKeySummary, TerminalTarget, UpdateState, VaultState, WorkspaceTab } from '@shared/types'
import { MAX_PANES, dividers, dropTarget, filterLayout, insertBeside, mapLayout, neighbor, paneRects, panes, removePane, setRatio, splitPane, type Divider, type Layout, type Rect, type SplitDir } from '@shared/layout'
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
import { TransferHost } from './components/Transfers'
import { StatusDot, TerminalView, type ConnState } from './components/TerminalView'
import { HostPickerSheet, WorkspaceNameSheet, WorkspacesPage } from './components/Workspaces'
import { IconButton, PaneContext, useConfirm, useMenu, useToast, type IconType, type MenuItem } from './ui'
import { keys as shortcutLabel, mod } from './platform'

type Page = 'hosts' | 'workspaces' | 'keys' | 'known' | 'ai' | 'activity' | 'settings'

interface Session {
  id: string
  kind: 'terminal' | 'files' | 'docker'
  host: HostSummary
  state: ConnState
  /** a terminal that shows something else than a login shell: a screen, a container log, a shell in a container */
  target?: { target: TerminalTarget; name: string }
  /** files with unsaved changes in this session's editor */
  unsaved: number
  /** a terminal: the folder its shell is in, as far as known */
  cwd?: string
}

/** An entry under "Open": one connection, or several side by side. */
interface Tab {
  id: string
  /** set when the tab was saved as a workspace or opened from one */
  name?: string
  workspaceId?: string
  layout: Layout<string>
  /** the session that has the keyboard */
  focus: string
  /** focus mode: only the focused pane is shown */
  zoomed: boolean
  /** what is typed into one terminal of the tab goes to all of them; never saved */
  broadcast?: boolean
}

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
/** what a tab that is dragged out of the sidebar carries */
const TAB_DRAG = 'application/x-clavium-tab'
const pct = (n: number): string => `${(n * 100).toFixed(4)}%`
let nextId = 0

function kindLabel(s: Pick<Session, 'kind' | 'target'>): string {
  return s.target ? s.target.name : s.kind === 'terminal' ? 'Terminal' : s.kind === 'docker' ? 'Docker' : 'Files'
}

function worstState(states: ConnState[]): ConnState {
  return states.includes('error') ? 'error' : states.includes('closed') ? 'closed' : states.includes('connecting') ? 'connecting' : 'connected'
}

const LIBRARY: { page: Page; label: string; icon: IconType; tile: string }[] = [
  { page: 'hosts', label: 'Hosts', icon: Server, tile: 'blue' },
  { page: 'workspaces', label: 'Workspaces', icon: PanelsTopLeft, tile: 'teal' },
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
  const [tabs, setTabs] = useState<Tab[]>([])
  const menu = useMenu()
  const mainRef = useRef<HTMLElement>(null)
  /** a host is chosen for a new pane next to this session */
  const [picking, setPicking] = useState<{ beside: string; dir: SplitDir } | null>(null)
  /** a tab is being dragged out of the sidebar; `at`: where it would land in the visible tab */
  const [dragTab, setDragTab] = useState<{ id: string; at: { pane: string; dir: SplitDir; rect: Rect } | null } | null>(null)
  /** the tab that is being saved under a name */
  const [naming, setNaming] = useState<string | null>(null)
  const [workspaceSignal, setWorkspaceSignal] = useState(0)
  /** the tabs of the last session were looked at; only then the current ones are written */
  const [restored, setRestored] = useState(false)
  const [hostsLoaded, setHostsLoaded] = useState(false)
  const [hosts, setHosts] = useState<HostSummary[]>([])
  const [keys, setKeys] = useState<SshKeySummary[]>([])
  const [tunnels, setTunnels] = useState<ActiveForward[]>([])
  const [settings, setSettings] = useState<UiSettings | null>(null)
  const [selectedHost, setSelectedHost] = useState<string | null>(null)
  const [newHostSignal, setNewHostSignal] = useState(0)
  const [update, setUpdate] = useState<UpdateState | null>(null)

  const reloadHosts = useCallback(
    () =>
      void api.hosts.list().then((list) => {
        setHosts(list)
        setHostsLoaded(true)
      }, toast.error),
    []
  )
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

  const hostsRef = useRef(hosts)
  hostsRef.current = hosts
  const go = (p: Page): void => {
    setPage(p)
    setActive('page')
  }
  /** Open a connection in a tab of its own, or next to the session `beside`. */
  const open = (kind: Session['kind'], host: HostSummary, show = true, target?: Session['target'], beside?: { session: string; dir: SplitDir }): void => {
    const id = `${kind}-${host.id}-${Date.now()}-${nextId++}`
    if (beside) {
      const tab = tabs.find((t) => panes(t.layout).includes(beside.session))
      if (!tab) return
      if (panes(tab.layout).length >= MAX_PANES) {
        toast.error(new Error(`A tab holds up to ${MAX_PANES} connections.`))
        return
      }
      setSessions((s) => [...s, { id, kind, host, state: 'connecting', unsaved: 0, target }])
      setTabs((list) => list.map((t) => (t.id === tab.id ? { ...t, layout: splitPane(t.layout, beside.session, beside.dir, id), focus: id, zoomed: false } : t)))
      return
    }
    setSessions((s) => [...s, { id, kind, host, state: 'connecting', unsaved: 0, target }])
    setTabs((list) => [...list, { id: `tab-${id}`, layout: { pane: id }, focus: id, zoomed: false }])
    if (show) setActive(`tab-${id}`)
  }

  /** Turn a stored tab into sessions. Panes whose host is gone are left out. */
  const build = (saved: WorkspaceTab): { tab: Tab; sessions: Session[] } | null => {
    const made: (Session | null)[] = saved.panes.map((p) => {
      const host = hostsRef.current.find((h) => h.id === p.hostId)
      if (!host || (p.kind !== 'files' && host.protocol !== 'ssh')) return null
      return { id: `${p.kind}-${host.id}-${Date.now()}-${nextId++}`, kind: p.kind, host, state: 'connecting', unsaved: 0, target: p.target, cwd: p.kind === 'terminal' && !p.target ? p.cwd : undefined }
    })
    const layout = filterLayout(
      mapLayout(saved.layout, (i) => made[i]?.id ?? ''),
      (id) => id !== ''
    )
    const list = made.filter((m): m is Session => m !== null)
    if (!layout || list.length === 0) return null
    const focus = made[saved.focus]?.id ?? list[0].id
    return { tab: { id: `tab-${list[0].id}`, name: saved.name, workspaceId: saved.workspaceId, layout, focus, zoomed: saved.zoomed && list.length > 1 }, sessions: list }
  }
  const openWorkspace = (w: SavedWorkspace): void => {
    const already = tabs.find((t) => t.workspaceId === w.id)
    if (already) return setActive(already.id)
    const built = build({ ...w, workspaceId: w.id })
    if (!built) return toast.error(new Error('None of the hosts of this workspace exists any more.'))
    if (built.sessions.length < w.panes.length) toast.error(new Error('Some hosts of this workspace no longer exist. The rest was opened.'))
    setSessions((s) => [...s, ...built.sessions])
    setTabs((list) => [...list, built.tab])
    setActive(built.tab.id)
  }
  /** A tab the way it is stored: hosts by id, panes by position. */
  const describe = (tab: Tab): WorkspaceTab | null => {
    const ids = panes(tab.layout)
    const list = ids.map((id) => sessions.find((s) => s.id === id))
    if (list.some((s) => !s)) return null
    return {
      name: tab.name,
      workspaceId: tab.workspaceId,
      panes: (list as Session[]).map((s) => ({ hostId: s.host.id, kind: s.kind, ...(s.target ? { target: s.target } : {}), ...(s.kind === 'terminal' && !s.target && s.cwd ? { cwd: s.cwd } : {}) })),
      layout: mapLayout(tab.layout, (id) => ids.indexOf(id)),
      focus: Math.max(0, ids.indexOf(tab.focus)),
      zoomed: tab.zoomed
    }
  }

  // Requests from AI clients (via the MCP server) about the files open in the editor.
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
  const confirmDiscard = (list: Session[]): Promise<boolean> => {
    const unsaved = list.reduce((n, x) => n + x.unsaved, 0)
    if (unsaved === 0) return Promise.resolve(true)
    const names = [...new Set(list.filter((x) => x.unsaved > 0).map((x) => x.host.name))].join(', ')
    return confirm({
      title: unsaved === 1 ? 'Close and Discard Your Changes?' : `Close and Discard Changes to ${unsaved} Files?`,
      message: `The editor for “${names}” has unsaved changes. They are lost if you close this session.`,
      confirmLabel: 'Discard and Close',
      destructive: true
    })
  }
  const dropTab = (list: Tab[], tabId: string): Tab[] => {
    const idx = list.findIndex((t) => t.id === tabId)
    const next = list.filter((t) => t.id !== tabId)
    setActive((cur) => (cur === tabId ? (next[Math.min(idx, next.length - 1)]?.id ?? 'page') : cur))
    return next
  }
  /** Close one connection. A tab whose last connection is closed goes away. */
  const close = async (id: string): Promise<void> => {
    const s = sessions.find((x) => x.id === id)
    if (s && !(await confirmDiscard([s]))) return
    setSessions((list) => list.filter((x) => x.id !== id))
    setTabs((list) => {
      const tab = list.find((t) => panes(t.layout).includes(id))
      if (!tab) return list
      const layout = removePane(tab.layout, id)
      if (!layout) return dropTab(list, tab.id)
      const rest = panes(layout)
      return list.map((t) => (t.id === tab.id ? { ...t, layout, focus: rest.includes(t.focus) ? t.focus : rest[0], zoomed: t.zoomed && rest.length > 1 } : t))
    })
  }
  const closeTab = async (tabId: string): Promise<void> => {
    const tab = tabs.find((t) => t.id === tabId)
    if (!tab) return
    const ids = panes(tab.layout)
    if (!(await confirmDiscard(sessions.filter((x) => ids.includes(x.id))))) return
    setSessions((list) => list.filter((x) => !ids.includes(x.id)))
    setTabs((list) => dropTab(list, tabId))
  }
  const patchTab = (tabId: string, patch: Partial<Tab> | ((t: Tab) => Partial<Tab>)): void =>
    setTabs((list) => list.map((t) => (t.id === tabId ? { ...t, ...(typeof patch === 'function' ? patch(t) : patch) } : t)))
  const focusPane = (tabId: string, sessionId: string): void => patchTab(tabId, (t) => (t.focus === sessionId ? {} : { focus: sessionId }))
  const toggleZoom = (tabId: string): void => patchTab(tabId, (t) => ({ zoomed: !t.zoomed && panes(t.layout).length > 1 }))
  /** Give the keyboard to a pane: to its terminal, or else to its first control. */
  const focusInto = (sessionId: string, afterRender = false): void => {
    const run = (): void => {
      const pane = mainRef.current?.querySelector<HTMLElement>(`[data-pane="${CSS.escape(sessionId)}"]`)
      ;(pane?.querySelector<HTMLElement>('.xterm-helper-textarea') ?? pane?.querySelector<HTMLElement>('button, [tabindex]'))?.focus()
    }
    // At once where the pane is on screen, so that the very next key already goes there.
    if (afterRender) requestAnimationFrame(run)
    else run()
  }
  /** Take a pane out of its tab and give it a tab of its own. */
  const detach = (tabId: string, sessionId: string): void => {
    setTabs((list) => {
      const tab = list.find((t) => t.id === tabId)
      const layout = tab && removePane(tab.layout, sessionId)
      if (!tab || !layout) return list
      const rest = panes(layout)
      const own: Tab = { id: `tab-${sessionId}-${nextId++}`, layout: { pane: sessionId }, focus: sessionId, zoomed: false }
      setActive(own.id)
      return [...list.map((t) => (t.id === tabId ? { ...t, layout, focus: rest[0], zoomed: t.zoomed && rest.length > 1 } : t)), own]
    })
  }
  const sessionsOf = (t: Tab): Session[] =>
    panes(t.layout)
      .map((id) => sessions.find((x) => x.id === id))
      .filter((x): x is Session => !!x)
  /** What a tab is called in the sidebar. */
  const tabLabel = (t: Tab): string => {
    const list = sessionsOf(t)
    const first = list[0]
    if (t.name || !first) return t.name ?? ''
    if (list.length > 1) return [...new Set(list.map((x) => x.host.name))].join(' + ')
    return first.target ? `${first.target.name} · ${first.host.name}` : first.host.name
  }
  /** Move all connections of one tab into another, next to one of its panes. Nothing is connected again. */
  const mergeTabs = (fromId: string, intoId: string, beside: string, dir: SplitDir): void => {
    const from = tabs.find((t) => t.id === fromId)
    const into = tabs.find((t) => t.id === intoId)
    if (!from || !into || from === into || !panes(into.layout).includes(beside)) return
    if (panes(from.layout).length + panes(into.layout).length > MAX_PANES) {
      toast.error(new Error(`A tab holds up to ${MAX_PANES} connections.`))
      return
    }
    setTabs((list) => list.filter((t) => t.id !== fromId).map((t) => (t.id === intoId ? { ...t, layout: insertBeside(t.layout, beside, dir, from.layout), focus: from.focus, zoomed: false } : t)))
    setActive(intoId)
    focusInto(from.focus, true)
  }
  const saveWorkspace = async (tabId: string, name: string, asNew: boolean): Promise<void> => {
    const tab = tabs.find((t) => t.id === tabId)
    const described = tab && describe(tab)
    if (!tab || !described) return
    const saved = await api.workspaces.save(name, { ...described, name, workspaceId: undefined }, asNew ? undefined : tab.workspaceId)
    patchTab(tabId, { name: saved.name, workspaceId: saved.id })
    setWorkspaceSignal((n) => n + 1)
    toast.ok(`Saved the workspace “${saved.name}”`)
  }
  const openPaneMenu = (e: ReactMouseEvent<HTMLElement>, tab: Tab, s: Session): void => {
    const ssh = s.host.protocol === 'ssh'
    const full = panes(tab.layout).length >= MAX_PANES
    const beside = (dir: SplitDir) => ({ session: s.id, dir })
    const items: MenuItem[] = []
    if (ssh) {
      items.push({ label: 'Terminal to the Right', icon: Columns2, hint: shortcutLabel('Ctrl+Shift+D'), disabled: full, onSelect: () => open('terminal', s.host, true, undefined, beside('row')) })
      items.push({ label: 'Terminal Below', icon: Rows2, hint: shortcutLabel('Ctrl+Shift+E'), disabled: full, onSelect: () => open('terminal', s.host, true, undefined, beside('col')) })
    }
    items.push({ label: 'Files to the Right', icon: FolderOpen, disabled: full, onSelect: () => open('files', s.host, true, undefined, beside('row')) })
    items.push({ label: 'Files Below', icon: FolderOpen, disabled: full, onSelect: () => open('files', s.host, true, undefined, beside('col')) })
    items.push('separator')
    items.push({ label: 'Another Host to the Right…', icon: Server, disabled: full, onSelect: () => setPicking({ beside: s.id, dir: 'row' }) })
    items.push({ label: 'Another Host Below…', icon: Server, disabled: full, onSelect: () => setPicking({ beside: s.id, dir: 'col' }) })
    // the same as dragging a tab out of the sidebar onto this pane, for the keyboard
    const others = tabs.filter((t) => t.id !== tab.id).slice(0, 6)
    if (others.length) items.push('separator')
    for (const other of others) {
      items.push({ label: `Move “${tabLabel(other)}” Here`, icon: PanelsTopLeft, disabled: panes(other.layout).length + panes(tab.layout).length > MAX_PANES, onSelect: () => mergeTabs(other.id, tab.id, s.id, 'row') })
    }
    if (panes(tab.layout).length > 1) {
      items.push('separator')
      items.push({ label: 'Move to a Tab of Its Own', icon: ExternalLink, onSelect: () => detach(tab.id, s.id) })
    }
    const terminals = panes(tab.layout).filter((id) => sessions.find((x) => x.id === id)?.kind === 'terminal').length
    if (terminals > 1) {
      items.push('separator')
      items.push({
        label: tab.broadcast ? 'Stop Typing into All Terminals' : `Type into All ${terminals} Terminals of This Tab`,
        icon: Keyboard,
        onSelect: () => patchTab(tab.id, (t) => ({ broadcast: !t.broadcast }))
      })
    }
    items.push('separator')
    if (tab.workspaceId) {
      items.push({ label: `Save Changes to “${tab.name}”`, icon: Save, onSelect: () => void saveWorkspace(tab.id, tab.name ?? 'Workspace', false).catch(toast.error) })
      items.push({ label: 'Save as a New Workspace…', icon: Save, onSelect: () => setNaming(tab.id) })
    } else {
      items.push({ label: 'Save Workspace…', icon: Save, onSelect: () => setNaming(tab.id) })
    }
    menu.openBelow(e, items)
  }

  // Open the tabs of the last session again, once, after the first unlock.
  useEffect(() => {
    if (vault !== 'unlocked' || !settings || !hostsLoaded || restored) return
    let cancelled = false
    const finish = (): void => {
      if (!cancelled) setRestored(true)
    }
    if (!settings.restoreSession || sessions.length > 0) return finish()
    api.session
      .get()
      .then((snapshot) => {
        if (cancelled || !snapshot) return
        const built = snapshot.tabs.map(build)
        const ok = built.filter((b): b is NonNullable<typeof b> => b !== null)
        if (ok.length === 0) return
        setSessions((s) => [...s, ...ok.flatMap((b) => b.sessions)])
        setTabs((list) => [...list, ...ok.map((b) => b.tab)])
        const wanted = snapshot.active >= 0 ? built[snapshot.active] : null
        if (wanted) setActive(wanted.tab.id)
      })
      .catch(() => undefined)
      .finally(finish)
    return () => {
      cancelled = true
    }
  }, [vault, settings?.restoreSession, hostsLoaded, restored])

  // Remember the open tabs, so that the next start can bring them back.
  const lastSnapshot = useRef('')
  const snapshot = useMemo((): SessionSnapshot => {
    if (!settings?.restoreSession) return { tabs: [], active: -1 }
    const kept = tabs.map((t) => ({ id: t.id, saved: describe(t) })).filter((x): x is { id: string; saved: WorkspaceTab } => x.saved !== null)
    return { tabs: kept.map((x) => x.saved), active: kept.findIndex((x) => x.id === active) }
  }, [tabs, sessions.map((s) => `${s.id}\n${s.cwd ?? ''}`).join('\n'), active, settings?.restoreSession])
  useEffect(() => {
    if (vault !== 'unlocked' || !restored) return
    const text = JSON.stringify(snapshot)
    if (text === lastSnapshot.current) return
    const timer = setTimeout(() => {
      lastSnapshot.current = text
      void api.session.set(snapshot).catch(() => undefined)
    }, 600)
    return () => clearTimeout(timer)
  }, [snapshot, vault, restored])

  const setUnsaved = (id: string, unsaved: number): void =>
    setSessions((list) => list.map((x) => (x.id === id && x.unsaved !== unsaved ? { ...x, unsaved } : x)))
  const setCwd = (id: string, cwd: string): void => setSessions((list) => list.map((x) => (x.id === id && x.cwd !== cwd ? { ...x, cwd } : x)))
  const setSessionState = (id: string, state: ConnState): void =>
    setSessions((list) => list.map((x) => (x.id === id && x.state !== state ? { ...x, state } : x)))

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl+Tab switches tabs on both systems; on macOS Cmd+Tab belongs to the system.
      const tab = e.ctrlKey && e.key === 'Tab'
      if ((!mod(e) && !tab) || vault !== 'unlocked') return
      const inTerminal = (e.target as HTMLElement | null)?.closest?.('.xterm, .editor, .find-bar') != null
      // the text editor has its own meaning for some of these keys
      const inEditor = (e.target as HTMLElement | null)?.closest?.('.editor, .find-bar') != null
      const key = e.key.toLowerCase()
      const tabNow = tabs.find((t) => t.id === active)
      const focused = tabNow && sessions.find((x) => x.id === tabNow.focus)
      if (tab) {
        if (tabs.length === 0) return
        e.preventDefault()
        const ids = tabs.map((t) => t.id)
        const i = ids.indexOf(active)
        setActive(ids[(i + (e.shiftKey ? -1 : 1) + ids.length) % ids.length])
      } else if (e.shiftKey && key === 'w' && tabNow) {
        e.preventDefault()
        void close(tabNow.focus)
      } else if (e.shiftKey && (key === 'd' || key === 'e') && tabNow && focused) {
        // split: the same host again, as a terminal where the server has one
        e.preventDefault()
        open(focused.host.protocol === 'ssh' ? 'terminal' : 'files', focused.host, true, undefined, { session: focused.id, dir: key === 'd' ? 'row' : 'col' })
      } else if (e.shiftKey && e.key === 'Enter' && tabNow && !inEditor) {
        // the terminal would otherwise take the key as a line break
        e.preventDefault()
        e.stopPropagation()
        toggleZoom(tabNow.id)
        focusInto(tabNow.focus, true)
      } else if (e.altKey && e.key.startsWith('Arrow') && tabNow && !tabNow.zoomed && !inEditor) {
        const next = neighbor(tabNow.layout, tabNow.focus, e.key.slice(5).toLowerCase() as 'left' | 'right' | 'up' | 'down')
        if (!next) return
        e.preventDefault()
        e.stopPropagation()
        focusPane(tabNow.id, next)
        focusInto(next)
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
    // Before the terminal sees the key: it stops keys it understands from travelling further.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [sessions, tabs, active, vault])

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
          {(tabs.length > 0 || tunnels.length > 0) && (
            <>
              <div className="side-title">Open</div>
              {tabs.map((t) => {
                const list = sessionsOf(t)
                const first = list[0]
                if (!first) return null
                const several = list.length > 1
                const label = tabLabel(t)
                return (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    className={`side-item ${active === t.id ? 'active' : ''} ${dragTab && dragTab.id !== t.id ? 'drop-ready' : ''}`}
                    aria-current={active === t.id ? 'page' : undefined}
                    title={list.map((x) => `${kindLabel(x)}: ${x.host.username}@${x.host.hostname}`).join('\n') + (tabs.length > 1 ? '\nDrag onto another tab to show both side by side' : '')}
                    draggable={tabs.length > 1}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(TAB_DRAG, t.id)
                      e.dataTransfer.effectAllowed = 'move'
                      setDragTab({ id: t.id, at: null })
                    }}
                    onDragEnd={() => setDragTab(null)}
                    // another tab dropped on this one joins it, to the right of the pane that has the keyboard
                    onDragOver={(e) => {
                      if (!dragTab || dragTab.id === t.id) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                      if (!dragTab || dragTab.id === t.id) return
                      e.preventDefault()
                      mergeTabs(dragTab.id, t.id, t.focus, 'row')
                      setDragTab(null)
                    }}
                    onClick={() => setActive(t.id)}
                    onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && setActive(t.id)}
                    onAuxClick={(e) => e.button === 1 && void closeTab(t.id)}
                  >
                    <span className="glyph">
                      {several ? (
                        <Columns2 size={16} />
                      ) : first.kind === 'docker' ? (
                        <Container size={16} />
                      ) : first.target && ('attach' in first.target.target || 'create' in first.target.target) ? (
                        <Layers size={16} />
                      ) : first.kind === 'terminal' ? (
                        <SquareTerminal size={16} />
                      ) : (
                        <FolderOpen size={16} />
                      )}
                    </span>
                    <span className="label">{label}</span>
                    <span className="trail hide-on-hover">
                      {several && <span className="pane-count">{list.length}</span>}
                      <StatusDot state={worstState(list.map((x) => x.state))} />
                    </span>
                    <button
                      className="close"
                      aria-label={`Close ${label}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        void closeTab(t.id)
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                )
              })}
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

      <main className="main" ref={mainRef}>
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
          {page === 'workspaces' && <WorkspacesPage hosts={hosts} signal={workspaceSignal} open={openWorkspace} changed={() => setWorkspaceSignal((n) => n + 1)} />}
          {page === 'keys' && <KeysPage keys={keys} reload={reloadKeys} />}
          {page === 'known' && <KnownHostsPage />}
          {page === 'ai' && <McpPage hosts={hosts} settings={settings} reloadHosts={reloadHosts} />}
          {page === 'activity' && <ActivityPage />}
          {page === 'settings' && <SettingsPage settings={settings} />}
        </div>
        {sessions.map((s) => {
          const tab = tabs.find((t) => panes(t.layout).includes(s.id))
          if (!tab) return null
          const several = panes(tab.layout).length > 1
          const split = several && !tab.zoomed
          const rect = split ? (paneRects(tab.layout).find((r) => r.pane === s.id)?.rect ?? FULL) : FULL
          const shown = active === tab.id && (!tab.zoomed || tab.focus === s.id)
          const focused = active === tab.id && tab.focus === s.id
          // only the pane in the top right corner has to keep clear of the window buttons
          const corner = rect.y < 0.001 && rect.x + rect.w > 0.999
          // the other terminals of the tab, while what is typed goes to all of them
          const others = tab.broadcast && s.kind === 'terminal' ? panes(tab.layout).filter((id) => id !== s.id && sessions.find((x) => x.id === id)?.kind === 'terminal') : []
          return (
            <div
              key={s.id}
              data-pane={s.id}
              className={`view pane ${shown ? '' : 'hidden'} ${split ? 'split' : ''} ${split && focused ? 'focused' : ''} ${corner ? '' : 'inner'} ${split && rect.w < 0.6 ? 'narrow' : ''}`}
              style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h), right: 'auto', bottom: 'auto' }}
              role={several ? 'group' : undefined}
              aria-label={several ? `${kindLabel(s)} on ${s.host.name}` : undefined}
              onPointerDownCapture={() => focusPane(tab.id, s.id)}
              onFocusCapture={() => focusPane(tab.id, s.id)}
            >
              <PaneContext.Provider value={{ split: several, zoomed: tab.zoomed, toggleZoom: () => toggleZoom(tab.id), openMenu: (e) => openPaneMenu(e, tab, s) }}>
                {s.kind === 'terminal' ? (
                  <TerminalView
                    host={s.host}
                    active={focused}
                    fontSize={settings.terminalFontSize}
                    autocomplete={settings.terminalAutocomplete}
                    onState={(st) => setSessionState(s.id, st)}
                    target={s.target}
                    startDir={s.cwd}
                    paneId={s.id}
                    mirror={others}
                    onStopMirror={() => patchTab(tab.id, { broadcast: false })}
                    onPlain={() => setSessions((list) => list.map((x) => (x.id === s.id ? { ...x, target: undefined } : x)))}
                    onCwd={(cwd) => setCwd(s.id, cwd)}
                    onOpenFiles={() => open('files', s.host)}
                    onOpenScreen={(screen) => open('terminal', s.host, true, screen)}
                    onOpenDocker={() => open('docker', s.host)}
                    onClose={() => void close(s.id)}
                  />
                ) : s.kind === 'docker' ? (
                  <DockerView
                    host={s.host}
                    active={focused}
                    onState={(st) => setSessionState(s.id, st)}
                    onOpenTerminal={(t) => open('terminal', s.host, true, t)}
                    onClose={() => void close(s.id)}
                  />
                ) : (
                  <FilesView host={s.host} onState={(st) => setSessionState(s.id, st)} onClose={() => void close(s.id)} onUnsaved={(n) => setUnsaved(s.id, n)} />
                )}
              </PaneContext.Provider>
            </div>
          )
        })}
        {/* While a tab is dragged, the visible tab takes it: the marked half shows where it lands. */}
        {dragTab &&
          tabs
            .filter((t) => t.id === active && t.id !== dragTab.id && !t.zoomed)
            .map((t) => {
              const at = (e: React.DragEvent): { pane: string; dir: SplitDir; rect: Rect } | null => {
                const box = e.currentTarget.getBoundingClientRect()
                return dropTarget(t.layout, (e.clientX - box.left) / box.width, (e.clientY - box.top) / box.height)
              }
              return (
                <div
                  key="tab-drop"
                  className="tab-drop"
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    const next = at(e)
                    if (next?.pane !== dragTab.at?.pane || next?.dir !== dragTab.at?.dir) setDragTab({ id: dragTab.id, at: next })
                  }}
                  onDragLeave={() => dragTab.at && setDragTab({ id: dragTab.id, at: null })}
                  onDrop={(e) => {
                    e.preventDefault()
                    const target = at(e)
                    if (target) mergeTabs(dragTab.id, t.id, target.pane, target.dir)
                    setDragTab(null)
                  }}
                >
                  {dragTab.at && <div className="tab-drop-mark" style={{ left: pct(dragTab.at.rect.x), top: pct(dragTab.at.rect.y), width: pct(dragTab.at.rect.w), height: pct(dragTab.at.rect.h) }} />}
                </div>
              )
            })}
        {tabs
          .filter((t) => t.id === active && !t.zoomed)
          .flatMap((t) => dividers(t.layout).map((d) => <PaneDivider key={`${t.id}:${d.path}`} divider={d} area={mainRef} onChange={(ratio) => patchTab(t.id, (cur) => ({ layout: setRatio(cur.layout, d.path, ratio) }))} />))}
      </main>
      {menu.element}
      {picking && <HostPickerSheet hosts={hosts} direction={picking.dir} close={() => setPicking(null)} pick={(host, kind: PaneKind) => open(kind, host, true, undefined, { session: picking.beside, dir: picking.dir })} />}
      {naming && (
        <WorkspaceNameSheet
          title="Save Workspace"
          initial={tabs.find((t) => t.id === naming)?.name ?? ''}
          action="Save"
          note="The connections of this tab and their arrangement are saved. You find the workspace under Workspaces in the sidebar."
          close={() => setNaming(null)}
          submit={(name) => saveWorkspace(naming, name, true)}
        />
      )}
      <TransferHost />
      <PromptHost />
    </div>
    </>
  )
}

/** The line between two panes. Drag it, or move it with the arrow keys. */
function PaneDivider(props: { divider: Divider; area: React.RefObject<HTMLElement | null>; onChange: (ratio: number) => void }) {
  const { divider: d } = props
  const row = d.dir === 'row'
  const [dragging, setDragging] = useState(false)
  const ratioAt = (e: ReactPointerEvent): number => {
    const box = props.area.current?.getBoundingClientRect()
    if (!box) return d.ratio
    return row ? (e.clientX - box.left - d.area.x * box.width) / (d.area.w * box.width) : (e.clientY - box.top - d.area.y * box.height) / (d.area.h * box.height)
  }
  const onKey = (e: ReactKeyboardEvent): void => {
    const step = e.shiftKey ? 0.1 : 0.02
    const less = row ? 'ArrowLeft' : 'ArrowUp'
    const more = row ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== less && e.key !== more && e.key !== 'Home') return
    e.preventDefault()
    props.onChange(e.key === 'Home' ? 0.5 : d.ratio + (e.key === more ? step : -step))
  }
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={row ? 'Resize the panes left and right' : 'Resize the panes above and below'}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-valuenow={Math.round(d.ratio * 100)}
      className={`pane-divider ${row ? 'side-by-side' : 'stacked'} ${dragging ? 'dragging' : ''}`}
      style={row ? { left: pct(d.area.x + d.area.w * d.ratio), top: pct(d.area.y), height: pct(d.area.h) } : { top: pct(d.area.y + d.area.h * d.ratio), left: pct(d.area.x), width: pct(d.area.w) }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
      }}
      onPointerMove={(e) => dragging && props.onChange(ratioAt(e))}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onDoubleClick={() => props.onChange(0.5)}
      onKeyDown={onKey}
    />
  )
}
