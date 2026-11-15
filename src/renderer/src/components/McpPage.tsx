import { useEffect, useState } from 'react'
import { Copy, Eye, EyeOff } from 'lucide-react'
import type { McpSnippets } from '@shared/ipc'
import type { AiAccess, AiConfirm, HostSummary, McpStatus } from '@shared/types'
import { api, hostToInput, on, type UiSettings } from '../api'
import { Group, Note, Row, Segmented, Select, Switch, Toolbar, useConfirm, useToast } from '../ui'
import { AI_ACCESS_OPTIONS, AI_CONFIRM_OPTIONS } from './HostEditor'
import { address } from './HostsPage'
import { isMac } from '../platform'

type Client = 'claudeCode' | 'claudeDesktop' | 'codex' | 'generic'

const CLIENT_HELP: Record<Client, string> = {
  claudeCode: 'Run this command once in a terminal. Clavium is then available in all your Claude Code projects.',
  claudeDesktop: 'In Claude Desktop, open Settings › Developer › Edit Config, add this entry and restart Claude Desktop.',
  codex: `Add this to ${isMac ? '~/.codex/config.toml' : '.codex\\config.toml in your user folder'} and restart Codex.`,
  generic: 'For any other MCP client that supports Streamable HTTP or stdio servers.'
}

