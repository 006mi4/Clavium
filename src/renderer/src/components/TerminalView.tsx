import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Container, FolderOpen, Layers, Plus, Power, RotateCw, X } from 'lucide-react'
import type { HostSummary, ScreenList, TerminalTarget } from '@shared/types'
import { api, on } from '../api'
import { IconButton, Sheet, Toolbar, useConfirm, useDarkMode, useMenu, useToast, type MenuItem } from '../ui'
import { useTerminalSuggest } from './TerminalSuggest'

export type ConnState = 'connecting' | 'connected' | 'closed' | 'error'

const DARK: ITheme = {
  background: '#1c1c1e',
  foreground: '#e6e6ea',
  cursor: '#e6e6ea',
  cursorAccent: '#1c1c1e',
  selectionBackground: 'rgba(64,140,255,0.35)',
  black: '#2c2c2e',
  red: '#ff6b61',
  green: '#46c873',
  yellow: '#eda63c',
  blue: '#5c9dff',
  magenta: '#c58af9',
  cyan: '#4ec3d6',
  white: '#d1d1d6',
  brightBlack: '#8d8d96',
  brightRed: '#ff8a82',
  brightGreen: '#6fdc94',
  brightYellow: '#f5c06a',
  brightBlue: '#82b4ff',
  brightMagenta: '#d7a8fb',
  brightCyan: '#7dd6e4',
  brightWhite: '#ffffff'
}

const LIGHT: ITheme = {
  background: '#ffffff',
  foreground: '#1c1c1e',
  cursor: '#1c1c1e',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(11,101,227,0.22)',
  black: '#1c1c1e',
  red: '#c8102e',
  green: '#1a7f37',
  yellow: '#9a5b00',
  blue: '#0b65e3',
  magenta: '#8a3fc7',
  cyan: '#0e7c86',
  white: '#8a8a90',
  brightBlack: '#737378',
  brightRed: '#e0284a',
  brightGreen: '#2ea44f',
  brightYellow: '#b87400',
  brightBlue: '#3d8bff',
  brightMagenta: '#a45fe0',
  brightCyan: '#1397a3',
  brightWhite: '#5e5e63'
}

const STATE_TEXT: Record<ConnState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Disconnected',
  error: 'Connection failed'
}

export function StatusDot({ state }: { state: ConnState }) {
  return <span className={`status-dot ${state === 'connected' ? 'on' : state === 'error' ? 'err' : state === 'connecting' ? 'busy' : ''}`} />
}

