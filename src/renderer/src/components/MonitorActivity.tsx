import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Copy, Info, ListFilter, MoreHorizontal, OctagonX, Power, Search } from 'lucide-react'
import type { MonitorActivity, MonitorPort, MonitorProcess, MonitorSignal } from '@shared/types'
import { api } from '../api'
import { Empty, IconButton, formatBytes, useConfirm, useMenu, useToast, type MenuItem } from '../ui'

type Activity = Extract<MonitorActivity, { supported: true }>

/** More rows than this make the list slow and nobody reads them: the search finds the rest. */
const MAX_ROWS = 200

const STATES: Record<string, string> = { R: 'running', S: 'waiting', I: 'idle', D: 'waiting for a disk', Z: 'ended, not yet cleared away', T: 'stopped', t: 'stopped by a debugger' }

const percent = (v: number | null): string => (v === null ? '…' : v > 0 && v < 0.05 ? '< 0.1 %' : `${v > 0 && v < 10 ? v.toFixed(1) : Math.round(v)} %`)

/** What a process is called in sentences: its command, shortened, or its name. */
const titleOf = (p: MonitorProcess): string => p.name || `process ${p.pid}`

/**
 * Ends a process after asking, with the consequences spelled out: whose process it is, whether
 * sudo is needed for it, and whether the monitor itself depends on it.
 */
function useEndProcess(sid: string, activity: Activity, refresh: () => void) {
  const confirm = useConfirm()
  const toast = useToast()
  return async (p: MonitorProcess, signal: MonitorSignal): Promise<void> => {
    const foreign = !p.own && !activity.self.root
    const parts: string[] = []
    parts.push(signal === 'TERM' ? 'The program is asked to end and can still save its work.' : 'The program is stopped at once and cannot save anything. Use this only when it does not react to “End”.')
    if (foreign) parts.push(`It belongs to ${p.user}, not to ${activity.self.user}. Clavium tries this with sudo, which only works if ${activity.self.user} may use sudo without a password. The server notes the attempt in its log.`)
    if (p.connection) parts.push('This connection runs through this process: ending it disconnects the monitor, and with it possibly your terminals on this server.')
    const ok = await confirm({
      title: `${signal === 'TERM' ? 'End' : 'Force'} “${titleOf(p)}” (process ${p.pid})${signal === 'TERM' ? '?' : ' to quit?'}`,
      message: parts.join(' '),
      confirmLabel: signal === 'TERM' ? 'End' : 'Force Quit',
      destructive: true
    })
    if (!ok) return
    try {
      await api.monitor.signal(sid, p.pid, p.start, signal, foreign)
      toast.ok(signal === 'TERM' ? `Asked “${titleOf(p)}” to end.` : `Stopped “${titleOf(p)}”.`)
      refresh()
    } catch (e) {
      toast.error(e)
    }
  }
}

/** Why a process offers no actions, or null when it can be ended. */
function fixed(p: MonitorProcess): string | null {
  if (p.kernel) return 'part of the system'
  if (p.pid === 1) return 'starts everything else'
  if (p.state === 'Z') return 'already ended'
  return null
}

type SortKey = 'cpu' | 'memory' | 'name' | 'user' | 'pid'

function SortHead(props: { id: SortKey; sort: { key: SortKey; down: boolean }; set: (s: { key: SortKey; down: boolean }) => void; numeric?: boolean; hint?: string; children: ReactNode }) {
  const active = props.sort.key === props.id
  return (
    <th scope="col" className={props.numeric ? 'num' : undefined} aria-sort={active ? (props.sort.down ? 'descending' : 'ascending') : 'none'}>
      <button type="button" title={props.hint} onClick={() => props.set({ key: props.id, down: active ? !props.sort.down : props.id === 'cpu' || props.id === 'memory' })}>
        {props.children}
        {active && (props.sort.down ? <ArrowDown size={12} aria-hidden="true" /> : <ArrowUp size={12} aria-hidden="true" />)}
      </button>
    </th>
  )
}

