import { useDeferredValue, useEffect, useMemo, useRef, useState, type KeyboardEvent, type WheelEvent } from 'react'
import { ChevronDown, ChevronLeft, ChevronUp, Download, Keyboard, Replace, Save, Search, X } from 'lucide-react'
import type { RemoteEntry, TextFile } from '@shared/types'
import { api } from '../api'
import {
  backspace,
  buildSearch,
  changeCase,
  deleteLines,
  duplicateLines,
  findMatches,
  indent,
  indentUnit,
  insertLine,
  lineBlock,
  MAX_MATCHES,
  moveLines,
  newline,
  offsetOfLine,
  outdent,
  replaceAll,
  replacementFor,
  smartHome,
  toggleComment,
  typeChar,
  type Edit,
  type SearchOptions
} from '../editor/commands'
import { detectLanguage, escapeHtml, highlight, languageName, lineCommentOf } from '../editor/highlight'
import { IconButton, Sheet, Toolbar, useConfirm, useToast } from '../ui'

/** Above this size the text is shown without colors to keep typing fluid. */
const HIGHLIGHT_LIMIT = 400_000
const MAX_RENDERED_MARKS = 3000
const DEFAULT_FONT = 12.5

type Panel = 'find' | 'replace' | 'goto' | null

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'File',
    [
      ['Ctrl+S', 'Save'],
      ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
      ['Ctrl + / − / 0', 'Zoom in / out / reset (also Ctrl+mouse wheel)']
    ]
  ],
  [
    'Search',
    [
      ['Ctrl+F', 'Find'],
      ['Ctrl+H', 'Find and replace'],
      ['F3 / Shift+F3', 'Next / previous match'],
      ['Ctrl+G', 'Go to line']
    ]
  ],
  [
    'Lines',
    [
      ['Ctrl+D', 'Duplicate line or selected lines'],
      ['Ctrl+L or Ctrl+Shift+K', 'Delete line'],
      ['Alt+↑ / Alt+↓', 'Move line up / down (also Ctrl+Shift+↑/↓)'],
      ['Ctrl+Enter / Ctrl+Shift+Enter', 'New line below / above'],
      ['Ctrl+C / Ctrl+X without selection', 'Copy / cut the whole line']
    ]
  ],
  [
    'Editing',
    [
      ['Tab / Shift+Tab', 'Indent / outdent (also Ctrl+] and Ctrl+[)'],
      ['Ctrl+/ or Ctrl+Q', 'Comment or uncomment lines'],
      ['Ctrl+U / Ctrl+Shift+U', 'lowercase / UPPERCASE'],
      ['( [ { " \'', 'Close brackets; wrap the selection'],
      ['Home', 'Start of text, then start of line']
    ]
  ]
]

