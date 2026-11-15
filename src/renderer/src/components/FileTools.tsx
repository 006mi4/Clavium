import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, File as FileIcon, Folder, Link2 } from 'lucide-react'
import type { ChmodOptions, FolderSize, RemoteEntry, SearchResult, SearchUpdate, TreeChange } from '@shared/types'
import { api, on } from '../api'
import { Select, Sheet, formatBytes, formatDate, useToast } from '../ui'

export function parentOf(p: string): string {
  if (p === '/' || !p.includes('/')) return '/'
  const up = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
  return up || '/'
}
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}
export function countOf(n: number): string {
  return n === 1 ? '1 item' : `${n.toLocaleString()} items`
}
/** "rwxr-xr-x" as a number */
export function modeOf(permissions: string | undefined): number {
  let mode = 0
  for (let i = 0; i < 9; i++) if (permissions && permissions[i] && permissions[i] !== '-') mode |= 1 << (8 - i)
  return mode
}
const BITS = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x']
const newToken = (): string => crypto.randomUUID()
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

// ------------------------------------------------------------ folder tree --

/** More folders than this in one place are not all drawn in the tree; the list shows them. */
const TREE_LIMIT = 500

type Children = string[] | 'loading' | 'error'

interface TreeRow {
  path: string
  name: string
  level: number
  expanded: boolean
  note?: string
}

/**
 * The folders of the server as a tree. Folders are read when they are opened; the folder the list
 * shows is taken from the list, so browsing costs no extra requests.
 */
export function FolderTree(props: {
  sid: string
  cwd: string
  showHidden: boolean
  /** What the list has just loaded. */
  listing: { path: string; entries: RemoteEntry[] }
  onOpen: (path: string) => void
  /** Makes a folder a target for dragged items. */
  dropProps: (dir: string) => object
  onDragLeave: () => void
}) {
  const [nodes, setNodes] = useState<Map<string, Children>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['/']))
  const [focus, setFocus] = useState('/')
  const treeRef = useRef<HTMLDivElement>(null)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const put = (path: string, value: Children): void => setNodes((m) => new Map(m).set(path, value))
  const fetch = (path: string): void => {
    put(path, 'loading')
    api.files
      .list(props.sid, path)
      .then((items) => put(path, items.filter((e) => e.type === 'dir').map((e) => e.name)))
      .catch(() => put(path, 'error'))
  }

  // a new connection knows nothing yet
  useEffect(() => {
    setNodes(new Map())
  }, [props.sid])

  useEffect(() => {
    put(props.listing.path, props.listing.entries.filter((e) => e.type === 'dir').map((e) => e.name))
  }, [props.listing])

  // the way to the current folder is open
  useEffect(() => {
    if (!props.cwd) return
    const chain: string[] = ['/']
    for (let p = props.cwd; p !== '/'; p = parentOf(p)) chain.push(p)
    setExpanded((s) => new Set([...s, ...chain]))
    for (const p of chain) if (p !== props.cwd && !nodesRef.current.has(p)) fetch(p)
    setFocus(props.cwd)
  }, [props.cwd, props.sid])

  const rows = useMemo(() => {
    const out: TreeRow[] = []
    const add = (path: string, name: string, level: number): void => {
      const open = expanded.has(path)
      out.push({ path, name, level, expanded: open })
      if (!open) return
      const children = nodes.get(path)
      if (children === 'loading' || children === undefined) return void out.push({ path: path + '\0', name: '', level: level + 1, expanded: false, note: 'Loading…' })
      if (children === 'error') return void out.push({ path: path + '\0', name: '', level: level + 1, expanded: false, note: 'Can’t be read' })
      const shown = children.filter((n) => props.showHidden || !n.startsWith('.')).sort(byName)
      for (const child of shown.slice(0, TREE_LIMIT)) add(joinPath(path, child), child, level + 1)
      if (shown.length > TREE_LIMIT) out.push({ path: path + '\0', name: '', level: level + 1, expanded: false, note: `${(shown.length - TREE_LIMIT).toLocaleString()} more in the list` })
    }
    add('/', '/', 1)
    return out
  }, [nodes, expanded, props.showHidden])

  const items = rows.filter((r) => !r.note)
  const toggle = (row: TreeRow, open = !row.expanded): void => {
    setExpanded((s) => {
      const next = new Set(s)
      if (open) next.add(row.path)
      else next.delete(row.path)
      return next
    })
    // opened again: read again, the folder may have changed
    if (open && row.path !== props.cwd) fetch(row.path)
  }
  const focusRow = (path: string): void => {
    setFocus(path)
    // At once, not a frame later: the next key press must already land on the new row.
    const all = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []
    for (const el of all) if (el.dataset.path === path) el.focus()
  }
  const onKey = (e: KeyboardEvent, row: TreeRow): void => {
    const i = items.findIndex((r) => r.path === row.path)
    const go = (r: TreeRow | undefined): void => {
      if (r) focusRow(r.path)
    }
    switch (e.key) {
      case 'ArrowDown':
        go(items[i + 1])
        break
      case 'ArrowUp':
        go(items[i - 1])
        break
      case 'Home':
        go(items[0])
        break
      case 'End':
        go(items.at(-1))
        break
      case 'ArrowRight':
        if (!row.expanded) toggle(row, true)
        else go(items[i + 1]?.level > row.level ? items[i + 1] : undefined)
        break
      case 'ArrowLeft':
        if (row.expanded) toggle(row, false)
        else go(items.find((r) => r.path === parentOf(row.path) && row.path !== '/'))
        break
      case 'Enter':
      case ' ':
        props.onOpen(row.path)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  const focusable = items.some((r) => r.path === focus) ? focus : '/'

  return (
    <div className="tree" role="tree" aria-label="Folders" ref={treeRef} onDragLeave={props.onDragLeave}>
      {rows.map((row) =>
        row.note ? (
          <div key={row.path} className="tree-note" style={{ paddingLeft: 8 + (row.level - 1) * 14 + 20 }}>
            {row.note}
          </div>
        ) : (
          <div
            key={row.path}
            role="treeitem"
            data-path={row.path}
            aria-level={row.level}
            aria-expanded={row.expanded}
            aria-selected={row.path === props.cwd}
            aria-label={row.path === '/' ? 'Root folder' : row.name}
            tabIndex={row.path === focusable ? 0 : -1}
            className="tree-item"
            style={{ paddingLeft: 8 + (row.level - 1) * 14 }}
            onClick={() => {
              setFocus(row.path)
              props.onOpen(row.path)
            }}
            onKeyDown={(e) => onKey(e, row)}
            onFocus={() => setFocus(row.path)}
            {...props.dropProps(row.path)}
          >
            <span
              className="twisty"
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation()
                toggle(row)
              }}
            >
              {row.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <Folder size={15} className="dir" aria-hidden="true" />
            <span className="label">{row.name}</span>
          </div>
        )
      )}
    </div>
  )
}