export function ProcessesTab(props: { sid: string; activity: Activity; filter: string; setFilter: (f: string) => void; refresh: () => void }) {
  const { activity } = props
  const menu = useMenu()
  const toast = useToast()
  const end = useEndProcess(props.sid, activity, props.refresh)
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: 'cpu', down: true })
  const [mine, setMine] = useState(false)

  const rows = useMemo(() => {
    const q = props.filter.trim().toLowerCase()
    const dir = sort.down ? -1 : 1
    return activity.processes
      .filter((p) => (!mine || p.own) && (!q || `${p.name} ${p.command} ${p.user} ${p.pid}`.toLowerCase().includes(q)))
      .sort((a, b) => {
        const by = sort.key === 'cpu' ? (a.cpu ?? -1) - (b.cpu ?? -1) : sort.key === 'memory' ? a.memory - b.memory : sort.key === 'pid' ? a.pid - b.pid : sort.key === 'user' ? a.user.localeCompare(b.user) : a.name.localeCompare(b.name)
        return by * dir || a.pid - b.pid
      })
  }, [activity.processes, props.filter, sort, mine])

  const actions = (p: MonitorProcess): MenuItem[] => [
    { label: 'End…', icon: Power, onSelect: () => void end(p, 'TERM') },
    { label: 'Force Quit…', icon: OctagonX, destructive: true, onSelect: () => void end(p, 'KILL') },
    'separator',
    { label: 'Copy Command', icon: Copy, onSelect: () => void api.clipboard.write(p.command || p.name).then(() => toast.ok('Copied.'), toast.error) }
  ]

  return (
    <div className="mon mon-act">
      {activity.hidden && !activity.self.root && (
        <p className="note">
          <Info size={15} aria-hidden="true" />
          <span>
            This server shows {activity.self.user} only its own processes. Other users run processes too, but the server hides them, so they are missing here and their load is not counted. Connect as root to see everything.
          </span>
        </p>
      )}
      <div className="mon-bar">
        <div className="search">
          <Search size={14} aria-hidden="true" />
          <input className="field" type="search" aria-label="Search processes" placeholder="Search processes" spellCheck={false} value={props.filter} onChange={(e) => props.setFilter(e.target.value)} />
        </div>
        <button type="button" className="btn" aria-pressed={mine} onClick={() => setMine((m) => !m)}>
          <ListFilter size={14} aria-hidden="true" /> Only Mine
        </button>
        <span className="mon-count" role="status">
          {rows.length === activity.processes.length ? `${rows.length} processes` : `${rows.length} of ${activity.processes.length} processes`}
          {rows.length > MAX_ROWS ? `, the first ${MAX_ROWS} shown` : ''}
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty icon={Search} title="No Process Matches" />
      ) : (
        <div className="mon-scroll" role="region" aria-label="Processes" tabIndex={0}>
          <table className="mon-list">
            <thead>
              <tr>
                <SortHead id="name" sort={sort} set={setSort}>
                  Process
                </SortHead>
                <SortHead id="user" sort={sort} set={setSort}>
                  User
                </SortHead>
                <SortHead id="cpu" sort={sort} set={setSort} numeric hint="Share of one processor since the last measurement. 100 % is one whole core, so a program on several cores can show more.">
                  Processor
                </SortHead>
                <SortHead id="memory" sort={sort} set={setSort} numeric hint="Memory the process really holds">
                  Memory
                </SortHead>
                <SortHead id="pid" sort={sort} set={setSort} numeric hint="The number of the process (PID)">
                  Number
                </SortHead>
                <th scope="col">
                  <span className="mon-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, MAX_ROWS).map((p) => {
                const why = fixed(p)
                return (
                  <tr key={`${p.pid}-${p.start}`}>
                    <th scope="row">
                      <span className="mon-name">
                        {p.kernel ? `[${p.name}]` : p.name}
                        {p.connection && <span className="mon-badge">this connection</span>}
                        {p.state !== 'S' && p.state !== 'I' && p.state !== 'R' && <span className="mon-badge">{STATES[p.state] ?? `state ${p.state}`}</span>}
                      </span>
                      <span className="mon-cmd mono" title={p.command || undefined}>
                        {p.kernel ? 'part of the system' : p.command || 'command not readable'}
                      </span>
                    </th>
                    <td>{p.user}</td>
                    <td className="num">{percent(p.cpu)}</td>
                    <td className="num">
                      {formatBytes(p.memory)}
                      {activity.memTotal > 0 && p.memory > 0 && <span className="dim"> · {percent((p.memory / activity.memTotal) * 100)}</span>}
                    </td>
                    <td className="num">{p.pid}</td>
                    <td className="act">{why ? <span className="mon-sr">No actions: {why}</span> : <IconButton icon={MoreHorizontal} label={`Actions for ${titleOf(p)}, process ${p.pid}`} onClick={(e) => menu.openBelow(e, actions(p))} />}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="caption">
        {activity.self.root
          ? 'Connected as root: every process can be ended from here.'
          : `Connected as ${activity.self.user}: this user can end its own processes. For others Clavium tries sudo, which works only where ${activity.self.user} may use it without a password.`}{' '}
        Processor shares compare two measurements, a few seconds apart.
      </p>
      {menu.element}
    </div>
  )
}

const REACH: Record<MonitorPort['scope'], { text: string; hint: string }> = {
  all: { text: 'Every network', hint: 'The program accepts connections on every address of the server. Whether they arrive from outside depends on firewalls.' },
  local: { text: 'This server only', hint: 'Only programs on the server itself can connect.' },
  address: { text: 'Certain addresses', hint: 'The program accepts connections only on the addresses listed.' }
}

