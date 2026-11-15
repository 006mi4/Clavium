import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { DEFAULT_SETTINGS } from '@shared/types'
import { AuditLog } from '../src/main/core/audit'
import { sha256Hex } from '../src/main/core/crypto'
import { McpHttpServer } from '../src/main/core/mcp/http'
import { McpService, type EditorBridge } from '../src/main/core/mcp/service'
import { applyAiEdit } from '../src/renderer/src/editor/commands'
import type { Vault } from '../src/main/core/vault'
import { MASTER, newUnlockedVault, recordingPrompter, sshHost, type RecordingPrompter } from './helpers/fixtures'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'
import { join } from 'node:path'

const TOKEN = 'clv_test-token-0123456789'
const BRIDGE_EXE = resolve(__dirname, '../resources/bin/clavium-mcp.exe')
let srv: TestSshServer
let vault: Vault
let prompter: RecordingPrompter
let audit: AuditLog
let service: McpService
let http: McpHttpServer
let port: number

async function client(token = TOKEN): Promise<Client> {
  const c = new Client({ name: 'test', version: '1.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return c
}

function textOf(r: unknown): string {
  return ((r as { content: { text: string }[] }).content[0]?.text ?? '') as string
}

function rawPost(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
  })
}

/** Stand-in for the editor window: open files per host, edited with the real edit function. */
const editorFiles = new Map<string, { text: string; saved: string }>()
const fakeEditor: EditorBridge = {
  async list() {
    return [...editorFiles].map(([key, f]) => ({ hostId: key.split('|')[0], path: key.split('|')[1], name: key.split('/').pop() as string, unsaved: f.text !== f.saved }))
  },
  async open(hostId, path) {
    if (!editorFiles.has(`${hostId}|${path}`)) editorFiles.set(`${hostId}|${path}`, { text: 'port = 80\nhost = a\n', saved: 'port = 80\nhost = a\n' })
  },
  async read(hostId, path) {
    const f = editorFiles.get(`${hostId}|${path}`)
    if (!f) throw new Error('This file is not open in the editor. Call editor_open_file first.')
    return { text: f.text, unsaved: f.text !== f.saved }
  },
  async edit(hostId, path, edit) {
    const f = editorFiles.get(`${hostId}|${path}`)
    if (!f) throw new Error('This file is not open in the editor. Call editor_open_file first.')
    const r = applyAiEdit(f.text, edit)
    f.text = r.text
    return r.count
  }
}

beforeAll(async () => {
  srv = await startTestSshServer()
  const v = await newUnlockedVault()
  vault = v.vault
  audit = new AuditLog(join(v.dir, 'audit.log'))
  prompter = recordingPrompter()
  await vault.update((d) => {
    d.mcpToken = TOKEN
    d.hosts.push(sshHost(srv.port))
    d.hosts.push(sshHost(srv.port, { id: 'h2', name: 'readonly-box', aiAccess: 'read', aiConfirm: 'none' }))
    d.hosts.push(sshHost(srv.port, { id: 'h3', name: 'secret-box', aiAccess: 'none' }))
  })
  // Pre-trust the host key: AI sessions never get to accept unknown keys silently.
  const { connectSsh } = await import('../src/main/core/ssh')
  ;(await connectSsh(sshHost(srv.port), { vault, prompter, interactive: true })).end()
  service = new McpService({ vault, prompter, audit, version: 'test', editor: fakeEditor })
  http = new McpHttpServer({
    vault,
    service,
    settings: () => ({ ...DEFAULT_SETTINGS, mcpTokenHash: sha256Hex(TOKEN) })
  })
  port = 40000 + Math.floor(Math.random() * 20000)
  await http.start(port)
})

afterAll(async () => {
  service.shutdown()
  await http.stop()
  await srv.close()
})

beforeEach(() => {
  prompter.allow = true
  prompter.confirmCalls = []
})

describe('MCP HTTP security', () => {
  it('rejects missing/wrong tokens, browser origins and foreign Host headers', async () => {
    expect(await rawPost({})).toBe(401)
    expect(await rawPost({ authorization: 'Bearer nope' })).toBe(401)
    expect(await rawPost({ authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })).toBe(403)
    expect(await rawPost({ authorization: `Bearer ${TOKEN}`, host: `evil.example:${port}` })).toBe(403)
    await expect(client('wrong-token')).rejects.toThrow()
  })
})

