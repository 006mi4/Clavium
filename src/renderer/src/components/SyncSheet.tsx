import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, File as FileIcon, Folder, FolderSync, Info } from 'lucide-react'
import { allowedActions, defaultAction, isDelete } from '@shared/sync'
import type { SyncAction, SyncComparison, SyncItem, SyncKind, SyncMode, SyncOptions, SyncProgress, SyncResult, WatchStatus } from '@shared/types'
import { api, on } from '../api'
import { isMac } from '../platform'
import { Select, Sheet, formatBytes, formatDate, useToast } from '../ui'

const TRASH = isMac ? 'Trash' : 'Recycle Bin'

const KIND_LABEL: Record<SyncKind, string> = {
  onlyLocal: 'Only on this computer',
  onlyRemote: 'Only on the server',
  localNewer: 'Newer on this computer',
  remoteNewer: 'Newer on the server',
  different: 'Different size, same time'
}
const ACTION_LABEL: Record<SyncAction, string> = {
  upload: 'Upload',
  download: 'Download',
  deleteLocal: 'Delete on this computer',
  deleteRemote: 'Delete on the server',
  skip: 'Leave as it is'
}
type Direction = 'upload' | 'download' | 'both'
const DIRECTIONS: { value: Direction; label: string; hint: string }[] = [
  { value: 'upload', label: 'Upload to the server', hint: 'New and newer files of this computer go to the server.' },
  { value: 'download', label: 'Download to this computer', hint: 'New and newer files of the server come to this computer.' },
  { value: 'both', label: 'Both ways', hint: 'Each side gets what is new or newer on the other. Nothing is deleted.' }
]
/** Rows drawn at first, and added with each "Show more". */
const PAGE = 200

const remembered = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}
const remember = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode or full: the folder is simply asked for again */
  }
}

const count = (n: number, one: string, many: string): string => `${n.toLocaleString()} ${n === 1 ? one : many}`
const side = (s: SyncItem['local'], type: SyncItem['type']): string =>
  !s ? '' : [type === 'file' ? formatBytes(s.size) : 'Folder', s.modifiedAt && type === 'file' ? formatDate(s.modifiedAt) : ''].filter(Boolean).join(', ')

