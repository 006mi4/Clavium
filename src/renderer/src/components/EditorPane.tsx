import { forwardRef, useDeferredValue, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { ChevronDown, ChevronUp, ClipboardPaste, Copy, CopyPlus, Hash, MessageSquareCode, Replace, Scissors, Search, TextSelect, Trash2, X } from 'lucide-react'
import { api } from '../api'
import {
  backspace,
  buildSearch,
  changeCase,
  deleteLines,
  duplicateLines,
  findMatches,
  indent,
  insertLine,
  lineBlock,
  matchBracket,
  MAX_MATCHES,
  moveLines,
  newline,
  offsetOfLine,
  outdent,
  renderMarks,
  replaceAll,
  replacementFor,
  smartHome,
  toggleComment,
  typeChar,
  wordOccurrences,
  type Edit,
  type Mark,
  type SearchOptions
} from '../editor/commands'
import { escapeHtml, highlight, LANGUAGE_LIST, languageName, lineCommentOf, withLineMarkers } from '../editor/highlight'
import { IconButton, useMenu, useToast } from '../ui'
import { isMac, keys, mod } from '../platform'

/** Above this size the text is shown without colors to keep typing fluid. */
export const HIGHLIGHT_LIMIT = 400_000
const MAX_RENDERED_MARKS = 3000
const PAD_TOP = 10

export type EditorPanel = 'find' | 'replace' | 'goto'

export interface EditorPaneHandle {
  openPanel(p: EditorPanel): void
  focus(): void
}

export const EditorPane = forwardRef<
  EditorPaneHandle,
  {
    name: string
    text: string
    language: string
    unit: string
    eol: 'lf' | 'crlf' | 'mixed'
    bom: boolean
    visible: boolean
    /**
     * false while the same file is being edited in the other pane. The text field then keeps its
     * old value (the colored layer still follows), because writing into a text field from code
     * would wipe the browser's undo history for the pane that is being typed in.
     */
    live: boolean
    fontSize: number
    defaultFontSize: number
    wrap: boolean
    onChange: (text: string) => void
    onLanguage: (id: string) => void
    onFocus: () => void
  }
>(function EditorPane(props, ref) {
  const toast = useToast()
  const menu = useMenu()
  const area = useRef<HTMLTextAreaElement | null>(null)
  const fieldHost = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const code = useRef<HTMLPreElement>(null)
  const marksEl = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLPreElement>(null)
  const lineBar = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const lastSel = useRef<[number, number]>([0, 0])
  const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0, start: 0, end: 0 })
  const [panel, setPanel] = useState<EditorPanel | null>(null)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [opts, setOpts] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false })
  const [gotoLine, setGotoLine] = useState('')
  const [bodyWidth, setBodyWidth] = useState(0)
  const { text, language, unit } = props
  const frozen = useRef(text)
  if (props.live || text.length > HIGHLIGHT_LIMIT) frozen.current = text
  const fieldValue = frozen.current
  const lineHeight = Math.round(props.fontSize * 1.52)

  const deferred = useDeferredValue(text)
  const colored = deferred.length <= HIGHLIGHT_LIMIT
  const wrap = props.wrap && colored
  const html = useMemo(() => {
    if (!colored) return null
    const h = highlight(deferred, language)
    // the trailing newline keeps the last (empty) line as tall as in the textarea
    return (wrap ? withLineMarkers(h) : h) + '\n'
  }, [deferred, language, colored, wrap])
  const lineCount = useMemo(() => text.split('\n').length, [text])
  const numbers = useMemo(() => (wrap ? '' : Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')), [lineCount, wrap])

  const searching = panel === 'find' || panel === 'replace'
  const search = useMemo(() => buildSearch(searching ? query : '', opts), [query, opts, searching])
  const matches = useMemo(() => findMatches(deferred, search.re), [deferred, search.re])
  const currentMatch = matches.findIndex(([a, b]) => a === cursor.start && b === cursor.end)

  const marksHtml = useMemo(() => {
    if (!colored) return null
    const list: Mark[] = []
    if (matches.length > 0) {
      matches.slice(0, MAX_RENDERED_MARKS).forEach(([from, to], i) => list.push({ from, to, cls: i === currentMatch ? 'cur' : 'hit' }))
    } else if (cursor.selected > 0) {
      for (const [from, to] of wordOccurrences(deferred, cursor.start, cursor.end)) list.push({ from, to, cls: 'word' })
    } else {
      const pair = matchBracket(deferred, cursor.start)
      if (pair) pair.forEach((p) => list.push({ from: p, to: p + 1, cls: 'bracket' }))
    }
    return list.length ? renderMarks(deferred, list, escapeHtml) + '\n' : null
  }, [matches, deferred, currentMatch, colored, cursor.start, cursor.end, cursor.selected])

  /** Top edge of a line inside the scrolled content (differs from line × height when lines wrap). */
  const lineTop = (line: number): number => {
    if (wrap && code.current) {
      const marker = code.current.querySelector<HTMLElement>(`b[data-n="${line}"]`)
      if (marker) return marker.offsetTop
      if (line > lineCount) return code.current.scrollHeight - PAD_TOP
    }
    return PAD_TOP + (line - 1) * lineHeight
  }

  const syncScroll = (): void => {
    const el = area.current
    if (!el) return
    const shift = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
    if (code.current) code.current.style.transform = shift
    if (marksEl.current) marksEl.current.style.transform = shift
    if (gutter.current) gutter.current.style.transform = `translateY(${-el.scrollTop}px)`
    if (lineBar.current) lineBar.current.style.transform = `translateY(${-el.scrollTop}px)`
  }

  // keep layers, current-line bar and scroll offsets in step with the text
  useLayoutEffect(() => {
    if (lineBar.current) {
      const top = lineTop(cursor.line)
      lineBar.current.style.top = `${top}px`
      lineBar.current.style.height = `${wrap ? Math.max(lineHeight, lineTop(cursor.line + 1) - top) : lineHeight}px`
    }
    syncScroll()
  })

  // the wrapped layers must be exactly as wide as the text area's content box
  useEffect(() => {
    const el = area.current
    if (!el) return
    const ro = new ResizeObserver(() => setBodyWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const updateCursor = (): void => {
    const el = area.current
    if (!el) return
    lastSel.current = [el.selectionStart, el.selectionEnd]
    const before = el.value.slice(0, el.selectionStart)
    const line = before.split('\n').length
    setCursor({ line, col: before.length - before.lastIndexOf('\n'), selected: el.selectionEnd - el.selectionStart, start: el.selectionStart, end: el.selectionEnd })
  }

  // The text field is not driven by React on every keystroke: writing its value from code would
  // reset the browser's undo history and make undo go one character at a time. It is only
  // written when the text really came from elsewhere (reload, or an edit in the other pane).
  useLayoutEffect(() => {
    const el = area.current
    if (!el || el.value === fieldValue) return
    const [a, b] = lastSel.current
    el.value = fieldValue
    el.setSelectionRange(Math.min(a, fieldValue.length), Math.min(b, fieldValue.length))
  }, [fieldValue])

  useEffect(() => {
    if (props.visible) requestAnimationFrame(syncScroll)
  }, [props.visible])

  /** Select a range and bring it into view (vertically centred). */
  const reveal = (start: number, end: number, focus = true): void => {
    const el = area.current
    if (!el) return
    el.setSelectionRange(start, end)
    const top = lineTop(el.value.slice(0, start).split('\n').length)
    if (top < el.scrollTop + lineHeight || top > el.scrollTop + el.clientHeight - 3 * lineHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2)
    if (focus) el.focus()
    syncScroll()
    updateCursor()
  }

  /** Apply an edit through the browser's editing commands so undo/redo keeps working. */
  const apply = (edit: Edit | null): boolean => {
    const el = area.current
    if (!el || !edit) return false
    el.focus()
    if (edit.from !== edit.to || edit.insert !== '') {
      el.setSelectionRange(edit.from, edit.to)
      const ok = edit.insert === '' ? document.execCommand('delete') : document.execCommand('insertText', false, edit.insert)
      if (!ok) {
        el.setRangeText(edit.insert, edit.from, edit.to, 'end')
        props.onChange(el.value)
      }
    }
    el.setSelectionRange(edit.start, edit.end)
    updateCursor()
    return true
  }
  const current = (): { text: string; start: number; end: number } => {
    const el = area.current as HTMLTextAreaElement
    return { text: el.value, start: el.selectionStart, end: el.selectionEnd }
  }

  // ------------------------------------------------------------ search --

  const openPanel = (p: EditorPanel): void => {
    const el = area.current
    if (el && p !== 'goto') {
      const sel = el.value.slice(el.selectionStart, el.selectionEnd)
      if (sel && !sel.includes('\n')) setQuery(sel)
    }
    setPanel(p)
    requestAnimationFrame(() => {
      findInput.current?.focus()
      findInput.current?.select()
    })
  }
  const closePanel = (): void => {
    setPanel(null)
    area.current?.focus()
  }
  useImperativeHandle(ref, () => ({ openPanel: (p) => (panel === p ? closePanel() : openPanel(p)), focus: () => area.current?.focus() }))

  const findNext = (dir: 1 | -1, focusEditor = false): void => {
    const el = area.current
    if (!el || !query) return
    const live = findMatches(el.value, search.re) // the live text, not the deferred copy
    if (live.length === 0) return
    let i = dir === 1 ? live.findIndex(([a]) => a >= el.selectionEnd) : live.findLastIndex(([, b]) => b <= el.selectionStart)
    if (i < 0) i = dir === 1 ? 0 : live.length - 1 // wrap around
    reveal(live[i][0], live[i][1], focusEditor)
  }

  const replaceOne = (): void => {
    const el = area.current
    if (!el || !search.re) return
    const hit = findMatches(el.value, search.re).find(([a, b]) => a === el.selectionStart && b === el.selectionEnd)
    if (hit) {
      const insert = replacementFor(el.value.slice(hit[0], hit[1]), search.re, replacement, opts.regex)
      apply({ from: hit[0], to: hit[1], insert, start: hit[0] + insert.length, end: hit[0] + insert.length })
    }
    findNext(1)
  }

  const replaceEverything = (): void => {
    const el = area.current
    if (!el || !search.re) return
    const r = replaceAll(el.value, search.re, replacement, opts.regex)
    if (r.count === 0) return toast.info('Nothing to replace')
    const top = el.scrollTop
    apply({ from: 0, to: el.value.length, insert: r.text, start: 0, end: 0 })
    el.scrollTop = top
    toast.ok(`Replaced ${r.count} ${r.count === 1 ? 'occurrence' : 'occurrences'}`)
  }

  const goTo = (): void => {
    const el = area.current
    const n = Number(gotoLine)
    if (!el || !Number.isInteger(n) || n < 1) return
    const pos = offsetOfLine(el.value, Math.min(n, lineCount))
    setPanel(null)
    reveal(pos, pos)
  }

  // ----------------------------------------------------- line commands --

  const comment = (): void => {
    const prefix = lineCommentOf(language)
    if (prefix) apply(toggleComment(current(), prefix))
    else toast.info(`${languageName(language)} has no line comments`)
  }
  const copy = (cut: boolean): void => {
    const s = current()
    if (s.start === s.end) {
      // no selection: the whole line
      const { from, to, block } = lineBlock(s)
      void api.clipboard.write(block + '\n')
      if (cut) apply(deleteLines({ ...s, start: from, end: to }))
    } else {
      void api.clipboard.write(s.text.slice(s.start, s.end))
      if (cut) apply({ from: s.start, to: s.end, insert: '', start: s.start, end: s.start })
    }
  }
  const paste = (): void => {
    void api.clipboard.read().then((t) => {
      if (!t) return
      const s = current()
      const insert = t.replace(/\r\n/g, '\n')
      apply({ from: s.start, to: s.end, insert, start: s.start + insert.length, end: s.start + insert.length })
    })
  }

  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    const s = current()
    const has = s.start !== s.end
    menu.openAt(e as unknown as ReactMouseEvent, [
      { label: has ? 'Cut' : 'Cut Line', icon: Scissors, onSelect: () => copy(true) },
      { label: has ? 'Copy' : 'Copy Line', icon: Copy, onSelect: () => copy(false) },
      { label: 'Paste', icon: ClipboardPaste, onSelect: paste },
      { label: 'Select All', icon: TextSelect, onSelect: () => reveal(0, s.text.length) },
      'separator',
      { label: 'Duplicate Line', icon: CopyPlus, onSelect: () => apply(duplicateLines(current())) },
      { label: 'Delete Line', icon: Trash2, onSelect: () => apply(deleteLines(current())) },
      { label: 'Toggle Comment', icon: MessageSquareCode, onSelect: comment, disabled: !lineCommentOf(language) },
      'separator',
      { label: has ? 'Find Selection' : 'Find…', icon: Search, onSelect: () => openPanel('find') },
      { label: 'Replace…', icon: Replace, onSelect: () => openPanel('replace') },
      { label: 'Go to Line…', icon: Hash, onSelect: () => openPanel('goto') }
    ])
  }

  // ---------------------------------------------------------- keyboard --

  const onKeyDown = (e: KeyboardEvent): void => {
    const el = area.current as HTMLTextAreaElement
    const s = { text: el.value, start: el.selectionStart, end: el.selectionEnd }
    const ctrl = mod(e)
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const always = (edit: Edit | null): void => {
      e.preventDefault()
      apply(edit)
    }

    if (e.altKey && !ctrl && (key === 'ArrowUp' || key === 'ArrowDown')) {
      return always(e.shiftKey ? duplicateLines(s) : moveLines(s, key === 'ArrowUp' ? -1 : 1))
    }
    if (ctrl && e.shiftKey && !e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) return always(moveLines(s, key === 'ArrowUp' ? -1 : 1))
    if (e.altKey) return

    if (ctrl) {
      if (key === 'Enter') return always(insertLine(s, e.shiftKey ? 'above' : 'below'))
      if (key === 'd' && !e.shiftKey) return always(duplicateLines(s))
      if ((key === 'k' && e.shiftKey) || (key === 'l' && !e.shiftKey)) return always(deleteLines(s))
      if (key === ']' && !e.shiftKey) {
        if (s.text.slice(s.start, s.end).includes('\n')) return always(indent(s, unit))
        const { from } = lineBlock(s)
        return always({ from, to: from, insert: unit, start: s.start + unit.length, end: s.end + unit.length })
      }
      if (key === '[' && !e.shiftKey) return always(outdent(s, unit))
      if (key === 'u') return always(changeCase(s, e.shiftKey))
      // Cmd+Q quits the app on macOS, so only Windows has the second shortcut.
      if (key === '/' || key === '#' || (key === 'q' && !e.shiftKey && !isMac)) {
        e.preventDefault()
        return comment()
      }
      if ((key === 'c' || key === 'x') && !e.shiftKey && s.start === s.end) {
        e.preventDefault()
        return copy(key === 'x')
      }
      return
    }

    if (key === 'Tab') return always(e.shiftKey ? outdent(s, unit) : indent(s, unit))
    if (key === 'Enter' && !e.shiftKey) return always(newline(s, unit))
    if (key === 'Backspace') {
      if (apply(backspace(s))) e.preventDefault()
      return
    }
    if (key === 'Home' && !e.shiftKey) {
      e.preventDefault()
      const pos = smartHome(s.text, s.start)
      el.setSelectionRange(pos, pos)
      return updateCursor()
    }
    if (e.key.length === 1 && apply(typeChar(s, e.key))) e.preventDefault()
  }

  /**
   * The text field is created by hand instead of through React. React writes into every text
   * field it manages after each input event, which makes the browser forget how typed characters
   * belong together: undo would then remove one character per step.
   */
  const live = useRef({ onKeyDown, onContextMenu, updateCursor, syncScroll, onChange: props.onChange })
  live.current = { onKeyDown, onContextMenu, updateCursor, syncScroll, onChange: props.onChange }
  useLayoutEffect(() => {
    const el = document.createElement('textarea')
    el.value = fieldValue
    el.spellcheck = false
    el.setAttribute('autocapitalize', 'off')
    el.setAttribute('autocorrect', 'off')
    el.addEventListener('input', () => {
      live.current.onChange(el.value)
      live.current.updateCursor()
    })
    el.addEventListener('scroll', () => live.current.syncScroll())
    el.addEventListener('keydown', (e) => live.current.onKeyDown(e))
    el.addEventListener('contextmenu', (e) => live.current.onContextMenu(e))
    for (const type of ['keyup', 'click', 'select']) el.addEventListener(type, () => live.current.updateCursor())
    fieldHost.current?.appendChild(el)
    area.current = el
    return () => {
      el.remove()
      area.current = null
    }
  }, [])
  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    el.className = html === null ? 'plain' : ''
    el.wrap = wrap ? 'soft' : 'off'
    el.setAttribute('aria-label', `Contents of ${props.name}`)
  }, [html === null, wrap, props.name])

  // search shortcuts work in the text and in the find bar
  const onShortcut = (e: ReactKeyboardEvent): void => {
    const ctrl = mod(e) && !e.shiftKey && !e.altKey
    const key = e.key.toLowerCase()
    // macOS hides the app on Cmd+H, so replacing is on Option+Cmd+F there, as in other Mac editors.
    // Option changes the character that is typed, so the key itself (F = 70) is checked.
    const replace = isMac ? e.metaKey && e.altKey && !e.shiftKey && e.keyCode === 70 : ctrl && key === 'h'
    const take = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (replace) take(() => openPanel('replace'))
    else if (ctrl && key === 'f') take(() => openPanel('find'))
    else if (ctrl && key === 'g') take(() => openPanel('goto'))
    else if (e.key === 'F3') take(() => (query ? findNext(e.shiftKey ? -1 : 1, true) : openPanel('find')))
    else if (e.key === 'Escape' && panel) take(closePanel)
  }

  const toggle = (k: keyof SearchOptions, label: string, short: string) => (
    <button type="button" className="toggle" aria-pressed={opts[k]} title={label} aria-label={label} onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}>
      {short}
    </button>
  )

  return (
    <div className="ed-doc" style={props.visible ? undefined : { display: 'none' }} onKeyDown={onShortcut} onFocusCapture={props.onFocus}>
      {searching && (
        <div className="find-bar" role="search">
          <form
            className="find-row"
            onSubmit={(e) => {
              e.preventDefault()
              findNext(1)
            }}
          >
            <div className="search" style={{ width: 260 }}>
              <Search size={14} />
              <input
                ref={findInput}
                className="field"
                placeholder="Find"
                aria-label="Find in file"
                aria-invalid={!!search.error}
                value={query}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.shiftKey) {
                    e.preventDefault()
                    findNext(-1)
                  }
                }}
              />
            </div>
            {toggle('caseSensitive', 'Match Case', 'Aa')}
            {toggle('wholeWord', 'Whole Word', 'W')}
            {toggle('regex', 'Regular Expression', '.*')}
            <span className="find-count" role="status">
              {search.error
                ? `Invalid expression: ${search.error}`
                : !query
                  ? ''
                  : matches.length === 0
                    ? 'No results'
                    : `${currentMatch >= 0 ? `${currentMatch + 1} of ` : ''}${matches.length >= MAX_MATCHES ? `${MAX_MATCHES}+` : matches.length}`}
            </span>
            <span style={{ flex: 1 }} />
            <IconButton icon={ChevronUp} label="Previous Match (Shift+F3)" disabled={matches.length === 0} onClick={() => findNext(-1)} />
            <IconButton icon={ChevronDown} label="Next Match (F3)" disabled={matches.length === 0} onClick={() => findNext(1)} />
            <IconButton icon={X} label="Close (Esc)" onClick={closePanel} />
            <button type="submit" hidden />
          </form>
          {panel === 'replace' && (
            <form
              className="find-row"
              onSubmit={(e) => {
                e.preventDefault()
                replaceOne()
              }}
            >
              <div className="search" style={{ width: 260 }}>
                <Replace size={14} />
                <input className="field" placeholder="Replace with" aria-label="Replace with" value={replacement} spellCheck={false} onChange={(e) => setReplacement(e.target.value)} />
              </div>
              <button type="submit" className="btn" disabled={matches.length === 0}>
                Replace
              </button>
              <button type="button" className="btn" disabled={matches.length === 0} onClick={replaceEverything}>
                Replace All
              </button>
            </form>
          )}
        </div>
      )}
      {panel === 'goto' && (
        <div className="find-bar">
          <form
            className="find-row"
            onSubmit={(e) => {
              e.preventDefault()
              goTo()
            }}
          >
            <input
              ref={findInput}
              className="field"
              style={{ width: 160 }}
              type="number"
              min={1}
              max={lineCount}
              placeholder={`Line (1–${lineCount})`}
              aria-label="Go to line"
              value={gotoLine}
              onChange={(e) => setGotoLine(e.target.value)}
            />
            <button type="submit" className="btn">
              Go
            </button>
            <span style={{ flex: 1 }} />
            <IconButton icon={X} label="Close (Esc)" onClick={closePanel} />
          </form>
        </div>
      )}

      <div
        className={`editor${wrap ? ' wrap' : ''}`}
        style={{ ['--ed-fs' as string]: `${props.fontSize}px`, ['--ed-lh' as string]: `${lineHeight}px`, ['--ed-w' as string]: `${bodyWidth}px` }}
      >
        {!wrap && (
          <div className="editor-gutter" aria-hidden="true">
            <pre ref={gutter}>{numbers}</pre>
          </div>
        )}
        <div className="editor-body" ref={body}>
          <div className="editor-layer" aria-hidden="true">
            <div ref={lineBar} className="editor-line" />
          </div>
          {marksHtml !== null && (
            <div className="editor-layer" aria-hidden="true">
              <pre ref={marksEl} className="editor-marks" dangerouslySetInnerHTML={{ __html: marksHtml }} />
            </div>
          )}
          {html !== null && (
            <div className="editor-layer" aria-hidden="true">
              <pre ref={code} dangerouslySetInnerHTML={{ __html: html }} />
            </div>
          )}
          <div ref={fieldHost} className="editor-field" />
        </div>
      </div>

      <div className="editor-status">
        <select className="status-select" aria-label="Language" value={language} onChange={(e) => props.onLanguage(e.target.value)}>
          {LANGUAGE_LIST.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {html === null && <span>Colors and wrapping are off for large files</span>}
        <span style={{ flex: 1 }} />
        <button className="link" style={{ color: 'inherit' }} onClick={() => openPanel('goto')} title={`Go to Line (${keys('Ctrl+G')})`}>
          Line {cursor.line}, Column {cursor.col}
        </button>
        {cursor.selected > 0 && <span>{cursor.selected} selected</span>}
        <span>{lineCount} lines</span>
        {props.fontSize !== props.defaultFontSize && <span>{Math.round((props.fontSize / props.defaultFontSize) * 100)} %</span>}
        <span>{unit === '\t' ? 'Tabs' : 'Spaces: 2'}</span>
        <span>{props.eol === 'crlf' ? 'CRLF' : props.eol === 'mixed' ? 'Mixed line endings, saved as LF' : 'LF'}</span>
        <span>UTF-8{props.bom ? ' with BOM' : ''}</span>
      </div>
      {menu.element}
    </div>
  )
})
