import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import type { ActiveForward, AuditEntry, HostSummary, KnownHost, SshKeySummary } from '@shared/types'
import { api, on, type UiSettings } from '../api'
import { formatDate, Icon, Modal, Segmented, Switch, useToast } from '../ui'
import { StrengthBar } from './LockScreen'

// ------------------------------------------------------------- keychain --

export function KeysPage(props: { keys: SshKeySummary[]; reload: () => void }) {
  const toast = useToast()
  const [mode, setMode] = useState<'generate' | 'file' | 'paste' | null>(null)
  const [name, setName] = useState('')
  const [type, setType] = useState<'ed25519' | 'ecdsa' | 'rsa'>('ed25519')
  const [pass, setPass] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    setMode(null)
    setName('')
    setPass('')
    setText('')
  }
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      if (mode === 'generate') await api.keys.generate(name || 'clavium', type, pass)
      else if (mode === 'file') {
        if (!(await api.keys.importFile(name, pass))) return
      } else if (mode === 'paste') await api.keys.importText(name || 'imported key', text, pass)
      toast.ok('Key saved in the vault')
      close()
      props.reload()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <div className="row between">
        <div>
          <h1>Keychain</h1>
          <p className="sub">SSH keys are stored encrypted inside your vault.</p>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => setMode('generate')}>
            <Icon name="plus" /> Generate key
          </button>
          <button className="btn" onClick={() => setMode('file')}>
            Import file
          </button>
          <button className="btn" onClick={() => setMode('paste')}>
            Paste key
          </button>
        </div>
      </div>
      {props.keys.length === 0 && <div className="empty">No keys yet.</div>}
      {props.keys.map((k) => (
        <div className="section" key={k.id}>
          <div className="row between">
            <div className="row">
              <Icon name="key" />
              <b>{k.name}</b>
              <span className="badge">{k.type}</span>
              {k.encrypted && <span className="badge ok">passphrase</span>}
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => api.clipboard.write(k.publicKey).then(() => toast.ok('Public key copied'))}>
                <Icon name="copy" size={14} /> Copy public key
              </button>
              <button
                className="btn sm danger"
                onClick={() => {
                  if (confirm(`Delete key "${k.name}" from the vault?`)) api.keys.remove(k.id).then(props.reload, toast.error)
                }}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>
          <div className="small muted mono" style={{ marginTop: 6 }}>{k.fingerprint}</div>
          <div className="code" style={{ marginTop: 8, maxHeight: 80 }}>{k.publicKey}</div>
        </div>
      ))}
      <div className="small muted">
        Add a public key to a server with: <span className="mono">~/.ssh/authorized_keys</span> (one key per line).
      </div>

      {mode && (
        <Modal
          title={mode === 'generate' ? 'Generate SSH key' : mode === 'file' ? 'Import key file' : 'Paste private key'}
          onClose={close}
          footer={
            <>
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button className="btn primary" onClick={submit} disabled={busy || (mode === 'paste' && !text.trim())}>
                {mode === 'file' ? 'Choose file…' : 'Save'}
              </button>
            </>
          }
        >
          <label className="field">
            Name
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. laptop-2026" autoFocus />
          </label>
          {mode === 'generate' && (
            <div className="field" role="group" aria-label="Type">
              <span>Type</span>
              <Segmented
                value={type}
                onChange={setType}
                options={[
                  { value: 'ed25519', label: 'Ed25519 (recommended)' },
                  { value: 'ecdsa', label: 'ECDSA P-256' },
                  { value: 'rsa', label: 'RSA 4096' }
                ]}
              />
            </div>
          )}
          {mode === 'paste' && (
            <label className="field">
              Private key (OpenSSH or PEM)
              <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
            </label>
          )}
          <label className="field">
            {mode === 'generate' ? 'Passphrase (optional, extra protection if the key is exported)' : 'Passphrase of the key (if any)'}
            <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </label>
        </Modal>
      )}
    </div>
  )
}

// ---------------------------------------------------------- known hosts --