export function PortsTab(props: { sid: string; activity: Activity; refresh: () => void; showProcess: (pid: number) => void }) {
  const { activity } = props
  const menu = useMenu()
  const toast = useToast()
  const end = useEndProcess(props.sid, activity, props.refresh)
  const [filter, setFilter] = useState('')
  const byPid = useMemo(() => new Map(activity.processes.map((p) => [p.pid, p])), [activity.processes])

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return activity.ports.filter((p) => {
      if (!q) return true
      const holder = p.pid ? byPid.get(p.pid) : undefined
      return `${p.port} ${p.protocol} ${p.user} ${p.usual ?? ''} ${p.addresses.join(' ')} ${holder?.name ?? ''} ${holder?.command ?? ''}`.toLowerCase().includes(q)
    })
  }, [activity.ports, filter, byPid])

  const hiddenCount = activity.ports.filter((p) => p.holder === 'hidden').length

  const actions = (port: MonitorPort, holder: MonitorProcess | undefined): MenuItem[] => {
    const items: MenuItem[] = []
    if (holder && !fixed(holder)) {
      items.push({ label: `End “${titleOf(holder)}”…`, icon: Power, onSelect: () => void end(holder, 'TERM') })
      items.push({ label: `Force “${titleOf(holder)}” to Quit…`, icon: OctagonX, destructive: true, onSelect: () => void end(holder, 'KILL') })
    }
    if (holder) items.push({ label: 'Show in Processes', icon: Search, onSelect: () => props.showProcess(holder.pid) })
    if (items.length) items.push('separator')
    items.push({ label: 'Copy Port', icon: Copy, onSelect: () => void api.clipboard.write(String(port.port)).then(() => toast.ok('Copied.'), toast.error) })
    return items
  }

  return (
    <div className="mon mon-act">
      {hiddenCount > 0 && (
        <p className="note">
          <Info size={15} aria-hidden="true" />
          <span>
            {hiddenCount === 1 ? 'One port belongs' : `${hiddenCount} ports belong`} to other users. The server tells {activity.self.user} who owns them, but not which program it is. Connect as root to see the programs.
          </span>
        </p>
      )}
      <div className="mon-bar">
        <div className="search">
          <Search size={14} aria-hidden="true" />
          <input className="field" type="search" aria-label="Search ports" placeholder="Search ports" spellCheck={false} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <span className="mon-count" role="status">
          {rows.length === activity.ports.length ? `${rows.length} open ports` : `${rows.length} of ${activity.ports.length} open ports`}
        </span>
      </div>
      {activity.ports.length === 0 ? (
        <Empty icon={Search} title="No Open Ports Found">
          No program on this server waits for connections, or the server does not let this user see them.
        </Empty>
      ) : rows.length === 0 ? (
        <Empty icon={Search} title="No Port Matches" />
      ) : (
        <div className="mon-scroll" role="region" aria-label="Open ports" tabIndex={0}>
          <table className="mon-list">
            <thead>
              <tr>
                <th scope="col">Port</th>
                <th scope="col">Reachable From</th>
                <th scope="col">Program</th>
                <th scope="col">User</th>
                <th scope="col">
                  <span className="mon-sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((port) => {
                const holder = port.pid ? byPid.get(port.pid) : undefined
                const reach = REACH[port.scope]
                return (
                  <tr key={`${port.protocol}-${port.port}-${port.uid}-${port.pids.join('.')}-${port.addresses.join('.')}`}>
                    <th scope="row">
                      <span className="mon-name">
                        <span className="mon-port">{port.port}</span>
                        <span className="mon-badge">{port.protocol.toUpperCase()}</span>
                      </span>
                      {port.usual && <span className="mon-cmd">usually {port.usual}</span>}
                    </th>
                    <td>
                      <span className={`mon-reach ${port.scope}`} title={reach.hint}>
                        {reach.text}
                      </span>
                      <span className="mon-cmd mono">{port.addresses.join(', ')}</span>
                    </td>
                    <td>
                      {holder ? (
                        <>
                          <span className="mon-name">
                            {holder.name}
                            {port.pids.length > 1 && <span className="mon-badge">{port.pids.length} processes</span>}
                          </span>
                          <span className="mon-cmd mono" title={holder.command || undefined}>
                            {holder.command || `process ${holder.pid}`}
                          </span>
                        </>
                      ) : (
                        <span className="mon-unknown">
                          {port.holder === 'hidden'
                            ? `A program of ${port.user}. ${activity.self.user} may not see which one.`
                            : port.holder === 'kernel'
                              ? 'The system itself, not a program.'
                              : 'No program found. It may run in a container or have just ended.'}
                        </span>
                      )}
                    </td>
                    <td>{port.user}</td>
                    <td className="act">
                      <IconButton icon={MoreHorizontal} label={`Actions for port ${port.port} (${port.protocol.toUpperCase()})`} onClick={(e) => menu.openBelow(e, actions(port, holder))} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="caption">
        Listed are the ports on which a program on this server waits for connections. Whether a port can be reached from outside also depends on firewalls, which this list does not show. Ports that a firewall rule
        passes on to a container without a program listening on the server do not appear here.
      </p>
      {menu.element}
    </div>
  )
}
