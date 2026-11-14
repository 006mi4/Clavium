import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import { ChevronLeft, ClipboardCopy, Columns2, Download, Keyboard, MoreHorizontal, Replace, RotateCw, Save, SaveAll, Search, WrapText, X, XCircle } from 'lucide-react'
import type { RemoteEntry, TextFile } from '@shared/types'
import { api } from '../api'
import { indentUnit } from '../editor/commands'
import { detectLanguage } from '../editor/highlight'
import { IconButton, Note, Sheet, Toolbar, useConfirm, useMenu, useToast, type MenuItem } from '../ui'
import { EditorPane, type EditorPaneHandle } from './EditorPane'

const DEFAULT_FONT = 12.5

interface Doc {
  path: string
  name: string
  status: 'loading' | 'ready' | 'error'
  error?: string
  meta?: Pick<TextFile, 'eol' | 'bom' | 'version'>
  text: string
  savedText: string
  /** language chosen by hand; otherwise detected from the name */
  language?: string
  /** the file changed on the server since it was opened */
  stale?: boolean
  saving?: boolean
}

interface Pane {
  tabs: string[]
  active: string | null
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Files and Tabs',
    [
      ['Ctrl+S / Ctrl+Shift+S', 'Save / save all'],
      ['Ctrl+W', 'Close tab'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab'],
      ['Ctrl+\\', 'Split the editor'],
      ['Alt+Z', 'Wrap long lines'],
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
      ['Ctrl+Z / Ctrl+Y', 'Undo / redo'],
      ['Tab / Shift+Tab', 'Indent / outdent (also Ctrl+] and Ctrl+[)'],
      ['Ctrl+/ or Ctrl+Q', 'Comment or uncomment lines'],
      ['Ctrl+U / Ctrl+Shift+U', 'lowercase / UPPERCASE'],
      ['( [ { " \'', 'Close brackets; wrap the selection'],
      ['Home', 'Start of text, then start of line']
    ]
  ]
]

/**
 * The editor of one file session: any number of open files in tabs, optionally split into two
 * panes. It stays mounted while files are open, so unsaved text survives switching back to the
 * file list, losing the connection or locking the vault.
 */
