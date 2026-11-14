// Drives the real Electron app: vault, host editor, terminal, SFTP, MCP approval flow,
// stdio bridge and locking. Run with `npm run test:e2e` (builds first).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTestSshServer, TEST_PASSWORD, TEST_USER, type TestSshServer } from '../helpers/testServer'

const root = resolve(__dirname, '../..')
const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const shots = join(root, 'docs', 'screenshots')
const MASTER = 'e2e master password 123'

let srv: TestSshServer
let app: ElectronApplication
let page: Page
let dataDir: string
const mcpPort = 41000 + Math.floor(Math.random() * 9000)

async function shot(name: string): Promise<void> {
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(shots, `${name}.png`) })
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true })
  srv = await startTestSshServer()
  writeFileSync(join(srv.root, 'readme.txt'), 'Hello from the test server\n')
  mkdirSync(join(srv.root, 'www'))
  dataDir = mkdtempSync(join(tmpdir(), 'clavium-e2e-'))
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: { ...process.env, CLAVIUM_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
})

afterEach(async (ctx) => {
  if (ctx.task.result?.state === 'fail' && page) {
    const name = ctx.task.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 60)
    await page.screenshot({ path: join(tmpdir(), `clavium-e2e-FAIL-${name}.png`) }).catch(() => undefined)
  }
})

afterAll(async () => {
  await app?.close()
  await srv?.close()
})

describe('Clavium desktop app', () => {
  it('creates the vault', async () => {
    await page.getByText('Welcome to Clavium').waitFor()
    await page.getByPlaceholder('Master password', { exact: true }).fill(MASTER)
    await page.getByPlaceholder('Repeat master password').fill(MASTER)
    await shot('01-create-vault')
    await page.getByRole('button', { name: 'Create vault' }).click()
    await page.getByRole('heading', { name: 'Hosts' }).waitFor()
  })

  it('adds an SSH host with AI access', async () => {
    await page.getByRole('button', { name: 'New host' }).click()
    await page.getByLabel('Name', { exact: true }).fill('e2e-box')
    await page.getByLabel('Group', { exact: true }).fill('Test lab')
    await page.getByLabel('Host name / IP', { exact: true }).fill('127.0.0.1')
    await page.getByLabel('Port', { exact: true }).fill(String(srv.port))
    await page.getByLabel('User', { exact: true }).fill(TEST_USER)
    await page.getByLabel(/^Password/).fill(TEST_PASSWORD)
    await page.getByRole('button', { name: 'Full (commands + files)' }).click()
    expect(await page.getByRole('button', { name: 'Full (commands + files)' }).getAttribute('class')).toContain('on')
    await shot('02-host-editor')
    await page.getByRole('button', { name: 'Save' }).click()
    await page.locator('.host-card', { hasText: 'e2e-box' }).waitFor()
    await shot('03-hosts')
  })

  it('opens a terminal after verifying the host key', async () => {
    await page.locator('.host-card', { hasText: 'e2e-box' }).getByRole('button', { name: 'Terminal' }).click()
    await page.getByText('Unknown host key').waitFor()
    await shot('04-host-key')
    await page.getByRole('button', { name: 'Trust and connect' }).click()
    await page.locator('.xterm-rows', { hasText: 'Welcome to the Clavium test server' }).waitFor()
    await page.keyboard.type('hello clavium')
    await page.keyboard.press('Enter')
    await page.locator('.xterm-rows', { hasText: 'echo:hello clavium' }).waitFor()
    await shot('05-terminal')
  })

  it('browses files over SFTP', async () => {
    await page.locator('.tab').first().click()
    await page.locator('.host-card', { hasText: 'e2e-box' }).getByRole('button', { name: 'SFTP' }).click()
    await page.locator('.file-list td', { hasText: 'readme.txt' }).waitFor()
    await expect(page.locator('.file-list td', { hasText: 'www' }).count()).resolves.toBe(1)
    await shot('06-sftp')
  })

  let token = ''
  let url = ''

  it('enables the MCP server and shows the client configuration', async () => {
    await page.locator('.tab').first().click()
    await page.getByRole('button', { name: 'AI / MCP' }).click()
    await page.getByLabel('Port', { exact: true }).fill(String(mcpPort))
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.getByRole('switch', { name: 'Enable MCP server' }).click()
    await page.getByText('running').first().waitFor()
    await page.getByRole('button', { name: 'Show configuration' }).click()
    await page.locator('.code').first().waitFor()
    await shot('07-mcp')
    await page.getByRole('button', { name: 'Other' }).click()
    await page.getByRole('button', { name: 'Show token' }).click()
    const text = await page.locator('.code').first().innerText()
    token = /Bearer (clv_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? ''
    url = /URL:\s+(\S+)/.exec(text)?.[1] ?? ''
    expect(token).toMatch(/^clv_/)
    expect(url).toBe(`http://127.0.0.1:${mcpPort}/mcp`)
    // Back to the masked, path-free view so later screenshots contain no secrets or local paths.
    await page.getByRole('button', { name: 'Hide token' }).click()
    await page.getByRole('button', { name: 'Claude Code' }).click()
    expect(await page.locator('.code').first().innerText()).not.toContain(token)
  })

  it('lets an MCP client run a command only after the user approves it', async () => {
    const c = new Client({ name: 'e2e', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const hosts = await c.callTool({ name: 'list_hosts', arguments: {} })
    expect(JSON.stringify(hosts)).toContain('e2e-box')

    const call = c.callTool({ name: 'run_command', arguments: { host: 'e2e-box', command: 'uptime' } })
    await page.getByText('AI request').waitFor()
    await shot('08-ai-approval')
    await page.getByRole('button', { name: 'Allow once' }).click()
    const result = (await call) as { content: { text: string }[] }
    expect(result.content[0].text).toContain('ran: uptime')

    const denied = c.callTool({ name: 'delete_path', arguments: { host: 'e2e-box', path: '/readme.txt' } })
    await page.getByText('AI request').waitFor()
    await page.getByRole('button', { name: 'Deny' }).click()
    expect(JSON.stringify(await denied)).toContain('denied')
    await c.close()

    await page.getByRole('button', { name: 'Activity' }).click()
    await page.locator('table.list td', { hasText: 'run_command' }).waitFor()
    await shot('09-activity')
  })

  it('serves MCP over stdio through the installed bridge (bin/clavium-mcp.exe)', async () => {
    // The app copies the bridge into its data directory on start; that is the path shown to users.
    const bridge = join(dataDir, 'bin', 'clavium-mcp.exe')
    expect(existsSync(bridge)).toBe(true)
    const child = spawn(bridge, [], {
      env: { ...process.env, CLAVIUM_DATA_DIR: dataDir, CLAVIUM_MCP_TOKEN: token },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-e2e', version: '1' } } }) + '\n'
    )
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    child.stdin.end()
    const code = await new Promise<number | null>((r) => child.on('exit', r))
    const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(code).toBe(0)
    expect(msgs.find((m) => m.id === 1)?.result?.serverInfo?.name).toBe('clavium')
    expect(msgs.find((m) => m.id === 2)?.result?.tools?.length).toBe(9)
  })

  it('locks the vault', async () => {
    await page.getByRole('button', { name: 'Lock' }).click()
    await page.getByText('Clavium is locked').waitFor()
    await shot('10-locked')
  })
})
