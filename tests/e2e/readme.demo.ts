// Records the animation at the top of the README (docs/demo.gif) in the real app, against the
// test server: suggestions in the terminal, several connections in one tab, focus mode and the
// question before an AI runs a command. Run with `npm run demo`; needs ffmpeg in the PATH.
// Not a test: the file name keeps it out of `npm run test:e2e`.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTestSshServer, TEST_PASSWORD, TEST_USER, type TestSshServer } from '../helpers/testServer'
import { freePort } from '../helpers/fixtures'

const root = resolve(__dirname, '../..')
const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const MASTER = 'demo master password 123'
/** width of the animation; the window is recorded at 1280 by 800 */
const WIDTH = 960

let srv: TestSshServer
let app: ElectronApplication
let page: Page
let dataDir: string
let frameDir: string
const frames: { file: string; ms: number }[] = []

const panes = (): Locator => page.locator('.pane:not(.hidden)')
const view = (): Locator => page.locator('.view:not(.hidden)')
const sidebar = (): Locator => page.locator('.sidebar')
const terminal = (pane: Locator, text: string): Locator => pane.locator('.xterm-rows', { hasText: text })

/** One picture of the window, shown for `ms` milliseconds. */
async function frame(ms: number): Promise<void> {
  const file = join(frameDir, `${String(frames.length).padStart(4, '0')}.png`)
  await page.screenshot({ path: file })
  frames.push({ file, ms })
}

/** Types into the focused terminal, one picture per key. */
async function type(pane: Locator, text: string, shownBefore: string): Promise<void> {
  let shown = shownBefore
  for (const ch of text) {
    await page.keyboard.type(ch)
    shown += ch
    await terminal(pane, shown).waitFor()
    await frame(90)
  }
}

async function addHost(name: string, group: string, ai: string): Promise<void> {
  await page.getByRole('button', { name: /New Host|Add a Host/ }).first().click()
  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('Name', { exact: true }).fill(name)
  await sheet.getByLabel('Group', { exact: true }).fill(group)
  await sheet.getByLabel('Host', { exact: true }).fill('127.0.0.1')
  await sheet.getByLabel('Port', { exact: true }).fill(String(srv.port))
  await sheet.getByLabel('User', { exact: true }).fill(TEST_USER)
  await sheet.getByLabel(/^Password/).fill(TEST_PASSWORD)
  await sheet.getByLabel('Allow AI to', { exact: true }).selectOption(ai)
  await sheet.getByRole('button', { name: 'Save' }).click()
  await page.locator('.host-row', { hasText: name }).waitFor()
}

beforeAll(async () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) throw new Error('ffmpeg is needed to write the animation and was not found in the PATH')
  srv = await startTestSshServer()
  srv.onExec = (command) => {
    if (command.includes('__clavium_ctx__')) return '__clavium_ctx__\nbash\n/srv/www\n/home/tester\n'
    if (command.includes('for d in $PATH')) return 'git\ngrep\nls\ncat\n'
    if (command.includes('git branch')) return 'main\nfeature/login\n'
    if (command.includes('ls -1Ap') || command.includes('_history')) return ''
    return undefined
  }
  srv.onLine = (line) => (line.trim() === 'git checkout feature/login' ? "Switched to branch 'feature/login'" : undefined)
  dataDir = mkdtempSync(join(tmpdir(), 'clavium-demo-'))
  frameDir = mkdtempSync(join(tmpdir(), 'clavium-demo-frames-'))
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: { ...process.env, CLAVIUM_DATA_DIR: dataDir, CLAVIUM_NO_NOTIFICATIONS: '1', CLAVIUM_NO_AUTOLOCK: '1', CLAVIUM_NO_EXTERNAL_EDITOR: '1', ELECTRON_RENDERER_URL: '' }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light' })
})

afterAll(async () => {
  await app?.close()
  await srv?.close()
  if (frameDir) rmSync(frameDir, { recursive: true, force: true })
})

