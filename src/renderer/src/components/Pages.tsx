import { useEffect, useState, type MouseEvent } from 'react'
import { ClipboardPaste, Copy, FileKey2, History, KeyRound, Plus, ShieldCheck, Trash2, WandSparkles } from 'lucide-react'
import type { AppInfo } from '@shared/ipc'
import type { AuditEntry, KnownHost, SshKeySummary, UpdateState } from '@shared/types'
import { api, on, type UiSettings } from '../api'
import { Empty, Group, IconButton, Row, Segmented, Select, Sheet, Switch, Toolbar, ValueRow, formatDate, useConfirm, useMenu, useToast } from '../ui'
import { StrengthBar } from './LockScreen'

// ----------------------------------------------------------------- keys --

type KeyMode = 'generate' | 'file' | 'paste'

export function KeysPage(props: { keys: SshKeySummary[]; reload: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const menu = useMenu()
  const [mode, setMode] = useState<KeyMode | null>(null)

  const remove = async (k: SshKeySummary): Promise<void> => {
    const ok = await confirm({
      title: `Delete “${k.name}”?`,
      message: 'The private key is removed from the vault. Servers that only accept this key can no longer be reached with it.',
      confirmLabel: 'Delete',
      destructive: true
    })
    if (ok) void api.keys.remove(k.id).then(props.reload, toast.error)
  }

  const addMenu = (e: MouseEvent<HTMLElement>): void =>
    menu.openBelow(e, [
      { label: 'Generate New Key…', icon: WandSparkles, onSelect: () => setMode('generate') },
      { label: 'Import from File…', icon: FileKey2, onSelect: () => setMode('file') },
      { label: 'Paste Private Key…', icon: ClipboardPaste, onSelect: () => setMode('paste') }
    ])

  return (
    <>
      <Toolbar title="Keys">
        <button className="btn prominent" onClick={addMenu}>
          <Plus size={15} /> Add Key
        </button>
      </Toolbar>
      {props.keys.length === 0 ? (
        <div className="view-fixed">
          <Empty
            icon={KeyRound}
            title="No Keys Yet"
            action={
              <button className="btn prominent" onClick={() => setMode('generate')}>
                Generate a Key
              </button>
            }
          >
            SSH keys are safer than passwords. Clavium keeps the private key encrypted in your vault.
          </Empty>
        </div>
      ) : (
        <div className="view-scroll">
          <div className="page">
            <Group caption="To use a key, copy its public key into ~/.ssh/authorized_keys on the server, one key per line.">
              {props.keys.map((k) => (
                <div className="item" key={k.id}>
                  <KeyRound size={18} style={{ color: 'var(--text-2)', flexShrink: 0 }} />
                  <div className="body">
                    <div className="primary">{k.name}</div>
                    <div className="secondary">
                      {k.type.replace('ssh-', '').replace('ecdsa-sha2-', 'ecdsa ').toUpperCase()}
                      {k.encrypted ? ' · passphrase' : ''} · <span className="mono">{k.fingerprint}</span>
                    </div>
                  </div>
                  <div className="side">
                    <button className="btn" onClick={() => void api.clipboard.write(k.publicKey).then(() => toast.ok('Public key copied'))}>
                      <Copy size={14} /> Copy Public Key
                    </button>
                    <IconButton icon={Trash2} label={`Delete ${k.name}`} onClick={() => void remove(k)} />
                  </div>
                </div>
              ))}
            </Group>
          </div>
        </div>
      )}
      {menu.element}
      {mode && (
        <KeySheet
          mode={mode}
          close={() => setMode(null)}
          saved={() => {
            setMode(null)
            props.reload()
          }}
        />
      )}
    </>
  )
}

function KeySheet({ mode, close, saved }: { mode: KeyMode; close: () => void; saved: () => void }) {
  const toast = useToast()
  const [name, setName] = useState('')
  const [type, setType] = useState<'ed25519' | 'ecdsa' | 'rsa'>('ed25519')
  const [pass, setPass] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      if (mode === 'generate') await api.keys.generate(name || 'Clavium key', type, pass)
      else if (mode === 'paste') await api.keys.importText(name || 'Imported key', text, pass)
      else if (!(await api.keys.importFile(name, pass))) return
      saved()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={mode === 'generate' ? 'Generate Key' : mode === 'file' ? 'Import Key from File' : 'Paste Private Key'}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn prominent" onClick={() => void submit()} disabled={busy || (mode === 'paste' && !text.trim())}>
            {mode === 'file' ? 'Choose File…' : mode === 'generate' ? 'Generate' : 'Save'}
          </button>
        </>
      }
    >
      <Group>
        <Row label="Name">
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Laptop 2026" autoFocus />
        </Row>
        {mode === 'generate' && (
          <Row label="Type" multi>
            <Segmented
              label="Key type"
              value={type}
              onChange={setType}
              options={[
                { value: 'ed25519', label: 'Ed25519' },
                { value: 'ecdsa', label: 'ECDSA' },
                { value: 'rsa', label: 'RSA 4096' }
              ]}
            />
          </Row>
        )}
        {mode === 'paste' && (
          <Row label="Private key" stacked>
            <textarea className="field mono" rows={7} value={text} onChange={(e) => setText(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
          </Row>
        )}
        <Row label="Passphrase" hint={mode === 'generate' ? 'Optional' : 'Only if the key has one'}>
          <input className="field" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
        </Row>
      </Group>
      {mode === 'generate' && <p className="caption">Ed25519 is recommended. Choose RSA only for servers that don’t support it.</p>}
    </Sheet>
  )
}

// ---------------------------------------------------------- known hosts --

export function KnownHostsPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [items, setItems] = useState<KnownHost[] | null>(null)
  const load = (): void => void api.knownHosts.list().then(setItems, toast.error)
  useEffect(load, [])

  const forget = async (k: KnownHost): Promise<void> => {
    const ok = await confirm({
      title: 'Forget This Host Key?',
      message: `Clavium will ask you to verify ${k.id.replace(/^(ssh|ftps):/, '')} again the next time you connect.`,
      confirmLabel: 'Forget',
      destructive: true
    })
    if (ok) void api.knownHosts.remove(k.id).then(load, toast.error)
  }

  return (
    <>
      <Toolbar title="Known Hosts" />
      {items && items.length === 0 ? (
        <div className="view-fixed">
          <Empty icon={ShieldCheck} title="No Known Hosts">
            When you connect to a server for the first time, you verify its fingerprint and Clavium remembers it here.
          </Empty>
        </div>
      ) : (
        <div className="view-scroll">
          <div className="page">
            <p className="page-intro">
              Fingerprints of servers you verified. If a server later presents a different key, Clavium stops and warns you.
            </p>
            <Group>
              {(items ?? []).map((k) => (
                <div className="item" key={k.id}>
                  <ShieldCheck size={18} style={{ color: 'var(--green)', flexShrink: 0 }} />
                  <div className="body">
                    <div className="primary mono" style={{ fontSize: 12.5 }}>
                      {k.id.replace(/^(ssh|ftps):/, '')}
                    </div>
                    <div className="secondary">
                      {k.keyType === 'x509' ? 'TLS certificate' : k.keyType} · <span className="mono">{k.fingerprint}</span>
                    </div>
                  </div>
                  <div className="side">
                    <span className="when">{formatDate(k.addedAt)}</span>
                    <IconButton icon={Trash2} label="Forget" onClick={() => void forget(k)} />
                  </div>
                </div>
              ))}
            </Group>
          </div>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------- activity --

const RESULT: Record<AuditEntry['result'], { cls: string; label: string }> = {
  ok: { cls: 'ok', label: 'Done' },
  denied: { cls: 'warn', label: 'Denied' },
  error: { cls: 'danger', label: 'Failed' }
}

export function ActivityPage() {
  const [items, setItems] = useState<AuditEntry[] | null>(null)
  useEffect(() => {
    void api.audit.list(500).then(setItems)
    return on('audit:entry', (e: AuditEntry) => setItems((x) => [e, ...(x ?? [])].slice(0, 500)))
  }, [])

  return (
    <>
      <Toolbar title="Activity" />
      {items && items.length === 0 ? (
        <div className="view-fixed">
          <Empty icon={History} title="No Activity Yet">
            Everything an AI assistant does or tries to do on your hosts is recorded here.
          </Empty>
        </div>
      ) : (
        <div className="view-scroll">
          <div className="page wide">
            <Group>
              {(items ?? []).map((e, i) => (
                <div className="item" key={`${e.ts}-${i}`} style={{ alignItems: 'flex-start' }}>
                  <div className="body">
                    <div className="primary">
                      <span className="mono" style={{ fontSize: 12.5 }}>{e.action}</span>
                      {e.hostName && <span style={{ fontWeight: 400, color: 'var(--text-2)' }}> on {e.hostName}</span>}
                    </div>
                    <div className="secondary wrap mono" style={{ maxHeight: 76, overflow: 'auto' }}>
                      {e.detail}
                    </div>
                  </div>
                  <div className="side">
                    <span className={`signal ${RESULT[e.result].cls}`}>{RESULT[e.result].label}</span>
                    <span className="when" style={{ minWidth: 120, textAlign: 'right' }}>
                      {formatDate(e.ts)}
                    </span>
                  </div>
                </div>
              ))}
            </Group>
          </div>
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------- settings --

export function SettingsPage(props: { settings: UiSettings }) {
  const toast = useToast()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [changing, setChanging] = useState(false)
  const s = props.settings
  useEffect(() => void api.app.info().then(setInfo), [])
  const confirm = useConfirm()
  const set = (patch: Partial<UiSettings>): void => void api.settings.set(patch).catch(toast.error)
  const backUp = async (): Promise<void> => {
    try {
      if (await api.vault.exportBackup()) toast.ok('Backup saved. You need your master password to restore it.')
    } catch (e) {
      toast.error(e)
    }
  }
  const restore = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Restore the Vault from a Backup?',
      message:
        'All hosts and keys in this vault are replaced by those in the backup, and every session is closed. You then unlock with the master password of the backup. The vault you replace is kept as a file next to the vault.',
      confirmLabel: 'Choose Backup…',
      destructive: true
    })
    if (!ok) return
    await api.vault.importBackup().catch(toast.error)
  }

  return (
    <>
      <Toolbar title="Settings" />
      <div className="view-scroll">
        <div className="page">
          <Group title="Security" caption="Locking closes all sessions and removes the vault key from memory.">
            <Row label="Lock automatically">
              <Select<number>
                label="Lock automatically"
                value={s.autoLockMinutes}
                onChange={(v) => set({ autoLockMinutes: v })}
                options={[
                  { value: 1, label: 'After 1 Minute' },
                  { value: 5, label: 'After 5 Minutes' },
                  { value: 15, label: 'After 15 Minutes' },
                  { value: 30, label: 'After 30 Minutes' },
                  { value: 60, label: 'After 1 Hour' },
                  { value: 240, label: 'After 4 Hours' },
                  { value: 0, label: 'Never' }
                ]}
              />
            </Row>
            <Row label="Lock when Windows locks or sleeps">
              <Switch on={s.lockOnSystemLock} onChange={(v) => set({ lockOnSystemLock: v })} />
            </Row>
            <Row label="Master password" multi>
              <button className="btn" onClick={() => setChanging(true)}>
                Change…
              </button>
            </Row>
            <Row
              label="Backup"
              hint="One file with all hosts, keys and known hosts. It stays encrypted with your master password, so keep it wherever you like."
              multi
            >
              <button className="btn" onClick={() => void backUp()}>
                Back Up…
              </button>
              <button className="btn" onClick={() => void restore()}>
                Restore…
              </button>
            </Row>
          </Group>

          <Group title="General">
            <Row label="Keep running when the window is closed" hint="Clavium stays in the notification area so AI clients can reach it.">
              <Switch on={s.closeToTray} onChange={(v) => set({ closeToTray: v })} />
            </Row>
            <Row label="Terminal text size">
              <Select<number>
                label="Terminal text size"
                value={s.terminalFontSize}
                onChange={(v) => set({ terminalFontSize: v })}
                options={[11, 12, 13, 14, 15, 16, 18, 20, 24].map((n) => ({ value: n, label: `${n} pt` }))}
              />
            </Row>
          </Group>

          <UpdateGroup auto={s.autoCheckUpdates} setAuto={(v) => set({ autoCheckUpdates: v })} />

          {info && (
            <Group title="About">
              <ValueRow label="Version">{info.version}</ValueRow>
              <ValueRow label="License">MIT, open source</ValueRow>
              <div className="row">
                <span className="row-label">Source code</span>
                <span className="row-control">
                  <button className="link" onClick={() => void api.app.openExternal(info.repoUrl)}>
                    {info.repoUrl.replace('https://', '')}
                  </button>
                </span>
              </div>
            </Group>
          )}
        </div>
      </div>
      {changing && <PasswordSheet close={() => setChanging(false)} />}
    </>
  )
}

function UpdateGroup({ auto, setAuto }: { auto: boolean; setAuto: (v: boolean) => void }) {
  const toast = useToast()
  const [u, setU] = useState<UpdateState | null>(null)
  useEffect(() => {
    void api.update.state().then(setU)
    return on('update:changed', (s: UpdateState) => setU(s))
  }, [])
  if (!u) return null

  if (u.status === 'unsupported') {
    return (
      <Group
        title="Updates"
        caption={
          u.reason === 'portable'
            ? 'The portable version can’t update itself. Download the new version from GitHub, or use the installer to get in-app updates.'
            : 'Updates are only available in the installed app.'
        }
      >
        <ValueRow label="Installed version">{u.currentVersion}</ValueRow>
      </Group>
    )
  }

  const busy = u.status === 'checking' || u.status === 'downloading' || u.status === 'verifying'
  const text: Record<UpdateState['status'], string> = {
    unsupported: '',
    idle: `Version ${u.currentVersion}`,
    checking: 'Checking for updates…',
    'up-to-date': `Clavium ${u.currentVersion} is up to date`,
    available: `Version ${u.version} is available`,
    downloading: `Downloading version ${u.version}… ${u.progress ?? 0} %`,
    verifying: 'Verifying the signature…',
    ready: `Version ${u.version} is verified and ready to install`,
    error: u.error ?? 'The update failed'
  }

  return (
    <Group
      title="Updates"
      caption="Updates come from the project’s GitHub releases. Clavium installs an update only if it is signed with the Clavium release key, and never without your click."
    >
      <div className="row" role="group" aria-label="Software update">
        <span className="row-label" style={{ maxWidth: 'none' }}>
          <span className={u.status === 'error' ? 'signal danger' : u.status === 'ready' || u.status === 'up-to-date' ? 'signal ok' : ''} style={{ whiteSpace: 'normal', fontSize: 13 }}>
            {text[u.status]}
          </span>
          {u.checkedAt && !busy && <span className="hint">Last checked {formatDate(u.checkedAt)}</span>}
        </span>
        <span className="row-control">
          {u.status === 'available' ? (
            <button className="btn prominent" onClick={() => void api.update.download().catch(toast.error)}>
              Download Update
            </button>
          ) : u.status === 'ready' ? (
            <button className="btn prominent" onClick={() => void api.update.install().catch(toast.error)}>
              Restart and Install
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={() => void api.update.check().catch(toast.error)}>
              Check Now
            </button>
          )}
        </span>
      </div>
      <Row label="Check for updates automatically" hint="Contacts github.com on start and twice a day. Nothing else is sent.">
        <Switch on={auto} onChange={setAuto} />
      </Row>
    </Group>
  )
}

function PasswordSheet({ close }: { close: () => void }) {
  const toast = useToast()
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setError('')
    if (newPw.length < 10) return setError('Use at least 10 characters.')
    if (newPw !== newPw2) return setError('The new passwords don’t match.')
    setBusy(true)
    try {
      await api.vault.changePassword(oldPw, newPw)
      toast.ok('Master password changed')
      close()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="Change Master Password"
      onClose={close}
      footer={
        <>
          <span className="lead" style={{ color: 'var(--red)' }} role="alert">
            {error}
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn prominent" disabled={busy || !oldPw || !newPw || !newPw2} onClick={() => void submit()}>
            Change Password
          </button>
        </>
      }
    >
      <Group>
        <Row label="Current password">
          <input className="field" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoFocus autoComplete="current-password" />
        </Row>
      </Group>
      <Group>
        <Row label="New password">
          <input className="field" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
        </Row>
        <Row label="Repeat new password">
          <input className="field" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" />
        </Row>
      </Group>
      <StrengthBar pw={newPw} />
    </Sheet>
  )
}