describe('MCP tools for screens and Docker', () => {
  it('need full access, also for looking, and never reach hosts that are not shared', async () => {
    const c = await client()
    for (const [name, args] of [
      ['screen_list', {}],
      ['screen_read', { screen: 'minecraft' }],
      ['screen_send', { screen: 'minecraft', text: 'stop' }],
      ['docker_list', {}],
      ['docker_logs', { container: 'web' }],
      ['docker_container_action', { container: 'web', action: 'stop' }]
    ] as const) {
      const readOnly = await c.callTool({ name, arguments: { host: 'readonly-box', ...args } })
      expect(readOnly.isError, name).toBe(true)
      expect(textOf(readOnly), name).toMatch(/read-only/)
      const hidden = await c.callTool({ name, arguments: { host: 'secret-box', ...args } })
      expect(textOf(hidden), name).toMatch(/Unknown host/)
    }
    expect(prompter.confirmCalls).toHaveLength(0) // nothing was even asked
    await c.close()
  })

  it('ask the user before anything is typed into a screen or a container is stopped', async () => {
    const c = await client()
    prompter.allow = false
    expect(textOf(await c.callTool({ name: 'screen_send', arguments: { host: 'test-box', screen: 'minecraft', text: 'stop' } }))).toMatch(/denied/)
    expect(textOf(await c.callTool({ name: 'docker_container_action', arguments: { host: 'test-box', container: 'web', action: 'stop' } }))).toMatch(/denied/)
    expect(prompter.confirmCalls.map((x) => x.tool)).toEqual(['screen_send', 'docker_container_action'])
    expect(prompter.confirmCalls[0].detail).toBe('stop')
    // removing containers is not among the actions an AI client may ask for
    const r = await c.callTool({ name: 'docker_container_action', arguments: { host: 'test-box', container: 'web', action: 'remove' } }).catch((e: Error) => e)
    expect(JSON.stringify(r instanceof Error ? r.message : r)).toMatch(/Invalid|invalid/)
    await c.close()
  })
})

