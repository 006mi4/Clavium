import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import {
  CircleCheck,
  CircleHelp,
  Copy,
  FolderOpen,
  HardDriveUpload,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import type { ActiveForward, AiAccess, AiConfirm, HostSummary, KnownHost, SshKeySummary } from '@shared/types'
import { api, hostToInput, on } from '../api'
import { Empty, Group, IconButton, Row, Segmented, Select, Switch, Toolbar, ValueRow, useConfirm, useMenu, useToast } from '../ui'
import { AI_ACCESS_OPTIONS, AI_CONFIRM_OPTIONS, HostEditor } from './HostEditor'

const PROTOCOL_LABEL: Record<HostSummary['protocol'], string> = {
  ssh: 'SSH',
  ftps: 'FTPS (explicit TLS)',
  'ftps-implicit': 'FTPS (implicit TLS)',
  ftp: 'FTP'
}

export function address(h: HostSummary): string {
  return `${h.username ? `${h.username}@` : ''}${h.hostname}${h.port === (h.protocol === 'ssh' ? 22 : h.protocol === 'ftps-implicit' ? 990 : 21) ? '' : `:${h.port}`}`
}

export function HostsPage(props: {
  hosts: HostSummary[]
  keys: SshKeySummary[]
  mcpEnabled: boolean
  selectedId: string | null
  onSelect: (id: string | null) => void
  reload: () => void
  openTerminal: (h: HostSummary) => void
  openFiles: (h: HostSummary) => void
  newHostSignal: number
}) {
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<HostSummary | 'new' | null>(null)

  // Ctrl+N from the app shell
  useEffect(() => {
    if (props.newHostSignal > 0) setEditing('new')
  }, [props.newHostSignal])

  const groups = useMemo(() => [...new Set(props.hosts.map((h) => h.group).filter(Boolean))].sort(), [props.hosts])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return props.hosts
      .filter((h) => !q || `${h.name} ${h.hostname} ${h.username} ${h.group}`.toLowerCase().includes(q))
      .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  }, [props.hosts, query])
  const selected = props.hosts.find((h) => h.id === props.selectedId) ?? null

  // keep a sensible selection
  useEffect(() => {
    if (!selected && visible.length > 0) props.onSelect(visible[0].id)
  }, [selected, visible])

  const connect = (h: HostSummary): void => (h.protocol === 'ssh' ? props.openTerminal(h) : props.openFiles(h))

  const onListKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return
    e.preventDefault()
    const i = visible.findIndex((h) => h.id === props.selectedId)
    if (e.key === 'Enter') {
      if (selected) connect(selected)
      return
    }
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) props.onSelect(next.id)
  }

  let lastGroup: string | null = null

  return (
    <>
      <Toolbar title="Hosts">
        <div className="search">
          <Search size={14} />
          <input className="field" placeholder="Search" aria-label="Search hosts" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="btn prominent" onClick={() => setEditing('new')}>
          <Plus size={15} /> New Host
        </button>
      </Toolbar>

      {props.hosts.length === 0 ? (
        <div className="view-fixed">
          <Empty
            icon={Server}
            title="No Hosts Yet"
            action={
              <button className="btn prominent" onClick={() => setEditing('new')}>
                Add a Host
              </button>
            }
          >
            Add a server to open a terminal, transfer files or share it with an AI assistant.
          </Empty>
        </div>
      ) : (
        <div className="split" style={{ position: 'absolute', inset: 0 }}>
          <div className="list-col">
            <div className="list-scroll" role="listbox" aria-label="Hosts" tabIndex={0} onKeyDown={onListKey}>
              {visible.map((h) => {
                const header = h.group !== lastGroup ? (h.group || (groups.length ? 'Ungrouped' : '')) : null
                lastGroup = h.group
                return (
                  <div key={h.id}>
                    {header && <div className="list-header">{header}</div>}
                    <button
                      className="host-row"
                      role="option"
                      aria-selected={h.id === props.selectedId}
                      tabIndex={-1}
                      onClick={() => props.onSelect(h.id)}
                      onDoubleClick={() => connect(h)}
                    >
                      <span className="proto">{h.protocol === 'ssh' ? <SquareTerminal size={16} /> : <HardDriveUpload size={16} />}</span>
                      <span className="names">
                        <span className="name">{h.name}</span>
                        <span className="addr" style={{ display: 'block' }}>
                          {address(h)}
                        </span>
                      </span>
                      <span className="marks">
                        {h.protocol === 'ftp' && (
                          <span title="Unencrypted connection">
                            <ShieldAlert size={14} style={{ color: 'var(--red)' }} />
                          </span>
                        )}
                        {h.aiAccess !== 'none' && (
                          <span title={`Shared with AI (${h.aiAccess === 'full' ? 'full access' : 'read only'})`}>
                            <Sparkles size={14} />
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                )
              })}
              {visible.length === 0 && <div className="caption" style={{ padding: '16px 10px' }}>No hosts match “{query}”.</div>}
            </div>
          </div>

          <div className="detail-col">
            {selected ? (
              <HostDetail
                key={selected.id}
                host={selected}
                keys={props.keys}
                mcpEnabled={props.mcpEnabled}
                reload={props.reload}
                connect={() => connect(selected)}
                openFiles={() => props.openFiles(selected)}
                edit={() => setEditing(selected)}
                onDeleted={() => props.onSelect(null)}
                onDuplicated={(h) => props.onSelect(h.id)}
              />
            ) : (
              <div className="view-fixed">
                <Empty icon={Server} title="No Host Selected" />
              </div>
            )}
          </div>
        </div>
      )}

      {editing && (
        <HostEditor
          host={editing === 'new' ? undefined : editing}
          keys={props.keys}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null)
            props.reload()
            props.onSelect(saved.id)
          }}
        />
      )}
    </>
  )
}

