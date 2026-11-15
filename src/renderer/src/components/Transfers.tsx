import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Ban, Ellipsis, Pause, Play, RotateCw, SlidersHorizontal, Trash2, X } from 'lucide-react'
import type { ExistingRule, TransferConflict, TransferItem, TransferSnapshot } from '@shared/types'
import { api, on, type UiSettings } from '../api'
import { Group, IconButton, Row, Select, Sheet, Switch, formatBytes, formatDate, useMenu, useToast } from '../ui'

// ------------------------------------------------------------------ store --

const EMPTY: TransferSnapshot = {
  items: [],
  counts: { queued: 0, running: 0, paused: 0, asking: 0, done: 0, failed: 0, cancelled: 0, skipped: 0 },
  hidden: 0,
  bytesDone: 0,
  bytesTotal: 0,
  speed: 0,
  paused: false,
  scanning: false,
  conflict: null
}

let current = EMPTY
let listening = false
const subscribers = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  if (!listening) {
    listening = true
    const set = (s: TransferSnapshot): void => {
      current = s
      subscribers.forEach((f) => f())
    }
    on('files:queue', set)
    void api.files.queue().then(set, () => undefined)
  }
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** The transfer queue of the app. There is one for all servers. */
export function useTransfers(): TransferSnapshot {
  return useSyncExternalStore(subscribe, () => current)
}

// ---------------------------------------------------------------- wording --

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

