import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Container, Download, MoreHorizontal, Pause, Play, Plus, RotateCw, ScrollText, Search, Settings2, Square, SquareTerminal, Trash2, X } from 'lucide-react'
import type {
  DockerAction,
  DockerContainer,
  DockerCreateSpec,
  DockerDetails,
  DockerImage,
  DockerOverview,
  DockerPullProgress,
  DockerRestartPolicy,
  DockerStats,
  HostSummary,
  TerminalTarget
} from '@shared/types'
import { api, on } from '../api'
import { Empty, IconButton, Segmented, Select, Sheet, Switch, Toolbar, ValueRow, useConfirm, useMenu, useToast, type MenuItem } from '../ui'
import { StatusDot, type ConnState } from './TerminalView'

const RESTART_LABELS: { value: DockerRestartPolicy; label: string }[] = [
  { value: 'no', label: 'Never' },
  { value: 'on-failure', label: 'Only After a Crash' },
  { value: 'unless-stopped', label: 'Always, Unless I Stopped It' },
  { value: 'always', label: 'Always' }
]

/** running → green, paused or restarting → orange, everything else → grey */
function dotOf(c: DockerContainer): ConnState {
  return c.state === 'running' ? 'connected' : c.state === 'paused' || c.state === 'restarting' ? 'connecting' : c.state === 'dead' ? 'error' : 'closed'
}
const isUp = (c: DockerContainer): boolean => c.state === 'running' || c.state === 'paused' || c.state === 'restarting'