export function SyncSheet(props: { sid: string; hostId: string; remoteDir: string; watching: WatchStatus[]; close: () => void }) {
  const toast = useToast()
  const folderKey = `clavium.sync.folder.${props.hostId}`
  const [localDir, setLocalDir] = useState(() => remembered(`${folderKey}:${props.remoteDir}`) || '')
  const [direction, setDirection] = useState<Direction>('upload')
  const [mirror, setMirror] = useState(false)
  const [compareBy, setCompareBy] = useState<SyncOptions['compareBy']>('time')
  const [comparison, setComparison] = useState<SyncComparison | null>(null)
  const [actions, setActions] = useState<Map<string, SyncAction>>(new Map())
  const [running, setRunning] = useState(false)
  const [scanned, setScanned] = useState(0)
  const [shown, setShown] = useState(PAGE)
  const [confirming, setConfirming] = useState(false)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)
  const token = useRef('')
  const mode: SyncMode = direction === 'both' ? 'both' : mirror ? (direction === 'upload' ? 'mirrorUpload' : 'mirrorDownload') : direction

  useEffect(() => {
    const off = on('files:syncProgress', (p: SyncProgress) => p.token === token.current && setScanned(p.scanned))
    return () => {
      off()
      if (token.current) void api.files.cancelWork(token.current)
    }
  }, [])

  // Another way of synchronising: the proposal for every row starts over.
  useEffect(() => {
    if (comparison) setActions(new Map(comparison.items.map((i) => [i.rel, defaultAction(i, mode)])))
  }, [comparison, mode])

  const choose = async (): Promise<void> => {
    const [picked] = await api.files.pickLocal('sync').catch(() => [])
    if (!picked) return
    setLocalDir(picked)
    setComparison(null)
    setResult(null)
    remember(`${folderKey}:${props.remoteDir}`, picked)
  }

  const compare = (): void => {
    if (!localDir) return
    const mine = (token.current = crypto.randomUUID())
    setComparison(null)
    setResult(null)
    setScanned(0)
    setShown(PAGE)
    setRunning(true)
    api.files
      .syncCompare(props.sid, props.remoteDir, localDir, { compareBy, offsetMinutes: null }, mine)
      .then((c) => mine === token.current && setComparison(c))
      .catch((e) => mine === token.current && toast.error(e))
      .finally(() => mine === token.current && setRunning(false))
  }

  const chosen = useMemo(() => (comparison ? comparison.items.map((i) => ({ item: i, action: actions.get(i.rel) ?? 'skip' })) : []), [comparison, actions])
  const totals = useMemo(() => {
    const t = { upload: 0, download: 0, deleteLocal: 0, deleteRemote: 0, skip: 0 }
    for (const c of chosen) t[c.action]++
    return t
  }, [chosen])
  const deletes = chosen.filter((c) => isDelete(c.action))
  const work = chosen.length - totals.skip

  const apply = (): void => {
    if (!comparison) return
    setConfirming(false)
    setApplying(true)
    api.files
      .syncApply(
        comparison.id,
        chosen.filter((c) => c.action !== 'skip').map((c) => ({ rel: c.item.rel, action: c.action })),
        deletes.length
      )
      .then((r) => {
        setResult(r)
        setComparison(null)
      })
      .catch((e) => toast.error(e))
      .finally(() => setApplying(false))
  }

  const keepUpToDate = (): void => {
    api.files
      .watchStart(props.sid, props.remoteDir, localDir)
      .then(() => {
        toast.ok('Watching the folder. Changes are uploaded as they happen.')
        props.close()
      })
      .catch((e) => toast.error(e))
  }
  const alreadyWatching = props.watching.some((w) => w.localDir === localDir)

  const summary = [
    totals.upload && count(totals.upload, 'upload', 'uploads'),
    totals.download && count(totals.download, 'download', 'downloads'),
    totals.deleteRemote && count(totals.deleteRemote, 'deletion on the server', 'deletions on the server'),
    totals.deleteLocal && count(totals.deleteLocal, 'deletion on this computer', 'deletions on this computer'),
    totals.skip && `${totals.skip.toLocaleString()} left as they are`
  ]
    .filter(Boolean)
    .join(', ')

  const status = running
    ? `Comparing, ${scanned.toLocaleString()} items checked`
    : applying
      ? 'Synchronising. The transfers are shown in the transfer list.'
      : result
        ? [
            'Finished',
            result.uploaded ? `${result.uploaded.toLocaleString()} uploaded` : '',
            result.downloaded ? `${result.downloaded.toLocaleString()} downloaded` : '',
            result.deleted ? `${result.deleted.toLocaleString()} deleted` : '',
            result.cancelled ? `${result.cancelled.toLocaleString()} cancelled` : '',
            result.failed.length ? `${result.failed.length.toLocaleString()} failed` : ''
          ]
            .filter(Boolean)
            .join(', ') +
          '.' +
          (result.deletesSkipped ? ` Nothing was deleted, because transfers were cancelled (${count(result.deletesSkipped, 'deletion', 'deletions')} left out).` : '')
        : comparison
          ? comparison.items.length === 0
            ? `The folders are the same: ${count(comparison.same, 'file is', 'files are')} equal on both sides.`
            : `${count(comparison.items.length, 'difference', 'differences')}, ${count(comparison.same, 'file', 'files')} equal.${comparison.ended === 'stopped' ? ' The comparison was stopped early and is incomplete.' : ''}`
          : localDir
            ? 'Compare first. Nothing is transferred or deleted before you have seen the differences.'
            : 'Choose the local folder that belongs to this folder on the server.'

  if (confirming && comparison) {
    return (
      <Sheet
        size="wide"
        title={`Delete ${count(deletes.length, 'Item', 'Items')}?`}
        eyebrow="Synchronise"
        onClose={() => setConfirming(false)}
        footer={
          <>
            <button className="btn" onClick={() => setConfirming(false)} autoFocus>
              Back
            </button>
            <button className="btn destructive filled" onClick={apply}>
              Delete and Synchronise
            </button>
          </>
        }
      >
        <div className="note danger" role="alert">
          <AlertTriangle size={16} />
          <span>
            {totals.deleteRemote > 0 && `${count(totals.deleteRemote, 'item is', 'items are')} deleted on the server for good. `}
            {totals.deleteLocal > 0 && `${count(totals.deleteLocal, 'item', 'items')} on this computer ${totals.deleteLocal === 1 ? 'is' : 'are'} moved to the ${TRASH}. `}
            {summary && `Also planned: ${[totals.upload && count(totals.upload, 'upload', 'uploads'), totals.download && count(totals.download, 'download', 'downloads')].filter(Boolean).join(', ') || 'nothing else'}.`}
          </span>
        </div>
        <ul className="sync-deletes" aria-label="Items that will be deleted">
          {deletes.slice(0, 2000).map((d) => (
            <li key={d.item.rel}>
              {d.item.type === 'dir' ? <Folder size={14} /> : <FileIcon size={14} />}
              <span className="mono">{d.item.rel}</span>
              <span className="where">{d.action === 'deleteRemote' ? 'on the server' : 'on this computer'}</span>
            </li>
          ))}
        </ul>
        {deletes.length > 2000 && <p className="caption">And {(deletes.length - 2000).toLocaleString()} more.</p>}
      </Sheet>
    )
  }

  return (
    <Sheet
      size="xwide"
      title="Synchronise"
      eyebrow={`Folder on the server: ${props.remoteDir}`}
      onClose={applying ? undefined : props.close}
      footer={
        <>
          <button className="btn" style={{ marginRight: 'auto' }} disabled={!localDir || alreadyWatching || applying} onClick={keepUpToDate} title="Watch the local folder and upload every change">
            {alreadyWatching ? 'Already Kept Up to Date' : 'Keep Up to Date'}
          </button>
          <button className="btn" onClick={props.close} disabled={applying}>
            Close
          </button>
          <button
            className={`btn ${deletes.length ? 'destructive filled' : 'prominent'}`}
            disabled={!comparison || work === 0 || applying || running}
            autoFocus={!!comparison}
            onClick={() => (deletes.length ? setConfirming(true) : apply())}
          >
            {deletes.length ? 'Synchronise…' : 'Synchronise'}
          </button>
        </>
      }
    >
      <div className="sync-folder">
        <label htmlFor="sync-local">Local folder</label>
        <input id="sync-local" className="field mono" readOnly value={localDir} placeholder="No folder chosen" />
        <button className="btn" onClick={() => void choose()} disabled={applying} autoFocus={!localDir}>
          Choose…
        </button>
      </div>

      <fieldset className="sync-mode" disabled={applying}>
        <legend>Direction</legend>
        {DIRECTIONS.map((d) => (
          <label key={d.value}>
            <input type="radio" name="sync-direction" checked={direction === d.value} onChange={() => setDirection(d.value)} />
            <span>
              <strong>{d.label}</strong>
              <span className="hint">{d.hint}</span>
            </span>
          </label>
        ))}
        <label className={direction === 'both' ? 'off' : ''}>
          <input type="checkbox" checked={mirror && direction !== 'both'} disabled={direction === 'both'} onChange={(e) => setMirror(e.target.checked)} />
          <span>
            <strong>Mirror</strong>
            <span className="hint">
              Make the target exactly like the source: files that exist only at the target are deleted, and newer files there are replaced. You see the list and
              confirm it before anything is deleted.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="sync-run">
        <Select
          label="Compare by"
          value={compareBy}
          onChange={(v) => {
            setCompareBy(v)
            setComparison(null)
          }}
          options={[
            { value: 'time', label: 'Compare size and modification time' },
            { value: 'size', label: 'Compare size only' }
          ]}
        />
        {running ? (
          <button className="btn" onClick={() => void api.files.cancelWork(token.current)}>
            Stop
          </button>
        ) : (
          <button className={`btn ${comparison ? '' : 'prominent'}`} disabled={!localDir || applying} onClick={compare} autoFocus={!!localDir && !comparison}>
            {comparison || result ? 'Compare Again' : 'Compare'}
          </button>
        )}
      </div>

      <p className="caption" role="status" aria-live="polite">
        {status}
      </p>

      {comparison && (comparison.offsetDetected || comparison.truncated || comparison.unreadable.length > 0 || comparison.skipped.length > 0) && (
        <div className="note">
          <Info size={16} />
          <div>
            {comparison.offsetDetected && (
              <p>
                The clock of the server is {Math.abs(comparison.offsetMinutes)} minutes {comparison.offsetMinutes > 0 ? 'ahead' : 'behind'}. This was taken into account.
              </p>
            )}
            {comparison.truncated && <p>There are more differences than can be listed. Synchronise these first, then compare again.</p>}
            {comparison.unreadable.length > 0 && (
              <p>
                {count(comparison.unreadable.length, 'folder', 'folders')} could not be read and {comparison.unreadable.length === 1 ? 'is' : 'are'} left alone: {comparison.unreadable.slice(0, 5).join(', ')}
                {comparison.unreadable.length > 5 ? ' and more' : ''}.
              </p>
            )}
            {comparison.skipped.length > 0 && (
              <details>
                <summary>{count(comparison.skipped.length, 'item is', 'items are')} left alone</summary>
                <ul>
                  {comparison.skipped.slice(0, 200).map((s) => (
                    <li key={s.rel}>
                      <span className="mono">{s.rel}</span>: {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      )}

      {comparison && comparison.items.length > 0 && (
        <>
          <div className="sync-table" tabIndex={0} role="region" aria-label="Differences">
            <table>
              <caption className="sr-only">Differences between the local folder and the folder on the server, with the action for each</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Difference</th>
                  <th scope="col">This computer</th>
                  <th scope="col">Server</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {chosen.slice(0, shown).map(({ item, action }) => (
                  <tr key={item.rel} className={action === 'skip' ? 'skipped' : isDelete(action) ? 'deleting' : ''}>
                    <th scope="row" title={item.rel}>
                      <span className="name">
                        {item.type === 'dir' ? <Folder size={14} /> : <FileIcon size={14} />}
                        <span>{item.rel}</span>
                      </span>
                    </th>
                    <td>{KIND_LABEL[item.kind]}</td>
                    <td>{side(item.local, item.type)}</td>
                    <td>{side(item.remote, item.type)}</td>
                    <td>
                      <select
                        className="field"
                        aria-label={`Action for ${item.rel}`}
                        value={action}
                        disabled={applying}
                        onChange={(e) => setActions((cur) => new Map(cur).set(item.rel, e.target.value as SyncAction))}
                      >
                        {allowedActions(item).map((a) => (
                          <option key={a} value={a}>
                            {ACTION_LABEL[a]}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {chosen.length > shown && (
            <button className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => setShown((n) => n + PAGE * 5)}>
              Show More ({(chosen.length - shown).toLocaleString()} hidden)
            </button>
          )}
          <p className="caption" aria-live="polite">
            Planned: {summary || 'nothing'}.
          </p>
        </>
      )}

      {result && result.failed.length > 0 && (
        <div className="note warn" role="alert">
          <AlertTriangle size={16} />
          <div>
            <p>{count(result.failed.length, 'item', 'items')} could not be synchronised:</p>
            <ul>
              {result.failed.slice(0, 100).map((f) => (
                <li key={f.rel}>
                  <span className="mono">{f.rel}</span>: {f.error}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Sheet>
  )
}

/** Shows the folders that are kept up to date for this session, each with a button to stop. */
export function WatchBar(props: { watches: WatchStatus[] }) {
  if (!props.watches.length) return null
  return (
    <div className="watch-bar" role="status" aria-live="polite">
      {props.watches.map((w) => (
        <div key={w.id} className="watch">
          <FolderSync size={15} className={w.state === 'uploading' ? 'busy' : ''} />
          <span className="what">
            Keeping <span className="mono">{w.remoteDir}</span> up to date from <span className="mono">{w.localDir}</span>.{' '}
            {w.state === 'uploading' ? 'Uploading changes.' : `${count(w.uploaded, 'change', 'changes')} uploaded.`}
            {w.lastName && w.state !== 'uploading' ? ` Last: ${w.lastName}.` : ''}
            {w.failed > 0 && <span className="problem"> {count(w.failed, 'upload', 'uploads')} failed{w.lastError ? ` (${w.lastError})` : ''}.</span>}
          </span>
          <button className="btn small" onClick={() => void api.files.watchStop(w.id)} aria-label={`Stop keeping ${w.remoteDir} up to date`}>
            Stop
          </button>
        </div>
      ))}
    </div>
  )
}