const speedText = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`

function statusText(t: TransferItem): string {
  switch (t.state) {
    case 'queued':
      return 'Waiting'
    case 'paused':
      return t.transferred > 0 ? `Paused at ${formatBytes(t.transferred)}` : 'Paused'
    case 'asking':
      return 'Needs Your Answer'
    case 'done':
      return t.direction === 'upload' ? 'Uploaded' : t.direction === 'copy' ? 'Copied' : 'Downloaded'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'skipped':
      return 'Skipped'
    default: {
      const parts = [t.total ? `${formatBytes(t.transferred)} of ${formatBytes(t.total)}` : formatBytes(t.transferred)]
      if (t.speed > 0) parts.push(speedText(t.speed))
      if (t.eta !== undefined) parts.push(`${formatDuration(t.eta)} left`)
      return parts.join(', ')
    }
  }
}

function summary(s: TransferSnapshot): string {
  const active = s.counts.running + s.counts.queued
  const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  if (s.counts.asking > 0 && active === 0) return 'Waiting for Your Answer'
  if (s.paused && active + s.counts.paused > 0) return `Paused, ${n(active + s.counts.paused, 'Item', 'Items')} Left`
  if (active > 0) return `Transferring ${n(active, 'Item', 'Items')}`
  if (s.scanning) return 'Reading Folders'
  if (s.counts.paused > 0) return `${n(s.counts.paused, 'Transfer', 'Transfers')} Paused`
  if (s.counts.failed > 0) return `${n(s.counts.failed, 'Transfer', 'Transfers')} Failed`
  return 'Transfers Complete'
}

// ------------------------------------------------------------------ panel --

/** The queue with its controls, floating in the corner of a file view. */
export function TransferPanel() {
  const s = useTransfers()
  const menu = useMenu()
  const [options, setOptions] = useState(false)
  const total = Object.values(s.counts).reduce((a, b) => a + b, 0)
  if (total === 0 && !s.scanning && !options) return null

  const act = api.files.queueAction
  const active = s.counts.running + s.counts.queued
  const unfinished = active + s.counts.paused + s.counts.asking
  const percent = s.bytesTotal > 0 ? Math.min(100, (s.bytesDone / s.bytesTotal) * 100) : 0
  const details = [`${formatBytes(s.bytesDone)} of ${formatBytes(s.bytesTotal)}`]
  if (s.speed > 0) details.push(speedText(s.speed))
  if (s.eta !== undefined && !s.scanning) details.push(`about ${formatDuration(s.eta)} left`)
  if (s.counts.failed > 0 && unfinished > 0) details.push(`${s.counts.failed} failed`)

  const more = (e: React.MouseEvent<HTMLElement>, t: TransferItem): void =>
    menu.openBelow(e, [
      { label: 'Move to Top', onSelect: () => void act('top', t.id) },
      { label: 'Move Up', onSelect: () => void act('up', t.id) },
      { label: 'Move Down', onSelect: () => void act('down', t.id) },
      { label: 'Move to Bottom', onSelect: () => void act('bottom', t.id) }
    ])

  return (
    <section className="transfers" aria-label="Transfers">
      <header>
        <h3>{summary(s)}</h3>
        <span className="tools">
          {unfinished > 0 &&
            (s.paused ? (
              <IconButton icon={Play} label="Resume All Transfers" onClick={() => void act('resume')} />
            ) : (
              <IconButton icon={Pause} label="Pause All Transfers" onClick={() => void act('pause')} />
            ))}
          {s.counts.failed > 0 && <IconButton icon={RotateCw} label="Retry Failed Transfers" onClick={() => void act('retry')} />}
          <IconButton icon={SlidersHorizontal} label="Transfer Options" onClick={() => setOptions(true)} />
          {unfinished > 0 && <IconButton icon={Ban} label="Cancel All Transfers" onClick={() => void act('cancel')} />}
          <IconButton icon={Trash2} label="Clear Finished" onClick={() => void api.files.queueClear()} />
        </span>
      </header>
      {unfinished > 0 && (
        <div className="overall">
          <div className="bar" role="progressbar" aria-label="All transfers" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
            <div style={{ width: `${percent}%` }} />
          </div>
          <div className="caption">{details.join(', ')}</div>
        </div>
      )}
      <ul className="items">
        {s.items.map((t) => {
          const share = t.state === 'done' ? 100 : t.total ? Math.min(100, (t.transferred / t.total) * 100) : t.state === 'running' ? 4 : 0
          const movable = t.state === 'queued' || (t.state === 'paused' && t.direction !== 'copy')
          return (
            <li className="transfer" key={t.id} data-state={t.state}>
              <div className="line">
                <span className="name" title={t.remotePath}>
                  {t.name}
                </span>
                <span className="actions">
                  {t.state === 'running' && t.direction !== 'copy' && <RowButton icon={Pause} label={`Pause ${t.name}`} onClick={() => void act('pause', t.id)} />}
                  {t.state === 'queued' && <RowButton icon={Pause} label={`Hold ${t.name}`} onClick={() => void act('pause', t.id)} />}
                  {t.state === 'paused' && <RowButton icon={Play} label={`Resume ${t.name}`} onClick={() => void act('resume', t.id)} />}
                  {t.state === 'failed' && <RowButton icon={RotateCw} label={`Retry ${t.name}`} onClick={() => void act('retry', t.id)} />}
                  {movable && <RowButton icon={Ellipsis} label={`Change the Position of ${t.name}`} onClick={(e) => more(e, t)} />}
                  {(t.state === 'running' || t.state === 'queued' || t.state === 'paused' || t.state === 'asking') && (
                    <RowButton icon={X} label={`Cancel ${t.name}`} onClick={() => void act('cancel', t.id)} />
                  )}
                </span>
              </div>
              <div className="status">{statusText(t)}</div>
              {t.error && <div className="error">{t.error}</div>}
              {(t.state === 'running' || t.state === 'paused') && (
                <div className="bar" role="progressbar" aria-label={t.name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share)}>
                  <div style={{ width: `${share}%` }} />
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {s.hidden > 0 && <div className="caption more">And {s.hidden.toLocaleString()} more</div>}
      {menu.element}
      {options && <TransferOptionsSheet close={() => setOptions(false)} />}
    </section>
  )
}

function RowButton(props: { icon: typeof X; label: string; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void }) {
  return (
    <button type="button" className="row-btn" title={props.label} aria-label={props.label} onClick={props.onClick}>
      <props.icon size={13} />
    </button>
  )
}

// ---------------------------------------------------------------- options --

const RULES: { value: ExistingRule; label: string }[] = [
  { value: 'ask', label: 'Ask' },
  { value: 'overwrite', label: 'Replace' },
  { value: 'skip', label: 'Skip' },
  { value: 'rename', label: 'Keep Both' },
  { value: 'newer', label: 'Replace If Newer' },
  { value: 'resume', label: 'Continue Partial Files' }
]

const LIMITS = [0, 64, 256, 512, 1024, 2048, 5120, 10240, 51200]

/** The settings of the transfer queue, as rows for a group. */
export function TransferSettingsRows({ settings, set }: { settings: UiSettings; set: (patch: Partial<UiSettings>) => void }) {
  const limits = LIMITS.includes(settings.transferLimitKbps) ? LIMITS : [...LIMITS, settings.transferLimitKbps].sort((a, b) => a - b)
  return (
    <>
      <Row label="Transfers at the same time" hint="More connections are faster with many small files. Some servers allow only a few.">
        <Select<number>
          label="Transfers at the same time"
          value={settings.transferConcurrency}
          onChange={(v) => set({ transferConcurrency: v })}
          options={[1, 2, 3, 4, 5, 6, 8, 10].map((n) => ({ value: n, label: String(n) }))}
        />
      </Row>
      <Row label="Speed limit" hint="Applies to all transfers together.">
        <Select<number>
          label="Speed limit"
          value={settings.transferLimitKbps}
          onChange={(v) => set({ transferLimitKbps: v })}
          options={limits.map((k) => ({ value: k, label: k === 0 ? 'No Limit' : `${formatBytes(k * 1024)}/s` }))}
        />
      </Row>
      <Row label="When a file already exists">
        <Select<ExistingRule> label="When a file already exists" value={settings.transferExisting} onChange={(v) => set({ transferExisting: v })} options={RULES} />
      </Row>
      <Row label="Keep modification time and permissions" hint="Transferred files keep the time they were last changed. New files on the server also get the permissions they have here.">
        <Switch on={settings.transferPreserve} onChange={(v) => set({ transferPreserve: v })} label="Keep modification time and permissions" />
      </Row>
    </>
  )
}

function TransferOptionsSheet({ close }: { close: () => void }) {
  const toast = useToast()
  const [settings, setSettings] = useState<UiSettings | null>(null)
  useEffect(() => {
    void api.settings.get().then(setSettings)
    return on('settings:changed', (s: UiSettings) => setSettings(s))
  }, [])
  return (
    <Sheet
      title="Transfer Options"
      onClose={close}
      footer={
        <button className="btn prominent" onClick={close} autoFocus>
          Done
        </button>
      }
    >
      {settings && (
        <Group>
          <TransferSettingsRows settings={settings} set={(patch) => void api.settings.set(patch).catch(toast.error)} />
        </Group>
      )}
    </Sheet>
  )
}

// ------------------------------------------------------- questions, news --

/**
 * Shown once for the whole app: asks what to do when the target of a transfer exists, and tells
 * screen readers and the user when the queue has finished.
 */
export function TransferHost() {
  const s = useTransfers()
  const toast = useToast()
  const [news, setNews] = useState('')
  const busy = s.counts.running + s.counts.queued > 0 || s.scanning
  const wasBusy = useRef(false)
  const failedBefore = useRef(0)
  useEffect(() => {
    if (busy && !wasBusy.current) failedBefore.current = s.counts.failed
    if (!busy && wasBusy.current) {
      const failed = s.counts.failed - failedBefore.current
      if (failed > 0) toast.error(failed === 1 ? '1 transfer failed. You can retry it in the transfer list.' : `${failed} transfers failed. You can retry them in the transfer list.`)
      setNews(failed > 0 ? `Transfers finished, ${failed} failed.` : s.counts.paused > 0 ? 'Transfers paused.' : 'Transfers complete.')
    }
    wasBusy.current = busy
  }, [busy, s.counts.failed])
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {news}
      </div>
      {s.conflict && <ConflictSheet key={s.conflict.id} conflict={s.conflict} />}
    </>
  )
}

function ConflictSheet({ conflict: c }: { conflict: TransferConflict }) {
  const canResume = c.existing.size < c.source.size
  const [rule, setRule] = useState<Exclude<ExistingRule, 'ask'>>('overwrite')
  const [all, setAll] = useState(false)
  const group = useId()
  const where = c.direction === 'upload' ? 'on the server' : 'on this computer'
  const choices: { value: Exclude<ExistingRule, 'ask'>; label: string; hint: string }[] = [
    { value: 'overwrite', label: 'Replace', hint: `The file ${where} is replaced.` },
    { value: 'skip', label: 'Skip', hint: 'This file is not transferred.' },
    { value: 'rename', label: 'Keep Both', hint: 'The new file gets a number added to its name.' },
    { value: 'newer', label: 'Replace If Newer', hint: 'Replaces the file only when the new one was changed more recently.' }
  ]
  if (canResume) choices.push({ value: 'resume', label: 'Continue', hint: `Treats the file ${where} as the first part and transfers only the rest.` })
  const answer = (r: Exclude<ExistingRule, 'ask'>, forAll: boolean): void => void api.files.queueAnswer(c.id, r, forAll)
  const when = (ms: number): string => (ms > 0 ? formatDate(ms) : 'Unknown')
  return (
    <Sheet
      title={`“${c.name}” Already Exists`}
      eyebrow={c.direction === 'upload' ? 'Upload' : 'Download'}
      onClose={() => answer('skip', false)}
      footer={
        <>
          <button className="btn" onClick={() => answer('skip', false)}>
            Skip
          </button>
          <button className="btn prominent" onClick={() => answer(rule, all)}>
            Continue
          </button>
        </>
      }
    >
      <p className="mono conflict-path">{c.target}</p>
      <table className="conflict-table">
        <thead>
          <tr>
            <td />
            <th scope="col">Size</th>
            <th scope="col">Changed</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Existing file</th>
            <td>{formatBytes(c.existing.size)}</td>
            <td>{when(c.existing.modifiedAt)}</td>
          </tr>
          <tr>
            <th scope="row">New file</th>
            <td>{formatBytes(c.source.size)}</td>
            <td>{when(c.source.modifiedAt)}</td>
          </tr>
        </tbody>
      </table>
      <fieldset className="choices">
        <legend>What should happen?</legend>
        {choices.map((choice, i) => (
          <label key={choice.value}>
            <input type="radio" name={group} checked={rule === choice.value} onChange={() => setRule(choice.value)} autoFocus={i === 0} />
            <span>
              <span className="choice-label">{choice.label}</span>
              <span className="caption">{choice.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
        <span>{c.waiting > 0 ? `Do this for all files that already exist (${c.waiting} more waiting)` : 'Do this for all files that already exist'}</span>
      </label>
    </Sheet>
  )
}