export function DockerView(props: {
  host: HostSummary
  active: boolean
  onState: (s: ConnState) => void
  /** open the log of a container or a shell inside it as a terminal tab */
  onOpenTerminal: (tab: { target: TerminalTarget; name: string }) => void
  onClose: () => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const menu = useMenu()
  const [sid, setSid] = useState<string | null>(null)
  const sidRef = useRef<string | null>(null)
  const [state, setState] = useState<ConnState>('connecting')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [overview, setOverview] = useState<DockerOverview | null>(null)
  const [stats, setStats] = useState<Map<string, DockerStats>>(new Map())
  const [images, setImages] = useState<DockerImage[] | null>(null)
  const [tab, setTab] = useState<'containers' | 'images'>('containers')
  const [filter, setFilter] = useState('')
  /** containers and images an action is running on right now */
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [details, setDetails] = useState<DockerContainer | null>(null)
  const [pulling, setPulling] = useState(false)
  const [creating, setCreating] = useState(false)
  /** the download that is running, with what Docker last reported */
  const [pull, setPull] = useState<{ image: string; done: number; total: number; status: string } | null>(null)

  const report = (s: ConnState, msg = ''): void => {
    setState(s)
    setError(msg)
    props.onState(s)
  }

  const refresh = useCallback(async (): Promise<void> => {
    const id = sidRef.current
    if (!id) return
    try {
      setOverview(await api.docker.overview(id))
    } catch (e) {
      if (sidRef.current === id) toast.error(e)
    }
  }, [])
  const refreshImages = useCallback(async (): Promise<void> => {
    const id = sidRef.current
    if (!id) return
    try {
      setImages(await api.docker.images(id))
    } catch (e) {
      toast.error(e)
    }
  }, [])

  // connect
  useEffect(() => {
    let cancelled = false
    report('connecting')
    api.docker
      .open(props.host.id)
      .then(async (id) => {
        if (cancelled) return void api.docker.close(id)
        sidRef.current = id
        setSid(id)
        report('connected')
        await refresh()
      })
      .catch((e: Error) => !cancelled && report('error', e.message))
    return () => {
      cancelled = true
      if (sidRef.current) void api.docker.close(sidRef.current)
      sidRef.current = null
    }
  }, [attempt])

  useEffect(
    () =>
      on('docker:closed', (id: string) => {
        if (id !== sidRef.current) return
        sidRef.current = null
        setSid(null)
        report('closed', 'The connection was closed.')
      }),
    []
  )

  useEffect(
    () =>
      on('docker:pullProgress', (p: DockerPullProgress) => {
        if (p.id === sidRef.current) setPull((cur) => (cur && cur.image === p.image ? { ...cur, ...p } : cur))
      }),
    []
  )
  const download = async (image: string): Promise<boolean> => {
    if (!sid) return false
    setPull({ image, done: 0, total: 0, status: 'Starting…' })
    try {
      await api.docker.pull(sid, image)
      toast.ok(`Downloaded “${image}”.`)
      await refreshImages()
      return true
    } catch (e) {
      toast.error(e)
      return false
    } finally {
      setPull(null)
    }
  }
  const create = async (spec: DockerCreateSpec): Promise<boolean> => {
    if (!sid) return false
    try {
      await api.docker.create(sid, spec)
      toast.ok(spec.start ? `Created and started ${spec.name ? `“${spec.name}”` : 'the container'}.` : `Created ${spec.name ? `“${spec.name}”` : 'the container'}.`)
      setTab('containers')
      setFilter('')
      return true
    } catch (e) {
      toast.error(e)
      return false
    } finally {
      await refresh()
    }
  }

  // keep the list current while it is on screen; the figures for CPU and memory take Docker about two seconds
  const usable = !!sid && props.active && overview?.status === 'ok'
  useEffect(() => {
    if (!sid || !props.active) return
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
  }, [sid, props.active])
  useEffect(() => {
    if (!usable) return
    let stopped = false
    const load = async (): Promise<void> => {
      const id = sidRef.current
      if (!id) return
      const list = await api.docker.stats(id).catch(() => null)
      if (list && !stopped) setStats(new Map(list.map((s) => [s.id, s])))
    }
    void load()
    const timer = setInterval(() => void load(), 6000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [usable])
  useEffect(() => {
    if (usable && tab === 'images') void refreshImages()
  }, [usable, tab])

  const act = async (action: DockerAction, items: DockerContainer[], done: string): Promise<void> => {
    if (!sid || items.length === 0) return
    const ids = items.map((c) => c.id)
    setBusy((b) => new Set([...b, ...ids]))
    try {
      await api.docker.action(sid, action, ids)
      toast.ok(done)
    } catch (e) {
      toast.error(e)
    }
    setBusy((b) => new Set([...b].filter((x) => !ids.includes(x))))
    await refresh()
  }
  const label = (items: DockerContainer[]): string => (items.length === 1 ? `“${items[0].name}”` : `${items.length} containers`)
  const start = (items: DockerContainer[]): Promise<void> => act('start', items, `Started ${label(items)}.`)
  const stop = (items: DockerContainer[]): Promise<void> => act('stop', items, `Stopped ${label(items)}.`)
  const restart = (items: DockerContainer[]): Promise<void> => act('restart', items, `Restarted ${label(items)}.`)
  const remove = async (c: DockerContainer): Promise<void> => {
    const ok = await confirm({
      title: `Remove the Container “${c.name}”?`,
      message: 'The container and everything stored inside it is deleted. Data in volumes and folders of the server that it used stays. This can’t be undone.',
      confirmLabel: 'Remove',
      destructive: true
    })
    if (ok) await act('remove', [c], `Removed “${c.name}”.`)
  }
  const removeImage = async (image: DockerImage): Promise<void> => {
    if (!sid) return
    const name = image.repository === '<none>' ? image.id.slice(0, 12) : `${image.repository}:${image.tag}`
    const ok = await confirm({
      title: `Delete the Image “${name}”?`,
      message: `This frees ${image.size} on the server. The image has to be downloaded again before it can be used.`,
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    setBusy((b) => new Set([...b, image.id]))
    try {
      await api.docker.removeImage(sid, image.id)
      toast.ok(`Deleted “${name}”.`)
    } catch (e) {
      toast.error(e)
    }
    setBusy((b) => new Set([...b].filter((x) => x !== image.id)))
    await refreshImages()
  }
  const more = (e: React.MouseEvent<HTMLElement>, c: DockerContainer): void => {
    const items: MenuItem[] = []
    if (c.state === 'running') items.push({ label: 'Pause', icon: Pause, onSelect: () => void act('pause', [c], `Paused “${c.name}”.`) })
    if (c.state === 'paused') items.push({ label: 'Resume', icon: Play, onSelect: () => void act('unpause', [c], `Resumed “${c.name}”.`) })
    items.push({ label: 'Details and Settings…', icon: Settings2, onSelect: () => setDetails(c) })
    items.push('separator', { label: 'Remove…', icon: Trash2, destructive: true, disabled: isUp(c), onSelect: () => void remove(c) })
    menu.openBelow(e, items)
  }

  /** compose projects first, each with its containers; then everything started on its own */
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const shown = (overview?.containers ?? []).filter((c) => !q || `${c.name} ${c.image} ${c.project ?? ''}`.toLowerCase().includes(q))
    const byProject = new Map<string, DockerContainer[]>()
    for (const c of shown) byProject.set(c.project ?? '', [...(byProject.get(c.project ?? '') ?? []), c])
    return [...byProject.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
      .map(([project, list]) => ({ project, list: list.sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [overview, filter])

  const all = overview?.containers ?? []
  const running = all.filter((c) => c.state === 'running').length
  const shownImages = (images ?? []).filter((i) => !filter.trim() || `${i.repository}:${i.tag}`.toLowerCase().includes(filter.trim().toLowerCase()))

  return (
    <>
      <Toolbar
        title={`Docker · ${props.host.name}`}
        subtitle={
          <>
            <StatusDot state={state} />
            {state !== 'connected'
              ? state === 'connecting'
                ? 'Connecting…'
                : 'Disconnected'
              : overview?.status === 'ok'
                ? `Docker ${overview.version} · ${running} running, ${all.length - running} stopped`
                : 'Connected'}
          </>
        }
      >
        {overview?.status === 'ok' && (
          <Segmented
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'containers', label: 'Containers' },
              { value: 'images', label: 'Images' }
            ]}
          />
        )}
        {overview?.status === 'ok' && (
          <>
            <IconButton
              icon={Plus}
              label="New Container"
              onClick={() => {
                void refreshImages()
                setCreating(true)
              }}
            />
            <IconButton icon={Download} label="Download Image" disabled={!!pull} onClick={() => setPulling(true)} />
          </>
        )}
        <IconButton icon={RotateCw} label="Reload" disabled={!sid} onClick={() => void (tab === 'images' ? refreshImages() : refresh())} />
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
      ) : !overview ? (
        <div className="view-fixed">
          <div className="overlay" style={{ position: 'relative', flex: 1 }}>
            <div className="box">
              <div className="spinner" />
              <p>Asking Docker…</p>
            </div>
          </div>
        </div>
      ) : overview.status !== 'ok' ? (
        <div className="view-fixed">
          <Empty
            icon={Container}
            title={overview.status === 'missing' ? 'Docker Is Not Installed Here' : overview.status === 'denied' ? 'This User May Not Use Docker' : 'Docker Doesn’t Answer'}
          >
            {overview.status === 'missing' && 'There is no “docker” command on this server.'}
            {overview.status === 'denied' && (
              <>
                The user “{props.host.username}” is not allowed to talk to Docker. An administrator can change that with
                <br />
                <span className="mono">sudo usermod -aG docker {props.host.username}</span>
                <br />
                After that, connect again.
              </>
            )}
            {overview.status === 'error' && (overview.message || 'Is the Docker service running?')}
          </Empty>
        </div>
      ) : (
        <div className="view-scroll">
          <div className="page wide docker">
            {pull && (
              <div className="docker-pull" role="status">
                <div className="spinner tiny" />
                <div className="body">
                  <div className="primary">Downloading {pull.image}{pull.total > 0 ? ` · ${pull.done} of ${pull.total} parts` : ''}</div>
                  <div className="secondary">{pull.status}</div>
                </div>
                <div className="bar">
                  <div style={{ width: `${pull.total ? Math.max(4, (pull.done / pull.total) * 100) : 4}%` }} />
                </div>
              </div>
            )}
            <div className="search" style={{ width: 260, marginBottom: 16 }}>
              <Search size={14} />
              <input className="field" placeholder={tab === 'images' ? 'Filter images' : 'Filter containers'} aria-label="Filter" spellCheck={false} value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>

            {tab === 'containers' &&
              (all.length === 0 ? (
                <Empty icon={Container} title="No Containers Yet">
                  Containers that are created on this server show up here.
                </Empty>
              ) : groups.length === 0 ? (
                <Empty icon={Search} title="Nothing to Show">
                  No container matches “{filter.trim()}”.
                </Empty>
              ) : (
                groups.map(({ project, list }) => {
                  const up = list.filter(isUp)
                  const down = list.filter((c) => !isUp(c))
                  return (
                    <section key={project || '-'} aria-label={project || 'Containers'}>
                      <div className="docker-head">
                        <h3>{project || (groups.length > 1 ? 'Other Containers' : 'Containers')}</h3>
                        {project && <span className="count">{up.length} of {list.length} running</span>}
                        {project && (
                          <span className="actions">
                            <button className="btn small" disabled={down.length === 0} onClick={() => void start(down)}>
                              Start All
                            </button>
                            <button className="btn small" disabled={up.length === 0} onClick={() => void stop(up)}>
                              Stop All
                            </button>
                            <button className="btn small" disabled={up.length === 0} onClick={() => void restart(up)}>
                              Restart All
                            </button>
                          </span>
                        )}
                      </div>
                      <div className="group">
                        {list.map((c) => {
                          const s = stats.get(c.id)
                          const working = busy.has(c.id)
                          return (
                            <div className="item docker-row" key={c.id} role="group" aria-label={c.name} onDoubleClick={() => setDetails(c)}>
                              {working ? <div className="spinner tiny" /> : <StatusDot state={dotOf(c)} />}
                              <div className="body">
                                <div className="primary">{c.name}</div>
                                <div className="secondary">
                                  {c.image} · {c.status}
                                </div>
                              </div>
                              <div className="ports">
                                {c.ports.slice(0, 3).map((p) => (
                                  <span className="port" key={p} title="Port on the server → port in the container">
                                    {p}
                                  </span>
                                ))}
                                {c.ports.length > 3 && <span className="port">+{c.ports.length - 3}</span>}
                              </div>
                              <div className="usage" title="Processor and memory in use">
                                {c.state === 'running' && s ? (
                                  <>
                                    <span>{s.cpu}</span>
                                    <span>{s.memory}</span>
                                  </>
                                ) : null}
                              </div>
                              <div className="side">
                                {isUp(c) ? (
                                  <IconButton icon={Square} label={`Stop ${c.name}`} disabled={working} onClick={() => void stop([c])} />
                                ) : (
                                  <IconButton icon={Play} label={`Start ${c.name}`} disabled={working} onClick={() => void start([c])} />
                                )}
                                <IconButton icon={RotateCw} label={`Restart ${c.name}`} disabled={working || !isUp(c)} onClick={() => void restart([c])} />
                                <IconButton icon={ScrollText} label={`Log of ${c.name}`} onClick={() => props.onOpenTerminal({ target: { dockerLogs: c.id }, name: `${c.name} log` })} />
                                <IconButton
                                  icon={SquareTerminal}
                                  label={`Shell in ${c.name}`}
                                  disabled={c.state !== 'running'}
                                  onClick={() => props.onOpenTerminal({ target: { dockerShell: c.id }, name: `${c.name} shell` })}
                                />
                                <IconButton icon={MoreHorizontal} label={`More for ${c.name}`} disabled={working} onClick={(e) => more(e, c)} />
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )
                })
              ))}

            {tab === 'images' &&
              (images === null ? (
                <p className="caption">Loading images…</p>
              ) : shownImages.length === 0 ? (
                <Empty icon={Box} title={images.length ? 'Nothing to Show' : 'No Images'}>
                  {images.length ? `No image matches “${filter.trim()}”.` : 'Images are downloaded when a container is created from them.'}
                </Empty>
              ) : (
                <div className="group">
                  {shownImages.map((i) => (
                    <div className="item docker-row" key={i.id} role="group" aria-label={`${i.repository}:${i.tag}`}>
                      <Box size={16} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
                      <div className="body">
                        <div className="primary">
                          {i.repository}
                          {i.tag && i.tag !== '<none>' && <span style={{ color: 'var(--text-2)', fontWeight: 400 }}>:{i.tag}</span>}
                        </div>
                        <div className="secondary">
                          {i.size} · created {i.created}
                        </div>
                      </div>
                      {i.inUse && <span className="port">in use</span>}
                      <div className="side">
                        {busy.has(i.id) ? (
                          <div className="spinner tiny" />
                        ) : (
                          <IconButton icon={Trash2} label={i.inUse ? 'In use by a container' : `Delete ${i.repository}:${i.tag}`} disabled={i.inUse} onClick={() => void removeImage(i)} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </div>
      )}
      {menu.element}
      {pulling && (
        <PullSheet
          close={() => setPulling(false)}
          start={(image) => {
            setPulling(false)
            setTab('images')
            void download(image)
          }}
        />
      )}
      {creating && (
        <CreateSheet
          images={images}
          close={() => setCreating(false)}
          create={create}
          download={() => {
            setCreating(false)
            setPulling(true)
          }}
        />
      )}
      {details && sid && <DetailsSheet sid={sid} container={details} close={() => setDetails(null)} changed={() => void refresh()} />}
    </>
  )
}

function DetailsSheet(props: { sid: string; container: DockerContainer; close: () => void; changed: () => void }) {
  const toast = useToast()
  const [info, setInfo] = useState<DockerDetails | null>(null)
  const [failed, setFailed] = useState('')
  const [policy, setPolicy] = useState<DockerRestartPolicy>('no')
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    api.docker
      .inspect(props.sid, props.container.id)
      .then((d) => {
        setInfo(d)
        setPolicy(d.restartPolicy)
      })
      .catch((e: Error) => setFailed(e.message))
  }, [])
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await api.docker.restartPolicy(props.sid, props.container.id, policy)
      toast.ok(`“${props.container.name}” now restarts: ${RESTART_LABELS.find((r) => r.value === policy)?.label}.`)
      props.changed()
      props.close()
    } catch (e) {
      toast.error(e)
      setSaving(false)
    }
  }
  const when = (iso: string): string => (iso && !iso.startsWith('0001') ? new Date(iso).toLocaleString() : '—')
  return (
    <Sheet
      title={props.container.name}
      eyebrow="Container"
      onClose={props.close}
      footer={
        <>
          <button className="btn" onClick={props.close}>
            {info && policy !== info.restartPolicy ? 'Cancel' : 'Close'}
          </button>
          {info && policy !== info.restartPolicy && (
            <button className="btn prominent" disabled={saving} onClick={() => void save()}>
              Save
            </button>
          )}
        </>
      }
    >
      {failed ? (
        <p>{failed}</p>
      ) : !info ? (
        <div className="spinner" />
      ) : (
        <>
          <div className="group">
            <label className="row">
              <span className="row-label">
                Start again by itself
                <span className="hint">When its program ends or the server restarts.</span>
              </span>
              <span className="row-control">
                <Select<DockerRestartPolicy> label="Start again by itself" value={policy} onChange={setPolicy} options={RESTART_LABELS} />
              </span>
            </label>
          </div>
          <div className="group" style={{ marginTop: 14 }}>
            <ValueRow label="Status">{props.container.status}</ValueRow>
            <ValueRow label="Image">{info.image}</ValueRow>
            {info.command && (
              <ValueRow label="Command">
                <span className="mono">{info.command}</span>
              </ValueRow>
            )}
            <ValueRow label="Created">{when(info.created)}</ValueRow>
            <ValueRow label="Last started">{when(info.startedAt)}</ValueRow>
            {info.restartCount > 0 && <ValueRow label="Restarted by Docker">{info.restartCount} times</ValueRow>}
            {props.container.project && (
              <ValueRow label="Compose project">
                {props.container.project}
                {info.workingDir && <span className="mono"> · {info.workingDir}</span>}
              </ValueRow>
            )}
            {props.container.ports.length > 0 && <ValueRow label="Ports">{props.container.ports.join(', ')}</ValueRow>}
            {info.networks.length > 0 && <ValueRow label="Networks">{info.networks.map((n) => (n.ip ? `${n.name} (${n.ip})` : n.name)).join(', ')}</ValueRow>}
          </div>
          {info.mounts.length > 0 && (
            <>
              <div className="group-title">Folders and Volumes</div>
              <div className="group">
                {info.mounts.map((m) => (
                  <ValueRow key={m.target} label={m.target}>
                    <span className="mono">
                      {m.source}
                      {m.readOnly ? ' (read only)' : ''}
                    </span>
                  </ValueRow>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  )
}

const IMAGE_REF = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[0-9a-f]{64})?$/

function PullSheet(props: { close: () => void; start: (image: string) => void }) {
  const [image, setImage] = useState('')
  const valid = IMAGE_REF.test(image)
  return (
    <Sheet
      size="narrow"
      title="Download an Image"
      onClose={props.close}
      footer={
        <>
          <button className="btn" onClick={props.close}>
            Cancel
          </button>
          <button className="btn prominent" disabled={!valid} onClick={() => props.start(image)}>
            Download
          </button>
        </>
      }
    >
      <p>An image is the packaged program a container is made from. Docker fetches it from Docker Hub unless the name contains another address.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) props.start(image)
        }}
      >
        <input className="field mono" aria-label="Image name" placeholder="e.g. nginx or postgres:17" autoFocus spellCheck={false} value={image} onChange={(e) => setImage(e.target.value.trim())} />
      </form>
      {image && !valid && <p>Image names are lower case, for example nginx, nginx:1.27 or ghcr.io/owner/app:v2.</p>}
    </Sheet>
  )
}

interface PortRow {
  host: string
  container: string
  protocol: 'tcp' | 'udp'
  localOnly: boolean
}
interface MountRow {
  source: string
  target: string
  readOnly: boolean
}
interface EnvRow {
  name: string
  value: string
}
const isPort = (v: string): boolean => /^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535
const isPath = (v: string): boolean => v.startsWith('/') && !/[,"]/.test(v)

function CreateSheet(props: { images: DockerImage[] | null; close: () => void; create: (spec: DockerCreateSpec) => Promise<boolean>; download: () => void }) {
  const choices = (props.images ?? []).filter((i) => i.repository !== '<none>' && i.tag !== '<none>').map((i) => `${i.repository}:${i.tag}`)
  const [image, setImage] = useState('')
  const [name, setName] = useState('')
  const [ports, setPorts] = useState<PortRow[]>([])
  const [mounts, setMounts] = useState<MountRow[]>([])
  const [env, setEnv] = useState<EnvRow[]>([])
  const [restart, setRestart] = useState<DockerRestartPolicy>('unless-stopped')
  const [command, setCommand] = useState('')
  const [start, setStart] = useState(true)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!image && choices.length) setImage(choices[0])
  }, [choices.length])

  const problem = !image
    ? 'Choose an image.'
    : name && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(name)
      ? 'Use letters, digits, dots, dashes and underscores for the name.'
      : ports.some((p) => !isPort(p.host) || !isPort(p.container))
        ? 'Ports are numbers from 1 to 65535.'
        : mounts.some((m) => !isPath(m.source) || !isPath(m.target))
          ? 'Folders need a full path like /srv/data, without commas or quotes.'
          : env.some((e) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name))
            ? 'Names of variables consist of letters, digits and underscores.'
            : ''

  const submit = async (): Promise<void> => {
    if (problem || busy) return
    setBusy(true)
    const done = await props.create({
      image,
      name: name || undefined,
      ports: ports.map((p) => ({ host: Number(p.host), container: Number(p.container), protocol: p.protocol, localOnly: p.localOnly })),
      mounts,
      env,
      restart,
      command: command.trim() || undefined,
      start
    })
    if (done) props.close()
    else setBusy(false)
  }
  const change = <T,>(list: T[], set: (l: T[]) => void, i: number, patch: Partial<T>): void => set(list.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const drop = <T,>(list: T[], set: (l: T[]) => void, i: number): void => set(list.filter((_, j) => j !== i))

  return (
    <Sheet
      size="wide"
      title="New Container"
      onClose={props.close}
      footer={
        <>
          {problem && image && <span className="form-problem">{problem}</span>}
          <button className="btn" onClick={props.close}>
            Cancel
          </button>
          <button className="btn prominent" disabled={!!problem || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : start ? 'Create and Start' : 'Create'}
          </button>
        </>
      }
    >
      <div className="group">
        <div className="row" role="group" aria-label="Image">
          <span className="row-label">
            Image
            <span className="hint">The packaged program the container runs.</span>
          </span>
          <span className="row-control">
            {props.images === null ? (
              <div className="spinner tiny" />
            ) : choices.length === 0 ? (
              <span style={{ color: 'var(--text-2)' }}>None on this server yet</span>
            ) : (
              <Select<string> label="Image" value={image} onChange={setImage} options={choices.map((c) => ({ value: c, label: c }))} />
            )}
            <button className="btn" onClick={props.download}>
              Download…
            </button>
          </span>
        </div>
        <label className="row">
          <span className="row-label">
            Name
            <span className="hint">Optional. Docker invents one otherwise.</span>
          </span>
          <span className="row-control">
            <input className="field" aria-label="Name" placeholder="e.g. website" spellCheck={false} style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value.trim())} />
          </span>
        </label>
        <label className="row">
          <span className="row-label">
            Start again by itself
            <span className="hint">When its program ends or the server restarts.</span>
          </span>
          <span className="row-control">
            <Select<DockerRestartPolicy> label="Start again by itself" value={restart} onChange={setRestart} options={RESTART_LABELS} />
          </span>
        </label>
        <label className="row">
          <span className="row-label">Start it right away</span>
          <span className="row-control">
            <Switch on={start} onChange={setStart} label="Start it right away" />
          </span>
        </label>
      </div>

      <div className="group-title">Ports</div>
      <p className="caption" style={{ margin: '0 2px 8px' }}>
        Makes a port of the container reachable through a port of the server, e.g. a website on port 80 through 8080.
      </p>
      <div className="group">
        {ports.map((p, i) => (
          <div className="row form-line" key={i} role="group" aria-label={`Port ${i + 1}`}>
            <input className="field" style={{ width: 84 }} inputMode="numeric" aria-label="Port on the server" placeholder="8080" value={p.host} onChange={(e) => change(ports, setPorts, i, { host: e.target.value.trim() })} />
            <span className="arrow">→</span>
            <input className="field" style={{ width: 84 }} inputMode="numeric" aria-label="Port in the container" placeholder="80" value={p.container} onChange={(e) => change(ports, setPorts, i, { container: e.target.value.trim() })} />
            <Select<'tcp' | 'udp'> label="Protocol" value={p.protocol} onChange={(v) => change(ports, setPorts, i, { protocol: v })} options={[{ value: 'tcp', label: 'TCP' }, { value: 'udp', label: 'UDP' }]} />
            <Select<string>
              label="Reachable from"
              value={p.localOnly ? 'local' : 'all'}
              onChange={(v) => change(ports, setPorts, i, { localOnly: v === 'local' })}
              options={[
                { value: 'all', label: 'Reachable from everywhere' },
                { value: 'local', label: 'Only from the server itself' }
              ]}
            />
            <span className="fill" />
            <IconButton icon={X} label="Remove Port" onClick={() => drop(ports, setPorts, i)} />
          </div>
        ))}
        <div className="row">
          <button className="btn" onClick={() => setPorts([...ports, { host: '', container: '', protocol: 'tcp', localOnly: false }])}>
            <Plus size={14} /> Add Port
          </button>
        </div>
      </div>

      <div className="group-title">Folders</div>
      <p className="caption" style={{ margin: '0 2px 8px' }}>
        Gives the container a folder of the server, so its data stays when the container is removed. The folder must exist.
      </p>
      <div className="group">
        {mounts.map((m, i) => (
          <div className="row form-line" key={i} role="group" aria-label={`Folder ${i + 1}`}>
            <input className="field mono" style={{ flex: 1, minWidth: 0 }} aria-label="Folder on the server" placeholder="/srv/website" spellCheck={false} value={m.source} onChange={(e) => change(mounts, setMounts, i, { source: e.target.value })} />
            <span className="arrow">→</span>
            <input className="field mono" style={{ flex: 1, minWidth: 0 }} aria-label="Path in the container" placeholder="/usr/share/nginx/html" spellCheck={false} value={m.target} onChange={(e) => change(mounts, setMounts, i, { target: e.target.value })} />
            <label className="check">
              <input type="checkbox" checked={m.readOnly} onChange={(e) => change(mounts, setMounts, i, { readOnly: e.target.checked })} /> Read only
            </label>
            <IconButton icon={X} label="Remove Folder" onClick={() => drop(mounts, setMounts, i)} />
          </div>
        ))}
        <div className="row">
          <button className="btn" onClick={() => setMounts([...mounts, { source: '', target: '', readOnly: false }])}>
            <Plus size={14} /> Add Folder
          </button>
        </div>
      </div>

      <div className="group-title">Settings of the Program</div>
      <p className="caption" style={{ margin: '0 2px 8px' }}>
        Environment variables, as listed in the description of the image, e.g. POSTGRES_PASSWORD. They are sent to Docker directly and do not show up in the command line.
      </p>
      <div className="group">
        {env.map((v, i) => (
          <div className="row form-line" key={i} role="group" aria-label={`Variable ${i + 1}`}>
            <input className="field mono" style={{ width: 220 }} aria-label="Name of the variable" placeholder="NAME" spellCheck={false} value={v.name} onChange={(e) => change(env, setEnv, i, { name: e.target.value.trim() })} />
            <span className="arrow">=</span>
            <input className="field mono" style={{ flex: 1, minWidth: 0 }} aria-label="Value of the variable" placeholder="value" spellCheck={false} value={v.value} onChange={(e) => change(env, setEnv, i, { value: e.target.value })} />
            <IconButton icon={X} label="Remove Variable" onClick={() => drop(env, setEnv, i)} />
          </div>
        ))}
        <div className="row">
          <button className="btn" onClick={() => setEnv([...env, { name: '', value: '' }])}>
            <Plus size={14} /> Add Variable
          </button>
        </div>
        <label className="row">
          <span className="row-label">
            Command
            <span className="hint">Optional. Replaces what the image starts by default.</span>
          </span>
          <span className="row-control">
            <input className="field mono" aria-label="Command" spellCheck={false} style={{ width: 260 }} value={command} onChange={(e) => setCommand(e.target.value)} />
          </span>
        </label>
      </div>
    </Sheet>
  )
}