export function TextEditor(props: {
  sid: string
  entry: RemoteEntry
  onClose: () => void
  /** called after a successful save so the file list can refresh */
  onSaved: () => void
  onDownload: () => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const area = useRef<HTMLTextAreaElement>(null)
  const code = useRef<HTMLPreElement>(null)
  const marks = useRef<HTMLPreElement>(null)
  const gutter = useRef<HTMLPreElement>(null)
  const lineBar = useRef<HTMLDivElement>(null)
  const findInput = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<TextFile | null>(null)
  const [error, setError] = useState('')
  const [text, setText] = useState('')
  const [savedText, setSavedText] = useState('')
  const [saving, setSaving] = useState(false)
  const [cursor, setCursor] = useState({ line: 1, col: 1, selected: 0, start: 0, end: 0 })
  const [panel, setPanel] = useState<Panel>(null)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [opts, setOpts] = useState<SearchOptions>({ caseSensitive: false, wholeWord: false, regex: false })
  const [gotoLine, setGotoLine] = useState('')
  const [fontSize, setFontSize] = useState(DEFAULT_FONT)
  const [help, setHelp] = useState(false)
  const dirty = text !== savedText
  const lineHeight = Math.round(fontSize * 1.52)

  useEffect(() => {
    let cancelled = false
    api.files
      .readText(props.sid, props.entry.path)
      .then((f) => {
        if (cancelled) return
        setFile(f)
        setText(f.text)
        setSavedText(f.text)
        requestAnimationFrame(() => area.current?.focus())
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [props.sid, props.entry.path])

  const language = useMemo(() => detectLanguage(props.entry.name, text.slice(0, 200).split('\n')[0]), [props.entry.name, file])
  const deferred = useDeferredValue(text)
  const colored = deferred.length <= HIGHLIGHT_LIMIT
  // the trailing newline keeps the last (empty) line as tall as in the textarea
  const html = useMemo(() => (colored ? highlight(deferred, language) + '\n' : null), [deferred, language, colored])
  const lineCount = useMemo(() => text.split('\n').length, [text])
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount])
  const unit = useMemo(() => indentUnit(savedText), [savedText])

  const search = useMemo(() => buildSearch(panel === 'find' || panel === 'replace' ? query : '', opts), [query, opts, panel])
  const matches = useMemo(() => findMatches(deferred, search.re), [deferred, search.re])
  const currentMatch = matches.findIndex(([a, b]) => a === cursor.start && b === cursor.end)
  const marksHtml = useMemo(() => {
    if (matches.length === 0 || !colored) return null
    let out = ''
    let last = 0
    for (let i = 0; i < Math.min(matches.length, MAX_RENDERED_MARKS); i++) {
      const [a, b] = matches[i]
      out += escapeHtml(deferred.slice(last, a)) + `<mark${i === currentMatch ? ' class="cur"' : ''}>` + escapeHtml(deferred.slice(a, b)) + '</mark>'
      last = b
    }
    return out + escapeHtml(deferred.slice(last)) + '\n'
  }, [matches, deferred, currentMatch, colored])

  const syncScroll = (): void => {
    const el = area.current
    if (!el) return
    const shift = `translate(${-el.scrollLeft}px, ${-el.scrollTop}px)`
    if (code.current) code.current.style.transform = shift
    if (marks.current) marks.current.style.transform = shift
    if (gutter.current) gutter.current.style.transform = `translateY(${-el.scrollTop}px)`
    if (lineBar.current) lineBar.current.style.transform = `translateY(${-el.scrollTop}px)`
  }
  useEffect(syncScroll, [html, marksHtml, fontSize, cursor.line])

  const updateCursor = (): void => {
    const el = area.current
    if (!el) return
    const before = el.value.slice(0, el.selectionStart)
    const line = before.split('\n').length
    setCursor({ line, col: before.length - before.lastIndexOf('\n'), selected: el.selectionEnd - el.selectionStart, start: el.selectionStart, end: el.selectionEnd })
  }

  /** Select a range and bring it into view (vertically centred). */
  const reveal = (start: number, end: number, focus = true): void => {
    const el = area.current
    if (!el) return
    el.setSelectionRange(start, end)
    const line = el.value.slice(0, start).split('\n').length
    const top = (line - 1) * lineHeight
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
        setText(el.value)
      }
    }
    el.setSelectionRange(edit.start, edit.end)
    updateCursor()
    return true
  }

  const save = async (force = false): Promise<void> => {
    if (!file || saving || (!dirty && !force)) return
    setSaving(true)
    try {
      const current = text
      const r = await api.files.writeText(props.sid, props.entry.path, { text: current, eol: file.eol, bom: file.bom }, file.version, force)
      if (r.saved) {
        setFile({ ...file, version: r.version })
        setSavedText(current)
        props.onSaved()
      } else {
        setSaving(false)
        const ok = await confirm(
          r.conflict === 'deleted'
            ? { title: 'The File No Longer Exists', message: 'It was deleted or moved on the server after you opened it. Save your text as this file again?', confirmLabel: 'Save Anyway' }
            : {
                title: 'The File Changed on the Server',
                message: 'Someone or something changed this file after you opened it. Saving replaces those changes with your version.',
                confirmLabel: 'Overwrite',
                destructive: true
              }
        )
        if (ok) return save(true)
      }
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  const close = async (): Promise<void> => {
    if (dirty) {
      const ok = await confirm({ title: 'Discard Your Changes?', message: `Changes to “${props.entry.name}” have not been saved.`, confirmLabel: 'Discard', destructive: true })
      if (!ok) return
    }
    props.onClose()
  }

  // ------------------------------------------------------------ search --

  const openPanel = (p: Exclude<Panel, null>): void => {
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

  const findNext = (dir: 1 | -1, focusEditor = false): void => {
    const el = area.current
    if (!el || !query) return
    // search the live text, not the deferred copy
    const live = findMatches(el.value, search.re)
    if (live.length === 0) return
    let i = dir === 1 ? live.findIndex(([a]) => a >= el.selectionEnd) : live.findLastIndex(([, b]) => b <= el.selectionStart)
    if (i < 0) i = dir === 1 ? 0 : live.length - 1 // wrap around
    reveal(live[i][0], live[i][1], focusEditor)
  }

  const replaceOne = (): void => {
    const el = area.current
    if (!el || !search.re) return
    const live = findMatches(el.value, search.re)
    const hit = live.find(([a, b]) => a === el.selectionStart && b === el.selectionEnd)
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

  // ---------------------------------------------------------- keyboard --

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const el = e.currentTarget
    const s = { text: el.value, start: el.selectionStart, end: el.selectionEnd }
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const done = (handled: boolean): void => {
      if (handled) e.preventDefault()
    }
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
      if (key === ']' && !e.shiftKey) return always(s.text.slice(s.start, s.end).includes('\n') ? indent(s, unit) : indentLine(s))
      if (key === '[' && !e.shiftKey) return always(outdent(s, unit))
      if (key === 'u') return always(changeCase(s, e.shiftKey))
      if (key === '/' || key === '#' || (key === 'q' && !e.shiftKey)) {
        const prefix = lineCommentOf(language)
        e.preventDefault()
        if (prefix) apply(toggleComment(s, prefix))
        else toast.info(`${languageName(language)} has no line comments`)
        return
      }
      if ((key === 'c' || key === 'x') && !e.shiftKey && s.start === s.end) {
        // no selection: copy or cut the whole line
        e.preventDefault()
        const { from, to, block } = lineBlock(s)
        void api.clipboard.write(block + '\n')
        if (key === 'x') apply(deleteLines({ ...s, start: from, end: to }))
        return
      }
      return
    }

    if (key === 'Tab') return always(e.shiftKey ? outdent(s, unit) : indent(s, unit))
    if (key === 'Enter' && !e.shiftKey) return always(newline(s, unit))
    if (key === 'Backspace') return done(apply(backspace(s)))
    if (key === 'Home' && !e.shiftKey) {
      e.preventDefault()
      const pos = smartHome(s.text, s.start)
      el.setSelectionRange(pos, pos)
      updateCursor()
      return
    }
    if (e.key.length === 1) done(apply(typeChar(s, e.key)))
  }

  /** Ctrl+] on a single line indents the line instead of inserting at the caret. */
  const indentLine = (s: { text: string; start: number; end: number }): Edit => {
    const { from } = lineBlock(s)
    return { from, to: from, insert: unit, start: s.start + unit.length, end: s.end + unit.length }
  }

  const zoom = (delta: number): void => setFontSize((f) => (delta === 0 ? DEFAULT_FONT : Math.max(9, Math.min(28, Math.round((f + delta) * 2) / 2))))

  // shortcuts that work anywhere in the editor, including the find bar
  const onShortcut = (e: KeyboardEvent): void => {
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const take = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (ctrl && !e.shiftKey && !e.altKey && key === 's') take(() => void save())
    else if (ctrl && !e.shiftKey && !e.altKey && key === 'f') take(() => openPanel('find'))
    else if (ctrl && !e.shiftKey && !e.altKey && key === 'h') take(() => openPanel('replace'))
    else if (ctrl && !e.shiftKey && !e.altKey && key === 'g') take(() => openPanel('goto'))
    else if (e.key === 'F3') take(() => (query ? findNext(e.shiftKey ? -1 : 1, true) : openPanel('find')))
    else if (ctrl && (e.key === '+' || e.key === '=')) take(() => zoom(1))
    else if (ctrl && e.key === '-') take(() => zoom(-1))
    else if (ctrl && e.key === '0') take(() => zoom(0))
    else if (e.key === 'Escape' && panel) take(closePanel)
  }

  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) zoom(e.deltaY < 0 ? 1 : -1)
  }

  const toggle = (k: keyof SearchOptions, label: string, short: string) => (
    <button type="button" className="toggle" aria-pressed={opts[k]} title={label} aria-label={label} onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}>
      {short}
    </button>
  )

  return (
    <div style={{ display: 'contents' }} onKeyDown={onShortcut}>
      <Toolbar
        lead={<IconButton icon={ChevronLeft} label="Back to Files" onClick={() => void close()} />}
        title={props.entry.name}
        subtitle={
          <>
            {dirty ? <span className="signal warn">Edited</span> : file ? <span>Saved</span> : null}
            <span className="mono" style={{ marginLeft: 4 }}>
              {props.entry.path}
            </span>
          </>
        }
      >
        <IconButton icon={Search} label="Find (Ctrl+F)" disabled={!file} onClick={() => (panel === 'find' ? closePanel() : openPanel('find'))} />
        <IconButton icon={Replace} label="Find and Replace (Ctrl+H)" disabled={!file} onClick={() => (panel === 'replace' ? closePanel() : openPanel('replace'))} />
        <IconButton icon={Keyboard} label="Keyboard Shortcuts" onClick={() => setHelp(true)} />
        <IconButton icon={Download} label="Download" onClick={props.onDownload} />
        <button className="btn prominent" disabled={!file || !dirty || saving} onClick={() => void save()}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </Toolbar>

      <div className="view-fixed">
        {error ? (
          <div className="overlay" style={{ position: 'relative', flex: 1 }}>
            <div className="box">
              <h2>Can’t Open “{props.entry.name}”</h2>
              <p>{error}</p>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={props.onClose}>
                  Back to Files
                </button>
                <button className="btn prominent" onClick={props.onDownload}>
                  Download Instead
                </button>
              </div>
            </div>
          </div>
        ) : !file ? (
          <div className="overlay" style={{ position: 'relative', flex: 1 }}>
            <div className="box">
              <div className="spinner" />
              <p>Opening {props.entry.name}…</p>
            </div>
          </div>
        ) : (
          <>
            {(panel === 'find' || panel === 'replace') && (
              <div className="find-bar" role="search">
                <form
                  className="find-row"
                  onSubmit={(e) => {
                    e.preventDefault()
                    findNext(1)
                  }}
                >
                  <div className="search" style={{ width: 280 }}>
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
                    <div className="search" style={{ width: 280 }}>
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

            <div className="editor" style={{ ['--ed-fs' as string]: `${fontSize}px`, ['--ed-lh' as string]: `${lineHeight}px` }} onWheel={onWheel}>
              <div className="editor-gutter" aria-hidden="true">
                <pre ref={gutter}>{numbers}</pre>
              </div>
              <div className="editor-body">
                <div className="editor-layer" aria-hidden="true">
                  <div ref={lineBar} className="editor-line" style={{ top: 10 + (cursor.line - 1) * lineHeight }} />
                </div>
                {marksHtml !== null && (
                  <div className="editor-layer" aria-hidden="true">
                    <pre ref={marks} className="editor-marks" dangerouslySetInnerHTML={{ __html: marksHtml }} />
                  </div>
                )}
                {html !== null && (
                  <div className="editor-layer" aria-hidden="true">
                    <pre ref={code} dangerouslySetInnerHTML={{ __html: html }} />
                  </div>
                )}
                <textarea
                  ref={area}
                  className={html === null ? 'plain' : ''}
                  aria-label={`Contents of ${props.entry.name}`}
                  value={text}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  wrap="off"
                  onChange={(e) => {
                    setText(e.target.value)
                    updateCursor()
                  }}
                  onScroll={syncScroll}
                  onKeyDown={onKeyDown}
                  onKeyUp={updateCursor}
                  onClick={updateCursor}
                  onSelect={updateCursor}
                />
              </div>
            </div>
            <div className="editor-status">
              <span>{languageName(language)}</span>
              {html === null && <span>Colors are off for large files</span>}
              <span style={{ flex: 1 }} />
              <button className="link" style={{ color: 'inherit' }} onClick={() => openPanel('goto')} title="Go to Line (Ctrl+G)">
                Line {cursor.line}, Column {cursor.col}
              </button>
              {cursor.selected > 0 && <span>{cursor.selected} selected</span>}
              <span>{lineCount} lines</span>
              {fontSize !== DEFAULT_FONT && <span>{Math.round((fontSize / DEFAULT_FONT) * 100)} %</span>}
              <span>{unit === '\t' ? 'Tabs' : 'Spaces: 2'}</span>
              <span>{file.eol === 'crlf' ? 'CRLF' : file.eol === 'mixed' ? 'Mixed line endings, saved as LF' : 'LF'}</span>
              <span>UTF-8{file.bom ? ' with BOM' : ''}</span>
            </div>
          </>
        )}
      </div>

      {help && (
        <Sheet
          size="wide"
          title="Keyboard Shortcuts"
          onClose={() => setHelp(false)}
          footer={
            <button className="btn prominent" onClick={() => setHelp(false)} autoFocus>
              Done
            </button>
          }
        >
          {SHORTCUTS.map(([group, rows]) => (
            <div key={group}>
              <h3 className="group-title" style={{ marginTop: 4 }}>
                {group}
              </h3>
              <div className="group">
                {rows.map(([keys, what]) => (
                  <div className="row" key={keys} style={{ minHeight: 34, padding: '5px 14px' }}>
                    <span className="row-label" style={{ minWidth: 0 }}>
                      {what}
                    </span>
                    <span className="row-value">
                      <kbd>{keys}</kbd>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Sheet>
      )}
    </div>
  )
}
