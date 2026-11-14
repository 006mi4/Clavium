import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { HostSummary } from '@shared/types'
import { api, on } from '../api'

export type ConnState = 'connecting' | 'connected' | 'closed' | 'error'

export function TerminalView(props: {
  host: HostSummary
  active: boolean
  fontSize: number
  onState: (s: ConnState) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)

  const update = (s: ConnState, msg = ''): void => {
    setState(s)
    setMessage(msg)
    props.onState(s)
  }

  // create the terminal once
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: props.fontSize,
      scrollback: 10000,
      allowProposedApi: false,
      theme: {
        background: '#0b0d12',
        foreground: '#e6e8ef',
        cursor: '#7aa2ff',
        selectionBackground: 'rgba(91,140,255,0.35)',
        black: '#1c2030',
        brightBlack: '#6d7590',
        blue: '#5b8cff',
        brightBlue: '#7aa2ff',
        green: '#3ccf8e',
        brightGreen: '#6be3ad',
        red: '#ff5d6c',
        brightRed: '#ff8a96',
        yellow: '#f5b94a',
        brightYellow: '#ffd27a',
        magenta: '#b48cff',
        brightMagenta: '#cdb0ff',
        cyan: '#4ad3e6',
        brightCyan: '#7fe6f3',
        white: '#d0d4e0',
        brightWhite: '#ffffff'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current as HTMLDivElement)
    termRef.current = term
    fitRef.current = fit

    const paste = (): void => {
      void api.clipboard.read().then((t) => {
        if (sessionRef.current && t) void api.term.write(sessionRef.current, t)
      })
    }
    // Ctrl+Shift+C / Ctrl+Shift+V, right-click: copy selection or paste
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
    ref.current?.addEventListener('contextmenu', onContext)

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
      term.write(`\r\n\x1b[90m[${reason}]\x1b[0m\r\n`)
      update('closed', reason)
    })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* hidden */
      }
    })
    ro.observe(ref.current as HTMLDivElement)

    return () => {
      ro.disconnect()
      offData()
      offExit()
      dataSub.dispose()
      resizeSub.dispose()
      ref.current?.removeEventListener('contextmenu', onContext)
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
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
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
    if (termRef.current) termRef.current.options.fontSize = props.fontSize
    try {
      fitRef.current?.fit()
    } catch {
      /* ignore */
    }
  }, [props.fontSize])

  useEffect(() => {
    if (props.active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit()
        } catch {
          /* ignore */
        }
        termRef.current?.focus()
      })
    }
  }, [props.active])

  return (
    <div className="term-wrap">
      <div ref={ref} style={{ height: '100%' }} />
      {state !== 'connected' && (
        <div className="overlay" style={state === 'closed' ? { background: 'rgba(11,13,18,0.55)' } : undefined}>
          <div className="box">
            {state === 'connecting' && (
              <>
                <div className="spinner" />
                <div className="muted">
                  Connecting to {props.host.username}@{props.host.hostname}…
                </div>
              </>
            )}
            {(state === 'error' || state === 'closed') && (
              <>
                <div className={state === 'error' ? 'callout danger' : 'muted'}>{message || 'Disconnected'}</div>
                <button className="btn primary" onClick={() => setAttempt((a) => a + 1)}>
                  Reconnect
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
