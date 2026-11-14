import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { FolderOpen, RotateCw, X } from 'lucide-react'
import type { HostSummary } from '@shared/types'
import { api, on } from '../api'
import { IconButton, Toolbar, useDarkMode } from '../ui'

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
  onState: (s: ConnState) => void
  onOpenFiles: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const dark = useDarkMode()

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
    termRef.current = term
    fitRef.current = fitAddon

    const paste = (): void => {
      void api.clipboard.read().then((t) => {
        if (sessionRef.current && t) void api.term.write(sessionRef.current, t)
      })
    }
    // Ctrl+Shift+C / Ctrl+Shift+V; right-click copies the selection or pastes
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true
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
      if (sessionRef.current) void api.term.write(sessionRef.current, d)
    })
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (sessionRef.current) void api.term.resize(sessionRef.current, cols, rows)
    })
    const offData = on('term:data', (id: string, data: Uint8Array) => {
      if (id === sessionRef.current) term.write(data)
    })
    const offExit = on('term:exit', (id: string, reason: string) => {
      if (id !== sessionRef.current) return
      sessionRef.current = null
      update('closed', reason)
    })
    const ro = new ResizeObserver(fit)
    ro.observe(node as HTMLDivElement)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      dataSub.dispose()
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
      .open(props.host.id, Math.max(term.cols, 20), Math.max(term.rows, 5))
      .then((id) => {
        if (cancelled) {
          void api.term.close(id)
          return
        }
        sessionRef.current = id
        update('connected')
        term.focus()
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
        termRef.current?.focus()
      })
    }
  }, [props.active])

  return (
    <>
      <Toolbar
        title={props.host.name}
        subtitle={
          <>
            <StatusDot state={state} />
            {STATE_TEXT[state]}
            <span className="mono" style={{ marginLeft: 6 }}>
              {props.host.username}@{props.host.hostname}
            </span>
          </>
        }
      >
        {state !== 'connecting' && state !== 'connected' && <IconButton icon={RotateCw} label="Reconnect" onClick={() => setAttempt((a) => a + 1)} />}
        <IconButton icon={FolderOpen} label="Browse Files" onClick={props.onOpenFiles} />
        <IconButton icon={X} label="Close Session" onClick={props.onClose} />
      </Toolbar>
      <div className="view-fixed">
        <div className="term-wrap" style={{ ['--term-bg' as string]: dark ? DARK.background : LIGHT.background }}>
          <div ref={ref} style={{ height: '100%' }} />
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