export function EditorWorkspace(props: {
  /** current file session, or null while disconnected */
  sid: string | null
  visible: boolean
  /** a file the user asked to open; `nonce` makes repeated requests for the same file distinct */
  request: { entry: RemoteEntry; nonce: number } | null
  onBack: () => void
  onReconnect: () => void
  onSaved: () => void
  onDownload: (path: string, name: string) => void
  /** reports open and unsaved file counts to the owner */
  onState: (open: number, unsaved: number) => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const menu = useMenu()
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  const [panes, setPanes] = useState<Pane[]>([{ tabs: [], active: null }])
  const [focus, setFocus] = useState(0)
  const [fontSize, setFontSize] = useState(DEFAULT_FONT)
  const [wrap, setWrap] = useState(false)
  const [help, setHelp] = useState(false)
  const handles = useRef(new Map<string, EditorPaneHandle>())
  const docsRef = useRef(docs)
  docsRef.current = docs
  const sidRef = useRef(props.sid)
  sidRef.current = props.sid

  const pane = panes[Math.min(focus, panes.length - 1)]
  const activeDoc = pane.active ? docs[pane.active] : undefined
  const isDirty = (d: Doc): boolean => d.status === 'ready' && d.text !== d.savedText
  const openCount = Object.keys(docs).length
  const unsaved = Object.values(docs).filter(isDirty).length

  useEffect(() => props.onState(openCount, unsaved), [openCount, unsaved])

  const patch = (path: string, p: Partial<Doc>): void => setDocs((d) => (d[path] ? { ...d, [path]: { ...d[path], ...p } } : d))

  const load = useCallback(async (path: string): Promise<void> => {
    const sid = sidRef.current
    if (!sid) return patch(path, { status: 'error', error: 'Not connected to the server.' })
    patch(path, { status: 'loading', error: undefined })
    try {
      const f = await api.files.readText(sid, path)
      patch(path, { status: 'ready', text: f.text, savedText: f.text, meta: { eol: f.eol, bom: f.bom, version: f.version }, stale: false })
    } catch (e) {
      patch(path, { status: 'error', error: (e as Error).message })
    }
  }, [])

  // open (or switch to) a requested file in the focused pane
  useEffect(() => {
    const r = props.request
    if (!r) return
    const path = r.entry.path
    const target = Math.min(focus, panes.length - 1)
    setPanes((ps) => ps.map((p, i) => (i === target ? { tabs: p.tabs.includes(path) ? p.tabs : [...p.tabs, path], active: path } : p)))
    if (!docsRef.current[path]) {
      setDocs((d) => ({ ...d, [path]: { path, name: r.entry.name, status: 'loading', text: '', savedText: '' } }))
      void load(path)
    }
  }, [props.request?.nonce])

  const focusEditor = (paneIndex: number, path: string | null): void => {
    if (path) requestAnimationFrame(() => handles.current.get(`${paneIndex}:${path}`)?.focus())
  }

  // ------------------------------------------------------------- saving --

  const save = async (path: string, force = false): Promise<boolean> => {
    const d = docsRef.current[path]
    const sid = sidRef.current
    if (!d || d.status !== 'ready' || !d.meta || d.saving) return false
    if (!sid) {
      toast.error('Not connected. Reconnect to save.')
      return false
    }
    if (!isDirty(d) && !force) return true
    patch(path, { saving: true })
    try {
      const textNow = d.text
      const r = await api.files.writeText(sid, path, { text: textNow, eol: d.meta.eol, bom: d.meta.bom }, d.meta.version, force)
      if (r.saved) {
        patch(path, { savedText: textNow, meta: { ...d.meta, version: r.version }, stale: false, saving: false })
        props.onSaved()
        return true
      }
      patch(path, { saving: false, stale: r.conflict === 'changed' })
      const ok = await confirm(
        r.conflict === 'deleted'
          ? { title: 'The File No Longer Exists', message: `“${d.name}” was deleted or moved on the server after you opened it. Save your text as this file again?`, confirmLabel: 'Save Anyway' }
          : {
              title: 'The File Changed on the Server',
              message: `Someone or something changed “${d.name}” after you opened it. Saving replaces those changes with your version.`,
              confirmLabel: 'Overwrite',
              destructive: true
            }
      )
      return ok ? save(path, true) : false
    } catch (e) {
      patch(path, { saving: false })
      toast.error(e)
      return false
    }
  }

  const saveAll = async (): Promise<void> => {
    for (const d of Object.values(docsRef.current)) if (isDirty(d)) await save(d.path)
  }

  const reload = async (path: string): Promise<void> => {
    const d = docsRef.current[path]
    if (!d) return
    if (isDirty(d)) {
      const ok = await confirm({ title: 'Reload and Discard Your Changes?', message: `Unsaved changes to “${d.name}” are replaced with the version on the server.`, confirmLabel: 'Reload', destructive: true })
      if (!ok) return
    }
    await load(path)
  }

  // Did the file change on the server? Checked when a tab becomes active or the window regains focus.
  const checkStale = useCallback(async (path: string | null): Promise<void> => {
    const d = path ? docsRef.current[path] : undefined
    const sid = sidRef.current
    if (!d || !sid || d.status !== 'ready' || !d.meta || d.saving) return
    try {
      const st = await api.files.stat(sid, d.path)
      const now = docsRef.current[d.path]
      if (now?.meta && !now.saving && (st.size !== now.meta.version.size || st.modifiedAt !== now.meta.version.modifiedAt)) patch(d.path, { stale: true })
    } catch {
      /* deleted or unreachable: saving will report it */
    }
  }, [])
  useEffect(() => {
    if (props.visible) void checkStale(pane.active)
    const onFocus = (): void => void checkStale(pane.active)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [pane.active, props.visible, props.sid])

  // -------------------------------------------------------------- tabs --

  /** Close tabs after asking about unsaved files that would disappear. */
  const closeTabs = async (paneIndex: number, paths: string[]): Promise<void> => {
    const other = panes.filter((_, i) => i !== paneIndex).flatMap((p) => p.tabs)
    const vanishing = paths.filter((p) => !other.includes(p))
    const dirty = vanishing.map((p) => docsRef.current[p]).filter((d) => d && isDirty(d))
    if (dirty.length > 0) {
      const ok = await confirm({
        title: dirty.length === 1 ? `Discard Changes to “${dirty[0].name}”?` : `Discard Changes to ${dirty.length} Files?`,
        message: 'Your changes have not been saved to the server.',
        confirmLabel: 'Discard',
        destructive: true
      })
      if (!ok) return
    }
    let next = panes.map((p, i) => {
      if (i !== paneIndex) return p
      const tabs = p.tabs.filter((t) => !paths.includes(t))
      const at = p.active ? p.tabs.indexOf(p.active) : 0
      return { tabs, active: p.active && tabs.includes(p.active) ? p.active : (tabs[Math.min(at, tabs.length - 1)] ?? null) }
    })
    if (next.length > 1) next = next.filter((p) => p.tabs.length > 0) // an empty pane closes the split
    if (next.length === 0) next = [{ tabs: [], active: null }]
    const still = new Set(next.flatMap((p) => p.tabs))
    setDocs((d) => Object.fromEntries(Object.entries(d).filter(([p]) => still.has(p))))
    setPanes(next)
    const f = Math.min(focus, next.length - 1)
    setFocus(f)
    if (still.size === 0) props.onBack()
    else focusEditor(f, next[f].active)
  }

  const activate = (paneIndex: number, path: string): void => {
    setPanes((ps) => ps.map((p, i) => (i === paneIndex ? { ...p, active: path } : p)))
    setFocus(paneIndex)
    focusEditor(paneIndex, path)
  }

  const toggleSplit = (): void => {
    if (panes.length === 1) {
      if (!pane.active) return
      // show the active file a second time, side by side
      setPanes([pane, { tabs: [pane.active], active: pane.active }])
      setFocus(1)
      focusEditor(1, pane.active)
    } else {
      // merge the second pane's tabs into the first; nothing is closed
      const merged = [...panes[0].tabs, ...panes[1].tabs.filter((t) => !panes[0].tabs.includes(t))]
      const active = panes[focus].active ?? panes[0].active
      setPanes([{ tabs: merged, active }])
      setFocus(0)
      focusEditor(0, active)
    }
  }

  const moveToOtherPane = (paneIndex: number, path: string): void => {
    const to = paneIndex === 0 ? 1 : 0
    let next = panes.length === 1 ? [...panes, { tabs: [], active: null } as Pane] : panes.map((p) => ({ ...p }))
    next[to] = { tabs: next[to].tabs.includes(path) ? next[to].tabs : [...next[to].tabs, path], active: path }
    const rest = next[paneIndex].tabs.filter((t) => t !== path)
    next[paneIndex] = { tabs: rest, active: next[paneIndex].active === path ? (rest[0] ?? null) : next[paneIndex].active }
    next = next.filter((p) => p.tabs.length > 0)
    setPanes(next)
    const f = Math.max(0, next.findIndex((p) => p.active === path && p.tabs.includes(path)))
    setFocus(f)
    focusEditor(f, path)
  }

  const tabMenu = (e: MouseEvent, paneIndex: number, path: string): void => {
    const p = panes[paneIndex]
    const items: MenuItem[] = [
      { label: 'Close', icon: X, onSelect: () => void closeTabs(paneIndex, [path]) },
      { label: 'Close Others', icon: XCircle, disabled: p.tabs.length < 2, onSelect: () => void closeTabs(paneIndex, p.tabs.filter((t) => t !== path)) },
      { label: 'Close All', icon: XCircle, onSelect: () => void closeTabs(paneIndex, p.tabs) },
      'separator',
      { label: panes.length === 1 ? 'Open to the Side' : 'Move to Other Side', icon: Columns2, onSelect: () => (panes.length === 1 && p.tabs.length === 1 ? toggleSplit() : moveToOtherPane(paneIndex, path)) },
      'separator',
      { label: 'Reload from Server', icon: RotateCw, disabled: !props.sid, onSelect: () => void reload(path) },
      { label: 'Download…', icon: Download, disabled: !props.sid, onSelect: () => props.onDownload(path, docs[path]?.name ?? path) },
      { label: 'Copy Path', icon: ClipboardCopy, onSelect: () => void api.clipboard.write(path).then(() => toast.ok('Path copied')) }
    ]
    menu.openAt(e, items)
  }

  // ---------------------------------------------------------- keyboard --

  const zoom = (delta: number): void => setFontSize((f) => (delta === 0 ? DEFAULT_FONT : Math.max(9, Math.min(28, Math.round((f + delta) * 2) / 2))))
  const paneCommand = (p: 'find' | 'replace'): void => {
    if (pane.active) handles.current.get(`${Math.min(focus, panes.length - 1)}:${pane.active}`)?.openPanel(p)
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    const take = (fn: () => void): void => {
      e.preventDefault()
      e.stopPropagation()
      fn()
    }
    if (ctrl && !e.altKey && key === 's') take(() => (e.shiftKey ? void saveAll() : pane.active && void save(pane.active)))
    else if (ctrl && !e.shiftKey && !e.altKey && key === 'w') take(() => pane.active && void closeTabs(Math.min(focus, panes.length - 1), [pane.active]))
    else if (ctrl && e.key === 'Tab' && pane.tabs.length > 1) {
      take(() => {
        const i = pane.tabs.indexOf(pane.active ?? '')
        activate(Math.min(focus, panes.length - 1), pane.tabs[(i + (e.shiftKey ? -1 : 1) + pane.tabs.length) % pane.tabs.length])
      })
    } else if (ctrl && !e.shiftKey && e.key === '\\') take(toggleSplit)
    else if (e.altKey && !ctrl && key === 'z') take(() => setWrap((w) => !w))
    else if (ctrl && (e.key === '+' || e.key === '=')) take(() => zoom(1))
    else if (ctrl && e.key === '-') take(() => zoom(-1))
    else if (ctrl && e.key === '0') take(() => zoom(0))
  }
  const onWheel = (e: WheelEvent): void => {
    if (e.ctrlKey) zoom(e.deltaY < 0 ? 1 : -1)
  }

  // -------------------------------------------------------------- view --

  if (openCount === 0) return null

  return (
    <div style={{ display: props.visible ? 'contents' : 'none' }} onKeyDown={onKeyDown}>
      {props.visible && (
        <Toolbar
          lead={<IconButton icon={ChevronLeft} label="Back to Files" onClick={props.onBack} />}
          title={activeDoc?.name ?? 'Editor'}
          subtitle={
            activeDoc && (
              <>
                {activeDoc.status === 'ready' && (isDirty(activeDoc) ? <span className="signal warn">Edited</span> : <span>Saved</span>)}
                <span className="mono" style={{ marginLeft: 4 }}>
                  {activeDoc.path}
                </span>
              </>
            )
          }
        >
          <IconButton icon={Search} label="Find (Ctrl+F)" disabled={activeDoc?.status !== 'ready'} onClick={() => paneCommand('find')} />
          <IconButton icon={Replace} label="Find and Replace (Ctrl+H)" disabled={activeDoc?.status !== 'ready'} onClick={() => paneCommand('replace')} />
          <span className="sep" />
          <IconButton icon={Columns2} label={panes.length === 1 ? 'Split Editor (Ctrl+\\)' : 'Close Split (Ctrl+\\)'} pressed={panes.length > 1} onClick={toggleSplit} />
          <IconButton icon={WrapText} label="Wrap Long Lines (Alt+Z)" pressed={wrap} onClick={() => setWrap((w) => !w)} />
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onClick={(e) =>
              menu.openBelow(e, [
                { label: 'Save All', icon: SaveAll, disabled: unsaved === 0, onSelect: () => void saveAll() },
                { label: 'Reload from Server', icon: RotateCw, disabled: !activeDoc || !props.sid, onSelect: () => activeDoc && void reload(activeDoc.path) },
                { label: 'Download…', icon: Download, disabled: !activeDoc || !props.sid, onSelect: () => activeDoc && props.onDownload(activeDoc.path, activeDoc.name) },
                'separator',
                { label: 'Keyboard Shortcuts', icon: Keyboard, onSelect: () => setHelp(true) }
              ])
            }
          />
          <button className="btn prominent" disabled={!activeDoc || !isDirty(activeDoc) || activeDoc.saving || !props.sid} onClick={() => activeDoc && void save(activeDoc.path)}>
            <Save size={14} /> {activeDoc?.saving ? 'Saving…' : 'Save'}
          </button>
        </Toolbar>
      )}

      <div className="view-fixed" style={props.visible ? undefined : { display: 'none' }} onWheel={onWheel}>
        {!props.sid && (
          <div style={{ padding: '8px 12px 0' }}>
            <Note kind="warn">
              The connection to the server is closed. Your text is still here.{' '}
              <button className="link" onClick={props.onReconnect}>
                Reconnect
              </button>{' '}
              to save it.
            </Note>
          </div>
        )}
        <div className="ed-panes">
          {panes.map((p, pi) => {
            const doc = p.active ? docs[p.active] : undefined
            return (
              <div className={`ed-pane${panes.length > 1 && pi === Math.min(focus, panes.length - 1) ? ' focused' : ''}`} key={pi} onMouseDownCapture={() => setFocus(pi)}>
                <div className="ed-tabs" role="tablist">
                  {p.tabs.map((path) => {
                    const d = docs[path]
                    if (!d) return null
                    return (
                      <div
                        key={path}
                        role="tab"
                        aria-selected={p.active === path}
                        className="ed-tab"
                        title={path}
                        onClick={() => activate(pi, path)}
                        onAuxClick={(e) => e.button === 1 && void closeTabs(pi, [path])}
                        onContextMenu={(e) => tabMenu(e, pi, path)}
                      >
                        <span className="name">{d.name}</span>
                        <button
                          className={`x${isDirty(d) ? ' dirty' : ''}`}
                          aria-label={`Close ${d.name}${isDirty(d) ? ' (unsaved)' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            void closeTabs(pi, [path])
                          }}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )
                  })}
                </div>

                {doc?.stale && doc.status === 'ready' && (
                  <div style={{ padding: '8px 12px 0' }}>
                    <Note kind="warn">
                      This file changed on the server.{' '}
                      <button className="link" onClick={() => void reload(doc.path)}>
                        Reload
                      </button>{' '}
                      to see the new version{isDirty(doc) ? '; your unsaved changes would be lost' : ''}.
                    </Note>
                  </div>
                )}

                {doc && doc.status !== 'ready' && (
                  <div className="overlay" style={{ position: 'relative', flex: 1 }}>
                    <div className="box">
                      {doc.status === 'loading' ? (
                        <>
                          <div className="spinner" />
                          <p>Opening {doc.name}…</p>
                        </>
                      ) : (
                        <>
                          <h2>Can’t Open “{doc.name}”</h2>
                          <p>{doc.error}</p>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button className="btn" onClick={() => void closeTabs(pi, [doc.path])}>
                              Close Tab
                            </button>
                            <button className="btn prominent" disabled={!props.sid} onClick={() => props.onDownload(doc.path, doc.name)}>
                              Download Instead
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {p.tabs.map((path) => {
                  const d = docs[path]
                  if (!d || d.status !== 'ready' || !d.meta) return null
                  const key = `${pi}:${path}`
                  return (
                    <EditorPane
                      key={key}
                      ref={(h) => {
                        if (h) handles.current.set(key, h)
                        else handles.current.delete(key)
                      }}
                      name={d.name}
                      text={d.text}
                      language={d.language ?? detectLanguage(d.name, d.savedText.slice(0, 200).split('\n')[0])}
                      unit={indentUnit(d.savedText)}
                      eol={d.meta.eol}
                      bom={d.meta.bom}
                      visible={props.visible && p.active === path}
                      live={pi === Math.min(focus, panes.length - 1) || !panes.some((o, oi) => oi !== pi && o.active === path)}
                      fontSize={fontSize}
                      defaultFontSize={DEFAULT_FONT}
                      wrap={wrap}
                      onChange={(t) => patch(path, { text: t })}
                      onLanguage={(id) => patch(path, { language: id })}
                      onFocus={() => setFocus(pi)}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {menu.element}
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