export function McpPage(props: { hosts: HostSummary[]; settings: UiSettings; reloadHosts: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [snippets, setSnippets] = useState<McpSnippets | null>(null)
  const [client, setClient] = useState<Client>('claudeCode')
  const [revealed, setRevealed] = useState(false)
  const [port, setPort] = useState(String(props.settings.mcpPort))
  const enabled = props.settings.mcpEnabled

  const refresh = (): void => void api.mcp.status().then(setStatus)
  useEffect(() => {
    refresh()
    return on('mcp:changed', refresh)
  }, [])
  useEffect(() => setPort(String(props.settings.mcpPort)), [props.settings.mcpPort])

  // The configuration contains the token, so it is only loaded while the server is on.
  useEffect(() => {
    if (!enabled) {
      setSnippets(null)
      setRevealed(false)
      return
    }
    void api.mcp.snippets().then(setSnippets, toast.error)
  }, [enabled, status?.port, status?.hasToken])

  const applyPort = (): void => {
    const n = Number(port)
    if (n === props.settings.mcpPort) return
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      toast.error('Choose a port between 1024 and 65535.')
      setPort(String(props.settings.mcpPort))
      return
    }
    void api.settings.set({ mcpPort: n }).then(refresh, toast.error)
  }

  const resetToken = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Reset the Access Token?',
      message: 'Every AI client you set up stops working until you copy the new configuration into it.',
      confirmLabel: 'Reset Token',
      destructive: true
    })
    if (!ok) return
    try {
      await api.mcp.regenerate()
      setSnippets(await api.mcp.snippets())
      toast.ok('New token created')
    } catch (e) {
      toast.error(e)
    }
  }

  const updateHost = async (h: HostSummary, patch: { aiAccess?: AiAccess; aiConfirm?: AiConfirm }): Promise<void> => {
    try {
      await api.hosts.save({ ...hostToInput(h), ...patch })
      props.reloadHosts()
    } catch (e) {
      toast.error(e)
    }
  }

  const text = snippets ? snippets[client] : ''
  const shown = revealed ? text : text.replace(/clv_[A-Za-z0-9_-]+/g, 'clv_••••••••••••')
  const shared = props.hosts.filter((h) => h.aiAccess !== 'none').length

  return (
    <>
      <Toolbar title="AI Access" />
      <div className="view-scroll">
        <div className="page">
          <p className="page-intro">
            Let Claude or Codex work on your servers through the Model Context Protocol (MCP). Assistants only see
            the hosts you share, and by default every command waits for your approval.
          </p>

          <Group
            caption={
              status?.error ? undefined : enabled ? 'Only programs on this PC can connect, and only with the access token.' : 'While this is off, no AI client can reach Clavium.'
            }
          >
            <Row
              label="MCP Server"
              hint={
                status?.error ? (
                  <span className="signal danger">{status.error}</span>
                ) : status?.running ? (
                  <span className="signal ok">Running on 127.0.0.1:{status.port}</span>
                ) : (
                  'Off'
                )
              }
            >
              <Switch on={enabled} label="MCP Server" onChange={(v) => void api.settings.set({ mcpEnabled: v }).then(refresh, toast.error)} />
            </Row>
            {enabled && (
              <Row label="Port" hint="Changing it requires updating your AI clients.">
                <input
                  className="field"
                  style={{ width: 90 }}
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  onBlur={applyPort}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              </Row>
            )}
          </Group>

          {enabled && (
            <>
              <h3 className="group-title">Set Up a Client</h3>
              <Segmented<Client>
                label="AI client"
                value={client}
                onChange={setClient}
                options={[
                  { value: 'claudeCode', label: 'Claude Code' },
                  { value: 'claudeDesktop', label: 'Claude Desktop' },
                  { value: 'codex', label: 'Codex' },
                  { value: 'generic', label: 'Other' }
                ]}
              />
              <p className="caption" style={{ margin: '10px 0 8px' }}>
                {CLIENT_HELP[client]}
              </p>
              <div className="code" data-testid="mcp-config">
                {shown || 'Loading…'}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                <button className="btn" disabled={!text} onClick={() => void api.clipboard.write(text).then(() => toast.ok('Copied'))}>
                  <Copy size={14} /> Copy
                </button>
                <button className="btn" disabled={!text} onClick={() => setRevealed((r) => !r)}>
                  {revealed ? <EyeOff size={14} /> : <Eye size={14} />} {revealed ? 'Hide Token' : 'Show Token'}
                </button>
                <span style={{ flex: 1 }} />
                <button className="btn destructive" onClick={() => void resetToken()}>
                  Reset Token…
                </button>
              </div>
              <p className="caption" style={{ marginTop: 10 }}>
                Treat the token like a password. Clavium must be running and unlocked for assistants to work; it can
                stay in the notification area.
              </p>
            </>
          )}

          <Group
            title="Shared Hosts"
            caption={
              props.hosts.length === 0
                ? undefined
                : shared === 0
                  ? 'No host is shared. Assistants can’t see or reach any of your servers.'
                  : '“Read Files” never allows commands. “Full Access” also allows commands, uploads, renaming and deleting.'
            }
          >
            {props.hosts.length === 0 && (
              <div className="row" style={{ color: 'var(--text-2)' }}>
                Add a host first.
              </div>
            )}
            {props.hosts.map((h) => (
              <div className="item" key={h.id} role="group" aria-label={h.name}>
                <div className="body">
                  <div className="primary">{h.name}</div>
                  <div className="secondary mono">{address(h)}</div>
                </div>
                <div className="side">
                  {h.aiAccess !== 'none' && (
                    <Select<AiConfirm>
                      label={`Ask before, ${h.name}`}
                      value={h.aiConfirm}
                      onChange={(v) => void updateHost(h, { aiConfirm: v })}
                      options={AI_CONFIRM_OPTIONS.map((o) => ({ ...o, label: o.value === 'none' ? 'Never Ask' : `Ask: ${o.label}` }))}
                    />
                  )}
                  <Select<AiAccess> label={`AI access, ${h.name}`} value={h.aiAccess} onChange={(v) => void updateHost(h, { aiAccess: v })} options={AI_ACCESS_OPTIONS} />
                </div>
              </div>
            ))}
          </Group>

          {props.hosts.some((h) => h.aiAccess === 'full' && h.aiConfirm === 'none') && (
            <div style={{ marginTop: 10 }}>
              <Note kind="warn">At least one host allows full access without approval. An assistant can run any command there without asking you.</Note>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
