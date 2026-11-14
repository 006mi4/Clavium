import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import {
  ArrowUp,
  FilePenLine,
  Download,
  File as FileIcon,
  FilePlus2,
  Folder,
  FolderPlus,
  FolderUp,
  Link2,
  Pencil,
  RotateCw,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { HostSummary, RemoteEntry, TransferProgress } from '@shared/types'
import { api, on } from '../api'
import { Empty, IconButton, Sheet, Toolbar, formatBytes, formatDate, useConfirm, useMenu, useToast, type MenuItem } from '../ui'
import { StatusDot, type ConnState } from './TerminalView'
import { TextEditor } from './TextEditor'

function parentOf(p: string): string {
  if (p === '/' || !p.includes('/')) return '/'
  const up = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
  return up || '/'
}
function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
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

export function FilesView(props: { host: HostSummary; onState: (s: ConnState) => void; onClose: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const menu = useMenu()
  const [sid, setSid] = useState<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [error, setError] = useState('')
  const [cwd, setCwd] = useState('')
  const [pathEdit, setPathEdit] = useState<string | null>(null)
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [transfers, setTransfers] = useState<Map<string, TransferProgress>>(new Map())
  const [attempt, setAttempt] = useState(0)
  const [ask, setAsk] = useState<{ title: string; label: string; value: string; action: string; ok: (v: string) => void } | null>(null)
  const [editing, setEditing] = useState<RemoteEntry | null>(null)
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
      list.sort((a, b) => ((a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      setEntries(list)
      setCwd(path)
      cwdRef.current = path
      setSelected(new Set())
      lastClicked.current = -1
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
        await load(await api.files.home(id), id)
      })
      .catch((e: Error) => !cancelled && report('error', e.message))
    return () => {
      cancelled = true
      if (sidRef.current) void api.files.close(sidRef.current)
      sidRef.current = null
    }
  }, [attempt])

  useEffect(() => {
    const offProg = on('files:progress', (p: TransferProgress) => {
      setTransfers((m) => new Map(m).set(p.transferId, p))
      if (p.done && p.direction === 'upload' && !p.error) void load(cwdRef.current)
      if (p.done && p.error) toast.error(`${p.name}: ${p.error}`)
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
      const next = new Set(e.ctrlKey ? prev : [])
      if (e.shiftKey && lastClicked.current >= 0) {
        const [a, b] = [lastClicked.current, index].sort((x, y) => x - y)
        entries.slice(a, b + 1).forEach((x) => next.add(x.path))
      } else if (e.ctrlKey && prev.has(entry.path)) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    lastClicked.current = index
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
  const rename = (e: RemoteEntry): void =>
    setAsk({
      title: `Rename “${e.name}”`,
      label: 'New name',
      value: e.name,
      action: 'Rename',
      ok: (name) => {
        if (validName(name) && name !== e.name && sid) void run(() => api.files.rename(sid, e.path, join(cwd, name)))
      }
    })
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
    if (sid) void api.files.upload(sid, cwd, kind).catch(toast.error)
  }

  const rowMenu = (e: MouseEvent, entry: RemoteEntry, index: number): void => {
    let items = selEntries
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]))
      lastClicked.current = index
      items = [entry]
    }
    const list: MenuItem[] = []
    if (items.length === 1 && entry.type !== 'file') list.push({ label: 'Open', icon: Folder, onSelect: () => void load(entry.path) })
    if (items.length === 1 && entry.type === 'file') list.push({ label: 'Edit', icon: FilePenLine, onSelect: () => setEditing(entry) })
    list.push({ label: items.length > 1 ? `Download ${items.length} Items` : 'Download…', icon: Download, onSelect: () => download(items) })
    if (items.length === 1) list.push({ label: 'Rename…', icon: Pencil, onSelect: () => rename(entry) })
    list.push('separator', { label: 'Delete…', icon: Trash2, destructive: true, onSelect: () => void remove(items) })
    menu.openAt(e, list)
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    if (!sid) return
    const paths = [...e.dataTransfer.files].map((f) => window.clavium.pathForFile(f)).filter(Boolean)
    if (paths.length) void api.files.uploadPaths(sid, cwd, paths).catch(toast.error)
  }

  const transferList = [...transfers.values()].slice(-20).reverse()
  const running = transferList.filter((t) => !t.done).length
  const connected = !!sid

  if (editing && sid) {
    return (
      <>
        <TextEditor sid={sid} entry={editing} onClose={() => setEditing(null)} onSaved={() => void load(cwdRef.current)} onDownload={() => download([editing])} />
        {menu.element}
      </>
    )
  }

  return (
    <>
      <Toolbar
        title={props.host.name}
        subtitle={
          <>
            <StatusDot state={state} />
            {STATE_TEXT[state]} · {protocolName}
          </>
        }
      >
        <IconButton icon={FolderPlus} label="New Folder" disabled={!connected} onClick={newFolder} />
        <IconButton
          icon={Upload}
          label="Upload"
          disabled={!connected}
          onClick={(e) =>
            menu.openBelow(e, [
              { label: 'Upload Files…', icon: FilePlus2, onSelect: () => upload('files') },
              { label: 'Upload Folder…', icon: FolderUp, onSelect: () => upload('folder') }
            ])
          }
        />
        <IconButton icon={Download} label="Download" disabled={!selEntries.length} onClick={() => download(selEntries)} />
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
              <IconButton icon={ArrowUp} label="Enclosing Folder" disabled={cwd === '/'} onClick={() => void load(parentOf(cwd))} />
              <IconButton icon={RotateCw} label="Reload" onClick={() => void load(cwd)} />
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
                      <button onClick={() => void load(c.path)}>{c.label}</button>
                    </span>
                  ))}
                  <span className="fill" onClick={() => setPathEdit(cwd)} />
                </div>
              )}
            </div>

            <div
              className="file-area"
              tabIndex={0}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onKeyDown={(e) => {
                if (e.key === 'Delete') void remove(selEntries)
                if (e.key === 'Backspace') void load(parentOf(cwd))
                if (e.key === 'Enter' && selEntries.length === 1) {
                  if (selEntries[0].type === 'file') setEditing(selEntries[0])
                  else void load(selEntries[0].path)
                }
                if (e.key === 'F2' && selEntries.length === 1) rename(selEntries[0])
                if (e.ctrlKey && e.key.toLowerCase() === 'a') {
                  e.preventDefault()
                  setSelected(new Set(entries.map((x) => x.path)))
                }
              }}
            >
              {dragOver && <div className="drop-hint">Drop to upload to {cwd}</div>}
              {entries.length > 0 ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th style={{ textAlign: 'right' }}>Size</th>
                      <th>Modified</th>
                      <th>Permissions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e, i) => (
                      <tr
                        key={e.path}
                        aria-selected={selected.has(e.path)}
                        onClick={(ev) => clickRow(ev, e, i)}
                        onContextMenu={(ev) => rowMenu(ev, e, i)}
                        onDoubleClick={() => (e.type === 'file' ? setEditing(e) : void load(e.path))}
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
                  </tbody>
                </table>
              ) : (
                !loading && (
                  <Empty icon={Folder} title="This Folder Is Empty">
                    Drop files here to upload them.
                  </Empty>
                )
              )}
            </div>
          </>
        )}

        {transferList.length > 0 && (
          <div className="transfers">
            <header>
              <span>{running > 0 ? `Transferring ${running} ${running === 1 ? 'Item' : 'Items'}` : 'Transfers Complete'}</span>
              <IconButton icon={X} label="Clear Finished" onClick={() => setTransfers(new Map([...transfers].filter(([, t]) => !t.done)))} />
            </header>
            <div className="items">
              {transferList.map((t) => (
                <div className="transfer" key={t.transferId}>
                  <div className="line">
                    <span>{t.name}</span>
                    <span>
                      {t.error ? 'Failed' : t.done ? (t.direction === 'upload' ? 'Uploaded' : 'Downloaded') : t.total ? `${formatBytes(t.transferred)} of ${formatBytes(t.total)}` : formatBytes(t.transferred)}
                    </span>
                  </div>
                  <div className={`bar ${t.error ? 'failed' : t.done ? 'done' : ''}`}>
                    <div style={{ width: `${t.done ? 100 : t.total ? Math.min(100, (t.transferred / t.total) * 100) : 4}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {menu.element}
      {ask && <AskSheet {...ask} close={() => setAsk(null)} />}
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
