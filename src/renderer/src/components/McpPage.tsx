import { useEffect, useState } from 'react'
import type { McpSnippets } from '@shared/ipc'
import type { AiAccess, AiConfirm, HostSummary, McpStatus } from '@shared/types'
import { api, hostToInput, on, type UiSettings } from '../api'
import { Icon, Segmented, Switch, useToast } from '../ui'

type Client = 'claudeCode' | 'claudeDesktop' | 'codex' | 'generic'

const CLIENT_HELP: Record<Client, string> = {
  claudeCode: 'Run this once in a terminal (PowerShell or cmd). It registers Clavium for all your projects.',
  claudeDesktop:
    'Claude Desktop → Settings → Developer → Edit Config. Merge this into claude_desktop_config.json and restart Claude Desktop.',
  codex: 'Add this to %USERPROFILE%\\.codex\\config.toml and restart Codex.',
  generic: 'For any other MCP client that supports Streamable HTTP or stdio servers.'
}

export function McpPage(props: { hosts: HostSummary[]; settings: UiSettings; reloadHosts: () => void }) {
  const toast = useToast()
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [snippets, setSnippets] = useState<McpSnippets | null>(null)
  const [client, setClient] = useState<Client>('claudeCode')
  const [showSecrets, setShowSecrets] = useState(false)
  const [port, setPort] = useState(String(props.settings.mcpPort))

  const refresh = (): void => {
    void api.mcp.status().then(setStatus)
  }
  useEffect(() => {
    refresh()
    return on('mcp:changed', () => {
      refresh()
      setSnippets(null)
      setShowSecrets(false)
    })
  }, [])

  const setEnabled = async (v: boolean): Promise<void> => {
    try {
      await api.settings.set({ mcpEnabled: v })
      refresh()
    } catch (e) {
      toast.error(e)
    }
  }

  const reveal = async (): Promise<void> => {
    try {
      setSnippets(await api.mcp.snippets())
      setShowSecrets(false) // masked until explicitly revealed (screen sharing!)
    } catch (e) {
      toast.error(e)
    }
  }

  const regenerate = async (): Promise<void> => {
    if (!confirm('Create a new token? All AI clients configured with the old token stop working until you update them.')) return
    try {
      await api.mcp.regenerate()
      setSnippets(await api.mcp.snippets())
      setShowSecrets(true)
      toast.ok('New token created')
    } catch (e) {
      toast.error(e)
    }
  }

  const copy = (text: string): void => {
    void api.clipboard.write(text).then(() => toast.ok('Copied to clipboard'))
  }

  const updateHost = async (h: HostSummary, patch: { aiAccess?: AiAccess; aiConfirm?: AiConfirm }): Promise<void> => {
    try {
      await api.hosts.save({ ...hostToInput(h), ...patch })
      props.reloadHosts()
    } catch (e) {
      toast.error(e)
    }
  }

  const snippetText = snippets ? snippets[client] : ''
  const masked = snippetText.replace(/clv_[A-Za-z0-9_-]+/g, 'clv_••••••••••••••••')

  return (
    <div className="page">
      <h1>AI / MCP</h1>
      <p className="sub">
        Let Claude (Code / Desktop) or Codex use your servers through the Model Context Protocol — only the hosts you
        share, only with the rights you grant, and with your approval.
      </p>

      <div className="section">
        <div className="row between">
          <div>
            <h2 style={{ margin: 0 }}>MCP server</h2>
            <div className="small muted">
              {status?.running ? (
                <>
                  <span className="badge ok">running</span> on <span className="mono">{status.url}</span> (this
                  computer only)
                </>
              ) : status?.enabled ? (
                <span className="badge danger">not running</span>
              ) : (
                <span className="badge">off</span>
              )}
            </div>
          </div>
          <Switch on={props.settings.mcpEnabled} onChange={setEnabled} label="Enable MCP server" />
        </div>
        {status?.error && <div className="callout danger small" style={{ marginTop: 10 }}>{status.error}</div>}
        <div className="row" style={{ marginTop: 12 }}>
          <label className="field" style={{ width: 160 }}>
            Port
            <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
          </label>
          <button
            className="btn sm"
            style={{ alignSelf: 'flex-end' }}
            disabled={Number(port) === props.settings.mcpPort}
            onClick={() => api.settings.set({ mcpPort: Number(port) }).then(refresh, toast.error)}
          >
            Apply
          </button>
          <span className="small muted" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}>
            Changing the port requires updating the AI client configuration.
          </span>
        </div>
      </div>

      {props.settings.mcpEnabled && (
        <div className="section">
          <h2>Connect an AI client</h2>
          <div className="row" style={{ marginBottom: 10 }}>
            <Segmented<Client>
              value={client}
              onChange={setClient}
              options={[
                { value: 'claudeCode', label: 'Claude Code' },
                { value: 'claudeDesktop', label: 'Claude Desktop' },
                { value: 'codex', label: 'Codex' },
                { value: 'generic', label: 'Other' }
              ]}
            />
          </div>
          <div className="small muted" style={{ marginBottom: 8 }}>{CLIENT_HELP[client]}</div>
          {snippets ? (
            <>
              <div className="code">{showSecrets ? snippetText : masked}</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn sm primary" onClick={() => copy(snippetText)}>
                  <Icon name="copy" size={14} /> Copy
                </button>
                <button className="btn sm" onClick={() => setShowSecrets((s) => !s)}>
                  <Icon name="eye" size={14} /> {showSecrets ? 'Hide token' : 'Show token'}
                </button>
                <span className="grow" />
                <button className="btn sm danger" onClick={regenerate}>
                  New token (revoke old)
                </button>
              </div>
            </>
          ) : (
            <button className="btn" onClick={reveal}>
              <Icon name="key" size={14} /> Show configuration
            </button>
          )}
          <div className="callout small" style={{ marginTop: 12 }}>
            The token works like a password for the MCP server. Anyone with the token <i>and</i> access to this
            computer could use your shared hosts — keep it inside the AI client's config. Clavium must be running
            (it can live in the tray) and unlocked for tools to work.
          </div>
        </div>
      )}

      <div className="section">
        <h2>Shared hosts</h2>
        <table className="list">
          <thead>
            <tr>
              <th>Host</th>
              <th>AI access</th>
              <th>Ask before</th>
            </tr>
          </thead>
          <tbody>
            {props.hosts.map((h) => (
              <tr key={h.id}>
                <td>
                  <div>{h.name}</div>
                  <div className="small muted mono">{h.hostname}</div>
                </td>
                <td>
                  <Segmented<AiAccess>
                    value={h.aiAccess}
                    onChange={(v) => updateHost(h, { aiAccess: v })}
                    options={[
                      { value: 'none', label: 'Off' },
                      { value: 'read', label: 'Read' },
                      { value: 'full', label: 'Full' }
                    ]}
                  />
                </td>
                <td>
                  {h.aiAccess !== 'none' && (
                    <Segmented<AiConfirm>
                      value={h.aiConfirm}
                      onChange={(v) => updateHost(h, { aiConfirm: v })}
                      options={[
                        { value: 'all', label: 'Everything' },
                        { value: 'changes', label: 'Changes' },
                        { value: 'none', label: 'Never' }
                      ]}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {props.hosts.length === 0 && <div className="empty">Add hosts first.</div>}
      </div>

      <div className="section">
        <h2>How Clavium protects your servers</h2>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>The MCP server only listens on 127.0.0.1 and requires a secret token; browser requests are rejected.</li>
          <li>AI clients never see passwords or private keys — only host names you shared.</li>
          <li>Hosts are hidden from AI unless you enable access per host. “Read” never allows commands.</li>
          <li>By default every command and every change needs your click on “Allow once”.</li>
          <li>Unknown or changed host keys are never accepted on behalf of the AI.</li>
          <li>Everything the AI does is written to the Activity log.</li>
        </ul>
      </div>
    </div>
  )
}