function HostDetail(props: {
  host: HostSummary
  keys: SshKeySummary[]
  mcpEnabled: boolean
  reload: () => void
  connect: () => void
  openFiles: () => void
  edit: () => void
  onDeleted: () => void
  onDuplicated: (h: HostSummary) => void
}) {
  const h = props.host
  const toast = useToast()
  const confirm = useConfirm()
  const menu = useMenu()
  const [known, setKnown] = useState<KnownHost[]>([])
  const [active, setActive] = useState<ActiveForward[]>([])
  const [busyTunnel, setBusyTunnel] = useState<string | null>(null)
  const ssh = h.protocol === 'ssh'

  useEffect(() => {
    const loadKnown = (): void => void api.knownHosts.list().then(setKnown, () => undefined)
    const loadActive = (): void => void api.fwd.list().then(setActive, () => undefined)
    loadKnown()
    loadActive()
    const off = on('fwd:changed', () => {
      loadActive()
      loadKnown()
    })
    return off
  }, [h.id, h.updatedAt])

  const pinned = known.find((k) => k.id === `${ssh ? 'ssh' : 'ftps'}:${h.hostname}:${h.port}`)
  const key = props.keys.find((k) => k.id === h.keyId)

  const signIn =
    !ssh || h.authMethod === 'password'
      ? h.hasPassword
        ? 'Password, saved in the vault'
        : 'Password, asked when connecting'
      : h.authMethod === 'key'
        ? `SSH key “${key?.name ?? 'missing'}”`
        : h.authMethod === 'agent'
          ? 'SSH agent'
          : 'Interactive (2FA)'

  const update = async (patch: { aiAccess?: AiAccess; aiConfirm?: AiConfirm }): Promise<void> => {
    try {
      await api.hosts.save({ ...hostToInput(h), ...patch })
      props.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete “${h.name}”?`,
      message: 'The host and its saved password are removed from the vault. This can’t be undone.',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    try {
      await api.hosts.remove(h.id)
      props.onDeleted()
      props.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  const toggleTunnel = async (forwardId: string, running: boolean): Promise<void> => {
    setBusyTunnel(forwardId)
    try {
      if (running) await api.fwd.stop(h.id, forwardId)
      else await api.fwd.start(h.id, forwardId)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusyTunnel(null)
    }
  }

  return (
    <div className="view-scroll">
      <div className="page">
        <div className="detail-head">
          <span className="proto large">{ssh ? <SquareTerminal size={24} strokeWidth={1.6} /> : <HardDriveUpload size={24} strokeWidth={1.6} />}</span>
          <div style={{ minWidth: 0 }}>
            <h1>{h.name}</h1>
            <div className="addr">
              {h.username ? `${h.username}@` : ''}
              {h.hostname}:{h.port}
            </div>
          </div>
        </div>

        <div className="detail-actions">
          <button className="btn prominent" onClick={props.connect}>
            {ssh ? <SquareTerminal size={15} /> : <FolderOpen size={15} />}
            {ssh ? 'Connect' : 'Browse Files'}
          </button>
          {ssh && (
            <button className="btn" onClick={props.openFiles}>
              <FolderOpen size={15} /> Browse Files
            </button>
          )}
          <button className="btn" onClick={props.edit}>
            <Pencil size={14} /> Edit
          </button>
          <IconButton
            icon={MoreHorizontal}
            label="More"
            onClick={(e) =>
              menu.openBelow(
                e,
                [
                  {
                    label: 'Duplicate',
                    icon: Copy,
                    onSelect: () =>
                      void api.hosts.duplicate(h.id).then((copy) => {
                        props.reload()
                        props.onDuplicated(copy)
                      }, toast.error)
                  },
                  'separator',
                  { label: 'Delete…', icon: Trash2, destructive: true, onSelect: () => void remove() }
                ],
                'left'
              )
            }
          />
        </div>

        <Group title="Connection">
          <ValueRow label="Protocol">
            {h.protocol === 'ftp' ? (
              <span className="signal danger">
                <ShieldAlert size={14} /> FTP, unencrypted
              </span>
            ) : (
              PROTOCOL_LABEL[h.protocol]
            )}
          </ValueRow>
          <ValueRow label="Sign-in">{signIn}</ValueRow>
          {h.protocol !== 'ftp' && (
            <ValueRow label={ssh ? 'Host key' : 'Certificate'}>
              {pinned ? (
                <span className="signal ok" title={pinned.fingerprint}>
                  <CircleCheck size={14} /> Verified <span className="mono" style={{ color: 'var(--text-2)' }}>{pinned.fingerprint.slice(0, 23)}…</span>
                </span>
              ) : ssh ? (
                <span className="signal muted">
                  <CircleHelp size={14} /> Checked on first connection
                </span>
              ) : (
                'Checked against trusted authorities'
              )}
            </ValueRow>
          )}
          {h.group && <ValueRow label="Group">{h.group}</ValueRow>}
        </Group>

        <Group
          title="AI Access"
          caption={
            h.aiAccess === 'none'
              ? 'This host is hidden from AI assistants.'
              : !props.mcpEnabled
                ? 'The MCP server is off. Turn it on under AI Access to let assistants reach this host.'
                : h.aiAccess === 'full' && h.aiConfirm === 'none'
                  ? 'Assistants can run any command here without asking you.'
                  : h.aiAccess === 'read'
                    ? 'Assistants can list folders and read files. They can’t run commands or change anything.'
                    : ssh
                      ? 'Assistants can run commands and change files.'
                      : 'Assistants can read and change files.'
          }
        >
          <Row label="Allow AI to" multi>
            <Segmented<AiAccess> label="AI access level" value={h.aiAccess} onChange={(v) => void update({ aiAccess: v })} options={AI_ACCESS_OPTIONS} />
          </Row>
          {h.aiAccess !== 'none' && (
            <Row label="Ask me before">
              <Select<AiConfirm> label="Ask me before" value={h.aiConfirm} onChange={(v) => void update({ aiConfirm: v })} options={AI_CONFIRM_OPTIONS} />
            </Row>
          )}
        </Group>

        {ssh && h.forwards.length > 0 && (
          <Group title="Tunnels" caption="Opens a port on this PC and forwards it through SSH.">
            {h.forwards.map((f) => {
              const running = active.some((a) => a.hostId === h.id && a.forwardId === f.id)
              return (
                <label className="row" key={f.id}>
                  <span className="row-label mono" style={{ maxWidth: 'none' }}>
                    127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
                  </span>
                  <span className="row-control">
                    <span className={`signal ${running ? 'ok' : 'muted'}`}>{busyTunnel === f.id ? 'Working…' : running ? 'Active' : 'Off'}</span>
                    <Switch on={running} label={`Tunnel on port ${f.localPort}`} onChange={() => void toggleTunnel(f.id, running)} />
                  </span>
                </label>
              )
            })}
          </Group>
        )}

        {h.notes.trim() && (
          <Group title="Notes">
            <div className="row" style={{ whiteSpace: 'pre-wrap', userSelect: 'text', color: 'var(--text-2)' }}>
              {h.notes}
            </div>
          </Group>
        )}
      </div>
      {menu.element}
    </div>
  )
}
