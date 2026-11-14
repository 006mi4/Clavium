import type { McpSnippets } from '@shared/ipc'
import type { McpStatus } from '@shared/types'
import type { AuditLog } from './core/audit'
import { randomToken, sha256Hex } from './core/crypto'
import { McpHttpServer } from './core/mcp/http'
import { McpService, type EditorBridge } from './core/mcp/service'
import type { Prompter } from './core/prompter'
import type { SettingsStore } from './core/settings'
import type { Vault } from './core/vault'

export interface McpControllerDeps {
  vault: Vault
  settings: SettingsStore
  prompter: Prompter
  audit: AuditLog
  version: string
  editor?: EditorBridge
  /** Path of the installed stdio bridge (clavium-mcp.exe). */
  bridgePath: string
  onChange: () => void
}

export class McpController {
  readonly service: McpService
  private readonly http: McpHttpServer
  private lastError?: string

  constructor(private readonly deps: McpControllerDeps) {
    this.service = new McpService({ vault: deps.vault, prompter: deps.prompter, audit: deps.audit, version: deps.version, editor: deps.editor })
    this.http = new McpHttpServer({ vault: deps.vault, service: this.service, settings: () => deps.settings.get() })
  }

  /** Start/stop/restart the HTTP endpoint according to the settings. */
  async apply(): Promise<void> {
    const s = this.deps.settings.get()
    try {
      if (s.mcpEnabled) {
        if (this.deps.vault.state() === 'unlocked' && !this.deps.vault.data.mcpToken) await this.regenerate()
        if (this.http.listeningPort !== s.mcpPort) await this.http.start(s.mcpPort)
        this.lastError = undefined
      } else {
        await this.http.stop()
        this.service.shutdown()
        this.lastError = undefined
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      this.lastError =
        err.code === 'EADDRINUSE' ? `Port ${s.mcpPort} is already in use — choose another port` : err.message
    }
    this.deps.onChange()
  }

  status(): McpStatus {
    const s = this.deps.settings.get()
    return {
      enabled: s.mcpEnabled,
      running: this.http.listeningPort !== 0,
      port: s.mcpPort,
      url: `http://127.0.0.1:${s.mcpPort}/mcp`,
      hasToken: !!s.mcpTokenHash,
      error: this.lastError
    }
  }

  async token(): Promise<string> {
    const existing = this.deps.vault.data.mcpToken
    return existing ?? this.regenerate()
  }

  /** Issue a new token; every configured AI client must be updated afterwards. */
  async regenerate(): Promise<string> {
    const token = randomToken()
    await this.deps.vault.update((d) => {
      d.mcpToken = token
    })
    await this.deps.settings.set({ mcpTokenHash: sha256Hex(token) })
    this.service.shutdown()
    this.deps.onChange()
    return token
  }

  async snippets(): Promise<McpSnippets> {
    const token = await this.token()
    const { mcpPort } = this.deps.settings.get()
    const url = `http://127.0.0.1:${mcpPort}/mcp`
    const command = this.deps.bridgePath
    const args: string[] = []
    const tomlStr = (v: string): string => JSON.stringify(v)

    const claudeCode = `claude mcp add --scope user --transport http clavium ${url} --header "Authorization: Bearer ${token}"`

    const claudeDesktop = JSON.stringify(
      { mcpServers: { clavium: { command, args, env: { CLAVIUM_MCP_TOKEN: token } } } },
      null,
      2
    )

    const codex = [
      '# ~/.codex/config.toml',
      '[mcp_servers.clavium]',
      `command = ${tomlStr(command)}`,
      `args = [${args.map(tomlStr).join(', ')}]`,
      `env = { CLAVIUM_MCP_TOKEN = ${tomlStr(token)} }`,
      'tool_timeout_sec = 180'
    ].join('\n')

    const generic = [
      `URL:    ${url}   (Streamable HTTP, POST only)`,
      `Header: Authorization: Bearer ${token}`,
      '',
      'stdio alternative:',
      `  command: ${command}`,
      `  args:    ${JSON.stringify(args)}`,
      `  env:     CLAVIUM_MCP_TOKEN=${token}`
    ].join('\n')

    return { url, exePath: command, claudeCode, claudeDesktop, codex, generic }
  }

  async shutdown(): Promise<void> {
    this.service.shutdown()
    await this.http.stop()
  }
}