describe('MCP tools', () => {
  it('lists only hosts shared with AI', async () => {
    const c = await client()
    const tools = await c.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [
        'delete_path',
        'docker_container_action',
        'docker_list',
        'docker_logs',
        'editor_edit_file',
        'editor_list_open_files',
        'editor_open_file',
        'editor_read_file',
        'file_info',
        'list_directory',
        'list_hosts',
        'make_directory',
        'read_file',
        'rename_path',
        'run_command',
        'screen_list',
        'screen_read',
        'screen_send',
        'write_file'
      ].sort()
    )
    const hosts = JSON.parse(textOf(await c.callTool({ name: 'list_hosts', arguments: {} })))
    expect(hosts.map((h: { name: string }) => h.name)).toEqual(['test-box', 'readonly-box'])
    expect(JSON.stringify(hosts)).not.toContain('correct horse')
    await c.close()
  })

  it('runs commands only after confirmation', async () => {
    const c = await client()
    const ok = await c.callTool({ name: 'run_command', arguments: { host: 'test-box', command: 'whoami' } })
    expect(textOf(ok)).toContain('ran: whoami')
    expect(textOf(ok)).toContain('exit_code: 3')
    expect(prompter.confirmCalls).toEqual([{ tool: 'run_command', detail: 'whoami' }])

    prompter.allow = false
    const denied = await c.callTool({ name: 'run_command', arguments: { host: 'test-box', command: 'rm -rf /' } })
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toMatch(/denied/)
    await c.close()
  })

  it('enforces read-only and hidden hosts', async () => {
    const c = await client()
    const r = await c.callTool({ name: 'run_command', arguments: { host: 'readonly-box', command: 'id' } })
    expect(r.isError).toBe(true)
    expect(textOf(r)).toMatch(/read-only/)
    const hidden = await c.callTool({ name: 'list_directory', arguments: { host: 'secret-box' } })
    expect(textOf(hidden)).toMatch(/Unknown host/)
    const ls = await c.callTool({ name: 'list_directory', arguments: { host: 'readonly-box', path: '/' } })
    expect(ls.isError).toBeFalsy()
    expect(prompter.confirmCalls).toHaveLength(0) // read-only host with confirmation "none"
    await c.close()
  })

  it('writes, reads and deletes files; refuses deleting /', async () => {
    const c = await client()
    await c.callTool({ name: 'write_file', arguments: { host: 'h1', path: '/notes.txt', content: 'hi from ai' } })
    const read = await c.callTool({ name: 'read_file', arguments: { host: 'h1', path: '/notes.txt' } })
    expect(textOf(read)).toBe('hi from ai')
    const again = await c.callTool({ name: 'write_file', arguments: { host: 'h1', path: '/notes.txt', content: 'x' } })
    expect(again.isError).toBe(true)
    const root = await c.callTool({ name: 'delete_path', arguments: { host: 'h1', path: '/', recursive: true } })
    expect(textOf(root)).toMatch(/Refusing/)
    const del = await c.callTool({ name: 'delete_path', arguments: { host: 'h1', path: '/notes.txt' } })
    expect(del.isError).toBeFalsy()
    const log = await audit.recent()
    expect(log.some((e) => e.action === 'delete_path' && e.result === 'ok')).toBe(true)
    await c.close()
  })

  it('works on files open in the editor without saving them, under the same access rules', async () => {
    const c = await client()
    editorFiles.set('h3|/secret.conf', { text: 'x', saved: 'x' }) // open on a host that is NOT shared with AI

    await c.callTool({ name: 'editor_open_file', arguments: { host: 'test-box', path: '/etc/app.conf' } })
    const list = textOf(await c.callTool({ name: 'editor_list_open_files', arguments: {} }))
    expect(list).toContain('/etc/app.conf')
    expect(list).not.toContain('secret.conf')

    // editing needs full access and, with the default setting, the user's approval
    prompter.confirmCalls = []
    const edited = await c.callTool({ name: 'editor_edit_file', arguments: { host: 'test-box', path: '/etc/app.conf', old_text: 'port = 80', new_text: 'port = 8080' } })
    expect(textOf(edited)).toMatch(/not saved yet/)
    expect(prompter.confirmCalls[0]).toMatchObject({ tool: 'editor_edit_file' })
    expect(prompter.confirmCalls[0].detail).toContain('- port = 80')
    const read = textOf(await c.callTool({ name: 'editor_read_file', arguments: { host: 'test-box', path: '/etc/app.conf' } }))
    expect(read).toContain('port = 8080')
    expect(read).toContain('not saved to the server')

    // text that does not match, or matches several times, changes nothing
    const missing = await c.callTool({ name: 'editor_edit_file', arguments: { host: 'test-box', path: '/etc/app.conf', old_text: 'nope', new_text: 'x' } })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toMatch(/not found/)
    const noTarget = await c.callTool({ name: 'editor_edit_file', arguments: { host: 'test-box', path: '/etc/app.conf', new_text: 'x' } })
    expect(textOf(noTarget)).toMatch(/Give old_text/)

    prompter.allow = false
    const denied = await c.callTool({ name: 'editor_edit_file', arguments: { host: 'test-box', path: '/etc/app.conf', new_text: 'wiped', replace_entire_file: true } })
    expect(textOf(denied)).toMatch(/denied/)
    expect(editorFiles.get('h1|/etc/app.conf')?.text).toContain('port = 8080')
    prompter.allow = true

    // read-only host: may read the editor, may not change it; hidden host: nothing at all
    await c.callTool({ name: 'editor_open_file', arguments: { host: 'readonly-box', path: '/ro.conf' } })
    expect(textOf(await c.callTool({ name: 'editor_read_file', arguments: { host: 'readonly-box', path: '/ro.conf' } }))).toContain('port = 80')
    const ro = await c.callTool({ name: 'editor_edit_file', arguments: { host: 'readonly-box', path: '/ro.conf', old_text: 'port', new_text: 'x' } })
    expect(textOf(ro)).toMatch(/read-only/)
    expect(textOf(await c.callTool({ name: 'editor_read_file', arguments: { host: 'secret-box', path: '/secret.conf' } }))).toMatch(/Unknown host/)
    await c.close()
  })

  it('refuses tool use while the vault is locked but still authenticates via the token hash', async () => {
    vault.lock()
    try {
      const c = await client()
      const r = await c.callTool({ name: 'list_hosts', arguments: {} })
      expect(textOf(r)).toMatch(/locked/)
      await c.close()
    } finally {
      await vault.unlock(MASTER)
    }
  })

  it.runIf(process.platform === 'win32' && existsSync(BRIDGE_EXE))('works through the stdio bridge (clavium-mcp.exe)', async () => {
    const child = spawn(BRIDGE_EXE, [], {
      env: { ...process.env, CLAVIUM_MCP_TOKEN: TOKEN, CLAVIUM_MCP_URL: `http://127.0.0.1:${port}/mcp` },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    const input = child.stdin
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test', version: '1' } }
      }) + '\n'
    )
    input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 'call-3', method: 'tools/call', params: { name: 'run_command', arguments: { host: 'test-box', command: 'echo bridged' } } }) + '\n')
    input.end()
    const code = await new Promise<number | null>((r) => child.on('exit', r))
    expect(code).toBe(0)
    // stdout must contain nothing but JSON-RPC lines
    const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(msgs.find((m) => m.id === 1).result.serverInfo.name).toBe('clavium')
    expect(msgs.find((m) => m.id === 2).result.tools.length).toBe(19)
    expect(JSON.stringify(msgs.find((m) => m.id === 'call-3'))).toContain('ran: echo bridged')

    // wrong token: the 401 reply is mapped back onto the request id
    const bad = spawn(BRIDGE_EXE, [], {
      env: { ...process.env, CLAVIUM_MCP_TOKEN: 'nope', CLAVIUM_MCP_URL: `http://127.0.0.1:${port}/mcp` },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let badOut = ''
    bad.stdout.on('data', (d: Buffer) => (badOut += d.toString('utf8')))
    bad.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n')
    await new Promise((r) => bad.on('exit', r))
    const err = JSON.parse(badOut.trim())
    expect(err.id).toBe(7)
    expect(err.error.message).toMatch(/Unauthorized/)
  })
})
