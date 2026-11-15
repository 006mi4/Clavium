// Suggestions while typing at the prompt of a terminal: commands, subcommands, options, paths
// and lines of the history, in a small list at the cursor.
//
// What is on the command line is read from the screen of the terminal, never from the keys:
// a password that is typed without echo is therefore never seen here.
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { IMarker, Terminal } from '@xterm/xterm'
import { CornerDownRight, File, Flag, Folder, History, SquareTerminal, Tag } from 'lucide-react'
import { completionNeeds, keystrokes, parseLine, suggest, type CompletionNeed, type LineContext, type Suggestion, type SuggestKind } from '@shared/complete'
import type { DynamicKind } from '@shared/completeSpecs'
import type { CompletionContext } from '@shared/types'
import { api } from '../api'
import { keys } from '../platform'
import type { IconType } from '../ui'

const ICONS: Record<SuggestKind, IconType> = { history: History, command: SquareTerminal, subcommand: CornerDownRight, option: Flag, file: File, dir: Folder, value: Tag }
const KIND_TEXT: Record<SuggestKind, string> = { history: 'from the history', command: 'command', subcommand: 'subcommand', option: 'option', file: 'file', dir: 'folder', value: 'value' }

/** Lists of a folder or of the server are asked again after this time. */
const FRESH_MS = 8000
const ROW = 26

interface Popup {
  items: Suggestion[]
  selected: number
  ctx: LineContext
  left: number
  /** distance from the top of the terminal area, or from its bottom when `above` */
  offset: number
  above: boolean
}

export interface SuggestHandle {
  /** called with what the user typed, before it is sent to the server */
  onInput: (data: string) => void
  /** called for every key press in the terminal; false: the key was used here */
  onKey: (e: KeyboardEvent) => boolean
  /** the terminal drew new output */
  onOutput: () => void
  /** the connection was closed or opened again */
  reset: () => void
  element: ReactNode
}

class Engine {
  marker: IMarker | null = null
  startCol = 0
  /** Escape was pressed, or a search of the shell is open: quiet until the line ends */
  quiet = false
  /** opened with the shortcut: also shown for an empty line */
  forced = false
  /** the user moved through the list, so Enter takes the selected entry */
  touched = false
  context: CompletionContext | null = null
  commands: string[] | undefined
  remoteHistory: string[] = []
  typedHistory: string[] = []
  lists = new Map<string, { at: number; items: string[] }>()
  pending = new Set<string>()
  timer: ReturnType<typeof setTimeout> | null = null
  generation = 0
  /**
   * Characters that were typed but whose echo has not been seen on the screen yet. While this is
   * not zero, the list still belongs to an older state of the line.
   */
  awaiting = 0
  lastLength = 0
  lastTypedAt = 0
  /** Tab or Enter asked for the selected entry while typed characters were still on their way */
  pendingAccept: ReturnType<typeof setTimeout> | null = null

  endLine(): void {
    this.marker?.dispose()
    this.marker = null
    this.quiet = false
    this.forced = false
    this.touched = false
    this.context = null
    this.generation++
    this.awaiting = 0
    this.lastLength = 0
    if (this.pendingAccept) clearTimeout(this.pendingAccept)
    this.pendingAccept = null
    // a command may have changed folders, branches or containers
    this.lists.clear()
  }
}

const needKey = (n: CompletionNeed): string => (n.kind === 'commands' ? 'commands' : n.kind === 'dir' ? `dir:${n.path}` : `${n.kind}:${n.cwd}`)

/** The text between the place where the line started and the cursor; null when it cannot be read. */
function readInput(term: Terminal, marker: IMarker, startCol: number): string | null {
  const buf = term.buffer.active
  const first = marker.line
  const last = buf.baseY + buf.cursorY
  if (first < 0 || last - first > 6) return null
  if (last < first || (last === first && buf.cursorX < startCol)) return ''
  let text = ''
  for (let y = first; y <= last; y++) {
    const line = buf.getLine(y)
    if (!line) return null
    // a second line that is not a wrapped one belongs to a multi-line command ("> ")
    if (y > first && !line.isWrapped) return null
    text += line.translateToString(false, y === first ? startCol : 0, y === last ? buf.cursorX : term.cols)
  }
  return text
}

