import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Activity, AlertTriangle, ArrowDown, ArrowUp, HardDriveDownload, HardDriveUpload, Pause, Play, X } from 'lucide-react'
import type { HostSummary, MonitorActivity, MonitorSample } from '@shared/types'
import { api, on } from '../api'
import { Empty, IconButton, Segmented, Toolbar, formatBytes } from '../ui'
import { PortsTab, ProcessesTab } from './MonitorActivity'
import { StatusDot, type ConnState } from './TerminalView'

type Stats = Extract<MonitorSample, { supported: true }>

/** How often the server is asked. The first two measurements follow each other quickly, because rates need two. */
const INTERVAL_MS = 3000
const FIRST_INTERVAL_MS = 1000
/** Processes and ports are a longer answer and are only asked for while their tab is shown. */
const ACTIVITY_INTERVAL_MS = 4000

type Tab = 'overview' | 'processes' | 'ports'
/** What the charts show: the last minute at first, growing with the measurements up to five minutes. */
const MAX_WINDOW_MS = 5 * 60 * 1000
const MIN_WINDOW_MS = 60 * 1000
const KEEP = Math.ceil(MAX_WINDOW_MS / INTERVAL_MS) + 2
/** Measurements further apart than this are not joined by a line: nothing is known about the time between. */
const GAP_MS = INTERVAL_MS * 3

interface Point {
  at: number
  cpu: number | null
  mem: number
  rx: number | null
  tx: number | null
  read: number | null
  write: number | null
  gpu: (number | null)[]
}

