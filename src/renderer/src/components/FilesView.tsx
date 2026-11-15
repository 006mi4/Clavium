import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Copy,
  CornerLeftUp,
  Eye,
  EyeOff,
  FilePenLine,
  Download,
  File as FileIcon,
  FileUp,
  FilePlus2,
  Folder,
  FolderPlus,
  FolderSearch,
  FolderSync,
  FolderTree as FolderTreeIcon,
  Info,
  Star,
  FolderUp,
  Link2,
  Pencil,
  RotateCw,
  Scissors,
  Search,
  Trash2,
  Undo2,
  Upload,
  X
} from 'lucide-react'
import type { HostSummary, MovePair, RemoteEntry, WatchStatus } from '@shared/types'
import { api, on } from '../api'
import { TransferPanel } from './Transfers'
import { SyncSheet, WatchBar } from './SyncSheet'
import { FolderTree, PropertiesSheet, SearchSheet, countOf, joinPath as join, parentOf } from './FileTools'
import { Empty, IconButton, Sheet, Toolbar, formatBytes, formatDate, useConfirm, useMenu, useToast, type MenuItem } from '../ui'
import { StatusDot, type ConnState } from './TerminalView'
import { registerEditorSession } from '../editor/registry'
import { getRemoteClip, lastUndo, popUndo, pushUndo, setRemoteClip, subscribeFileOps } from '../fileops'
import { EditorWorkspace, type WorkspaceApi } from './EditorWorkspace'
import { FILE_MANAGER, OS_NAME, isMac, keys, mod } from '../platform'

/** True when `child` is `parent` or lies below it. */
function isInside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent.replace(/\/+$/, '') + '/')
}
type SortKey = 'name' | 'size' | 'modifiedAt'
/** Folders with more entries than this draw only the rows that are in view. */
const VIRTUAL_FROM = 300
const OVERSCAN = 20
function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* a missing preference is not worth an error */
  }
}
function crumbsOf(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  const out = [{ label: '/', path: '/' }]
  parts.forEach((part, i) => out.push({ label: part, path: '/' + parts.slice(0, i + 1).join('/') }))
  return out
}

const STATE_TEXT: Record<ConnState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  closed: 'Disconnected',
  error: 'Connection failed'
}

