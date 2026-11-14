// Drives the real Electron app: vault, host editor, terminal, SFTP, MCP approval flow,
// stdio bridge and locking. Run with `npm run test:e2e` (builds first).
// It also regenerates the screenshots in docs/screenshots (light, plus a few dark ones).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTestSshServer, TEST_PASSWORD, TEST_USER, type TestSshServer } from '../helpers/testServer'

const root = resolve(__dirname, '../..')
const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const shots = join(root, 'docs', 'screenshots')
const MASTER = 'e2e master password 123'
const HOST = 'web-01'

let srv: TestSshServer
let app: ElectronApplication
let page: Page
let dataDir: string
const mcpPort = 41000 + Math.floor(Math.random() * 9000)

async function shot(name: string, alsoDark = false): Promise<void> {
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(shots, `${name}.png`) })
  if (alsoDark) {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(shots, `${name}-dark.png`) })
    await page.emulateMedia({ colorScheme: 'light' })
  }
}

/** The view that is currently visible (library page or a session). */
const view = (): Locator => page.locator('.view:not(.hidden)')
const sidebar = (): Locator => page.locator('.sidebar')

async function addHost(o: { name: string; group: string; user?: string; protocol?: string; ai?: string }): Promise<void> {
  await page.getByRole('button', { name: /New Host|Add a Host/ }).first().click()
  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('Name', { exact: true }).fill(o.name)
  await sheet.getByLabel('Group', { exact: true }).fill(o.group)
  if (o.protocol) await sheet.getByLabel('Protocol', { exact: true }).selectOption(o.protocol)
  await sheet.getByLabel('Host', { exact: true }).fill('127.0.0.1')
  await sheet.getByLabel('Port', { exact: true }).fill(String(srv.port))
  await sheet.getByLabel('User', { exact: true }).fill(o.user ?? TEST_USER)
  await sheet.getByLabel(/^Password/).fill(TEST_PASSWORD)
  if (o.ai) await sheet.getByLabel('Allow AI to', { exact: true }).selectOption(o.ai)
  if (o.name === HOST) await shot('02-host-editor')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await page.locator('.host-row', { hasText: o.name }).waitFor()
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true })
  srv = await startTestSshServer()
  writeFileSync(join(srv.root, 'readme.txt'), 'Hello from the test server\n')
  writeFileSync(join(srv.root, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx:stable\n')
  writeFileSync(join(srv.root, 'backup-2026-11-01.tar.gz'), Buffer.alloc(48_211))
  for (const dir of ['www', 'logs', 'scripts']) mkdirSync(join(srv.root, dir))
  dataDir = mkdtempSync(join(tmpdir(), 'clavium-e2e-'))
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: { ...process.env, CLAVIUM_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '' }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light' })
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
    await page.getByLabel('Master password', { exact: true }).fill(MASTER)
    await page.getByLabel('Repeat master password').fill(MASTER)
    await shot('01-create-vault')
    await page.getByRole('button', { name: 'Create Vault' }).click()
    await page.getByText('No Hosts Yet').waitFor()
  })

  it('adds hosts and shows their details', async () => {
    await addHost({ name: HOST, group: 'Production', ai: 'full' })
    await addHost({ name: 'db-01', group: 'Production', user: 'postgres', ai: 'read' })
    await addHost({ name: 'staging', group: 'Staging', user: 'deploy' })
    await addHost({ name: 'legacy-share', group: 'Staging', user: 'ftpuser', protocol: 'ftp' })

    await page.locator('.host-row', { hasText: HOST }).click()
    await view().getByRole('heading', { name: HOST }).waitFor()
    expect(await view().getByRole('button', { name: 'Full Access' }).getAttribute('aria-pressed')).toBe('true')
    await shot('03-hosts', true)
  })

  it('opens a terminal after verifying the host key', async () => {
    await view().getByRole('button', { name: 'Connect' }).click()
    await page.getByText('Verify Host Key').waitFor()
    await shot('04-host-key')
    await page.getByRole('button', { name: 'Trust and Connect' }).click()
    await view().locator('.xterm-rows', { hasText: 'Welcome to the Clavium test server' }).waitFor()
    await page.keyboard.type('hello clavium')
    await page.keyboard.press('Enter')
    await view().locator('.xterm-rows', { hasText: 'echo:hello clavium' }).waitFor()
    await shot('05-terminal', true)
  })

  it('browses files over SFTP from the terminal session', async () => {
    await view().getByRole('button', { name: 'Browse Files' }).click()
    await view().locator('.table td', { hasText: 'readme.txt' }).waitFor()
    expect(await view().locator('.table td.name', { hasText: 'www' }).count()).toBe(1)
    await view().locator('.table tr', { hasText: 'docker-compose.yml' }).click()
    await shot('06-sftp', true)
    // both sessions are listed in the sidebar
    expect(await sidebar().locator('.side-item', { hasText: HOST }).count()).toBe(2)
  })

  let token = ''
  let url = ''

  it('enables the MCP server and shows the client configuration', async () => {
    await sidebar().getByRole('button', { name: /AI Access/ }).click()
    await view().getByRole('switch', { name: 'MCP Server' }).click()
    await view().getByText(/Running on 127\.0\.0\.1/).waitFor()
    const port = view().getByLabel(/^Port/)
    await port.fill(String(mcpPort))
    await port.press('Enter')
    await view().getByText(`Running on 127.0.0.1:${mcpPort}`).waitFor()

    const config = view().getByTestId('mcp-config')
    await view().getByRole('button', { name: 'Other' }).click()
    await view().getByRole('button', { name: 'Show Token' }).click()
    await expect.poll(() => config.innerText()).toContain(`:${mcpPort}/mcp`)
    const text = await config.innerText()
    token = /Bearer (clv_[A-Za-z0-9_-]+)/.exec(text)?.[1] ?? ''
    url = /URL:\s+(\S+)/.exec(text)?.[1] ?? ''
    expect(token).toMatch(/^clv_/)
    expect(url).toBe(`http://127.0.0.1:${mcpPort}/mcp`)

    // Back to the masked, path-free view so screenshots contain no secrets or local paths.
    await view().getByRole('button', { name: 'Hide Token' }).click()
    await view().getByRole('button', { name: 'Claude Code' }).click()
    expect(await config.innerText()).not.toContain(token)
    await shot('07-ai-access', true)
  })

  it('lets an MCP client run a command only after the user approves it', async () => {
    const c = new Client({ name: 'e2e', version: '1' })
    await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const hosts = JSON.stringify(await c.callTool({ name: 'list_hosts', arguments: {} }))
    expect(hosts).toContain(HOST)
    expect(hosts).toContain('db-01')
    expect(hosts).not.toContain('staging') // not shared with AI

    const call = c.callTool({ name: 'run_command', arguments: { host: HOST, command: 'sudo systemctl restart nginx' } })
    await page.getByText(/AI request/).waitFor()
    await shot('08-ai-approval', true)
    await page.getByRole('button', { name: 'Allow Once' }).click()
    const result = (await call) as { content: { text: string }[] }
    expect(result.content[0].text).toContain('ran: sudo systemctl restart nginx')

    const denied = c.callTool({ name: 'delete_path', arguments: { host: HOST, path: '/readme.txt' } })
    await page.getByText(/AI request/).waitFor()
    await page.getByRole('button', { name: 'Deny' }).click()
    expect(JSON.stringify(await denied)).toContain('denied')

    // read-only host: commands are refused without even asking
    const refused = JSON.stringify(await c.callTool({ name: 'run_command', arguments: { host: 'db-01', command: 'id' } }))
    expect(refused).toContain('read-only')
    await c.close()

    await sidebar().getByRole('button', { name: 'Activity' }).click()
    await view().locator('.item', { hasText: 'run_command' }).first().waitFor()
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

  it('shows keys, known hosts and settings, then locks the vault', async () => {
    await sidebar().getByRole('button', { name: 'Keys' }).click()
    await view().getByRole('button', { name: 'Generate a Key' }).click()
    await page.getByRole('dialog').getByLabel('Name', { exact: true }).fill('Laptop 2026')
    await page.getByRole('dialog').getByRole('button', { name: 'Generate' }).click()
    await view().locator('.item', { hasText: 'Laptop 2026' }).waitFor()
    await shot('10-keys')

    await sidebar().getByRole('button', { name: 'Known Hosts' }).click()
    await view().locator('.item', { hasText: `127.0.0.1:${srv.port}` }).waitFor()

    await sidebar().getByRole('button', { name: 'Settings' }).click()
    await view().getByText('Lock automatically').waitFor()
    await shot('11-settings', true)

    // smallest supported window: layout must not break (checked by eye, not committed)
    await sidebar().getByRole('button', { name: 'Hosts', exact: true }).click()
    await page.setViewportSize({ width: 940, height: 600 })
    await page.waitForTimeout(200)
    await page.screenshot({ path: join(tmpdir(), 'clavium-min-window.png') })
    await page.setViewportSize({ width: 1280, height: 800 })

    await sidebar().getByRole('button', { name: /Lock Vault/ }).click()
    await page.getByText('Clavium Is Locked').waitFor()
    await shot('12-locked', true)
  })
})
