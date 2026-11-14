import { useState } from 'react'
import type { AiAccess, AiConfirm, AuthMethod, HostInput, HostSummary, PortForward, Protocol, SshKeySummary } from '@shared/types'
import { api, hostToInput } from '../api'
import { Icon, Modal, Segmented, useToast } from '../ui'

const DEFAULT_PORT: Record<Protocol, number> = { ssh: 22, ftps: 21, 'ftps-implicit': 990, ftp: 21 }

function blank(): HostInput {
  return {
    name: '',
    group: '',
    protocol: 'ssh',
    hostname: '',
    port: 22,
    username: '',
    authMethod: 'password',
    password: undefined,
    keyId: undefined,
    allowLegacyAlgorithms: false,
    aiAccess: 'none',
    aiConfirm: 'changes',
    notes: '',
    forwards: []
  }
}

function newId(): string {
  return Math.random().toString(36).slice(2, 12)
}

export function HostEditor(props: {
  host?: HostSummary
  keys: SshKeySummary[]
  groups: string[]
  onClose: () => void
  onSaved: (h: HostSummary) => void
}) {
  const toast = useToast()
  const [h, setH] = useState<HostInput>(props.host ? hostToInput(props.host) : blank())
  const [pwTouched, setPwTouched] = useState(false)
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]): void => setH((x) => ({ ...x, [k]: v }))
  const isSsh = h.protocol === 'ssh'

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const input: HostInput = {
        ...h,
        name: h.name.trim() || h.hostname.trim(),
        authMethod: isSsh ? h.authMethod : 'password',
        keyId: isSsh && h.authMethod === 'key' ? h.keyId : undefined,
        forwards: isSsh ? h.forwards : [],
        aiAccess: h.aiAccess,
        password: pwTouched ? (pw === '' ? null : pw) : undefined
      }
      const saved = await api.hosts.save(input)
      toast.ok(`Saved ${saved.name}`)
      props.onSaved(saved)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const setForward = (i: number, patch: Partial<PortForward>): void =>
    set(
      'forwards',
      h.forwards.map((f, j) => (j === i ? { ...f, ...patch } : f))
    )

  const usesPassword = !isSsh || h.authMethod === 'password' || h.authMethod === 'keyboard-interactive'

  return (
    <Modal
      className="wide"
      title={props.host ? `Edit ${props.host.name}` : 'New host'}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !h.hostname.trim() || (isSsh && h.authMethod === 'key' && !h.keyId)}>
            Save
          </button>
        </>
      }
    >
      <div className="grid2">
        <label className="field">
          Name
          <input className="input" value={h.name} placeholder="Production web" onChange={(e) => set('name', e.target.value)} autoFocus />
        </label>
        <label className="field">
          Group
          <input className="input" list="groups" value={h.group} placeholder="e.g. Customers" onChange={(e) => set('group', e.target.value)} />
          <datalist id="groups">
            {props.groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="field" role="group" aria-label="Protocol">
        <span>Protocol</span>
        <Segmented<Protocol>
          value={h.protocol}
          onChange={(p) => setH((x) => ({ ...x, protocol: p, port: x.port === DEFAULT_PORT[x.protocol] ? DEFAULT_PORT[p] : x.port }))}
          options={[
            { value: 'ssh', label: 'SSH + SFTP' },
            { value: 'ftps', label: 'FTPS (explicit)' },
            { value: 'ftps-implicit', label: 'FTPS (implicit)' },
            { value: 'ftp', label: 'FTP (unencrypted)' }
          ]}
        />
      </div>
      {h.protocol === 'ftp' && (
        <div className="callout danger small">
          Plain FTP sends your password and all files unencrypted over the network. Use SFTP or FTPS whenever the
          server supports it.
        </div>
      )}

      <div className="grid3">
        <label className="field">
          Host name / IP
          <input className="input mono" value={h.hostname} placeholder="server.example.com" onChange={(e) => set('hostname', e.target.value.trim())} />
        </label>
        <label className="field">
          Port
          <input className="input" type="number" min={1} max={65535} value={h.port} onChange={(e) => set('port', Number(e.target.value) || 0)} />
        </label>
        <label className="field">
          User
          <input className="input mono" value={h.username} placeholder="root" onChange={(e) => set('username', e.target.value)} />
        </label>
      </div>

      {isSsh && (
        <div className="field" role="group" aria-label="Authentication">
          <span>Authentication</span>
          <Segmented<AuthMethod>
            value={h.authMethod}
            onChange={(v) => set('authMethod', v)}
            options={[
              { value: 'password', label: 'Password' },
              { value: 'key', label: 'SSH key' },
              { value: 'agent', label: 'SSH agent' },
              { value: 'keyboard-interactive', label: 'Interactive / 2FA' }
            ]}
          />
        </div>
      )}

      {isSsh && h.authMethod === 'key' && (
        <label className="field">
          Key from keychain
          <select className="input" value={h.keyId ?? ''} onChange={(e) => set('keyId', e.target.value || undefined)}>
            <option value="">— choose a key —</option>
            {props.keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} ({k.type})
              </option>
            ))}
          </select>
          {props.keys.length === 0 && <span className="small">No keys yet — add one under “Keychain”.</span>}
        </label>
      )}
      {isSsh && h.authMethod === 'agent' && (
        <div className="small muted">Uses the Windows OpenSSH agent (or Pageant). Agent forwarding is always disabled.</div>
      )}

      {usesPassword && (
        <label className="field">
          Password {props.host?.hasPassword && !pwTouched ? '(stored — leave empty to keep)' : '(optional — asked on connect if empty)'}
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={pw}
            placeholder={props.host?.hasPassword && !pwTouched ? '••••••••' : ''}
            onChange={(e) => {
              setPw(e.target.value)
              setPwTouched(true)
            }}
          />
          {props.host?.hasPassword && (
            <span>
              <a
                onClick={() => {
                  setPw('')
                  setPwTouched(true)
                }}
              >
                Remove stored password
              </a>
            </span>
          )}
        </label>
      )}

      {isSsh && (
        <label className="check small">
          <input type="checkbox" checked={h.allowLegacyAlgorithms} onChange={(e) => set('allowLegacyAlgorithms', e.target.checked)} />
          Allow legacy algorithms (ssh-rsa/SHA-1) — only for very old servers
        </label>
      )}

      {isSsh && (
        <div className="section" style={{ marginBottom: 0 }}>
          <div className="row between">
            <h2 style={{ margin: 0 }}>Port forwarding (local → remote)</h2>
            <button
              className="btn sm"
              onClick={() => set('forwards', [...h.forwards, { id: newId(), localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80 }])}
            >
              <Icon name="plus" size={14} /> Add
            </button>
          </div>
          {h.forwards.length === 0 && <div className="small muted" style={{ marginTop: 8 }}>e.g. local 5432 → 127.0.0.1:5432 to reach a database on the server.</div>}
          {h.forwards.map((f, i) => (
            <div className="row" key={f.id} style={{ marginTop: 8 }}>
              <span className="small muted">127.0.0.1:</span>
              <input className="input" style={{ width: 90 }} type="number" value={f.localPort} onChange={(e) => setForward(i, { localPort: Number(e.target.value) || 0 })} />
              <Icon name="forward" />
              <input className="input mono" style={{ width: 180 }} value={f.remoteHost} onChange={(e) => setForward(i, { remoteHost: e.target.value })} />
              <span>:</span>
              <input className="input" style={{ width: 90 }} type="number" value={f.remotePort} onChange={(e) => setForward(i, { remotePort: Number(e.target.value) || 0 })} />
              <button className="btn ghost sm" onClick={() => set('forwards', h.forwards.filter((_, j) => j !== i))} aria-label="remove">
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="section" style={{ marginBottom: 0 }}>
        <h2>AI access (MCP)</h2>
        <div className="stack">
          <div className="field" role="group" aria-label="What may Claude / Codex do on this host?">
            <span>What may Claude / Codex do on this host?</span>
            <Segmented<AiAccess>
              value={h.aiAccess}
              onChange={(v) => set('aiAccess', v)}
              options={[
                { value: 'none', label: 'Nothing (hidden)' },
                { value: 'read', label: 'Read files only' },
                { value: 'full', label: isSsh ? 'Full (commands + files)' : 'Full (read + write files)' }
              ]}
            />
          </div>
          {h.aiAccess !== 'none' && (
            <div className="field" role="group" aria-label="Ask me before…">
              <span>Ask me before…</span>
              <Segmented<AiConfirm>
                value={h.aiConfirm}
                onChange={(v) => set('aiConfirm', v)}
                options={[
                  { value: 'all', label: 'every action' },
                  { value: 'changes', label: 'commands & changes' },
                  { value: 'none', label: 'never' }
                ]}
              />
            </div>
          )}
          {h.aiAccess === 'full' && h.aiConfirm === 'none' && (
            <div className="callout danger small">
              The AI can run any command on this server without asking you. Only use this for disposable test
              machines.
            </div>
          )}
        </div>
      </div>

      <label className="field">
        Notes
        <textarea className="input" value={h.notes} onChange={(e) => set('notes', e.target.value)} />
      </label>
    </Modal>
  )
}