export function useTerminalSuggest(opts: {
  term: RefObject<Terminal | null>
  session: RefObject<string | null>
  /** the element the list is positioned in */
  wrap: RefObject<HTMLElement | null>
  enabled: boolean
}): SuggestHandle {
  const engine = useRef<Engine>(null as unknown as Engine)
  if (!engine.current) engine.current = new Engine()
  const [popup, setPopup] = useState<Popup | null>(null)
  const popupRef = useRef<Popup | null>(null)
  const enabledRef = useRef(opts.enabled)
  enabledRef.current = opts.enabled
  const listRef = useRef<HTMLUListElement>(null)
  const [announce, setAnnounce] = useState('')

  const show = (next: Popup | null): void => {
    if (!next && !popupRef.current) return
    popupRef.current = next
    setPopup(next)
  }
  const hide = (): void => show(null)

  const load = (need: CompletionNeed, generation: number): void => {
    const e = engine.current
    const id = opts.session.current
    const key = needKey(need)
    if (!id || e.pending.has(key)) return
    e.pending.add(key)
    api.term
      .completeList(id, need)
      .then(
        (items) => {
          if (need.kind === 'commands') e.commands = items
          else e.lists.set(key, { at: Date.now(), items })
        },
        () => {
          // remember the failure for a moment, so that a broken list is not asked on every key
          if (need.kind !== 'commands') e.lists.set(key, { at: Date.now(), items: [] })
        }
      )
      .finally(() => {
        e.pending.delete(key)
        if (generation === e.generation) refresh()
      })
  }

  const refresh = (): void => {
    const e = engine.current
    const term = opts.term.current
    if (!term || !enabledRef.current || !e.marker || e.quiet || e.context?.busy || term.buffer.active.type !== 'normal') return hide()
    const input = readInput(term, e.marker, e.startCol)
    if (input !== null) {
      // every character the line grew or shrank by is one echo that has arrived
      e.awaiting = Math.max(0, e.awaiting - Math.abs([...input].length - e.lastLength))
      e.lastLength = [...input].length
    }
    if (input === null || (!input.trim() && !e.forced)) return hide()
    const ctx = parseLine(input)
    const cwd = e.context?.cwd ?? ''
    const fresh = (key: string): string[] | undefined => {
      const hit = e.lists.get(key)
      return hit && Date.now() - hit.at < FRESH_MS ? hit.items : undefined
    }
    for (const need of completionNeeds(ctx, cwd)) {
      const known = need.kind === 'commands' ? e.commands : fresh(needKey(need))
      if (!known) load(need, e.generation)
    }
    const items = suggest(
      ctx,
      {
        commands: e.commands,
        history: [...e.typedHistory, ...e.remoteHistory],
        // a list that is a little old is still better than none while the new one loads
        dir: (path) => e.lists.get(`dir:${path}`)?.items,
        dynamic: (kind: DynamicKind, at) => e.lists.get(`${kind}:${at}`)?.items
      },
      cwd
    )
    if (items.length === 0) return hide()
    // where the cursor is, in pixels of the terminal area
    const screen = term.element?.querySelector('.xterm-screen')?.getBoundingClientRect()
    const wrap = opts.wrap.current?.getBoundingClientRect()
    if (!screen || !wrap) return hide()
    const cellW = screen.width / term.cols
    const cellH = screen.height / term.rows
    const buf = term.buffer.active
    const tokenCols = Math.min(buf.cursorX, [...ctx.token].length)
    const cursorTop = screen.top - wrap.top + buf.cursorY * cellH
    const height = Math.min(items.length, 8) * ROW + 38
    const above = cursorTop + cellH + height > wrap.height && cursorTop > height
    const previous = popupRef.current
    const same = previous && previous.ctx.input === input
    show({
      items,
      selected: same ? Math.min(previous.selected, items.length - 1) : 0,
      ctx,
      left: Math.max(4, Math.min(screen.left - wrap.left + (buf.cursorX - tokenCols) * cellW, wrap.width - 240)),
      offset: above ? wrap.height - cursorTop + 2 : cursorTop + cellH + 2,
      above
    })
    if (!same) e.touched = false
  }

  const schedule = (): void => {
    const e = engine.current
    if (e.timer) clearTimeout(e.timer)
    e.timer = setTimeout(() => {
      refresh()
      if (e.pendingAccept && e.awaiting === 0) finishAccept()
    }, 40)
  }

  const beginLine = (): void => {
    const e = engine.current
    const term = opts.term.current
    const id = opts.session.current
    if (!term || !id || term.buffer.active.type !== 'normal') return
    e.marker = term.registerMarker(0)
    e.startCol = term.buffer.active.cursorX
    const generation = e.generation
    api.term.completeContext(id).then(
      (context) => {
        if (generation !== e.generation) return
        e.context = context
        schedule()
      },
      () => undefined
    )
    if (e.remoteHistory.length === 0 && !e.pending.has('history')) {
      e.pending.add('history')
      api.term
        .completeHistory(id)
        .then(
          (lines) => (e.remoteHistory = lines),
          () => undefined
        )
        .finally(() => e.pending.delete('history'))
    }
  }

  const accept = (index: number): void => {
    const p = popupRef.current
    const id = opts.session.current
    const item = p?.items[index]
    if (!p || !id || !item) return
    const e = engine.current
    e.touched = false
    const typed = keystrokes(item, p.ctx)
    e.awaiting += [...typed].length
    void api.term.write(id, typed)
    opts.term.current?.focus()
  }
  /** Take the selected entry now that the screen shows everything that was typed. */
  const finishAccept = (): void => {
    const e = engine.current
    const id = opts.session.current
    if (e.pendingAccept) clearTimeout(e.pendingAccept)
    e.pendingAccept = null
    const p = popupRef.current
    if (p) accept(p.selected)
    // nothing fits the line as it is now: the key goes to the shell after all
    else if (id) void api.term.write(id, '\t')
  }
  /** Tab or Enter on the list. Waits for characters that are still on their way to the server and back. */
  const requestAccept = (): void => {
    const e = engine.current
    // a key that the shell did not echo must not keep the list waiting for ever
    if (Date.now() - e.lastTypedAt > 600) e.awaiting = 0
    if (e.awaiting === 0) return accept(popupRef.current?.selected ?? 0)
    if (e.pendingAccept) return
    e.pendingAccept = setTimeout(() => {
      e.awaiting = 0
      refresh()
      finishAccept()
    }, 500)
  }

  const handle = useMemo<Omit<SuggestHandle, 'element'>>(
    () => ({
      onInput(data) {
        const e = engine.current
        const term = opts.term.current
        if (!enabledRef.current || !term) return
        if (data.length > 1 && /[\r\n]/.test(data)) {
          // pasted text with several lines
          e.endLine()
          hide()
        } else if (data === '\r' || data === '\n') {
          // remember the line for this session; a line typed into a program is not a command
          if (e.marker && !e.context?.busy && term.buffer.active.type === 'normal') {
            const line = readInput(term, e.marker, e.startCol)?.trim()
            if (line && line.length <= 500) e.typedHistory = [line, ...e.typedHistory.filter((l) => l !== line)].slice(0, 200)
          }
          e.endLine()
          hide()
        } else if (data === '\x03' || data === '\x04' || data === '\x0c' || data === '\x1a') {
          e.endLine()
          hide()
        } else if (data === '\x12' || data === '\x13') {
          // the search of the shell replaces the prompt: nothing sensible can be read
          e.quiet = true
          hide()
        } else {
          if (!e.marker) beginLine()
          e.lastTypedAt = Date.now()
          // plain characters and the backspace change the line by one; anything else is not counted
          if (data === '\x7f' || (!data.startsWith('\x1b') && [...data].every((c) => c >= ' '))) e.awaiting += [...data].length
          else e.awaiting = 0
        }
      },
      onKey(ev) {
        const e = engine.current
        if (ev.type !== 'keydown' || !enabledRef.current) return true
        const used = (): boolean => {
          ev.preventDefault()
          return false
        }
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && ev.code === 'Space') {
          e.forced = true
          e.quiet = false
          if (!e.marker) beginLine()
          refresh()
          return used()
        }
        const p = popupRef.current
        if (!p || ev.ctrlKey || ev.altKey || ev.metaKey) return true
        if (ev.key === 'Tab' && !ev.shiftKey) {
          requestAccept()
          return used()
        }
        if (ev.key === 'ArrowDown') {
          show({ ...p, selected: e.touched ? (p.selected + 1) % p.items.length : p.selected })
          e.touched = true
          return used()
        }
        // The arrow up belongs to the history of the shell until the list is in use.
        if (ev.key === 'ArrowUp' && e.touched) {
          if (p.selected === 0) e.touched = false
          else show({ ...p, selected: p.selected - 1 })
          return used()
        }
        if (ev.key === 'Enter' && e.touched) {
          requestAccept()
          return used()
        }
        if (ev.key === 'Escape') {
          e.quiet = true
          e.forced = false
          hide()
          return used()
        }
        return true
      },
      onOutput: schedule,
      reset() {
        const e = engine.current
        e.endLine()
        e.commands = undefined
        e.remoteHistory = []
        hide()
      }
    }),
    []
  )

  useEffect(() => {
    if (!opts.enabled) hide()
  }, [opts.enabled])
  useEffect(
    () => () => {
      if (engine.current.timer) clearTimeout(engine.current.timer)
    },
    []
  )

  // keep the selected entry in view, and tell screen readers about it
  useEffect(() => {
    if (!popup) return setAnnounce('')
    listRef.current?.children[popup.selected]?.scrollIntoView({ block: 'nearest' })
    const item = popup.items[popup.selected]
    const timer = setTimeout(() => {
      const count = popup.items.length === 1 ? '1 suggestion' : `${popup.items.length} suggestions`
      setAnnounce(`${count}. ${item.label}, ${item.detail ?? KIND_TEXT[item.kind]}. Tab inserts it.`)
    }, 500)
    return () => clearTimeout(timer)
  }, [popup?.selected, popup?.items])

  const touched = engine.current.touched
  const element = (
    <>
      {popup && (
        <div className="suggest" style={{ left: popup.left, ...(popup.above ? { bottom: popup.offset } : { top: popup.offset }) }}>
          <ul ref={listRef} role="listbox" aria-label="Suggestions">
            {popup.items.map((item, i) => {
              const Icon = ICONS[item.kind]
              return (
                <li
                  key={i}
                  role="option"
                  aria-selected={i === popup.selected}
                  title={item.detail ? `${item.label}: ${item.detail}` : item.label}
                  // the terminal keeps the keyboard
                  onMouseDown={(ev) => {
                    ev.preventDefault()
                    accept(i)
                  }}
                >
                  <Icon size={13} aria-hidden />
                  <span className="label">{item.label}</span>
                  {item.detail && <span className="detail">{item.detail}</span>}
                </li>
              )
            })}
          </ul>
          <div className="foot">
            Tab inserts · ↓ chooses{touched ? ' · Enter inserts' : ''} · Esc closes · {keys('Ctrl+Space', '⌃Space')} opens
          </div>
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
    </>
  )
  return { ...handle, element }
}
