import { useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react'
import type { HostSummary, RemoteEntry, TransferProgress } from '@shared/types'
import { api, on } from '../api'
import { formatBytes, formatDate, Icon, Modal, useToast } from '../ui'
import type { ConnState } from './TerminalView'

function parent(p: string): string {
  if (p === '/' || !p.includes('/')) return '/'
  const up = p.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
  return up || '/'
}
function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

export function FilesView(props: { host: HostSummary; onState: (s: ConnState) => void }) {
  const toast = useToast()
  const [sid, setSid] = useState<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [error, setError] = useState('')
  const [cwd, setCwd] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [entries, setEntries] = useState<RemoteEntry[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [transfers, setTransfers] = useState<Map<string, TransferProgress>>(new Map())
  const [attempt, setAttempt] = useState(0)
  const [ask, setAsk] = useState<{ title: string; value: string; ok: (v: string) => void } | null>(null)
  const lastClicked = useRef<number>(-1)
  const sidRef = useRef<string | null>(null)
  const cwdRef = useRef('')

  const report = (s: ConnState, msg = ''): void => {
    setState(s)
    setError(msg)
    props.onState(s)
  }

  const load = useCallback(
    async (path: string, id = sidRef.current) => {
      if (!id) return
      setLoading(true)
      try {
        const list = await api.files.list(id, path)
        list.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1)
        setEntries(list)
        setCwd(path)
        cwdRef.current = path
        setPathInput(path)
        setSelected(new Set())
      } catch (e) {
        toast.error(e)
        setPathInput(cwdRef.current)
      } finally {
        setLoading(false)
      }
    },
    []
  )

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
        report('closed', 'Connection closed')
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
      if (reload) await load(cwd)
    } catch (e) {
      toast.error(e)
    }
  }

  const validName = (n: string): boolean => !!n && !n.includes('/') && n !== '.' && n !== '..'
  const mkdir = (): void => {
    setAsk({
      title: 'New folder',
      value: '',
      ok: (name) => {
        if (validName(name) && sid) void run(() => api.files.mkdir(sid, join(cwd, name)))
      }
    })
  }
  const rename = (): void => {
    const e = selEntries[0]
    if (!e || !sid) return
    setAsk({
      title: `Rename ${e.name}`,
      value: e.name,
      ok: (name) => {
        if (validName(name) && name !== e.name) void run(() => api.files.rename(sid, e.path, join(cwd, name)))
      }
    })
  }
  const remove = (): void => {
    if (!sid || selEntries.length === 0) return
    const dirs = selEntries.filter((e) => e.type === 'dir').length
    if (!confirm(`Delete ${selEntries.length} item(s)${dirs ? ` including ${dirs} folder(s) with all contents` : ''}? This cannot be undone.`)) return
    void run(async () => {
      for (const e of selEntries) await api.files.remove(sid, e.path, e.type === 'dir')
    })
  }
  const download = (): void => {
    if (sid && selEntries.length) void run(() => api.files.download(sid, selEntries), false)
  }

  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragOver(false)
    if (!sid) return
    const paths = [...e.dataTransfer.files].map((f) => window.clavium.pathForFile(f)).filter(Boolean)
    if (paths.length) void api.files.uploadPaths(sid, cwd, paths).catch(toast.error)
  }

  const activeTransfers = [...transfers.values()].slice(-30).reverse()

  if (state !== 'connected' && !sid) {
    return (
      <div className="overlay" style={{ position: 'relative', height: '100%' }}>
        <div className="box">
          {state === 'connecting' ? (
            <>
              <div className="spinner" />
              <div className="muted">Connecting to {props.host.hostname}…</div>
            </>
          ) : (
            <>
              <div className={state === 'error' ? 'callout danger' : 'muted'}>{error || 'Disconnected'}</div>
              <button className="btn primary" onClick={() => setAttempt((a) => a + 1)}>
                Reconnect
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="toolbar">
        <button className="btn ghost sm" title="Up" onClick={() => load(parent(cwd))}>
          <Icon name="up" />
        </button>
        <button className="btn ghost sm" title="Home" onClick={() => sid && api.files.home(sid).then((h) => load(h), toast.error)}>
          <Icon name="home" />
        </button>
        <button className="btn ghost sm" title="Refresh" onClick={() => load(cwd)}>
          <Icon name="refresh" />
        </button>
        <form
          className="path"
          onSubmit={(e) => {
            e.preventDefault()
            void load(pathInput || '/')
          }}
        >
          <input className="input" value={pathInput} onChange={(e) => setPathInput(e.target.value)} spellCheck={false} />
        </form>
        <button className="btn sm" onClick={() => sid && api.files.upload(sid, cwd, 'files').catch(toast.error)}>
          <Icon name="upload" size={14} /> Upload
        </button>
        <button className="btn sm" onClick={() => sid && api.files.upload(sid, cwd, 'folder').catch(toast.error)}>
          <Icon name="upload" size={14} /> Folder
        </button>
        <button className="btn sm" disabled={!selEntries.length} onClick={download}>
          <Icon name="download" size={14} /> Download
        </button>
        <button className="btn ghost sm" title="New folder" onClick={mkdir}>
          <Icon name="newfolder" />
        </button>
        <button className="btn ghost sm" title="Rename" disabled={selEntries.length !== 1} onClick={rename}>
          <Icon name="edit" />
        </button>
        <button className="btn ghost sm" title="Delete" disabled={!selEntries.length} onClick={remove}>
          <Icon name="trash" />
        </button>
      </div>
      <div
        className="file-list"
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onKeyDown={(e) => {
          if (e.key === 'Delete') remove()
          if (e.key === 'Backspace') void load(parent(cwd))
        }}
        tabIndex={0}
      >
        {dragOver && <div className="drop-hint">Drop to upload into {cwd}</div>}
        {state === 'closed' && (
          <div className="callout warn" style={{ margin: 10 }}>
            Connection closed. <a onClick={() => setAttempt((a) => a + 1)}>Reconnect</a>
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th className="num">Size</th>
              <th>Modified</th>
              <th>Permissions</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr
                key={e.path}
                className={selected.has(e.path) ? 'sel' : ''}
                onClick={(ev) => clickRow(ev, e, i)}
                onDoubleClick={() => (e.type === 'dir' || e.type === 'link' ? load(e.path) : download())}
              >
                <td className="name">
                  <Icon name={e.type === 'dir' ? 'folder' : e.type === 'link' ? 'link' : 'file'} />
                  {e.name}
                </td>
                <td className="num">{e.type === 'dir' ? '' : formatBytes(e.size)}</td>
                <td className="muted">{formatDate(e.modifiedAt)}</td>
                <td className="perm">{e.permissions ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && entries.length === 0 && <div className="empty">Empty folder — drop files here to upload.</div>}
      </div>
      {activeTransfers.length > 0 && (
        <div className="transfers">
          <div className="row between small muted">
            <span>Transfers</span>
            <a onClick={() => setTransfers(new Map([...transfers].filter(([, t]) => !t.done)))}>Clear finished</a>
          </div>
          {activeTransfers.map((t) => (
            <div className="transfer" key={t.transferId}>
              <Icon name={t.direction === 'upload' ? 'upload' : 'download'} size={14} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
              <div className="bar">
                <div
                  style={{
                    width: `${t.done ? 100 : t.total ? Math.min(100, (t.transferred / t.total) * 100) : 5}%`,
                    background: t.error ? 'var(--danger)' : t.done ? 'var(--ok)' : undefined
                  }}
                />
              </div>
              <span className="small muted">{t.error ? 'failed' : t.done ? 'done' : formatBytes(t.transferred)}</span>
            </div>
          ))}
        </div>
      )}
      {ask && <AskDialog {...ask} close={() => setAsk(null)} />}
    </>
  )
}

function AskDialog(props: { title: string; value: string; ok: (v: string) => void; close: () => void }) {
  const [v, setV] = useState(props.value)
  const submit = (): void => {
    props.close()
    props.ok(v.trim())
  }
  return (
    <Modal
      title={props.title}
      onClose={props.close}
      footer={
        <>
          <button className="btn" onClick={props.close}>
            Cancel
          </button>
          <button className="btn primary" onClick={submit} disabled={!v.trim()}>
            OK
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <input className="input" autoFocus value={v} onChange={(e) => setV(e.target.value)} onFocus={(e) => e.target.select()} />
      </form>
    </Modal>
  )
}