describe('the animation of the README', () => {
  it('records docs/demo.gif', async () => {
    // --- not recorded: a vault, two hosts, the MCP server ---
    await page.getByText('Welcome to Clavium').waitFor()
    await page.getByLabel('Master password', { exact: true }).fill(MASTER)
    await page.getByLabel('Repeat master password').fill(MASTER)
    await page.getByRole('button', { name: 'Create Vault' }).click()
    await page.getByText('No Hosts Yet').waitFor()
    await addHost('web-01', 'Production', 'full')
    await addHost('db-01', 'Production', 'read')

    const mcpPort = await freePort()
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
    const token = /Bearer (clv_[A-Za-z0-9_-]+)/.exec(await config.innerText())?.[1] ?? ''
    expect(token).toMatch(/^clv_/)
    await view().getByRole('button', { name: 'Hide Token' }).click()
    const ai = new Client({ name: 'demo', version: '1' })
    await ai.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))

    await sidebar().getByRole('button', { name: 'Hosts', exact: true }).click()
    await page.locator('.host-row', { hasText: 'web-01' }).click()
    await view().getByRole('button', { name: 'Connect' }).click()
    await page.getByRole('button', { name: 'Trust and Connect' }).click()
    await terminal(panes(), 'Welcome to the Clavium test server').waitFor()

    // --- 1. suggestions while typing ---
    const list = page.getByRole('listbox', { name: 'Suggestions' })
    await frame(900)
    await type(panes(), 'git che', '$ ')
    await list.getByRole('option', { name: /^checkout/ }).waitFor()
    await frame(1300)
    await page.keyboard.press('Tab')
    await terminal(panes(), '$ git checkout ').waitFor()
    await frame(450)
    await type(panes(), 'fe', '$ git checkout ')
    await list.getByRole('option', { name: 'feature/login' }).waitFor()
    await frame(1100)
    await page.keyboard.press('Tab')
    await terminal(panes(), '$ git checkout feature/login ').waitFor()
    // the list offers what could follow; Escape puts it away (only while it is open, or the key goes to the shell)
    await page.waitForTimeout(400)
    if (await list.count()) await page.keyboard.press('Escape')
    await expect.poll(() => list.count()).toBe(0)
    await frame(500)
    await page.keyboard.press('Enter')
    await terminal(panes(), "Switched to branch 'feature/login'").waitFor()
    await frame(1200)

    // --- 2. several connections in one tab ---
    await panes().getByRole('button', { name: 'Split View and Workspace' }).click()
    const toTheRight = page.locator('.menu button', { hasText: 'Terminal to the Right' })
    await toTheRight.waitFor()
    await page.waitForTimeout(300) // the menu fades in
    await frame(900)
    await toTheRight.click()
    await expect.poll(() => panes().count()).toBe(2)
    await terminal(panes().nth(1), 'Welcome to the Clavium test server').waitFor()
    await frame(800)
    await panes().nth(1).getByRole('button', { name: 'Split View and Workspace' }).click()
    await page.locator('.menu button', { hasText: 'Another Host Below' }).click()
    const picker = page.getByRole('dialog')
    await picker.getByLabel('Search hosts').fill('db')
    await picker.getByRole('button', { name: /db-01/ }).waitFor()
    await page.waitForTimeout(300)
    await frame(900)
    await picker.getByRole('button', { name: /db-01/ }).click()
    await expect.poll(() => panes().count()).toBe(3)
    await terminal(panes().nth(2), 'Welcome to the Clavium test server').waitFor()
    await frame(1500)

    // --- 3. focus mode ---
    await panes().nth(0).locator('.xterm').click()
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    await expect.poll(() => panes().count()).toBe(1)
    await frame(1300)
    await panes().getByRole('button', { name: /Leave Focus Mode/ }).click()
    await expect.poll(() => panes().count()).toBe(3)
    await frame(900)

    // --- 4. an AI asks before it runs a command ---
    const call = ai.callTool({ name: 'run_command', arguments: { host: 'web-01', command: 'sudo systemctl restart nginx' } })
    await page.getByText(/AI request/).waitFor()
    await page.waitForTimeout(300)
    await frame(2600)
    await page.getByRole('button', { name: 'Allow Once' }).click()
    expect(JSON.stringify(await call)).toContain('ran: sudo systemctl restart nginx')
    await page.getByText(/AI request/).waitFor({ state: 'detached' })
    await frame(1400)
    await ai.close()

    // --- the pictures become one file ---
    const listFile = join(frameDir, 'frames.txt')
    const quoted = (file: string): string => `file '${file.replace(/\\/g, '/')}'`
    writeFileSync(listFile, [...frames.map((f) => `${quoted(f.file)}\nduration ${(f.ms / 1000).toFixed(3)}`), quoted(frames[frames.length - 1].file), ''].join('\n'))
    const out = join(root, 'docs', 'demo.gif')
    const filter = `fps=12,scale=${WIDTH}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`
    const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-vf', filter, '-loop', '0', out], { encoding: 'utf8' })
    expect(made.stderr).toBe('')
    expect(made.status).toBe(0)
  })
})