const share = (part: number, whole: number): number => (whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0)
const pct = (v: number | null): string => (v === null ? 'measuring…' : `${v > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} %`)
const bytes = (v: number): string => formatBytes(Math.round(v))
const rate = (v: number | null): string => (v === null ? 'measuring…' : `${bytes(v)}/s`)

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d} d ${h} h`
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

/** The top of a chart of rates: the next round amount above the highest value (1, 2 or 5 times a unit). */
export function niceTop(highest: number): number {
  let unit = 1024
  while (unit * 1024 <= highest) unit *= 1024
  for (const step of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1024]) if (unit * step >= highest) return unit * step
  return unit * 1024
}

/** 75 % and more counts as high, 90 % and more as very high: shown by colour and always also in words. */
type Level = 'ok' | 'high' | 'critical'
const levelOf = (v: number): Level => (v >= 90 ? 'critical' : v >= 75 ? 'high' : 'ok')

function LevelTag({ level, words }: { level: Level; words?: [string, string] }) {
  if (level === 'ok') return null
  const [high, critical] = words ?? ['High', 'Very high']
  return (
    <strong className={`mon-tag ${level}`}>
      <AlertTriangle size={12} aria-hidden="true" /> {level === 'critical' ? critical : high}
    </strong>
  )
}

function Meter(props: { label: string; value: number | null; text: string; size?: 'small' | 'large'; plain?: boolean }) {
  const v = props.value ?? 0
  return (
    <div
      className={`mon-meter ${props.plain ? 'ok' : levelOf(v)} ${props.size ?? ''}`}
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-valuetext={props.text}
      title={`${props.label}: ${props.text}`}
    >
      <span style={{ width: `${v}%` }} />
    </div>
  )
}

/** A ring that fills clockwise from the top, with the number in its middle. */
function Ring(props: { label: string; value: number | null; text: string }) {
  const v = props.value ?? 0
  const R = 30
  const around = 2 * Math.PI * R
  return (
    <div className={`mon-ring ${levelOf(v)}`} role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-valuetext={props.text} title={`${props.label}: ${props.text}`}>
      <svg viewBox="0 0 72 72" aria-hidden="true" focusable="false">
        <circle className="track" cx="36" cy="36" r={R} />
        {v > 0 && <circle className="fill" cx="36" cy="36" r={R} strokeDasharray={`${(v / 100) * around} ${around}`} transform="rotate(-90 36 36)" />}
      </svg>
      <span className="mon-ring-text" aria-hidden="true">
        {props.value === null ? '…' : Math.round(v)}
        {props.value !== null && <small>%</small>}
      </span>
    </div>
  )
}

interface Series {
  name: string
  values: (number | null)[]
}

/**
 * How one or two values changed over the last minutes: time runs to the right and ends at
 * "now", the scale is on the left. Pointing at it, or the arrow keys, shows the exact values of
 * one moment. The same values are in the table at the end of the page.
 */
function Chart(props: { label: string; times: number[]; series: Series[]; top?: number; format: (v: number | null) => string }) {
  const { times, series } = props
  const [at, setAt] = useState<number | null>(null)
  const [spoken, setSpoken] = useState('')
  const end = times.length ? times[times.length - 1] : Date.now()
  // whole minutes, so the scale of the time stays still between two steps
  const WINDOW_MS = Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, Math.ceil((end - (times[0] ?? end)) / MIN_WINDOW_MS) * MIN_WINDOW_MS))
  const minutes = WINDOW_MS / 60000
  const start = end - WINDOW_MS
  const first = Math.max(0, times.findIndex((t) => t >= start))
  const top = props.top ?? niceTop(Math.max(1, ...series.flatMap((s) => s.values.slice(first).map((v) => v ?? 0))))
  const x = (i: number): number => ((times[i] - start) / WINDOW_MS) * 100
  const y = (v: number): number => 100 - (Math.min(v, top) / top) * 100

  /** the stretches of a series that are measured without a gap */
  const stretches = (values: (number | null)[]): number[][] => {
    const out: number[][] = []
    let cur: number[] = []
    for (let i = first; i < times.length; i++) {
      const broken = values[i] === null || values[i] === undefined || (cur.length > 0 && times[i] - times[cur[cur.length - 1]] > GAP_MS)
      if (broken && cur.length) {
        out.push(cur)
        cur = []
      }
      if (values[i] !== null && values[i] !== undefined) cur.push(i)
    }
    if (cur.length) out.push(cur)
    return out
  }
  const line = (values: (number | null)[], run: number[]): string => run.map((i, n) => `${n ? 'L' : 'M'}${x(i).toFixed(2)} ${y(values[i] as number).toFixed(2)}`).join(' ')

  const shown = at !== null && at >= first && at < times.length ? at : null
  const describe = (i: number): string => `${new Date(times[i]).toLocaleTimeString()}: ${series.map((s) => `${s.name} ${props.format(s.values[i] ?? null)}`).join(', ')}`
  const summary = series
    .map((s) => {
      const known = s.values.slice(first).filter((v): v is number => v !== null && v !== undefined)
      if (!known.length) return `${s.name}: not measured yet`
      return `${s.name}: now ${props.format(known[known.length - 1])}, lowest ${props.format(Math.min(...known))}, highest ${props.format(Math.max(...known))}`
    })
    .join('. ')

  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (times.length <= first) return
    const box = e.currentTarget.getBoundingClientRect()
    const t = start + ((e.clientX - box.left) / box.width) * WINDOW_MS
    let best = first
    for (let i = first; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i
    setAt(best)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (times.length <= first) return
    const last = times.length - 1
    const cur = shown ?? last + 1
    const next = e.key === 'ArrowLeft' ? Math.max(first, cur - 1) : e.key === 'ArrowRight' ? Math.min(last, cur + 1) : e.key === 'Home' ? first : e.key === 'End' ? last : e.key === 'Escape' ? -1 : null
    if (next === null) return
    e.preventDefault()
    setAt(next < 0 ? null : next)
    setSpoken(next < 0 ? '' : describe(next))
  }

  return (
    <div className="mon-chart">
      <div className="mon-chart-body">
        <div className="mon-scale" aria-hidden="true">
          <span>{props.format(top)}</span>
          <span>{props.format(top / 2)}</span>
          <span>{props.format(0)}</span>
        </div>
        <div
          className="mon-plot"
          tabIndex={0}
          role="group"
          aria-label={`${props.label}, last ${minutes === 1 ? 'minute' : `${minutes} minutes`}. ${summary}. Arrow keys read single moments.`}
          onPointerMove={onMove}
          onPointerLeave={() => setAt(null)}
          onBlur={() => {
            setAt(null)
            setSpoken('')
          }}
          onKeyDown={onKey}
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <line className="grid" x1="0" x2="100" y1="0" y2="0" vectorEffect="non-scaling-stroke" />
            <line className="grid" x1="0" x2="100" y1="50" y2="50" vectorEffect="non-scaling-stroke" />
            <line className="grid base" x1="0" x2="100" y1="100" y2="100" vectorEffect="non-scaling-stroke" />
            {series.map((s, n) =>
              stretches(s.values).map((run, k) => (
                <g key={`${n}-${k}`}>
                  {series.length === 1 && run.length > 1 && <path className="area" d={`${line(s.values, run)} L${x(run[run.length - 1]).toFixed(2)} 100 L${x(run[0]).toFixed(2)} 100 Z`} />}
                  <path className={`line s${n + 1}`} d={run.length > 1 ? line(s.values, run) : `${line(s.values, run)} h0.01`} vectorEffect="non-scaling-stroke" />
                </g>
              ))
            )}
          </svg>
          {times.length - first < 2 && <span className="mon-plot-empty">The chart fills as measurements arrive.</span>}
          {shown !== null && (
            <>
              <span className="mon-cross" style={{ left: `${x(shown)}%` }} />
              {series.map((s, n) => (s.values[shown] === null || s.values[shown] === undefined ? null : <span key={n} className={`mon-dot s${n + 1}`} style={{ left: `${x(shown)}%`, top: `${y(s.values[shown] as number)}%` }} />))}
              <div className={`mon-tip ${x(shown) > 55 ? 'left' : 'right'}`} style={x(shown) > 55 ? { right: `${100 - x(shown)}%` } : { left: `${x(shown)}%` }}>
                <span className="when">{new Date(times[shown]).toLocaleTimeString()}</span>
                {series.map((s, n) => (
                  <span key={n} className="row">
                    <i className={`mon-key s${n + 1}`} aria-hidden="true" />
                    {s.name} <b>{props.format(s.values[shown] ?? null)}</b>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <span />
        <div className="mon-time" aria-hidden="true">
          <span>{minutes} min ago</span>
          <span>{minutes === 1 ? '30 s ago' : `${minutes / 2} min ago`}</span>
          <span>now</span>
        </div>
      </div>
      <span className="mon-sr" aria-live="polite">
        {spoken}
      </span>
    </div>
  )
}

function Card(props: { title: string; tag?: ReactNode; wide?: boolean; note?: string; children?: ReactNode }) {
  const id = useId()
  return (
    <section className={`mon-card${props.wide ? ' wide' : ''}`} aria-labelledby={id}>
      <div className="mon-head">
        <h2 id={id}>{props.title}</h2>
        {props.tag}
      </div>
      {props.children}
      {props.note && <p className="mon-note">{props.note}</p>}
    </section>
  )
}

function Fact(props: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="mon-pair">
      <dt title={props.hint}>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  )
}

/** Two big numbers next to each other, each with an arrow and a mark in the colour of its line. */
function Flow(props: { items: { name: string; value: string; icon: typeof ArrowDown }[] }) {
  return (
    <dl className="mon-flow">
      {props.items.map((it, i) => (
        <div key={it.name}>
          <dt>
            <it.icon size={13} aria-hidden="true" /> {it.name}
          </dt>
          <dd>
            <i className={`mon-key s${i + 1}`} aria-hidden="true" />
            {it.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/** The load of a server: processor, memory, disks, network and graphics cards, measured again every few seconds. */
export function MonitorView(props: { host: HostSummary; active: boolean; onState: (s: ConnState) => void; onClose: () => void }) {
  const [sid, setSid] = useState<string | null>(null)
  const sidRef = useRef<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [sample, setSample] = useState<MonitorSample | null>(null)
  const [history, setHistory] = useState<Point[]>([])
  const [paused, setPaused] = useState(false)
  /** why the last measurement failed; empty when it worked */
  const [failure, setFailure] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [activity, setActivity] = useState<MonitorActivity | null>(null)
  const [activityFailure, setActivityFailure] = useState('')
  const [processFilter, setProcessFilter] = useState('')
  /** counts up to ask for processes and ports at once, after something was ended */
  const [asked, setAsked] = useState(0)

  const report = (s: ConnState, msg = ''): void => {
    setState(s)
    setError(msg)
    props.onState(s)
  }

  useEffect(() => {
    let cancelled = false
    report('connecting')
    setSample(null)
    setHistory([])
    setFailure('')
    setActivity(null)
    setActivityFailure('')
    api.monitor
      .open(props.host.id)
      .then((id) => {
        if (cancelled) return void api.monitor.close(id)
        sidRef.current = id
        setSid(id)
        report('connected')
      })
      .catch((e: Error) => !cancelled && report('error', e.message))
    return () => {
      cancelled = true
      if (sidRef.current) void api.monitor.close(sidRef.current)
      sidRef.current = null
      setSid(null)
    }
  }, [attempt])

  useEffect(
    () =>
      on('monitor:closed', (id: string) => {
        if (id !== sidRef.current) return
        sidRef.current = null
        setSid(null)
        report('closed', 'The connection was closed.')
      }),
    []
  )

  useEffect(() => {
    if (!sid || paused) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let count = 0
    const tick = async (): Promise<void> => {
      try {
        const s = await api.monitor.sample(sid)
        if (stopped) return
        setSample(s)
        setFailure('')
        // a system the monitor cannot read will not become readable by asking again
        if (!s.supported) return
        const point: Point = {
          at: Date.now(),
          cpu: s.cpu.usage,
          mem: share(s.mem.used, s.mem.total),
          rx: s.net.rx,
          tx: s.net.tx,
          read: s.io?.read ?? null,
          write: s.io?.write ?? null,
          gpu: s.gpus.map((g) => g.usage)
        }
        setHistory((h) => [...h.slice(-(KEEP - 1)), point])
      } catch (e) {
        if (stopped || sidRef.current !== sid) return
        setFailure(e instanceof Error ? e.message : String(e))
      }
      timer = setTimeout(() => void tick(), count++ === 0 ? FIRST_INTERVAL_MS : INTERVAL_MS)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sid, paused])

  useEffect(() => {
    if (!sid || tab === 'overview') return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let count = 0
    const tick = async (): Promise<void> => {
      try {
        const a = await api.monitor.activity(sid)
        if (stopped) return
        setActivity(a)
        setActivityFailure('')
        if (!a.supported) return
      } catch (e) {
        if (stopped || sidRef.current !== sid) return
        setActivityFailure(e instanceof Error ? e.message : String(e))
      }
      // shares of the processor need two measurements, so the second one follows quickly
      if (!paused) timer = setTimeout(() => void tick(), count++ === 0 ? FIRST_INTERVAL_MS : ACTIVITY_INTERVAL_MS)
    }
    void tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [sid, tab === 'overview', paused, asked])

  const stats: Stats | null = sample?.supported ? sample : null
  const live = activity?.supported ? activity : null
  const times = history.map((p) => p.at)
  const memShare = stats ? share(stats.mem.used, stats.mem.total) : 0
  const cacheShare = stats ? Math.min(100 - memShare, share(stats.mem.cache, stats.mem.total)) : 0

  return (
    <>
      <Toolbar
        title={`Monitor · ${props.host.name}`}
        subtitle={
          <>
            <StatusDot state={state} />
            {state !== 'connected' ? (state === 'connecting' ? 'Connecting…' : 'Disconnected') : stats ? `${stats.os} · up for ${formatUptime(stats.uptime)}${paused ? ' · paused' : ''}` : 'Connected'}
          </>
        }
      >
        {stats && (
          <Segmented<Tab>
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'overview', label: 'Overview' },
              { value: 'processes', label: 'Processes' },
              { value: 'ports', label: 'Ports' }
            ]}
          />
        )}
        {stats && <IconButton icon={paused ? Play : Pause} label={paused ? 'Resume Measuring' : 'Pause Measuring'} pressed={paused} onClick={() => setPaused((p) => !p)} />}
        <span className="sep" />
        <IconButton icon={X} label="Close" onClick={props.onClose} />
      </Toolbar>

      {!sid ? (
        <div className="view-fixed">
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
        </div>
      ) : !sample ? (
        <div className="view-fixed">
          {failure ? (
            <Empty icon={Activity} title="The Server Could Not Be Measured">
              {failure}
            </Empty>
          ) : (
            <div className="overlay" style={{ position: 'relative', flex: 1 }}>
              <div className="box">
                <div className="spinner" />
                <p>Measuring…</p>
              </div>
            </div>
          )}
        </div>
      ) : !stats ? (
        <div className="view-fixed">
          <Empty icon={Activity} title="The Monitor Works on Linux Servers">
            This server runs {sample.supported ? 'another system' : sample.os}, which does not report its load the way Linux does. Terminal and files work as usual.
          </Empty>
        </div>
      ) : tab !== 'overview' ? (
        !live ? (
          <div className="view-fixed">
            {activityFailure ? (
              <Empty icon={Activity} title="Processes and Ports Could Not Be Read">
                {activityFailure}
              </Empty>
            ) : (
              <div className="overlay" style={{ position: 'relative', flex: 1 }}>
                <div className="box">
                  <div className="spinner" />
                  <p>Reading processes and ports…</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="view-scroll">
            {activityFailure && (
              <p className="note mon-stale" role="status">
                The last reading failed, the list shown is older: {activityFailure}
              </p>
            )}
            {tab === 'processes' ? (
              <ProcessesTab sid={sid} activity={live} filter={processFilter} setFilter={setProcessFilter} refresh={() => setAsked((n) => n + 1)} />
            ) : (
              <PortsTab
                sid={sid}
                activity={live}
                refresh={() => setAsked((n) => n + 1)}
                showProcess={(pid) => {
                  setProcessFilter(String(pid))
                  setTab('processes')
                }}
              />
            )}
          </div>
        )
      ) : (
        <div className="view-scroll">
          <div className="mon">
            {failure && (
              <p className="note" role="status">
                The last measurement failed, the values shown are older: {failure}
              </p>
            )}
            <div className="mon-grid">
              <Card title="Processor" tag={stats.cpu.usage !== null && <LevelTag level={levelOf(stats.cpu.usage)} />}>
                <div className="mon-top">
                  <Ring label="Processor in use" value={stats.cpu.usage} text={pct(stats.cpu.usage)} />
                  <dl className="mon-facts">
                    <Fact label="In use">{pct(stats.cpu.usage)}</Fact>
                    <Fact label="Cores">{stats.cpu.count}</Fact>
                    <Fact label="Load" hint="How many programs wanted the processor on average, over 1, 5 and 15 minutes">
                      {stats.load.map((l) => l.toFixed(2)).join(' · ')}
                    </Fact>
                    {stats.cpu.iowait !== null && stats.cpu.iowait >= 1 && <Fact label="Waiting for disks">{pct(stats.cpu.iowait)}</Fact>}
                  </dl>
                </div>
                <Chart label="Processor in use" times={times} series={[{ name: 'Processor', values: history.map((p) => p.cpu) }]} top={100} format={pct} />
                {stats.cpu.cores.length > 1 && (
                  <div className="mon-cores" role="group" aria-label="In use per core">
                    {stats.cpu.cores.map((v, i) => (
                      <div key={i}>
                        <Meter size="small" label={`Core ${i + 1}`} value={v} text={pct(v)} />
                        {stats.cpu.cores.length <= 32 && (
                          <span aria-hidden="true">
                            {i + 1}: {Math.round(v)} %
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Memory" tag={<LevelTag level={levelOf(memShare)} />}>
                <div className="mon-top">
                  <Ring label="Memory in use" value={memShare} text={`${bytes(stats.mem.used)} of ${bytes(stats.mem.total)}`} />
                  <dl className="mon-facts">
                    <Fact label={<><i className="mon-key block s1" aria-hidden="true" /> In use</>}>
                      {bytes(stats.mem.used)} of {bytes(stats.mem.total)}
                    </Fact>
                    <Fact label={<><i className="mon-key block cache" aria-hidden="true" /> Cache</>} hint="Memory the system uses to speed up files and gives back as soon as a program needs it">
                      {bytes(stats.mem.cache)}
                    </Fact>
                    <Fact label={<><i className="mon-key block free" aria-hidden="true" /> Free</>}>{bytes(Math.max(0, stats.mem.total - stats.mem.used - stats.mem.cache))}</Fact>
                  </dl>
                </div>
                <div className="mon-stack" aria-hidden="true" title="How the memory is divided: in use, cache, free">
                  <span className="s1" style={{ width: `${memShare}%` }} />
                  <span className="cache" style={{ width: `${cacheShare}%` }} />
                </div>
                <Chart label="Memory in use" times={times} series={[{ name: 'Memory', values: history.map((p) => p.mem) }]} top={100} format={pct} />
                <dl className="mon-facts">
                  <Fact label="Swap" hint="Space on a disk the system uses when the memory is full">
                    {stats.mem.swapTotal > 0 ? `${bytes(stats.mem.swapUsed)} of ${bytes(stats.mem.swapTotal)}` : 'none'}
                  </Fact>
                </dl>
                {stats.mem.swapTotal > 0 && <Meter size="small" label="Swap in use" value={share(stats.mem.swapUsed, stats.mem.swapTotal)} text={`${bytes(stats.mem.swapUsed)} of ${bytes(stats.mem.swapTotal)}`} />}
              </Card>

              <Card title="Network">
                <Flow
                  items={[
                    { name: 'Receiving', value: rate(stats.net.rx), icon: ArrowDown },
                    { name: 'Sending', value: rate(stats.net.tx), icon: ArrowUp }
                  ]}
                />
                <Chart
                  label="Network"
                  times={times}
                  series={[
                    { name: 'Receiving', values: history.map((p) => p.rx) },
                    { name: 'Sending', values: history.map((p) => p.tx) }
                  ]}
                  format={rate}
                />
                {stats.net.interfaces.length > 1 && (
                  <dl className="mon-facts">
                    {stats.net.interfaces.map((i) => (
                      <Fact key={i.name} label={<span className="mono">{i.name}</span>}>
                        {rate(i.rx)} in, {rate(i.tx)} out
                      </Fact>
                    ))}
                  </dl>
                )}
              </Card>

              {stats.io && (
                <Card title="Disk Activity">
                  <Flow
                    items={[
                      { name: 'Reading', value: rate(stats.io.read), icon: HardDriveUpload },
                      { name: 'Writing', value: rate(stats.io.write), icon: HardDriveDownload }
                    ]}
                  />
                  <Chart
                    label="Disk activity"
                    times={times}
                    series={[
                      { name: 'Reading', values: history.map((p) => p.read) },
                      { name: 'Writing', values: history.map((p) => p.write) }
                    ]}
                    format={rate}
                  />
                </Card>
              )}

              {stats.gpus.map((g, i) => (
                <Card key={i} title={stats.gpus.length > 1 ? `Graphics Card ${i + 1}` : 'Graphics Card'} tag={g.usage !== null && <LevelTag level={levelOf(g.usage)} />}>
                  <div className="mon-top">
                    {g.usage !== null && <Ring label="Graphics card in use" value={g.usage} text={pct(g.usage)} />}
                    <dl className="mon-facts">
                      <Fact label="Model">{g.name}</Fact>
                      {g.memUsed !== null && g.memTotal !== null && (
                        <Fact label="Memory">
                          {bytes(g.memUsed)} of {bytes(g.memTotal)}
                        </Fact>
                      )}
                      {g.temp !== null && <Fact label="Temperature">{Math.round(g.temp)} °C</Fact>}
                      {g.power !== null && <Fact label="Power">{Math.round(g.power)} W</Fact>}
                    </dl>
                  </div>
                  {g.memUsed !== null && g.memTotal !== null && <Meter size="small" label="Graphics memory in use" value={share(g.memUsed, g.memTotal)} text={`${bytes(g.memUsed)} of ${bytes(g.memTotal)}`} />}
                  {g.usage !== null && <Chart label="Graphics card in use" times={times} series={[{ name: 'Graphics card', values: history.map((p) => p.gpu[i] ?? null) }]} top={100} format={pct} />}
                </Card>
              ))}

              {stats.temps.length > 0 && (
                <Card title="Temperatures" note="The bars run from 0 to 100 °C.">
                  <ul className="mon-temps">
                    {stats.temps.map((t) => (
                      <li key={t.label}>
                        <span>{t.label}</span>
                        <Meter plain label={`Temperature of ${t.label}`} value={Math.min(100, t.celsius)} text={`${t.celsius.toFixed(0)} °C`} />
                        <b>{t.celsius.toFixed(0)} °C</b>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card title="Storage" wide note={stats.disks.length === 0 ? 'The server reported no file systems.' : undefined}>
                <ul className="mon-disks">
                  {stats.disks.map((d) => {
                    const used = share(d.used, d.used + d.free)
                    return (
                      <li key={d.device + d.mount}>
                        <div className="mon-disk-head">
                          <span className="mono mon-mount">{d.mount}</span>
                          <LevelTag level={levelOf(used)} words={['Filling up', 'Almost full']} />
                          <b className="mon-disk-pct">{Math.round(used)} %</b>
                        </div>
                        <Meter size="large" label={`Used on ${d.mount}`} value={used} text={`${Math.round(used)} %, ${bytes(d.free)} free`} />
                        <span className="mon-disk-text">
                          {bytes(d.used)} of {bytes(d.total)} used, {bytes(d.free)} free
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </Card>
            </div>

            <details className="mon-table">
              <summary>Recent Values as a Table</summary>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Processor</th>
                    <th scope="col">Memory</th>
                    <th scope="col">Receiving</th>
                    <th scope="col">Sending</th>
                    <th scope="col">Reading</th>
                    <th scope="col">Writing</th>
                  </tr>
                </thead>
                <tbody>
                  {history
                    .slice(-20)
                    .reverse()
                    .map((p) => (
                      <tr key={p.at}>
                        <th scope="row">{new Date(p.at).toLocaleTimeString()}</th>
                        <td>{pct(p.cpu)}</td>
                        <td>{pct(p.mem)}</td>
                        <td>{rate(p.rx)}</td>
                        <td>{rate(p.tx)}</td>
                        <td>{rate(p.read)}</td>
                        <td>{rate(p.write)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </details>
            <p className="caption">
              Measured every {INTERVAL_MS / 1000} seconds over the SSH connection, by reading what Linux itself reports. Nothing is installed or changed on the server, and nothing is stored.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