export function FilesView(props: {
  host: HostSummary
  onState: (s: ConnState) => void
  onClose: () => void
  /** number of files with unsaved changes in the editor */
  onUnsaved: (n: number) => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const menu = useMenu()
  const [sid, setSid] = useState<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [error, setError] = useState('')
  const [cwd, setCwd] = useState('')
  const [pathEdit, setPathEdit] = useState<string | null>(null)
  /** everything in the current folder, as the server listed it */
  const [allEntries, setEntries] = useState<RemoteEntry[]>([])
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false })
  const [filter, setFilter] = useState('')
  const [showHidden, setShowHidden] = useState(() => readPref('files.showHidden', '1') === '1')
  const filterRef = useRef<HTMLInputElement>(null)
  const [propsFor, setPropsFor] = useState<RemoteEntry[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [allWatches, setWatches] = useState<WatchStatus[]>([])
  const watches = useMemo(() => allWatches.filter((w) => w.sessionId === sid), [allWatches, sid])
  useEffect(() => {
    void api.files.watchList().then(setWatches, () => undefined)
    return on('files:watch', (list: WatchStatus[]) => setWatches(list))
  }, [])
  const [showTree, setShowTree] = useState(() => readPref('files.tree', '1') === '1')
  const [bookmarks, setBookmarks] = useState<string[]>(props.host.bookmarks ?? [])
  /** the last listing, for the folder tree */
  const [listing, setListing] = useState<{ path: string; entries: RemoteEntry[] }>({ path: '', entries: [] })
  /** the row the keyboard is on */
  const [cursorPath, setCursorPath] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [rowHeight, setRowHeight] = useState(31)
  const [, setResized] = useState(0)
  const rowId = useId()
  /** select this item once its folder has loaded (coming from the search) */
  const revealAfterLoad = useRef<string | null>(null)
  const remember = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typed = useRef({ text: '', at: 0 })
  /** what the list shows: filtered and sorted, folders first */
  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = allEntries.filter((e) => (showHidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
    const dir = sort.desc ? -1 : 1
    return list.sort((a, b) => {
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1
      const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      if (sort.key === 'name') return dir * byName
      return dir * (a[sort.key] - b[sort.key]) || byName
    })
  }, [allEntries, sort, filter, showHidden])
  const hiddenCount = allEntries.length - entries.length
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  /** folder a drag is currently hovering over */
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  /** items of this browser that are being dragged right now */
  const [ownDrag, setOwnDrag] = useState<RemoteEntry[] | null>(null)
  const ownDragRef = useRef<RemoteEntry[] | null>(null)
  const [, rerender] = useState(0)
  useEffect(() => subscribeFileOps(() => rerender((n) => n + 1)), [])
  const [attempt, setAttempt] = useState(0)
  const [ask, setAsk] = useState<{ title: string; label: string; value: string; action: string; ok: (v: string) => void } | null>(null)
  const [mode, setMode] = useState<'list' | 'editor'>('list')
  const [request, setRequest] = useState<{ entry: RemoteEntry; nonce: number } | null>(null)
  const [openFiles, setOpenFiles] = useState(0)
  const edit = (entry: RemoteEntry): void => {
    setRequest({ entry, nonce: Date.now() })
    setMode('editor')
  }
  const workspaceApi = useRef<WorkspaceApi | null>(null)
  /** Double-click or Enter: folders are opened, files edited. A link may point to either. */
  const openEntry = (entry: RemoteEntry): void => {
    if (entry.type === 'file') return edit(entry)
    if (entry.type !== 'link' || !sidRef.current) return void load(entry.path)
    api.files
      .list(sidRef.current, entry.path)
      .then(() => load(entry.path))
      .catch(() => edit(entry))
  }

  // make this session's editor reachable for AI clients (through the MCP server)
  useEffect(() => {
    const wait = async <T,>(what: () => T | undefined, ms: number, message: string): Promise<T> => {
      const until = Date.now() + ms
      for (;;) {
        const v = what()
        if (v !== undefined) return v
        if (Date.now() > until) throw new Error(message)
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    return registerEditorSession({
      hostId: props.host.id,
      list: () => (workspaceApi.current?.list() ?? []).filter((d) => d.status === 'ready'),
      read: (path) => {
        if (!workspaceApi.current) throw new Error('This file is not open in the editor. Call editor_open_file first.')
        return workspaceApi.current.read(path)
      },
      edit: (path, e) => {
        if (!workspaceApi.current) throw new Error('This file is not open in the editor. Call editor_open_file first.')
        return workspaceApi.current.edit(path, e)
      },
      open: async (path) => {
        const id = await wait(() => sidRef.current ?? undefined, 30_000, 'Could not connect to the host.')
        const already = workspaceApi.current?.list().find((d) => d.path === path)
        const st = await api.files.stat(id, path)
        if (st.type === 'dir') throw new Error('This is a folder, not a file.')
        if (!already) edit({ ...st, path })
        const doc = await wait(
          () => workspaceApi.current?.list().find((d) => d.path === path && d.status !== 'loading'),
          30_000,
          'The file did not open in time.'
        )
        if (doc.status === 'error') throw new Error(doc.error ?? 'The file could not be opened.')
      }
    })
  }, [props.host.id])
  const lastClicked = useRef<number>(-1)
  const sidRef = useRef<string | null>(null)
  const cwdRef = useRef('')
  const protocolName = props.host.protocol === 'ssh' ? 'SFTP' : props.host.protocol === 'ftp' ? 'FTP' : 'FTPS'

  const report = (s: ConnState, msg = ''): void => {
    setState(s)
    setError(msg)
    props.onState(s)
  }

  const load = useCallback(async (path: string, id = sidRef.current) => {
    if (!id) return
    setLoading(true)
    try {
      const list = await api.files.list(id, path)
      setEntries(list)
      setListing({ path, entries: list })
      const moved = path !== cwdRef.current
      if (moved) setFilter('')
      setCwd(path)
      cwdRef.current = path
      const reveal = revealAfterLoad.current
      revealAfterLoad.current = null
      if (reveal && list.some((e) => e.path === reveal)) {
        setSelected(new Set([reveal]))
        setCursorPath(reveal)
      } else if (moved) {
        // A reload keeps what is selected, as far as it is still there.
        setSelected(new Set())
        setCursorPath(null)
        if (areaRef.current) areaRef.current.scrollTop = 0
      } else {
        const there = new Set(list.map((e) => e.path))
        setSelected((sel) => new Set([...sel].filter((p) => there.has(p))))
      }
      lastClicked.current = -1
      if (moved) {
        // The folder is remembered for the next visit, once the user has settled on it.
        if (remember.current) clearTimeout(remember.current)
        remember.current = setTimeout(() => void api.hosts.rememberPath(props.host.id, path).catch(() => undefined), 1500)
      }
    } catch (e) {
      toast.error(e)
    } finally {
      setLoading(false)
      setPathEdit(null)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    report('connecting')
    api.files
      .open(props.host.id)
      .then(async (id) => {
        if (cancelled) return void api.files.close(id)
        sidRef.current = id
        setSid(id)
        report('connected')
        // Back to where the user was last time, if that folder is still there.
        const last = cwdRef.current || props.host.lastPath
        const start = last && (await api.files.list(id, last).then(() => last, () => null))
        await load(start || (await api.files.home(id)), id)
      })
      .catch((e: Error) => !cancelled && report('error', e.message))
    return () => {
      cancelled = true
      if (sidRef.current) void api.files.close(sidRef.current)
      sidRef.current = null
    }
  }, [attempt])

  useEffect(() => {
    // an upload or a copy has put something on this server
    const offProg = on('files:changed', (id: string) => {
      if (id === sidRef.current) void load(cwdRef.current)
    })
    const offClosed = on('files:closed', (id: string) => {
      if (id === sidRef.current) {
        sidRef.current = null
        setSid(null)
        report('closed', 'The connection was closed.')
      }
    })
    return () => {
      offProg()
      offClosed()
    }
  }, [])

  const selEntries = entries.filter((e) => selected.has(e.path))

  const clickRow = (e: MouseEvent, entry: RemoteEntry, index: number): void => {
    setSelected((prev) => {
      const next = new Set(mod(e) ? prev : [])
      if (e.shiftKey && lastClicked.current >= 0) {
        const [a, b] = [lastClicked.current, index].sort((x, y) => x - y)
        entries.slice(a, b + 1).forEach((x) => next.add(x.path))
      } else if (mod(e) && prev.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    lastClicked.current = index
    setCursorPath(entry.path)
  }

  // ---- keyboard: arrows, paging, typing a name ----
  /** Scroll so that row `index` is in view. The header stays on top of the rows. */
  const showRow = (index: number): void => {
    const area = areaRef.current
    if (!area) return
    const header = area.querySelector('thead')?.getBoundingClientRect().height ?? 0
    const top = index * rowHeight
    if (top < area.scrollTop) area.scrollTop = top
    else if (header + top + rowHeight > area.scrollTop + area.clientHeight) area.scrollTop = header + top + rowHeight - area.clientHeight
  }
  const moveCursor = (to: number, extend: boolean): void => {
    if (entries.length === 0) return
    const index = Math.max(0, Math.min(entries.length - 1, to))
    if (extend && lastClicked.current >= 0) {
      const [a, b] = [lastClicked.current, index].sort((x, y) => x - y)
      setSelected(new Set(entries.slice(a, b + 1).map((x) => x.path)))
    } else {
      setSelected(new Set([entries[index].path]))
      lastClicked.current = index
    }
    setCursorPath(entries[index].path)
    showRow(index)
  }
  const listKey = (e: ReactKeyboardEvent): void => {
    if (e.target !== e.currentTarget) return
    const at = cursorPath ? entries.findIndex((x) => x.path === cursorPath) : -1
    const page = Math.max(1, Math.floor((areaRef.current?.clientHeight ?? 400) / rowHeight) - 2)
    const up = (): void => void (cwd !== '/' && load(parentOf(cwd)))
    let handled = true
    if (e.key === 'ArrowDown') {
      // Finder opens with Cmd+Down and goes up with Cmd+Up; Explorer goes up with Alt+Up.
      if (isMac && e.metaKey) selEntries.length === 1 && openEntry(selEntries[0])
      else moveCursor(at + 1, e.shiftKey)
    } else if (e.key === 'ArrowUp') {
      if (isMac ? e.metaKey : e.altKey) up()
      else moveCursor(at < 0 ? entries.length - 1 : at - 1, e.shiftKey)
    } else if (e.key === 'Home') moveCursor(0, e.shiftKey)
    else if (e.key === 'End') moveCursor(entries.length - 1, e.shiftKey)
    else if (e.key === 'PageDown') moveCursor(Math.max(at, 0) + page, e.shiftKey)
    else if (e.key === 'PageUp') moveCursor(Math.max(at, 0) - page, e.shiftKey)
    else if (e.key === 'Delete' || (isMac && e.metaKey && e.key === 'Backspace')) void remove(selEntries)
    else if (e.key === 'Backspace') up()
    else if (e.key === 'Enter' && (isMac ? false : e.altKey) && selEntries.length) setPropsFor(selEntries)
    else if (isMac && e.metaKey && e.key.toLowerCase() === 'i' && selEntries.length) setPropsFor(selEntries)
    else if (e.key === 'Enter' && selEntries.length === 1) openEntry(selEntries[0])
    else if (e.key === 'F2' && selEntries.length === 1) rename(selEntries[0])
    else if (mod(e) && e.key.toLowerCase() === 'a') setSelected(new Set(entries.map((x) => x.path)))
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key !== ' ' || typed.current.text)) {
      // Typing jumps to the first name that starts with what was typed.
      const now = Date.now()
      const text = (now - typed.current.at > 800 ? '' : typed.current.text) + e.key.toLowerCase()
      typed.current = { text, at: now }
      // A single letter typed again goes on to the next name with that letter.
      const from = text.length === 1 ? at + 1 : Math.max(at, 0)
      const order = [...entries.keys()].map((i) => (i + from) % entries.length)
      const hit = order.find((i) => entries[i].name.toLowerCase().startsWith(text))
      if (hit !== undefined) moveCursor(hit, false)
    } else handled = false
    if (handled) e.preventDefault()
  }
  useEffect(() => {
    // after a jump from the search, bring the item into view
    const i = cursorPath ? entries.findIndex((x) => x.path === cursorPath) : -1
    if (i >= 0) showRow(i)
  }, [entries, cursorPath])
  useEffect(() => {
    const onResize = (): void => setResized((n) => n + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // ---- bookmarks, search ----
  const saveBookmarks = (next: string[]): void => {
    setBookmarks(next)
    void api.hosts.setBookmarks(props.host.id, next).catch(toast.error)
  }
  const bookmarkMenu = (e: MouseEvent<HTMLElement>): void => {
    const marked = bookmarks.includes(cwd)
    const list: MenuItem[] = [
      marked
        ? { label: 'Remove Bookmark for This Folder', onSelect: () => saveBookmarks(bookmarks.filter((b) => b !== cwd)) }
        : { label: 'Add Bookmark for This Folder', icon: Star, onSelect: () => saveBookmarks([...bookmarks, cwd]) }
    ]
    if (bookmarks.length) list.push('separator')
    for (const b of bookmarks) list.push({ label: b, icon: Folder, onSelect: () => void load(b) })
    menu.openBelow(e, list)
  }
  const revealHit = (entry: RemoteEntry): void => {
    setSearching(false)
    revealAfterLoad.current = entry.path
    setFilter('')
    if (entry.name.startsWith('.') && !showHidden) toggleHidden()
    void load(parentOf(entry.path)).then(() => areaRef.current?.focus())
  }
  const toggleTree = (): void => {
    writePref('files.tree', showTree ? '0' : '1')
    setShowTree(!showTree)
  }

  const run = async (fn: () => Promise<unknown>, reload = true): Promise<void> => {
    try {
      await fn()
      if (reload) await load(cwdRef.current)
    } catch (e) {
      toast.error(e)
    }
  }

  const validName = (n: string): boolean => !!n && !n.includes('/') && n !== '.' && n !== '..'
  const newFolder = (): void =>
    setAsk({
      title: 'New Folder',
      label: 'Name',
      value: '',
      action: 'Create',
      ok: (name) => {
        if (validName(name) && sid) void run(() => api.files.mkdir(sid, join(cwd, name)))
      }
    })
  const newFile = (): void =>
    setAsk({
      title: 'New File',
      label: 'Name',
      value: '',
      action: 'Create',
      ok: (name) => {
        if (!validName(name) || !sid) return
        const path = join(cwd, name)
        void run(async () => {
          await api.files.createFile(sid, path)
          edit({ name, path, type: 'file', size: 0, modifiedAt: 0 })
        })
      }
    })
  const rename = (e: RemoteEntry): void =>
    setAsk({
      title: `Rename “${e.name}”`,
      label: 'New name',
      value: e.name,
      action: 'Rename',
      ok: (name) => {
        if (validName(name) && name !== e.name) void moveItems([{ from: e.path, to: join(cwd, name) }], `Rename of “${e.name}”`)
      }
    })

  // ---- moving, with undo ----
  const moveItems = async (pairs: MovePair[], label: string, done?: string): Promise<void> => {
    if (!sid || pairs.length === 0) return
    try {
      const r = await api.files.move(sid, pairs)
      if (r.moved.length) {
        pushUndo(props.host.id, { kind: 'move', label, pairs: r.moved })
        if (done) toast.ok(`${done} Press ${keys('Ctrl+Z')} to undo.`)
      }
      for (const f of r.failed) toast.error(`${f.name}: ${f.error}`)
    } catch (e) {
      toast.error(e)
    }
    await load(cwdRef.current)
  }
  /** Can these items be moved into `dir`? Not into themselves, and not to where they already are. */
  const canMove = (items: RemoteEntry[], dir: string): boolean =>
    items.every((e) => !isInside(e.path, dir)) && items.some((e) => parentOf(e.path) !== dir)
  const moveTo = (items: RemoteEntry[], dir: string): Promise<void> =>
    moveItems(
      items.filter((e) => parentOf(e.path) !== dir).map((e) => ({ from: e.path, to: join(dir, e.name) })),
      items.length === 1 ? `Move of “${items[0].name}”` : `Move of ${countOf(items.length)}`,
      `Moved ${items.length === 1 ? `“${items[0].name}”` : countOf(items.length)} to ${dir}.`
    )
  const undoStep = lastUndo(props.host.id)
  const undo = async (): Promise<void> => {
    const step = lastUndo(props.host.id)
    if (!step || !sid) return
    try {
      if (step.kind === 'move') {
        const r = await api.files.move(sid, [...step.pairs].reverse().map((p) => ({ from: p.to, to: p.from })))
        popUndo(props.host.id)
        for (const f of r.failed) toast.error(`${f.name} could not be moved back: ${f.error}`)
        if (r.moved.length) toast.ok(`Undone: ${step.label}`)
      } else {
        const ok = await confirm({
          title: `Undo ${step.label}?`,
          message: `This deletes the ${countOf(step.created.length)} that the copy created on the server.`,
          confirmLabel: 'Delete Copies',
          destructive: true
        })
        if (!ok) return
        popUndo(props.host.id)
        for (const path of step.created) await api.files.remove(sid, path, true)
        toast.ok(`Undone: ${step.label}`)
      }
    } catch (e) {
      toast.error(e)
    }
    await load(cwdRef.current)
  }

  // ---- uploading, copy and paste ----
  const uploadTo = async (dir: string, paths: string[]): Promise<void> => {
    if (!sid || paths.length === 0) return
    try {
      await api.files.uploadPaths(sid, dir, paths)
    } catch (e) {
      toast.error(e)
    }
  }
  const copyItems = async (items: RemoteEntry[], mode: 'copy' | 'cut'): Promise<void> => {
    if (!sid || items.length === 0) return
    setRemoteClip({ hostId: props.host.id, sid, entries: items, mode })
    toast.ok(`${mode === 'cut' ? 'Cut' : 'Copied'} ${countOf(items.length)}. Paste with ${keys('Ctrl+V')}.`)
    try {
      const r = await api.files.clipboardCopy(sid, items, mode === 'copy')
      if (r === 'too-large') toast.info(`Too large for the ${OS_NAME} clipboard. You can paste it inside Clavium, or drag it out to download it.`)
    } catch (e) {
      toast.error(e)
    }
  }
  const paste = async (dir: string): Promise<void> => {
    if (!sid) return
    try {
      const local = await api.files.clipboardFiles()
      if (local.length) return void (await uploadTo(dir, local))
      const clip = getRemoteClip()
      if (!clip) return toast.info(`Nothing to paste. Copy files here or in ${FILE_MANAGER} first.`)
      const sameHost = clip.hostId === props.host.id
      if (clip.mode === 'cut' && sameHost) {
        if (!canMove(clip.entries, dir)) return toast.info('These items are already in this folder.')
        setRemoteClip(null)
        return void (await moveTo(clip.entries, dir))
      }
      const r = await api.files.copy(sameHost ? sid : clip.sid, clip.entries, sid, dir)
      if (r.created.length) {
        pushUndo(props.host.id, {
          kind: 'copy',
          label: clip.entries.length === 1 ? `Copy of “${clip.entries[0].name}”` : `Copy of ${countOf(clip.entries.length)}`,
          created: r.created
        })
      }
      await load(cwdRef.current)
    } catch (e) {
      toast.error(e)
    }
  }
  const remove = async (items: RemoteEntry[]): Promise<void> => {
    if (!sid || items.length === 0) return
    const dirs = items.filter((e) => e.type === 'dir').length
    const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} Items`
    const ok = await confirm({
      title: `Delete ${what}?`,
      message: `${dirs ? 'Folders are deleted with everything inside. ' : ''}This is done on the server and can’t be undone.`,
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    void run(async () => {
      for (const e of items) await api.files.remove(sid, e.path, e.type === 'dir')
    })
  }
  const download = (items: RemoteEntry[]): void => {
    if (sid && items.length) void run(() => api.files.download(sid, items), false)
  }
  const upload = (kind: 'files' | 'folder'): void => {
    void api.files
      .pickLocal(kind)
      .then((paths) => uploadTo(cwdRef.current, paths))
      .catch(toast.error)
  }

  const rowMenu = (e: MouseEvent, entry: RemoteEntry, index: number): void => {
    e.stopPropagation()
    let items = selEntries
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]))
      lastClicked.current = index
      setCursorPath(entry.path)
      items = [entry]
    }
    const list: MenuItem[] = []
    if (items.length === 1 && entry.type !== 'file') list.push({ label: 'Open', icon: Folder, onSelect: () => void load(entry.path) })
    if (items.length === 1 && entry.type === 'file') list.push({ label: 'Edit', icon: FilePenLine, onSelect: () => edit(entry) })
    list.push({ label: items.length > 1 ? `Download ${items.length} Items` : 'Download…', icon: Download, onSelect: () => download(items) })
    list.push(
      'separator',
      { label: 'Cut', icon: Scissors, hint: keys('Ctrl+X'), onSelect: () => void copyItems(items, 'cut') },
      { label: 'Copy', icon: Copy, hint: keys('Ctrl+C'), onSelect: () => void copyItems(items, 'copy') }
    )
    if (items.length === 1 && entry.type === 'dir') {
      list.push({ label: 'Paste into Folder', icon: ClipboardPaste, onSelect: () => void paste(entry.path) })
    } else {
      list.push({ label: 'Paste', icon: ClipboardPaste, hint: keys('Ctrl+V'), onSelect: () => void paste(cwd) })
    }
    if (items.length === 1) list.push({ label: 'Rename…', icon: Pencil, hint: 'F2', onSelect: () => rename(entry) })
    list.push({ label: 'Properties…', icon: Info, hint: keys('Alt+Enter', '⌘I'), onSelect: () => setPropsFor(items) })
    list.push('separator', { label: 'Delete…', icon: Trash2, hint: keys('Del', '⌘⌫'), destructive: true, onSelect: () => void remove(items) })
    menu.openAt(e, list)
  }
  const toggleHidden = (): void => {
    writePref('files.showHidden', showHidden ? '0' : '1')
    setShowHidden(!showHidden)
  }
  const sortBy = (key: SortKey): void => setSort((cur) => ({ key, desc: cur.key === key ? !cur.desc : key !== 'name' }))
  const sortMark = (key: SortKey) => (sort.key === key ? sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} /> : null)
  const areaMenu = (e: MouseEvent): void => {
    menu.openAt(e, [
      { label: 'Paste', icon: ClipboardPaste, hint: keys('Ctrl+V'), onSelect: () => void paste(cwd) },
      { label: undoStep ? `Undo ${undoStep.label}` : 'Undo', icon: Undo2, hint: keys('Ctrl+Z'), disabled: !undoStep, onSelect: () => void undo() },
      'separator',
      { label: 'New File…', icon: FilePlus2, onSelect: newFile },
      { label: 'New Folder…', icon: FolderPlus, onSelect: newFolder },
      { label: 'Upload Files…', icon: FileUp, onSelect: () => upload('files') },
      { label: 'Upload Folder…', icon: FolderUp, onSelect: () => upload('folder') },
      'separator',
      { label: 'Search on the Server…', icon: FolderSearch, hint: keys('Ctrl+Shift+F'), onSelect: () => setSearching(true) },
      { label: 'Synchronise This Folder…', icon: FolderSync, onSelect: () => setSyncing(true) },
      { label: 'Properties of This Folder…', icon: Info, onSelect: () => setPropsFor([{ name: cwd === '/' ? '/' : cwd.split('/').pop()!, path: cwd, type: 'dir', size: 0, modifiedAt: 0 }]) },
      { label: showHidden ? 'Hide Hidden Files' : 'Show Hidden Files', icon: showHidden ? EyeOff : Eye, onSelect: toggleHidden },
      { label: 'Reload', icon: RotateCw, onSelect: () => void load(cwd) }
    ])
  }

  // ---- drag and drop ----
  // Rows are dragged as a real file drag of the system, so they can be dropped on the desktop or
  // in Explorer or Finder. Dropped inside this window, the same drag moves the items on the server instead.
  const startDrag = (e: DragEvent, entry: RemoteEntry): void => {
    e.preventDefault()
    if (!sid) return
    const items = selected.has(entry.path) ? selEntries : [entry]
    if (!selected.has(entry.path)) setSelected(new Set([entry.path]))
    ownDragRef.current = items
    setOwnDrag(items)
    api.files
      .dragOut(sid, items)
      .then((dir) => dir && toast.ok(`Downloading ${countOf(items.length)} to ${dir}`))
      .catch(toast.error)
      .finally(() => {
        ownDragRef.current = null
        setOwnDrag(null)
        setDropTarget(null)
      })
  }
  /** Props that make an element a drop target for the folder `dir`. */
  const dropProps = (dir: string) => ({
    'data-drop': dropTarget === dir || undefined,
    onDragOver: (e: DragEvent): void => {
      const own = ownDragRef.current
      if (!own && !e.dataTransfer.types.includes('Files')) return
      e.stopPropagation()
      if (!sid || (own && !canMove(own, dir))) return setDropTarget(null)
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDropTarget(dir)
    },
    onDrop: (e: DragEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      const own = ownDragRef.current
      if (own) {
        void api.files.dragCancel()
        if (canMove(own, dir)) void moveTo(own, dir)
        return
      }
      void uploadTo(dir, [...e.dataTransfer.files].map((f) => window.clavium.pathForFile(f)).filter(Boolean))
    }
  })
  // Ctrl+C / X / V / Z (Cmd on macOS) work whenever this file list is on screen, not only while it has the
  // keyboard focus (which is lost after every dialog). Text fields and open dialogs keep them.
  const areaRef = useRef<HTMLDivElement>(null)
  const shortcuts = useRef<Record<string, () => void>>({})
  shortcuts.current = {
    f: () => filterRef.current?.focus(),
    'shift+f': () => setSearching(true),
    c: () => void copyItems(selEntries, 'copy'),
    x: () => void copyItems(selEntries, 'cut'),
    v: () => void paste(cwd),
    z: () => void undo()
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = shortcuts.current[(e.shiftKey ? 'shift+' : '') + e.key.toLowerCase()]
      if (!action || !mod(e) || e.altKey || e.defaultPrevented) return
      if (!areaRef.current || areaRef.current.offsetParent === null) return // another tab or the editor is showing
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, select, [contenteditable], [role="dialog"]')) return
      if (document.querySelector('[role="dialog"]')) return
      if (e.key.toLowerCase() === 'c' && window.getSelection()?.toString()) return // copying selected text
      e.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const cutPaths = new Set(getRemoteClip()?.mode === 'cut' && getRemoteClip()?.hostId === props.host.id ? getRemoteClip()!.entries.map((e) => e.path) : [])

  const connected = !!sid

  // Large folders draw only the rows in view, with empty rows of the right height above and below.
  const virtual = entries.length > VIRTUAL_FROM
  const viewHeight = areaRef.current?.clientHeight ?? 800
  const first = virtual ? Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN) : 0
  const last = virtual ? Math.min(entries.length, Math.ceil((scrollTop + viewHeight) / rowHeight) + OVERSCAN) : entries.length
  const cursorIndex = cursorPath ? entries.findIndex((x) => x.path === cursorPath) : -1
  const measureRow = (el: HTMLTableRowElement | null): void => {
    const h = el?.getBoundingClientRect().height ?? 0
    if (h > 0 && Math.abs(h - rowHeight) > 0.25) setRowHeight(h)
  }

  return (
    <>
      {request && (
        <EditorWorkspace
          sid={sid}
          visible={mode === 'editor'}
          request={request}
          api={workspaceApi}
          onBack={() => setMode('list')}
          onReconnect={() => setAttempt((a) => a + 1)}
          onSaved={() => void load(cwdRef.current)}
          onDownload={(path, name) => download([{ name, path, type: 'file', size: 0, modifiedAt: 0 }])}
          onState={(open, unsaved) => {
            setOpenFiles(open)
            props.onUnsaved(unsaved)
          }}
        />
      )}
      <div style={{ display: mode === 'list' || openFiles === 0 ? 'contents' : 'none' }}>
      <Toolbar
        title={props.host.name}
        subtitle={
          <>
            <StatusDot state={state} />
            {STATE_TEXT[state]} · {protocolName}
          </>
        }
      >
        {openFiles > 0 && (
          <button className="btn" onClick={() => setMode('editor')}>
            <FilePenLine size={14} /> Editor · {openFiles}
          </button>
        )}
        <IconButton icon={FilePlus2} label="New File" disabled={!connected} onClick={newFile} />
        <IconButton icon={FolderPlus} label="New Folder" disabled={!connected} onClick={newFolder} />
        <IconButton
          icon={Upload}
          label="Upload"
          disabled={!connected}
          onClick={(e) =>
            menu.openBelow(e, [
              { label: 'Upload Files…', icon: FileUp, onSelect: () => upload('files') },
              { label: 'Upload Folder…', icon: FolderUp, onSelect: () => upload('folder') }
            ])
          }
        />
        <IconButton icon={Download} label="Download" disabled={!selEntries.length} onClick={() => download(selEntries)} />
        <IconButton icon={FolderSearch} label="Search on the Server" disabled={!connected} onClick={() => setSearching(true)} />
        <IconButton icon={FolderSync} label="Synchronise This Folder" disabled={!connected} onClick={() => setSyncing(true)} />
        <IconButton icon={Info} label="Properties" disabled={!selEntries.length} onClick={() => setPropsFor(selEntries)} />
        <IconButton icon={Undo2} label={undoStep ? `Undo ${undoStep.label}` : 'Undo'} disabled={!connected || !undoStep} onClick={() => void undo()} />
        <IconButton icon={Trash2} label="Delete" disabled={!selEntries.length} onClick={() => void remove(selEntries)} />
        <span className="sep" />
        <IconButton icon={X} label="Close Session" onClick={props.onClose} />
      </Toolbar>

      <div className="view-fixed">
        {!connected ? (
          <div className="overlay" style={{ position: 'relative', flex: 1 }}>
            <div className="box">
              {state === 'connecting' ? (
                <>
                  <div className="spinner" />
                  <p>Connecting to {props.host.hostname}…</p>
                </>
              ) : (
                <>
                  <h2>{state === 'error' ? 'Couldn’t Connect' : 'Session Ended'}</h2>
                  <p>{error || 'The connection was closed.'}</p>
                  <button className="btn prominent" onClick={() => setAttempt((a) => a + 1)}>
                    Reconnect
                  </button>
                </>
              )}
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '6px 12px', borderBottom: '1px solid var(--line)' }}>
              <span className="tree-toggle">
                <IconButton icon={FolderTreeIcon} label="Folder Tree" pressed={showTree} onClick={toggleTree} />
              </span>
              <span style={{ display: 'contents' }} {...(cwd === '/' ? {} : dropProps(parentOf(cwd)))} onDragLeave={() => setDropTarget(null)}>
                <IconButton icon={ArrowUp} label="Enclosing Folder" disabled={cwd === '/'} onClick={() => void load(parentOf(cwd))} />
              </span>
              <IconButton icon={RotateCw} label="Reload" onClick={() => void load(cwd)} />
              <IconButton icon={Star} label={bookmarks.includes(cwd) ? 'Bookmarks (This Folder Is Bookmarked)' : 'Bookmarks'} pressed={bookmarks.includes(cwd)} onClick={bookmarkMenu} />
              {pathEdit !== null ? (
                <form
                  style={{ flex: 1, marginLeft: 4 }}
                  onSubmit={(e) => {
                    e.preventDefault()
                    void load(pathEdit.trim() || '/')
                  }}
                >
                  <input
                    className="field mono"
                    aria-label="Path"
                    autoFocus
                    spellCheck={false}
                    value={pathEdit}
                    onChange={(e) => setPathEdit(e.target.value)}
                    onBlur={() => setPathEdit(null)}
                    onKeyDown={(e) => e.key === 'Escape' && setPathEdit(null)}
                  />
                </form>
              ) : (
                <div className="crumbs" style={{ marginLeft: 4 }} title="Click to type a path">
                  {crumbsOf(cwd).map((c, i) => (
                    <span key={c.path} style={{ display: 'contents' }}>
                      {i > 1 && <span className="slash">/</span>}
                      <button onClick={() => void load(c.path)} {...dropProps(c.path)} onDragLeave={() => setDropTarget(null)}>
                        {c.label}
                      </button>
                    </span>
                  ))}
                  <span className="fill" onClick={() => setPathEdit(cwd)} />
                </div>
              )}
              <div className="search" style={{ width: 190, marginLeft: 8 }}>
                <Search size={14} />
                <input
                  ref={filterRef}
                  className="field"
                  placeholder="Filter"
                  aria-label="Filter this folder"
                  spellCheck={false}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setFilter('')
                      areaRef.current?.focus()
                    }
                  }}
                />
              </div>
            </div>

            <WatchBar watches={watches} />
            <div className="file-split">
            {showTree && sid && (
              <FolderTree sid={sid} cwd={cwd} showHidden={showHidden} listing={listing} onOpen={(p) => void load(p)} dropProps={dropProps} onDragLeave={() => setDropTarget(null)} />
            )}
            <div
              ref={areaRef}
              className={`file-area${dropTarget === cwd ? ' drop-here' : ''}`}
              tabIndex={0}
              role="group"
              aria-label={`Files in ${cwd}`}
              aria-activedescendant={cursorIndex >= first && cursorIndex < last ? `${rowId}-${cursorIndex}` : undefined}
              {...dropProps(cwd)}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null)
              }}
              onContextMenu={areaMenu}
              onKeyDown={listKey}
              onScroll={(e) => virtual && setScrollTop(e.currentTarget.scrollTop)}
            >
              {ownDrag && cwd !== '/' && (
                <div className="drop-up" {...dropProps(parentOf(cwd))}>
                  <CornerLeftUp size={15} /> Drop here to move to {parentOf(cwd)}
                </div>
              )}
              {entries.length > 0 ? (
                <table className="table" role="grid" aria-multiselectable="true" aria-rowcount={entries.length + 1} aria-label={`Files in ${cwd}`}>
                  <thead>
                    <tr>
                      <th aria-sort={sort.key === 'name' ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                        <button className="sort" onClick={() => sortBy('name')}>
                          Name {sortMark('name')}
                        </button>
                      </th>
                      <th style={{ textAlign: 'right' }} aria-sort={sort.key === 'size' ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                        <button className="sort" onClick={() => sortBy('size')}>
                          {sortMark('size')} Size
                        </button>
                      </th>
                      <th aria-sort={sort.key === 'modifiedAt' ? (sort.desc ? 'descending' : 'ascending') : undefined}>
                        <button className="sort" onClick={() => sortBy('modifiedAt')}>
                          Modified {sortMark('modifiedAt')}
                        </button>
                      </th>
                      <th>Permissions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {first > 0 && (
                      <tr className="spacer" aria-hidden="true">
                        <td colSpan={4} style={{ height: first * rowHeight }} />
                      </tr>
                    )}
                    {entries.slice(first, last).map((e, k, shown, i = first + k) => (
                      <tr
                        key={e.path}
                        id={`${rowId}-${i}`}
                        ref={k === 0 ? measureRow : undefined}
                        aria-rowindex={i + 2}
                        aria-selected={selected.has(e.path)}
                        data-cursor={e.path === cursorPath || undefined}
                        data-cut={cutPaths.has(e.path) || undefined}
                        draggable
                        onDragStart={(ev) => startDrag(ev, e)}
                        {...(e.type === 'dir' ? dropProps(e.path) : {})}
                        onClick={(ev) => clickRow(ev, e, i)}
                        onContextMenu={(ev) => rowMenu(ev, e, i)}
                        onDoubleClick={() => openEntry(e)}
                      >
                        <td className="name">
                          {e.type === 'dir' ? <Folder size={16} className="dir" /> : e.type === 'link' ? <Link2 size={16} /> : <FileIcon size={16} />}
                          {e.name}
                        </td>
                        <td className="num">{e.type === 'dir' ? '—' : formatBytes(e.size)}</td>
                        <td className="dim">{formatDate(e.modifiedAt)}</td>
                        <td className="dim mono">{e.permissions ?? ''}</td>
                      </tr>
                    ))}
                    {last < entries.length && (
                      <tr className="spacer" aria-hidden="true">
                        <td colSpan={4} style={{ height: (entries.length - last) * rowHeight }} />
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                !loading &&
                (hiddenCount > 0 ? (
                  <Empty icon={Search} title="Nothing to Show">
                    {filter.trim() ? `No name in this folder contains “${filter.trim()}”.` : 'This folder only contains hidden files.'}
                  </Empty>
                ) : (
                  <Empty icon={Folder} title="This Folder Is Empty">
                    Drag files or folders from {FILE_MANAGER} into this window to upload them.
                  </Empty>
                ))
              )}
              {dropTarget && <div className="drop-pill">{ownDrag ? `Move to ${dropTarget}` : `Upload to ${dropTarget}`}</div>}
            </div>
            </div>
          </>
        )}

        <TransferPanel />
      </div>

      </div>
      {menu.element}
      {ask && <AskSheet {...ask} close={() => setAsk(null)} />}
      {propsFor && sid && (
        <PropertiesSheet sid={sid} canChown={props.host.protocol === 'ssh'} items={propsFor} close={() => setPropsFor(null)} changed={() => void load(cwdRef.current)} />
      )}
      {syncing && sid && <SyncSheet sid={sid} hostId={props.host.id} remoteDir={cwd} watching={watches} close={() => setSyncing(false)} />}
      {searching && sid && <SearchSheet sid={sid} root={cwd} onReveal={revealHit} close={() => setSearching(false)} />}
    </>
  )
}

function AskSheet(props: { title: string; label: string; value: string; action: string; ok: (v: string) => void; close: () => void }) {
  const [v, setV] = useState(props.value)
  const submit = (): void => {
    props.close()
    props.ok(v.trim())
  }
  return (
    <Sheet
      size="narrow"
      title={props.title}
      onClose={props.close}
      footer={
        <>
          <button className="btn" onClick={props.close}>
            Cancel
          </button>
          <button className="btn prominent" onClick={submit} disabled={!v.trim()}>
            {props.action}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (v.trim()) submit()
        }}
      >
        <input className="field" aria-label={props.label} autoFocus value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
      </form>
    </Sheet>
  )
}
