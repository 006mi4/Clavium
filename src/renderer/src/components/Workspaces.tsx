import { useEffect, useMemo, useState } from 'react'
import { Columns2, FolderOpen, PanelsTopLeft, Pencil, Server, SquareTerminal, Trash2 } from 'lucide-react'
import type { HostSummary, PaneKind, SavedWorkspace } from '@shared/types'
import { api } from '../api'
import { Empty, Group, IconButton, Segmented, Sheet, Toolbar, formatDate, useConfirm, useToast } from '../ui'

/** One line that says which connections a workspace holds. */
export function describeWorkspace(w: Pick<SavedWorkspace, 'panes'>, hosts: HostSummary[]): string {
  const names = w.panes.map((p) => {
    const host = hosts.find((h) => h.id === p.hostId)
    const what = p.target ? p.target.name : p.kind === 'terminal' ? 'Terminal' : p.kind === 'files' ? 'Files' : 'Docker'
    return host ? `${what} on ${host.name}` : `${what} on a deleted host`
  })
  return names.join(', ')
}

/** Saved workspaces: tabs with several connections that open again with one click. */
export function WorkspacesPage(props: { hosts: HostSummary[]; signal: number; open: (w: SavedWorkspace) => void; changed: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState<SavedWorkspace[] | null>(null)
  const [renaming, setRenaming] = useState<SavedWorkspace | null>(null)
  const load = (): void => void api.workspaces.list().then(setItems, toast.error)
  useEffect(load, [props.signal])

  const remove = async (w: SavedWorkspace): Promise<void> => {
    const ok = await confirm({
      title: `Delete the Workspace “${w.name}”?`,
      message: 'Only the saved arrangement is deleted. Hosts and open tabs stay as they are.',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (!ok) return
    try {
      await api.workspaces.remove(w.id)
      props.changed()
      load()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <>
      <Toolbar title="Workspaces" />
      {items && items.length === 0 ? (
        <div className="view-fixed">
          <Empty icon={PanelsTopLeft} title="No Saved Workspaces">
            Open a connection, use the split button in its toolbar to put more connections next to it, and choose “Save Workspace” there. The whole
            arrangement then opens again from here with one click.
          </Empty>
        </div>
      ) : (
        <div className="view-scroll">
          <div className="page">
            <p className="page-intro">
              A workspace is a tab with several connections side by side. Opening one connects to all of its servers and arranges them the way you saved
              them.
            </p>
            <Group>
              {(items ?? []).map((w) => (
                <div className="item" key={w.id}>
                  <Columns2 size={18} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <div className="body">
                    <div className="primary">{w.name}</div>
                    <div className="secondary">{describeWorkspace(w, props.hosts)}</div>
                  </div>
                  <div className="side">
                    <span className="when">{formatDate(w.updatedAt)}</span>
                    <button className="btn" onClick={() => props.open(w)} aria-label={`Open the workspace ${w.name}`}>
                      Open
                    </button>
                    <IconButton icon={Pencil} label={`Rename ${w.name}`} onClick={() => setRenaming(w)} />
                    <IconButton icon={Trash2} label={`Delete ${w.name}`} onClick={() => void remove(w)} />
                  </div>
                </div>
              ))}
            </Group>
          </div>
        </div>
      )}
      {renaming && (
        <WorkspaceNameSheet
          title="Rename Workspace"
          initial={renaming.name}
          action="Rename"
          close={() => setRenaming(null)}
          submit={async (name) => {
            const { id, name: _n, updatedAt: _u, ...tab } = renaming
            await api.workspaces.save(name, tab, id)
            props.changed()
            load()
          }}
        />
      )}
    </>
  )
}

export function WorkspaceNameSheet(props: { title: string; initial: string; action: string; note?: string; close: () => void; submit: (name: string) => Promise<void> }) {
  const toast = useToast()
  const [name, setName] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  const valid = name.trim().length > 0 && name.trim().length <= 80
  const submit = async (): Promise<void> => {
    if (!valid || busy) return
    setBusy(true)
    try {
      await props.submit(name.trim())
      props.close()
    } catch (e) {
      toast.error(e)
      setBusy(false)
    }
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
          <button className="btn prominent" onClick={() => void submit()} disabled={!valid || busy}>
            {props.action}
          </button>
        </>
      }
    >
      {props.note && <p>{props.note}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <input className="field" aria-label="Name of the workspace" placeholder="e.g. Shop production" autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Sheet>
  )
}

/** Choose the host that is opened next to the current pane. */
export function HostPickerSheet(props: { hosts: HostSummary[]; direction: 'row' | 'col'; close: () => void; pick: (host: HostSummary, kind: PaneKind) => void }) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'terminal' | 'files'>('terminal')
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return props.hosts
      .filter((h) => !q || `${h.name} ${h.group} ${h.hostname} ${h.username}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [props.hosts, query])
  return (
    <Sheet
      title={props.direction === 'row' ? 'Add a Connection to the Right' : 'Add a Connection Below'}
      onClose={props.close}
      footer={
        <button className="btn" onClick={props.close}>
          Cancel
        </button>
      }
    >
      <div className="picker-head">
        <input className="field" aria-label="Search hosts" placeholder="Search hosts" autoFocus spellCheck={false} value={query} onChange={(e) => setQuery(e.target.value)} />
        <Segmented<'terminal' | 'files'>
          label="What to open"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'terminal', label: 'Terminal' },
            { value: 'files', label: 'Files' }
          ]}
        />
      </div>
      {shown.length === 0 ? (
        <p>No host matches.</p>
      ) : (
        <ul className="picker-list" aria-label="Hosts">
          {shown.map((h) => {
            // FTP servers have no terminal: they always open as files
            const opens: PaneKind = h.protocol === 'ssh' ? kind : 'files'
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => {
                    props.close()
                    props.pick(h, opens)
                  }}
                >
                  {opens === 'terminal' ? <SquareTerminal size={16} /> : opens === 'files' ? <FolderOpen size={16} /> : <Server size={16} />}
                  <span className="name">{h.name}</span>
                  <span className="where mono">
                    {h.username}@{h.hostname}
                  </span>
                  {h.protocol !== 'ssh' && kind === 'terminal' && <span className="where">files only</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Sheet>
  )
}
