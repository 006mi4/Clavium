import { useMemo, useState } from 'react'
import type { HostSummary, SshKeySummary } from '@shared/types'
import { api } from '../api'
import { Icon, useToast } from '../ui'
import { HostEditor } from './HostEditor'

export function HostsPage(props: {
  hosts: HostSummary[]
  keys: SshKeySummary[]
  reload: () => void
  openTerminal: (h: HostSummary) => void
  openFiles: (h: HostSummary) => void
}) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<HostSummary | 'new' | null>(null)

  const groups = useMemo(() => [...new Set(props.hosts.map((h) => h.group).filter(Boolean))].sort(), [props.hosts])
  const filtered = props.hosts.filter((h) =>
    `${h.name} ${h.hostname} ${h.username} ${h.group}`.toLowerCase().includes(query.toLowerCase())
  )
  const byGroup = new Map<string, HostSummary[]>()
  for (const h of [...filtered].sort((a, b) => a.name.localeCompare(b.name))) {
    const g = h.group || 'Ungrouped'
    byGroup.set(g, [...(byGroup.get(g) ?? []), h])
  }

  const remove = async (h: HostSummary): Promise<void> => {
    if (!confirm(`Delete host "${h.name}"? Its stored password is deleted as well.`)) return
    try {
      await api.hosts.remove(h.id)
      props.reload()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Hosts</h1>
          <p className="sub">Your servers. Double-click to connect.</p>
        </div>
        <div className="row">
          <input className="input" style={{ width: 240 }} placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Icon name="plus" /> New host
          </button>
        </div>
      </div>

      {props.hosts.length === 0 && (
        <div className="empty">
          <p>No hosts yet.</p>
          <button className="btn primary" onClick={() => setEditing('new')}>
            Add your first server
          </button>
        </div>
      )}

      {[...byGroup.entries()].map(([group, hosts]) => (
        <div key={group}>
          <div className="group-title">{group}</div>
          <div className="host-grid">
            {hosts.map((h) => {
              const ssh = h.protocol === 'ssh'
              return (
                <div
                  key={h.id}
                  className="host-card"
                  onDoubleClick={() => (ssh ? props.openTerminal(h) : props.openFiles(h))}
                >
                  <div className="top">
                    <div className={`host-icon ${ssh ? 'ssh' : 'ftp'}`}>{ssh ? 'SSH' : 'FTP'}</div>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div className="name">{h.name}</div>
                      <div className="addr mono">
                        {h.username ? `${h.username}@` : ''}
                        {h.hostname}:{h.port}
                      </div>
                    </div>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {h.protocol === 'ftp' && <span className="badge danger">unencrypted</span>}
                    {h.protocol.startsWith('ftps') && <span className="badge">FTPS</span>}
                    {h.aiAccess !== 'none' && (
                      <span className={`badge ${h.aiAccess === 'full' && h.aiConfirm === 'none' ? 'danger' : 'accent'}`}>
                        AI: {h.aiAccess === 'full' ? 'full' : 'read'}
                        {h.aiConfirm === 'none' ? ', no approval' : ''}
                      </span>
                    )}
                    {h.forwards.length > 0 && <span className="badge">{h.forwards.length} forward(s)</span>}
                  </div>
                  <div className="actions">
                    {ssh && (
                      <button className="btn sm" onClick={() => props.openTerminal(h)}>
                        <Icon name="terminal" size={14} /> Terminal
                      </button>
                    )}
                    <button className="btn sm" onClick={() => props.openFiles(h)}>
                      <Icon name="folder" size={14} /> {ssh ? 'SFTP' : 'Files'}
                    </button>
                    <span className="grow" />
                    <button className="btn ghost sm" title="Edit" onClick={() => setEditing(h)}>
                      <Icon name="edit" size={14} />
                    </button>
                    <button
                      className="btn ghost sm"
                      title="Duplicate"
                      onClick={() => api.hosts.duplicate(h.id).then(props.reload, toast.error)}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                    <button className="btn ghost sm" title="Delete" onClick={() => remove(h)}>
                      <Icon name="trash" size={14} />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {editing && (
        <HostEditor
          host={editing === 'new' ? undefined : editing}
          keys={props.keys}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            props.reload()
          }}
        />
      )}
    </div>
  )
}
