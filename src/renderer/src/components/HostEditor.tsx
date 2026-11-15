import { useState } from 'react'
import { ArrowRight, Plus, X } from 'lucide-react'
import type { AiAccess, AiConfirm, AuthMethod, FtpEncoding, HostInput, HostSummary, PortForward, Protocol, ProxyConfig, SshKeySummary } from '@shared/types'
import { api, hostToInput } from '../api'
import { Group, IconButton, Note, Row, Select, Sheet, Switch, useToast } from '../ui'
import { isMac } from '../platform'

const DEFAULT_PORT: Record<Protocol, number> = { ssh: 22, ftps: 21, 'ftps-implicit': 990, ftp: 21 }

export const AI_ACCESS_OPTIONS: { value: AiAccess; label: string }[] = [
  { value: 'none', label: 'Nothing' },
  { value: 'read', label: 'Read Files' },
  { value: 'full', label: 'Full Access' }
]
export const AI_CONFIRM_OPTIONS: { value: AiConfirm; label: string }[] = [
  { value: 'all', label: 'Every Action' },
  { value: 'changes', label: 'Commands and Changes' },
  { value: 'none', label: 'Never' }
]

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
  /** The other hosts of the vault, to choose a jump host from. */
  hosts?: HostSummary[]
  onClose: () => void
  onSaved: (h: HostSummary) => void
}) {
  const toast = useToast()
  const [h, setH] = useState<HostInput>(props.host ? hostToInput(props.host) : blank())
  const [pw, setPw] = useState('')
  const [pwTouched, setPwTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [proxyPw, setProxyPw] = useState('')
  const [proxyPwTouched, setProxyPwTouched] = useState(false)
  const hasStoredProxyPw = !!props.host?.hasProxyPassword && !proxyPwTouched
  const jumpHosts = (props.hosts ?? []).filter((x) => x.protocol === 'ssh' && x.id !== props.host?.id)
  const route: 'direct' | 'jump' | 'proxy' = h.proxy ? 'proxy' : h.jumpHostId !== undefined && h.protocol === 'ssh' ? 'jump' : 'direct'
  const setRoute = (r: typeof route): void =>
    setH((x) => ({
      ...x,
      jumpHostId: r === 'jump' ? (x.jumpHostId ?? jumpHosts[0]?.id ?? '') : undefined,
      proxy: r === 'proxy' ? (x.proxy ?? { type: 'socks5', host: '', port: 1080 }) : undefined
    }))
  const setProxy = (patch: Partial<ProxyConfig>): void => setH((x) => (x.proxy ? { ...x, proxy: { ...x.proxy, ...patch } } : x))
  const set = <K extends keyof HostInput>(k: K, v: HostInput[K]): void => setH((x) => ({ ...x, [k]: v }))
  const isSsh = h.protocol === 'ssh'
  const usesPassword = !isSsh || h.authMethod === 'password' || h.authMethod === 'keyboard-interactive'
  const hasStored = !!props.host?.hasPassword && !pwTouched
  const valid =
    h.hostname.trim() !== '' &&
    h.port > 0 &&
    !(isSsh && h.authMethod === 'key' && !h.keyId) &&
    !(route === 'jump' && !h.jumpHostId) &&
    !(route === 'proxy' && (!h.proxy?.host.trim() || !((h.proxy?.port ?? 0) > 0)))

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await api.hosts.save({
        ...h,
        name: h.name.trim() || h.hostname.trim(),
        authMethod: isSsh ? h.authMethod : 'password',
        keyId: isSsh && h.authMethod === 'key' ? h.keyId : undefined,
        forwards: isSsh ? h.forwards : [],
        password: pwTouched ? (pw === '' ? null : pw) : undefined,
        jumpHostId: route === 'jump' ? h.jumpHostId : undefined,
        proxy: route === 'proxy' && h.proxy ? { ...h.proxy, host: h.proxy.host.trim(), username: h.proxy.username?.trim() || undefined } : undefined,
        proxyPassword: route !== 'proxy' ? null : proxyPwTouched ? (proxyPw === '' ? null : proxyPw) : undefined
      })
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

  return (
    <Sheet
      size="wide"
      title={props.host ? `Edit “${props.host.name}”` : 'New Host'}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn prominent" onClick={save} disabled={busy || !valid}>
            Save
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) void save()
        }}
      >
        <Group>
          <Row label="Name">
            <input className="field" value={h.name} placeholder="Production Web" onChange={(e) => set('name', e.target.value)} autoFocus />
          </Row>
          <Row label="Group">
            <input className="field" list="host-groups" value={h.group} placeholder="Optional" onChange={(e) => set('group', e.target.value)} />
            <datalist id="host-groups">
              {props.groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Row>
        </Group>

        <Group title="Connection">
          <Row label="Protocol">
            <Select<Protocol>
              label="Protocol"
              value={h.protocol}
              onChange={(p) => setH((x) => ({ ...x, protocol: p, port: x.port === DEFAULT_PORT[x.protocol] ? DEFAULT_PORT[p] : x.port }))}
              options={[
                { value: 'ssh', label: 'SSH (Terminal and SFTP)' },
                { value: 'ftps', label: 'FTPS (Explicit TLS)' },
                { value: 'ftps-implicit', label: 'FTPS (Implicit TLS)' },
                { value: 'ftp', label: 'FTP (Unencrypted)' }
              ]}
            />
          </Row>
          <Row label="Host">
            <input className="field mono" value={h.hostname} placeholder="server.example.com" onChange={(e) => set('hostname', e.target.value.trim())} />
          </Row>
          <Row label="Port">
            <input className="field" style={{ width: 90 }} type="number" min={1} max={65535} value={h.port || ''} onChange={(e) => set('port', Number(e.target.value) || 0)} />
          </Row>
          <Row label="User">
            <input className="field mono" value={h.username} placeholder="root" onChange={(e) => set('username', e.target.value)} />
          </Row>
          {!isSsh && (
            <Row label="File names" hint="Choose Western European only when names with accents or umlauts look wrong.">
              <Select<FtpEncoding>
                label="Character set of file names"
                value={h.ftpEncoding ?? 'utf8'}
                onChange={(v) => set('ftpEncoding', v)}
                options={[
                  { value: 'utf8', label: 'UTF-8' },
                  { value: 'latin1', label: 'Western European (ISO 8859-1)' }
                ]}
              />
            </Row>
          )}
        </Group>
        {h.protocol === 'ftp' && (
          <div style={{ marginTop: 8 }}>
            <Note kind="danger">
              FTP sends your password and files unencrypted. Use SSH or FTPS if the server supports it.
            </Note>
          </div>
        )}

        <Group
          title="Sign-In"
          caption={isSsh && h.authMethod === 'agent' ? (isMac ? 'Uses the SSH agent of macOS (the keys from ssh-add). Agent forwarding is never enabled.' : 'Uses the Windows OpenSSH agent or Pageant. Agent forwarding is never enabled.') : undefined}
        >
          {isSsh && (
            <Row label="Method">
              <Select<AuthMethod>
                label="Method"
                value={h.authMethod}
                onChange={(v) => set('authMethod', v)}
                options={[
                  { value: 'password', label: 'Password' },
                  { value: 'key', label: 'SSH Key' },
                  { value: 'agent', label: 'SSH Agent' },
                  { value: 'keyboard-interactive', label: 'Interactive (2FA)' }
                ]}
              />
            </Row>
          )}
          {isSsh && h.authMethod === 'key' && (
            <Row label="Key" hint={props.keys.length === 0 ? 'Add a key under Keys first.' : undefined}>
              <select className="field" aria-label="Key" style={{ width: 'auto' }} value={h.keyId ?? ''} onChange={(e) => set('keyId', e.target.value || undefined)}>
                <option value="">Choose…</option>
                {props.keys.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </Row>
          )}
          {usesPassword && (
            <Row label="Password" hint={hasStored ? 'Saved in the vault' : 'Optional. Asked when you connect if empty.'}>
              <input
                className="field"
                type="password"
                autoComplete="new-password"
                value={pw}
                placeholder={hasStored ? '••••••••' : ''}
                onChange={(e) => {
                  setPw(e.target.value)
                  setPwTouched(true)
                }}
              />
              {hasStored && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setPw('')
                    setPwTouched(true)
                  }}
                >
                  Remove
                </button>
              )}
            </Row>
          )}
        </Group>

        <Group
          title="Route"
          caption={
            route === 'jump'
              ? 'Clavium signs in to the jump host first and opens this host from there. Both host keys are checked.'
              : route === 'proxy'
                ? 'The proxy looks up the host name. With FTP, file transfers go through the proxy as well.'
                : undefined
          }
        >
          <Row label="Connect">
            <Select<typeof route>
              label="Connect"
              value={route}
              onChange={setRoute}
              options={[
                { value: 'direct', label: 'Directly' },
                ...(isSsh ? [{ value: 'jump' as const, label: 'Through a Jump Host' }] : []),
                { value: 'proxy', label: 'Through a Proxy' }
              ]}
            />
          </Row>
          {route === 'jump' && (
            <Row label="Jump host" hint={jumpHosts.length === 0 ? 'Add the jump host as an SSH host first.' : undefined}>
              <select className="field" aria-label="Jump host" style={{ width: 'auto' }} value={h.jumpHostId ?? ''} onChange={(e) => set('jumpHostId', e.target.value)}>
                <option value="">Choose…</option>
                {jumpHosts.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
            </Row>
          )}
          {route === 'proxy' && h.proxy && (
            <>
              <Row label="Proxy type">
                <Select<ProxyConfig['type']>
                  label="Proxy type"
                  value={h.proxy.type}
                  onChange={(v) => setProxy({ type: v, port: h.proxy?.port === 1080 || h.proxy?.port === 8080 ? (v === 'socks5' ? 1080 : 8080) : h.proxy?.port })}
                  options={[
                    { value: 'socks5', label: 'SOCKS5' },
                    { value: 'http', label: 'HTTP (CONNECT)' }
                  ]}
                />
              </Row>
              <Row label="Proxy address" multi>
                <input className="field mono" style={{ flex: 1, minWidth: 0 }} aria-label="Proxy host" spellCheck={false} value={h.proxy.host} onChange={(e) => setProxy({ host: e.target.value })} />
                <input className="field" style={{ width: 78 }} type="number" aria-label="Proxy port" value={h.proxy.port || ''} onChange={(e) => setProxy({ port: Number(e.target.value) || 0 })} />
              </Row>
              <Row label="Proxy user" hint="Optional">
                <input className="field" aria-label="Proxy user" autoComplete="off" spellCheck={false} value={h.proxy.username ?? ''} onChange={(e) => setProxy({ username: e.target.value })} />
              </Row>
              <Row label="Proxy password" hint={hasStoredProxyPw ? 'Saved in the vault' : 'Optional'}>
                <input
                  className="field"
                  type="password"
                  aria-label="Proxy password"
                  autoComplete="new-password"
                  value={proxyPw}
                  placeholder={hasStoredProxyPw ? '••••••••' : ''}
                  onChange={(e) => {
                    setProxyPw(e.target.value)
                    setProxyPwTouched(true)
                  }}
                />
              </Row>
            </>
          )}
        </Group>

        <Group title="AI Access" caption="What Claude or Codex may do on this host through Clavium’s MCP server.">
          <Row label="Allow AI to">
            <Select<AiAccess>
              label="Allow AI to"
              value={h.aiAccess}
              onChange={(v) => set('aiAccess', v)}
              options={[
                { value: 'none', label: 'Do Nothing (Hidden)' },
                { value: 'read', label: 'Read Files' },
                { value: 'full', label: isSsh ? 'Run Commands and Change Files' : 'Read and Change Files' }
              ]}
            />
          </Row>
          {h.aiAccess !== 'none' && (
            <Row label="Ask me before">
              <Select<AiConfirm> label="Ask me before" value={h.aiConfirm} onChange={(v) => set('aiConfirm', v)} options={AI_CONFIRM_OPTIONS} />
            </Row>
          )}
        </Group>
        {h.aiAccess === 'full' && h.aiConfirm === 'none' && (
          <div style={{ marginTop: 8 }}>
            <Note kind="danger">The AI can then run any command on this server without asking you. Use this only for disposable test machines.</Note>
          </div>
        )}

        {isSsh && (
          <Group title="Tunnels" caption="Forwards a port on this PC (127.0.0.1) through SSH to a destination reachable from the server.">
            {h.forwards.map((f, i) => (
              <div className="row" key={f.id} role="group" aria-label={`Tunnel ${i + 1}`}>
                <span className="mono" style={{ color: 'var(--text-2)' }}>127.0.0.1</span>
                <input className="field" style={{ width: 78 }} type="number" aria-label="Local port" value={f.localPort || ''} onChange={(e) => setForward(i, { localPort: Number(e.target.value) || 0 })} />
                <ArrowRight size={14} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                <input className="field mono" style={{ flex: 1, minWidth: 0 }} aria-label="Destination host" value={f.remoteHost} onChange={(e) => setForward(i, { remoteHost: e.target.value })} />
                <input className="field" style={{ width: 78 }} type="number" aria-label="Destination port" value={f.remotePort || ''} onChange={(e) => setForward(i, { remotePort: Number(e.target.value) || 0 })} />
                <IconButton icon={X} label="Remove Tunnel" onClick={() => set('forwards', h.forwards.filter((_, j) => j !== i))} />
              </div>
            ))}
            <div className="row">
              <button
                type="button"
                className="btn plain"
                style={{ marginLeft: -8 }}
                onClick={() => set('forwards', [...h.forwards, { id: newId(), localPort: 8080, remoteHost: '127.0.0.1', remotePort: 80 }])}
              >
                <Plus size={15} /> Add Tunnel
              </button>
            </div>
          </Group>
        )}

        <Group title="Advanced">
          {isSsh && (
            <Row label="Allow legacy algorithms" hint="SHA-1 and ssh-rsa, for very old servers only">
              <Switch on={h.allowLegacyAlgorithms} onChange={(v) => set('allowLegacyAlgorithms', v)} />
            </Row>
          )}
          <Row label="Notes" stacked>
            <textarea className="field" value={h.notes} onChange={(e) => set('notes', e.target.value)} />
          </Row>
        </Group>
        <button type="submit" hidden />
      </form>
    </Sheet>
  )
}