// ----------------------------------------------------------------- search --

/** Search by name in a folder and everything below it. */
export function SearchSheet(props: { sid: string; root: string; onReveal: (entry: RemoteEntry) => void; close: () => void }) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<RemoteEntry[]>([])
  const [scanned, setScanned] = useState(0)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const token = useRef('')

  useEffect(() => {
    const off = on('files:searchHits', (u: SearchUpdate) => {
      if (u.token !== token.current) return
      if (u.hits.length) setHits((h) => [...h, ...u.hits])
      setScanned(u.scanned)
    })
    return () => {
      off()
      if (token.current) void api.files.cancelWork(token.current)
    }
  }, [])

  const start = (): void => {
    const q = query.trim()
    if (!q) return
    if (token.current) void api.files.cancelWork(token.current)
    const mine = (token.current = newToken())
    setHits([])
    setScanned(0)
    setResult(null)
    setRunning(true)
    api.files
      .search(props.sid, props.root, q, mine)
      .then((r) => mine === token.current && setResult(r))
      .catch((e) => mine === token.current && toast.error(e))
      .finally(() => mine === token.current && setRunning(false))
  }
  const status = running
    ? `Searching, ${scanned.toLocaleString()} items checked, ${hits.length.toLocaleString()} found`
    : result
      ? [
          `${result.found.toLocaleString()} found in ${result.scanned.toLocaleString()} items`,
          result.ended === 'limit' ? 'Stopped at the limit: narrow the search to see the rest.' : result.ended === 'stopped' ? 'Stopped early.' : '',
          result.unreadable ? `${result.unreadable} ${result.unreadable === 1 ? 'folder' : 'folders'} could not be read.` : ''
        ]
          .filter(Boolean)
          .join('. ')
          .replace(/\.\./g, '.')
      : 'Finds files and folders whose name contains the text. Use * and ? for patterns, such as *.log.'

  return (
    <Sheet
      size="wide"
      title="Search on the Server"
      eyebrow={`In ${props.root} and all folders below`}
      onClose={props.close}
      footer={
        <button className="btn" onClick={props.close}>
          Close
        </button>
      }
    >
      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault()
          start()
        }}
      >
        <input className="field" aria-label="Name to search for" placeholder="Name or pattern" autoFocus spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
        {running ? (
          <button type="button" className="btn" onClick={() => void api.files.cancelWork(token.current)}>
            Stop
          </button>
        ) : (
          <button type="submit" className="btn prominent" disabled={!query.trim()}>
            Search
          </button>
        )}
      </form>
      <p className="caption" role="status" aria-live="polite">
        {status}
      </p>
      {hits.length > 0 && (
        <ul className="search-hits" aria-label="Search results">
          {hits.map((h) => (
            <li key={h.path}>
              <button type="button" onClick={() => props.onReveal(h)}>
                {h.type === 'dir' ? <Folder size={15} className="dir" /> : h.type === 'link' ? <Link2 size={15} /> : <FileIcon size={15} />}
                <span className="hit-name">{h.name}</span>
                <span className="hit-where">{parentOf(h.path)}</span>
                <span className="hit-size">{h.type === 'dir' ? '' : formatBytes(h.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}

// ------------------------------------------------------------- properties --

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{children}</td>
    </tr>
  )
}

const KIND: Record<RemoteEntry['type'], string> = { file: 'File', dir: 'Folder', link: 'Link', other: 'Special file' }

/**
 * Everything about one or more items: where they are, how large, who owns them, and the
 * permissions, which can be changed here, for folders also with everything inside.
 */
export function PropertiesSheet(props: { sid: string; canChown: boolean; items: RemoteEntry[]; close: () => void; changed: () => void }) {
  const toast = useToast()
  const { items } = props
  const one = items.length === 1 ? items[0] : null
  const hasFolders = items.some((e) => e.type === 'dir')
  const [mode, setMode] = useState(() => modeOf(items[0].permissions))
  const [touched, setTouched] = useState(false)
  const [recursive, setRecursive] = useState(false)
  const [target, setTarget] = useState<ChmodOptions['target']>('all')
  const [foldersOpen, setFoldersOpen] = useState(true)
  const same = <K extends 'uid' | 'gid'>(key: K): string => (items.every((e) => e[key] !== undefined && e[key] === items[0][key]) ? String(items[0][key]) : '')
  const [uid, setUid] = useState(() => same('uid'))
  const [gid, setGid] = useState(() => same('gid'))
  const [size, setSize] = useState<FolderSize | null>(null)
  const [busy, setBusy] = useState<'size' | 'apply' | null>(null)
  const token = useRef(newToken())
  useEffect(() => () => void api.files.cancelWork(token.current), [])

  const octal = mode.toString(8).padStart(3, '0')
  const who = ['Owner', 'Group', 'Everyone']
  const what = ['Read', 'Write', 'Run / open folder']
  const change = (next: number): void => {
    setMode(next)
    setTouched(true)
  }
  const ownerChanged = props.canChown && (uid !== same('uid') || gid !== same('gid')) && (uid !== '' || gid !== '')
  // Ticking "everything inside" alone applies the permissions shown, unless only the owner is being changed.
  const willChmod = touched || (recursive && hasFolders && !ownerChanged)
  const title = one ? `Properties of “${one.name}”` : `Properties of ${countOf(items.length)}`
  const plainSize = items.reduce((n, e) => n + (e.type === 'file' ? e.size : 0), 0)

  const measure = (): void => {
    setBusy('size')
    api.files
      .folderSize(props.sid, items, token.current)
      .then(setSize)
      .catch(toast.error)
      .finally(() => setBusy(null))
  }
  const report = (what: string, r: TreeChange): void => {
    if (r.failed.length) toast.error(`${what}: ${r.failed.length === 1 ? '1 item' : `${r.failed.length} items`} could not be changed. ${r.failed[0].path}: ${r.failed[0].error}`)
    else if (!r.complete) toast.info(`${what}: stopped after ${countOf(r.changed)}.`)
    else toast.ok(r.changed > items.length ? `${what} of ${countOf(r.changed)} changed.` : `${what} of ${one ? `“${one.name}”` : countOf(items.length)} changed.`)
  }
  const apply = async (): Promise<void> => {
    setBusy('apply')
    try {
      if (willChmod) report('Permissions', await api.files.chmodTree(props.sid, items, { mode, recursive: recursive && hasFolders, target, foldersOpen }, token.current))
      if (ownerChanged) {
        const owner = { uid: uid === '' ? undefined : Number(uid), gid: gid === '' ? undefined : Number(gid) }
        report('Owner', await api.files.chownTree(props.sid, items, owner, recursive && hasFolders, token.current))
      }
    } catch (e) {
      toast.error(e)
    }
    setBusy(null)
    props.close()
    props.changed()
  }
  const sizeText = size
    ? `${formatBytes(size.bytes)} in ${size.files.toLocaleString()} ${size.files === 1 ? 'file' : 'files'} and ${size.folders.toLocaleString()} ${size.folders === 1 ? 'folder' : 'folders'}` +
      (size.complete ? '' : ' (stopped early)') +
      (size.unreadable ? `, ${size.unreadable} unreadable` : '')
    : hasFolders
      ? null
      : formatBytes(plainSize)
  const number = (v: string, set: (v: string) => void, label: string): ReactNode => (
    <input className="field mono" style={{ width: 96 }} aria-label={label} inputMode="numeric" value={v} onChange={(e) => /^\d{0,10}$/.test(e.target.value) && set(e.target.value)} />
  )

  return (
    <Sheet
      title={title}
      onClose={props.close}
      footer={
        <>
          {busy === 'apply' && (
            <button className="btn" onClick={() => void api.files.cancelWork(token.current)}>
              Stop
            </button>
          )}
          <button className="btn" onClick={props.close}>
            {willChmod || ownerChanged ? 'Cancel' : 'Close'}
          </button>
          <button className="btn prominent" disabled={busy !== null || !(willChmod || ownerChanged)} onClick={() => void apply()}>
            {busy === 'apply' ? 'Applying…' : 'Apply'}
          </button>
        </>
      }
    >
      <table className="props-table">
        <tbody>
          <InfoRow label="Location">
            <span className="mono">{one ? one.path : parentOf(items[0].path)}</span>
          </InfoRow>
          <InfoRow label="Kind">{one ? KIND[one.type] : countOf(items.length)}</InfoRow>
          <InfoRow label="Size">
            {sizeText ?? (busy === 'size' ? 'Counting…' : 'Not counted yet')}{' '}
            {hasFolders &&
              (busy === 'size' ? (
                <button className="btn small" onClick={() => void api.files.cancelWork(token.current)}>
                  Stop
                </button>
              ) : (
                !size && (
                  <button className="btn small" onClick={measure} disabled={busy !== null}>
                    Calculate Size
                  </button>
                )
              ))}
          </InfoRow>
          {one && one.modifiedAt > 0 && <InfoRow label="Changed">{formatDate(one.modifiedAt)}</InfoRow>}
          {one && (one.owner || one.uid !== undefined) && (
            <InfoRow label="Owner">
              {[one.owner, one.uid !== undefined ? `(${one.uid})` : ''].filter(Boolean).join(' ')}
              {' · group '}
              {[one.group, one.gid !== undefined ? `(${one.gid})` : ''].filter(Boolean).join(' ') || 'unknown'}
            </InfoRow>
          )}
        </tbody>
      </table>

      <fieldset className="choices">
        <legend>Permissions</legend>
        <table className="perms">
          <thead>
            <tr>
              <td />
              {what.map((w) => (
                <th key={w} scope="col">
                  {w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {who.map((name, row) => (
              <tr key={name}>
                <th scope="row">{name}</th>
                {what.map((w, col) => {
                  const bit = 1 << (8 - (row * 3 + col))
                  return (
                    <td key={w}>
                      <input type="checkbox" aria-label={`${name}: ${w}`} checked={(mode & bit) !== 0} onChange={() => change(mode ^ bit)} />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="perms-octal">
          <label>
            Numeric{' '}
            <input
              className="field mono"
              aria-label="Numeric permissions"
              value={octal}
              maxLength={3}
              onChange={(e) => /^[0-7]{1,3}$/.test(e.target.value) && change(parseInt(e.target.value, 8))}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <span className="mono">{BITS.map((c, i) => (mode & (1 << (8 - i)) ? c : '-')).join('')}</span>
        </p>
      </fieldset>

      {props.canChown && (
        <fieldset className="choices">
          <legend>Owner</legend>
          <p className="owner-line">
            <label>User ID {number(uid, setUid, 'User ID of the owner')}</label>
            <label>Group ID {number(gid, setGid, 'Group ID')}</label>
          </p>
          <p className="caption">Changing the owner usually needs administrator rights on the server.</p>
        </fieldset>
      )}

      {hasFolders && (
        <fieldset className="choices">
          <legend>Folders</legend>
          <label>
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
            <span>
              <span className="choice-label">Also change everything inside</span>
              <span className="caption">Links are left alone.</span>
            </span>
          </label>
          {recursive && (
            <>
              <p className="owner-line">
                <label>
                  Change permissions of{' '}
                  <Select<ChmodOptions['target']>
                    label="Change permissions of"
                    value={target}
                    onChange={setTarget}
                    options={[
                      { value: 'all', label: 'Files and Folders' },
                      { value: 'files', label: 'Files Only' },
                      { value: 'folders', label: 'Folders Only' }
                    ]}
                  />
                </label>
              </p>
              <label>
                <input type="checkbox" checked={foldersOpen} onChange={(e) => setFoldersOpen(e.target.checked)} />
                <span>
                  <span className="choice-label">Keep folders openable</span>
                  <span className="caption">Folders get “open folder” for everyone who may read them, even where files get no “run”.</span>
                </span>
              </label>
            </>
          )}
        </fieldset>
      )}
      {!one && <p className="caption">All selected items get the same permissions.</p>}
    </Sheet>
  )
}