export function TerminalView(props: {
  host: HostSummary
  active: boolean
  fontSize: number
  /** suggest commands, options and paths while typing */
  autocomplete: boolean
  onState: (s: ConnState) => void
  /** set when this tab shows something else than a login shell: a screen, a container log, a shell in a container */
  target?: { target: TerminalTarget; name: string }
  onOpenFiles: () => void
  onOpenScreen: (screen: { target: TerminalTarget; name: string }) => void
  onOpenDocker: () => void
  onClose: () => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const menu = useMenu()
  const special = props.target?.target
  /** a screen of the server; null for everything else */
  const screen = special && ('attach' in special || 'create' in special) ? { target: special, name: props.target?.name ?? '' } : null
  const docker = special && 'dockerLogs' in special ? 'Log of a container' : special && 'dockerShell' in special ? 'Shell in a container' : null
  const [hasDocker, setHasDocker] = useState(false)
  /** screens of the logged-in user; null until the server has answered */
  const [screens, setScreens] = useState<ScreenList | null>(null)
  const [naming, setNaming] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const dark = useDarkMode()
  const wrapRef = useRef<HTMLDivElement>(null)
  // Suggestions are for the prompt of a shell: not for a screen, a log or a shell inside a container.
  const suggest = useTerminalSuggest({ term: termRef, session: sessionRef, wrap: wrapRef, enabled: props.autocomplete && !props.target })
  const suggestRef = useRef(suggest)
  suggestRef.current = suggest

  const update = (s: ConnState, msg = ''): void => {
    setState(s)
    setMessage(msg)
    props.onState(s)
  }
  const fit = (): void => {
    try {
      fitRef.current?.fit()
    } catch {
      /* not visible */
    }
  }

  /**
   * Give the keyboard to the terminal, unless it is on a control of this very pane: someone who
   * walks through the toolbar with the Tab key must not be pulled back into the terminal.
   */
  const focusUnlessBusy = (): void => {
    const pane = wrapRef.current?.closest('.pane')
    const at = document.activeElement
    if (pane && at && at !== document.body && pane.contains(at) && !at.classList.contains('xterm-helper-textarea')) return
    termRef.current?.focus()
  }

  // create the terminal once
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: props.fontSize,
      lineHeight: 1.15,
      scrollback: 10000,
      allowProposedApi: false,
      theme: window.matchMedia('(prefers-color-scheme: dark)').matches ? DARK : LIGHT
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(ref.current as HTMLDivElement)
    // lets the end-to-end tests read the scrollback
    ;(ref.current as HTMLDivElement & { term?: Terminal }).term = term
    termRef.current = term
    fitRef.current = fitAddon

    const paste = (): void => {
      void api.clipboard.read().then((t) => {
        if (!sessionRef.current || !t) return
        suggestRef.current.onInput(t)
        void api.term.write(sessionRef.current, t)
      })
    }
    // Ctrl+Shift+C / Ctrl+Shift+V; right-click copies the selection or pastes.
    // On macOS Cmd+C / Cmd+V also work: they come from the Edit menu of the app.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
      if (!suggestRef.current.onKey(e)) return false
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection()
        if (sel) void api.clipboard.write(sel)
        return false
      }
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        paste()
        return false
      }
      return true
    })
    const onContext = (e: MouseEvent): void => {
      e.preventDefault()
      const sel = term.getSelection()
      if (sel) {
        void api.clipboard.write(sel)
        term.clearSelection()
      } else {
        paste()
      }
    }
    const node = ref.current
    node?.addEventListener('contextmenu', onContext)

    const dataSub = term.onData((d) => {
      if (!sessionRef.current) return
      suggestRef.current.onInput(d)
      void api.term.write(sessionRef.current, d)
    })
    const parsedSub = term.onWriteParsed(() => suggestRef.current.onOutput())
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (sessionRef.current) void api.term.resize(sessionRef.current, cols, rows)
    })
    const offData = on('term:data', (id: string, data: Uint8Array) => {
      if (id === sessionRef.current) term.write(data)
    })
    const offExit = on('term:exit', (id: string, reason: string) => {
      if (id !== sessionRef.current) return
      sessionRef.current = null
      suggestRef.current.reset()
      update('closed', reason)
    })
    const ro = new ResizeObserver(fit)
    ro.observe(node as HTMLDivElement)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      dataSub.dispose()
      parsedSub.dispose()
      resizeSub.dispose()
      node?.removeEventListener('contextmenu', onContext)
      if (sessionRef.current) void api.term.close(sessionRef.current)
      term.dispose()
    }
  }, [])

  // (re)connect
  useEffect(() => {
    let cancelled = false
    const term = termRef.current
    if (!term) return
    update('connecting')
    fit()
    api.term
      .open(props.host.id, Math.max(term.cols, 20), Math.max(term.rows, 5), props.target?.target)
      .then((id) => {
        if (cancelled) {
          void api.term.close(id)
          return
        }
        if (props.target) term.reset() // a reconnect brings the history again
        sessionRef.current = id
        suggestRef.current.reset()
        update('connected')
        focusUnlessBusy()
        // Look for screens and Docker quietly; a server without them simply shows no button.
        if (props.host.protocol === 'ssh' && !props.target) {
          api.term
            .screens(id)
            .then((list) => !cancelled && setScreens(list))
            .catch(() => undefined)
          api.term
            .hasDocker(id)
            .then((yes) => !cancelled && setHasDocker(yes))
            .catch(() => undefined)
        }
      })
      .catch((e: Error) => {
        if (!cancelled) update('error', e.message)
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = dark ? DARK : LIGHT
  }, [dark])

  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = props.fontSize
    fit()
  }, [props.fontSize])

  useEffect(() => {
    if (props.active) {
      requestAnimationFrame(() => {
        fit()
        focusUnlessBusy()
      })
    }
  }, [props.active])

  const openScreensMenu = async (e: React.MouseEvent<HTMLElement>): Promise<void> => {
    const anchor = e.currentTarget.getBoundingClientRect()
    let list = screens
    try {
      // ask again: screens come and go while the terminal is open
      if (sessionRef.current) list = await api.term.screens(sessionRef.current)
      setScreens(list)
    } catch {
      /* show what is known */
    }
    const items: MenuItem[] = (list?.screens ?? []).map((s) => ({
      label: s.name,
      icon: Layers,
      hint: s.attached ? 'in use' : s.started,
      onSelect: () => props.onOpenScreen({ target: { attach: s.id }, name: s.name })
    }))
    if (items.length) items.push('separator')
    items.push({ label: 'New Screen…', icon: Plus, onSelect: () => setNaming(true) })
    menu.openBelow({ currentTarget: { getBoundingClientRect: () => anchor } } as React.MouseEvent<HTMLElement>, items)
  }
  const endScreen = async (): Promise<void> => {
    const target = screen?.target
    if (!target || !sessionRef.current) return
    const ok = await confirm({
      title: `End the Screen “${screen?.name}”?`,
      message: 'The program running in it is stopped. To leave it running, just close this tab instead.',
      confirmLabel: 'End Screen',
      destructive: true
    })
    if (!ok) return
    try {
      const list = await api.term.screens(sessionRef.current)
      const id = 'attach' in target ? target.attach : list.screens.find((s) => s.name === target.create)?.id
      if (id) await api.term.endScreen(sessionRef.current, id)
    } catch (e) {
      toast.error(e)
    }
  }
  const count = screens?.screens.length ?? 0

  return (
    <>
      <Toolbar
        title={props.target ? props.target.name : props.host.name}
        subtitle={
          <>
            <StatusDot state={state} />
            {state === 'connected' && (screen || docker) ? (screen ? 'Screen' : docker) : STATE_TEXT[state]}
            <span className="mono" style={{ marginLeft: 6 }}>
              {props.host.username}@{props.host.hostname}
            </span>
            {screen && state === 'connected' && <span style={{ marginLeft: 8 }}>· keeps running when you close this tab</span>}
          </>
        }
      >
        {state !== 'connecting' && state !== 'connected' && <IconButton icon={RotateCw} label="Reconnect" onClick={() => setAttempt((a) => a + 1)} />}
        {!props.target && hasDocker && state === 'connected' && (
          <button className="btn" title="Containers and images on this server" onClick={props.onOpenDocker}>
            <Container size={14} /> Docker
          </button>
        )}
        {!props.target && screens?.installed && state === 'connected' && (
          <button className="btn" title="Programs that keep running on the server (GNU screen)" onClick={(e) => void openScreensMenu(e)}>
            <Layers size={14} /> Screens{count ? ` · ${count}` : ''}
          </button>
        )}
        {screen && state === 'connected' && <IconButton icon={Power} label="End Screen…" onClick={() => void endScreen()} />}
        <IconButton icon={FolderOpen} label="Browse Files" onClick={props.onOpenFiles} />
        <IconButton icon={X} label={screen ? 'Close Tab (the screen keeps running)' : docker ? 'Close Tab' : 'Close Session'} onClick={props.onClose} />
      </Toolbar>
      {menu.element}
      {naming && (
        <NewScreenSheet
          close={() => setNaming(false)}
          create={(name) => props.onOpenScreen({ target: { create: name }, name })}
          taken={(screens?.screens ?? []).map((s) => s.name)}
        />
      )}
      <div className="view-fixed">
        <div className="term-wrap" ref={wrapRef} style={{ ['--term-bg' as string]: dark ? DARK.background : LIGHT.background }}>
          <div ref={ref} style={{ height: '100%' }} />
          {suggest.element}
          {state !== 'connected' && (
            <div className={`overlay ${state === 'closed' ? 'soft' : ''}`}>
              <div className="box">
                {state === 'connecting' ? (
                  <>
                    <div className="spinner" />
                    <p>
                      Connecting to {props.host.hostname}…
                    </p>
                  </>
                ) : (
                  <>
                    <h2>{state === 'error' ? 'Couldn’t Connect' : 'Session Ended'}</h2>
                    <p>{message || 'The connection was closed.'}</p>
                    <button className="btn prominent" onClick={() => setAttempt((a) => a + 1)}>
                      Reconnect
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function NewScreenSheet(props: { close: () => void; create: (name: string) => void; taken: string[] }) {
  const [name, setName] = useState('')
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)
  const submit = (): void => {
    if (!valid) return
    props.close()
    props.create(name)
  }
  return (
    <Sheet
      size="narrow"
      title="New Screen"
      onClose={props.close}
      footer={
        <>
          <button className="btn" onClick={props.close}>
            Cancel
          </button>
          <button className="btn prominent" onClick={submit} disabled={!valid}>
            {props.taken.includes(name) ? 'Open' : 'Create'}
          </button>
        </>
      }
    >
      <p>Whatever you start in a screen keeps running on the server after you close the tab, for example a game server.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input className="field" aria-label="Name of the screen" placeholder="e.g. minecraft" autoFocus spellCheck={false} value={name} onChange={(e) => setName(e.target.value.trim())} />
      </form>
      {name && !valid && <p>Use letters, digits, dots, dashes and underscores.</p>}
      {props.taken.includes(name) && <p>A screen with this name is already running. It will be opened.</p>}
    </Sheet>
  )
}