export function KnownHostsPage() {
  const toast = useToast()
  const [items, setItems] = useState<KnownHost[]>([])
  const load = (): void => void api.knownHosts.list().then(setItems, toast.error)
  useEffect(load, [])
  return (
    <div className="page">
      <h1>Known hosts</h1>
      <p className="sub">
        Server fingerprints you trusted. Clavium refuses to connect if a server suddenly presents a different key.
      </p>
      <div className="section">
        <table className="list">
          <thead>
            <tr>
              <th>Host</th>
              <th>Type</th>
              <th>Fingerprint</th>
              <th>Trusted since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((k) => (
              <tr key={k.id}>
                <td className="mono">{k.id}</td>
                <td>{k.keyType}</td>
                <td className="mono small" style={{ wordBreak: 'break-all' }}>{k.fingerprint}</td>
                <td className="small muted">{formatDate(k.addedAt)}</td>
                <td>
                  <button
                    className="btn sm ghost"
                    title="Forget"
                    onClick={() => {
                      if (confirm(`Forget the key of ${k.id}? You will be asked to verify it again.`)) api.knownHosts.remove(k.id).then(load, toast.error)
                    }}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="empty">No trusted hosts yet.</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------- port forwarding --

export function ForwardsPage(props: { hosts: HostSummary[] }) {
  const toast = useToast()
  const [active, setActive] = useState<ActiveForward[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const load = (): void => void api.fwd.list().then(setActive)
  useEffect(() => {
    load()
    return on('fwd:changed', load)
  }, [])
  const rows = props.hosts.flatMap((h) => h.forwards.map((f) => ({ h, f })))
  return (
    <div className="page">
      <h1>Port forwarding</h1>
      <p className="sub">Local tunnels through SSH (like ssh -L). Ports are only opened on 127.0.0.1. Configure them in the host editor.</p>
      <div className="section">
        <table className="list">
          <thead>
            <tr>
              <th>Host</th>
              <th>Tunnel</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ h, f }) => {
              const on_ = active.some((a) => a.hostId === h.id && a.forwardId === f.id)
              const key = `${h.id}:${f.id}`
              return (
                <tr key={key}>
                  <td>{h.name}</td>
                  <td className="mono small">
                    127.0.0.1:{f.localPort} → {f.remoteHost}:{f.remotePort}
                  </td>
                  <td>{on_ ? <span className="badge ok">active</span> : <span className="badge">stopped</span>}</td>
                  <td>
                    <button
                      className="btn sm"
                      disabled={busy === key}
                      onClick={async () => {
                        setBusy(key)
                        try {
                          if (on_) await api.fwd.stop(h.id, f.id)
                          else await api.fwd.start(h.id, f.id)
                        } catch (e) {
                          toast.error(e)
                        } finally {
                          setBusy(null)
                          load()
                        }
                      }}
                    >
                      <Icon name={on_ ? 'stop' : 'play'} size={14} /> {on_ ? 'Stop' : 'Start'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">No tunnels configured. Edit an SSH host to add one.</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------- activity --

export function ActivityPage() {
  const [items, setItems] = useState<AuditEntry[]>([])
  useEffect(() => {
    void api.audit.list(500).then(setItems)
    return on('audit:entry', (e: AuditEntry) => setItems((x) => [e, ...x].slice(0, 500)))
  }, [])
  return (
    <div className="page">
      <h1>Activity</h1>
      <p className="sub">Every action requested by an AI client, including denied ones.</p>
      <div className="section">
        <table className="list">
          <thead>
            <tr>
              <th>Time</th>
              <th>Host</th>
              <th>Tool</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e, i) => (
              <tr key={`${e.ts}-${i}`}>
                <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(e.ts)}</td>
                <td>{e.hostName ?? '—'}</td>
                <td className="mono small">{e.action}</td>
                <td>
                  <span className={`badge ${e.result === 'ok' ? 'ok' : e.result === 'denied' ? 'warn' : 'danger'}`}>{e.result}</span>
                </td>
                <td>
                  <div className="mono small" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 90, overflow: 'auto' }}>
                    {e.detail}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="empty">No AI activity yet.</div>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------- settings --

export function SettingsPage(props: { settings: UiSettings }) {
  const toast = useToast()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const s = props.settings
  useEffect(() => void api.app.info().then(setInfo), [])
  const set = (patch: Partial<UiSettings>): void => void api.settings.set(patch).catch(toast.error)

  const changePw = async (): Promise<void> => {
    if (newPw !== newPw2) return toast.error('The new passwords do not match')
    try {
      await api.vault.changePassword(oldPw, newPw)
      setOldPw('')
      setNewPw('')
      setNewPw2('')
      toast.ok('Master password changed')
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <div className="page">
      <h1>Settings</h1>
      <p className="sub">Preferences are stored locally; secrets only inside the encrypted vault.</p>

      <div className="section stack">
        <h2>Security</h2>
        <div className="row between">
          <span>Lock automatically after inactivity</span>
          <select className="input" style={{ width: 180 }} value={s.autoLockMinutes} onChange={(e) => set({ autoLockMinutes: Number(e.target.value) })}>
            {[1, 5, 10, 15, 30, 60, 240].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
            <option value={0}>never</option>
          </select>
        </div>
        <div className="row between">
          <span>Lock when Windows locks or sleeps</span>
          <Switch on={s.lockOnSystemLock} onChange={(v) => set({ lockOnSystemLock: v })} />
        </div>
      </div>

      <div className="section stack">
        <h2>Application</h2>
        <div className="row between">
          <span>Keep running in the tray when the window is closed (needed for MCP)</span>
          <Switch on={s.closeToTray} onChange={(v) => set({ closeToTray: v })} />
        </div>
        <div className="row between">
          <span>Terminal font size</span>
          <input className="input" type="number" min={8} max={32} style={{ width: 90 }} value={s.terminalFontSize} onChange={(e) => set({ terminalFontSize: Number(e.target.value) || 14 })} />
        </div>
      </div>

      <div className="section stack">
        <h2>Change master password</h2>
        <input className="input" type="password" placeholder="Current master password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} />
        <input className="input" type="password" placeholder="New master password (min. 10 characters)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
        <StrengthBar pw={newPw} />
        <input className="input" type="password" placeholder="Repeat new master password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} />
        <div>
          <button className="btn primary" disabled={!oldPw || newPw.length < 10} onClick={changePw}>
            Change password
          </button>
        </div>
      </div>

      {info && (
        <div className="section small muted">
          <b style={{ color: 'var(--text)' }}>Clavium {info.version}</b> · Electron {info.electron} · {info.platform}
          <br />
          Open source under the MIT license. <a onClick={() => api.app.openExternal(info.repoUrl)}>Source code on GitHub</a>
        </div>
      )}
    </div>
  )
}
