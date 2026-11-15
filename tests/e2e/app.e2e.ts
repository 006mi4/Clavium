// Drives the real Electron app: vault, host editor, terminal, SFTP, MCP approval flow,
// stdio bridge and locking. Run with `npm run test:e2e` (builds first).
// It also regenerates the screenshots in docs/screenshots (light, plus a few dark ones).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readClipboardFiles, writeClipboardFiles } from '../../src/main/winclipboard'
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
  writeFileSync(
    join(srv.root, 'docker-compose.yml'),
    ['# Web stack', 'services:', '  web:', '    image: nginx:stable', '    ports:', '      - "80:80"', '      - "443:443"', '    volumes:', '      - ./www:/usr/share/nginx/html:ro', '    restart: unless-stopped', '    environment:', '      TZ: Europe/Berlin', '      WORKERS: 4', ''].join('\n')
  )
  writeFileSync(join(srv.root, 'backup-2026-11-01.tar.gz'), Buffer.alloc(48_211))
  for (const dir of ['www', 'logs', 'scripts']) mkdirSync(join(srv.root, dir))
  dataDir = mkdtempSync(join(tmpdir(), 'clavium-e2e-'))
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: { ...process.env, CLAVIUM_DATA_DIR: dataDir, CLAVIUM_NO_NOTIFICATIONS: '1', CLAVIUM_NO_AUTOLOCK: '1', ELECTRON_RENDERER_URL: '' }
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

  it('edits a file in the built-in editor and saves it to the server', async () => {
    const remoteFile = join(srv.root, 'docker-compose.yml')
    await view().locator('.table tr', { hasText: 'docker-compose.yml' }).dblclick()
    const area = view().getByLabel('Contents of docker-compose.yml')
    await area.waitFor()
    expect(await area.inputValue()).toContain('image: nginx:stable')
    // colored rendering: the YAML key is marked as a key, the comment as a comment
    expect(await view().locator('.editor-layer .t-a', { hasText: 'services' }).count()).toBe(1)
    expect(await view().locator('.editor-layer .t-c', { hasText: '# Web stack' }).count()).toBe(1)
    expect(await view().getByText('YAML', { exact: true }).count()).toBe(1)
    await shot('06b-editor', true)

    // --- editor shortcuts, in the real app ---
    const original = await area.inputValue()
    const lines = async (): Promise<string[]> => (await area.inputValue()).split('\n')

    await area.press('Control+g')
    await view().getByLabel('Go to line').fill('4')
    await page.keyboard.press('Enter')
    await view().getByText('Line 4, Column 1').waitFor()

    await page.keyboard.press('Control+d') // duplicate line
    expect((await lines()).filter((l) => l === '    image: nginx:stable')).toHaveLength(2)
    await page.keyboard.press('Control+z') // undo restores it
    expect(await area.inputValue()).toBe(original)

    await page.keyboard.press('Control+/') // comment / uncomment
    expect((await lines())[3]).toBe('    # image: nginx:stable')
    await page.keyboard.press('Control+/')
    expect(await area.inputValue()).toBe(original)

    await page.keyboard.press('Alt+ArrowDown') // move line down and back up
    expect((await lines()).slice(3, 5)).toEqual(['    ports:', '    image: nginx:stable'])
    await page.keyboard.press('Alt+ArrowUp')
    expect(await area.inputValue()).toBe(original)

    await page.keyboard.press('Control+l') // delete line
    expect(await lines()).not.toContain('    image: nginx:stable')
    await page.keyboard.press('Control+z')
    expect(await area.inputValue()).toBe(original)

    // find with match count, then replace all and undo it in one step
    await area.press('Control+Home') // search starts at the caret
    await page.keyboard.press('Control+h')
    await view().getByLabel('Find in file').fill('nginx')
    await view().getByText('2', { exact: true }).waitFor()
    expect(await view().locator('.editor-marks mark').count()).toBe(2)
    await page.keyboard.press('Enter')
    await view().getByText('1 of 2').waitFor()
    await page.keyboard.press('F3')
    await view().getByText('2 of 2').waitFor()
    await view().getByLabel('Replace with').fill('caddy')
    await shot('06c-editor-find', true)
    await view().getByRole('button', { name: 'Replace All' }).click()
    expect(await area.inputValue()).toBe(original.replaceAll('nginx', 'caddy'))
    await area.press('Control+z')
    expect(await area.inputValue()).toBe(original)

    // regular expressions and invalid input
    await view().getByRole('button', { name: 'Regular Expression' }).click()
    await view().getByLabel('Find in file').fill('"\\d+:\\d+"')
    await view().getByText('2', { exact: true }).waitFor()
    await view().getByLabel('Find in file').fill('(')
    await view().getByText(/Invalid expression/).waitFor()
    await page.keyboard.press('Escape')
    expect(await view().getByLabel('Find in file').count()).toBe(0)

    await view().getByRole('button', { name: 'More' }).click()
    await page.getByRole('menuitem', { name: 'Keyboard Shortcuts' }).click()
    await page.getByText('Duplicate line or selected lines').waitFor()
    await page.getByRole('button', { name: 'Done' }).click()

    // right-click menu in the text
    await area.click({ button: 'right', position: { x: 60, y: 70 } })
    await page.getByRole('menuitem', { name: 'Duplicate Line' }).click()
    expect((await lines()).length).toBe(original.split('\n').length + 1)
    await area.press('Control+z')
    expect(await area.inputValue()).toBe(original)

    // wrapping long lines keeps one number per real line
    await view().getByRole('button', { name: /Wrap Long Lines/ }).click()
    expect(await view().locator('.editor.wrap b[data-n]').count()).toBe(original.split('\n').length)
    await view().getByRole('button', { name: /Wrap Long Lines/ }).click()
    expect(await view().locator('.editor.wrap').count()).toBe(0)

    // language can be changed by hand
    await view().getByLabel('Language').selectOption('json')
    expect(await view().locator('.editor-layer .t-c').count()).toBe(0) // "#" is no comment in JSON
    await view().getByLabel('Language').selectOption('yaml')
    expect(await view().locator('.editor-layer .t-c', { hasText: '# Web stack' }).count()).toBe(1)

    // --- several files: tabs and split view ---
    await view().getByRole('button', { name: 'Back to Files' }).click()
    await view().getByRole('button', { name: /Editor · 1/ }).waitFor() // the open file is kept
    await view().locator('.table tr', { hasText: 'readme.txt' }).dblclick()
    await view().getByRole('tab', { name: /readme\.txt/ }).waitFor()
    expect(await view().getByRole('tab').count()).toBe(2)

    await view().getByRole('button', { name: /Split Editor/ }).click()
    expect(await view().locator('.ed-pane').count()).toBe(2)
    const both = view().getByLabel('Contents of readme.txt')
    expect(await both.count()).toBe(2) // the same file, side by side
    await both.nth(1).press('Control+End')
    await page.keyboard.type('typed in the right pane')
    const leftView = view().locator('.ed-pane').first().locator('.editor-layer pre').last()
    await expect.poll(() => leftView.innerText()).toContain('typed in the right pane') // both views show the same text
    // undo takes typed text back in chunks like any text field, not one character per step,
    // and keeps working while the file is open twice
    let undoSteps = 0
    while ((await both.nth(1).inputValue()).length > 'Hello from the test server'.length + 1 && undoSteps < 30) {
      await both.nth(1).press('Control+z')
      undoSteps++
    }
    expect(undoSteps).toBeLessThanOrEqual(6)
    expect(await both.nth(1).inputValue()).toBe('Hello from the test server\n')
    await expect.poll(() => leftView.innerText()).not.toContain('typed in the right pane')
    await both.nth(0).click() // switching sides brings the other text field up to date
    expect(await both.nth(0).inputValue()).toBe('Hello from the test server\n')

    await view().locator('.ed-pane').first().getByRole('tab', { name: /docker-compose/ }).click()
    await shot('06d-editor-split', true)
    await view().getByRole('button', { name: /Close Split/ }).click()
    expect(await view().locator('.ed-pane').count()).toBe(1)
    expect(await view().getByRole('tab').count()).toBe(2)
    await view().getByRole('tab', { name: /readme\.txt/ }).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click()
    expect(await view().getByRole('tab').count()).toBe(1)

    // --- new file from the file list ---
    await view().getByRole('button', { name: 'Back to Files' }).click()
    await view().getByRole('button', { name: 'New File' }).click()
    await page.getByRole('dialog').getByLabel('Name').fill('notes.md')
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
    const notes = view().getByLabel('Contents of notes.md')
    await notes.waitFor()
    await notes.click()
    await page.keyboard.type('# Notes')
    await page.keyboard.press('Control+s')
    await expect.poll(() => (existsSync(join(srv.root, 'notes.md')) ? readFileSync(join(srv.root, 'notes.md'), 'utf8') : '')).toBe('# Notes')
    await view().getByText('Saved', { exact: true }).waitFor()
    await page.keyboard.press('Control+w')
    await expect.poll(() => view().getByRole('tab').count()).toBe(1)

    // --- saving ---
    await area.click()
    await area.press('Control+End')
    await page.keyboard.type('      DEBUG: "false"')
    await view().getByText('Edited').waitFor()
    await page.keyboard.press('Control+s')
    await view().getByText('Saved', { exact: true }).waitFor()
    const onServer = readFileSync(remoteFile, 'utf8')
    expect(onServer.endsWith(['      WORKERS: 4', '      DEBUG: "false"'].join('\n'))).toBe(true)
    expect(onServer.includes('\r')).toBe(false)

    // a file changed behind our back is not overwritten without asking
    await page.keyboard.type(' # mine')
    writeFileSync(remoteFile, 'changed on the server by someone else')
    await page.keyboard.press('Control+s')
    await page.getByText('The File Changed on the Server').waitFor()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(readFileSync(remoteFile, 'utf8')).toBe('changed on the server by someone else')
    await view().getByText('This file changed on the server.').waitFor()

    // closing the session with unsaved text asks first
    await view().getByRole('button', { name: 'Back to Files' }).click()
    await view().getByRole('button', { name: 'Close Session' }).click()
    await page.getByText('Close and Discard Your Changes?').waitFor()
    await page.getByRole('button', { name: 'Cancel' }).click()

    // locking the vault closes the connection but keeps the unsaved text for after unlocking
    await sidebar().getByRole('button', { name: /Lock Vault/ }).click()
    await page.getByText('Clavium Is Locked').waitFor()
    await page.getByLabel('Master password', { exact: true }).fill(MASTER)
    await page.keyboard.press('Enter')
    await page.getByText('Clavium Is Locked').waitFor({ state: 'detached' })
    await sidebar().locator('.side-item', { hasText: HOST }).last().click()
    await view().getByRole('button', { name: /Editor · 1/ }).click()
    expect(await area.inputValue()).toContain('DEBUG: "false" # mine')
    await view().getByText('The connection to the server is closed.').waitFor()
    await view().getByRole('button', { name: 'Reconnect' }).click()
    await view().getByText('The connection to the server is closed.').waitFor({ state: 'detached' })

    // closing the tab with unsaved changes asks first
    await view().getByRole('button', { name: /Close docker-compose\.yml \(unsaved\)/ }).click()
    await page.getByText(/Discard Changes to/).waitFor()
    await page.getByRole('button', { name: 'Discard' }).click()
    await view().locator('.table td', { hasText: 'readme.txt' }).waitFor()

    // binary files are refused instead of being shown as garbage
    await view().locator('.table tr', { hasText: 'backup-2026-11-01.tar.gz' }).dblclick()
    await view().getByText(/binary file/).waitFor()
    await view().getByRole('button', { name: 'Close Tab' }).click()
    await view().locator('.table td', { hasText: 'readme.txt' }).waitFor()
  })

  it('cuts, copies, pastes and undoes in the file browser', async () => {
    const has = (...parts: string[]): boolean => existsSync(join(srv.root, ...parts))
    const until = async (what: () => boolean): Promise<void> => {
      for (let i = 0; i < 100 && !what(); i++) await page.waitForTimeout(50)
      expect(what()).toBe(true)
    }
    const row = (name: string) => view().locator('.table tr', { hasText: name })

    // cut with Ctrl+X, paste into another folder with Ctrl+V
    await row('readme.txt').click()
    await page.keyboard.press('Control+x')
    await view().locator('.table tr[data-cut]', { hasText: 'readme.txt' }).waitFor()
    await row('scripts').dblclick()
    await view().getByText('This Folder Is Empty').waitFor()
    await page.keyboard.press('Control+v')
    await row('readme.txt').waitFor()
    expect(has('scripts', 'readme.txt')).toBe(true)
    expect(has('readme.txt')).toBe(false)

    // the move can be taken back, with the button and with Ctrl+Z
    await view().getByRole('button', { name: 'Undo Move of “readme.txt”' }).click()
    await until(() => has('readme.txt') && !has('scripts', 'readme.txt'))
    expect(await view().getByRole('button', { name: 'Undo', exact: true }).isDisabled()).toBe(true)

    // copy through the context menu; the copy gets a numbered name instead of replacing anything
    await view().getByRole('button', { name: 'Enclosing Folder' }).click()
    await row('docker-compose.yml').click({ button: 'right' })
    await shot('06e-files-menu', true)
    await page.getByRole('menuitem', { name: /^Copy/ }).click()
    await view().locator('.file-area').click({ button: 'right', position: { x: 600, y: 420 } })
    await page.getByRole('menuitem', { name: /^Paste/ }).click()
    await row('docker-compose (2).yml').waitFor()
    expect(readFileSync(join(srv.root, 'docker-compose (2).yml'), 'utf8')).toBe(readFileSync(join(srv.root, 'docker-compose.yml'), 'utf8'))

    // renaming never replaces an existing file, and can be undone as well
    await row('docker-compose (2).yml').click()
    await page.keyboard.press('F2')
    await page.getByLabel('New name').fill('readme.txt')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByText(/already exists/).waitFor()
    await row('docker-compose (2).yml').click()
    await page.keyboard.press('F2')
    await page.getByLabel('New name').fill('compose-copy.yml')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await until(() => has('compose-copy.yml'))
    await view().locator('.file-area').focus()
    await page.keyboard.press('Control+z')
    await until(() => has('docker-compose (2).yml') && !has('compose-copy.yml'))

    // undoing the copy deletes it, after asking
    await page.keyboard.press('Control+z')
    await page.getByRole('button', { name: 'Delete Copies' }).click()
    await until(() => !has('docker-compose (2).yml'))
    expect(has('docker-compose.yml')).toBe(true)

    // files copied in Windows are uploaded with Ctrl+V; an existing name asks before replacing
    const local = mkdtempSync(join(tmpdir(), 'clavium-e2e-local-'))
    writeFileSync(join(local, 'from-windows.txt'), 'made on the PC')
    writeFileSync(join(local, 'readme.txt'), 'new readme from the PC')
    await writeClipboardFiles([join(local, 'from-windows.txt')]).catch(() => undefined)
    const clipboardWorks = (await readClipboardFiles().catch(() => [])).length === 1
    if (clipboardWorks) {
      await view().locator('.file-area').focus()
      await page.keyboard.press('Control+v')
      await until(() => has('from-windows.txt'))
      expect(readFileSync(join(srv.root, 'from-windows.txt'), 'utf8')).toBe('made on the PC')

      await writeClipboardFiles([join(local, 'readme.txt')])
      await page.keyboard.press('Control+v')
      await page.getByText('Replace “readme.txt”?').waitFor()
      await page.getByRole('button', { name: 'Cancel' }).click()
      expect(readFileSync(join(srv.root, 'readme.txt'), 'utf8')).toBe('Hello from the test server\n')
      await page.keyboard.press('Control+v')
      await page.getByRole('button', { name: 'Replace', exact: true }).click()
      await until(() => readFileSync(join(srv.root, 'readme.txt'), 'utf8') === 'new readme from the PC')
      writeFileSync(join(srv.root, 'readme.txt'), 'Hello from the test server\n')
      rmSync(join(srv.root, 'from-windows.txt'))

      // a file copied in the app lands on the Windows clipboard as a real file
      await row('docker-compose.yml').click()
      await page.keyboard.press('Control+c')
      let onClipboard: string[] = []
      for (let i = 0; i < 40 && onClipboard.length === 0; i++) {
        await page.waitForTimeout(250)
        onClipboard = (await readClipboardFiles()).filter((f) => f.endsWith('docker-compose.yml'))
      }
      expect(onClipboard).toHaveLength(1)
      // compared in one spelling: the temp folder of a CI runner comes in its short form (RUNNER~1)
      const spelled = (p: string): string => realpathSync.native(p).toLowerCase()
      expect(spelled(onClipboard[0]).startsWith(spelled(join(dataDir, 'transfer-tmp')))).toBe(true)
      expect(readFileSync(onClipboard[0], 'utf8')).toBe(readFileSync(join(srv.root, 'docker-compose.yml'), 'utf8'))
    }
    await view().getByRole('button', { name: 'Clear Finished' }).click().catch(() => undefined)
    await view().getByRole('button', { name: 'Reload' }).click()
    await row('readme.txt').waitFor()
  })

  it('sorts and filters the file list and changes permissions', async () => {
    const row = (name: string) => view().locator('.table tr', { hasText: name })
    const fileNames = async (): Promise<string[]> => (await view().locator('.table tbody td.name').allInnerTexts()).map((t) => t.trim())

    // folders stay on top; a click on a column sorts by it, a second click turns the order around
    expect((await fileNames()).slice(0, 3)).toEqual(['logs', 'scripts', 'www'])
    await view().getByRole('button', { name: 'Size' }).click()
    expect((await fileNames())[3]).toBe('backup-2026-11-01.tar.gz') // largest first
    await view().getByRole('button', { name: 'Name' }).click()
    await view().getByRole('button', { name: 'Name' }).click()
    const descending = await fileNames()
    expect(descending.slice(0, 3)).toEqual(['www', 'scripts', 'logs'])
    await view().getByRole('button', { name: 'Name' }).click()

    // Ctrl+F jumps to the filter; Escape clears it again
    await page.keyboard.press('Control+f')
    await page.keyboard.type('READ')
    expect(await fileNames()).toEqual(['readme.txt'])
    await page.keyboard.press('Control+f')
    await page.keyboard.type('zzz')
    await view().getByText('Nothing to Show').waitFor()
    await page.keyboard.press('Escape')
    await row('docker-compose.yml').waitFor()

    // permissions: the sheet starts from the current ones, the server gets the new mode
    await row('readme.txt').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Permissions…' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByLabel('Numeric permissions').fill('640')
    expect(await sheet.getByLabel('Owner: Write').isChecked()).toBe(true)
    expect(await sheet.getByLabel('Everyone: Read').isChecked()).toBe(false)
    await sheet.getByLabel('Everyone: Read').check()
    await shot('06f-files-permissions')
    await sheet.getByRole('button', { name: 'Apply' }).click()
    await page.getByText('Permissions of “readme.txt” changed.').waitFor()
    expect(srv.setstat.at(-1)).toEqual({ path: '/readme.txt', mode: 0o644 })
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

    // --- the editor through MCP: open a file, change it in the editor, nothing is saved ---
    const openedByAi = (await c.callTool({ name: 'editor_open_file', arguments: { host: HOST, path: '/readme.txt' } })) as { content: { text: string }[] }
    expect(openedByAi.content[0].text).toContain('Opened /readme.txt')
    expect(JSON.stringify(await c.callTool({ name: 'editor_list_open_files', arguments: {} }))).toContain('/readme.txt')

    const aiEdit = c.callTool({ name: 'editor_edit_file', arguments: { host: HOST, path: '/readme.txt', old_text: 'Hello from', new_text: 'Greetings from' } })
    await page.getByText(/AI request/).waitFor()
    await page.getByText('- Hello from').waitFor() // the approval shows what changes
    await page.getByRole('button', { name: 'Allow Once' }).click()
    expect(JSON.stringify(await aiEdit)).toContain('not saved yet')
    const viaEditor = JSON.stringify(await c.callTool({ name: 'editor_read_file', arguments: { host: HOST, path: '/readme.txt' } }))
    expect(viaEditor).toContain('Greetings from the test server')
    expect(viaEditor).toContain('not saved to the server')
    expect(readFileSync(join(srv.root, 'readme.txt'), 'utf8')).toBe('Hello from the test server\n') // the server file is untouched

    // the user sees the change in the editor, marked as made by an AI, and decides
    await sidebar().locator('.side-item', { hasText: HOST }).last().click()
    await view().getByText('An AI assistant changed this text.').waitFor()
    expect(await view().getByLabel('Contents of readme.txt').inputValue()).toBe('Greetings from the test server\n')
    await view().getByText('Edited').waitFor()
    await shot('08b-ai-editor', true)
    await view().getByRole('button', { name: 'Save', exact: true }).click()
    await view().getByText('Saved', { exact: true }).waitFor()
    expect(readFileSync(join(srv.root, 'readme.txt'), 'utf8')).toBe('Greetings from the test server\n')
    expect(await view().getByText('An AI assistant changed this text.').count()).toBe(0)

    // a read-only host may not change editor text
    const roEdit = JSON.stringify(await c.callTool({ name: 'editor_edit_file', arguments: { host: 'db-01', path: '/readme.txt', old_text: 'a', new_text: 'b' } }))
    expect(roEdit).toContain('read-only')

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
    expect(msgs.find((m) => m.id === 2)?.result?.tools?.length).toBe(19)
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

    // back up the vault, then restore it: the app locks and opens again with the same password
    const backup = join(mkdtempSync(join(tmpdir(), 'clavium-e2e-backup-')), 'backup.clavium-vault')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
    }, backup)
    await view().getByRole('button', { name: 'Back Up…' }).click()
    await page.getByText(/Backup saved/).waitFor()
    const saved = JSON.parse(readFileSync(backup, 'utf8')) as { format: string }
    expect(saved.format).toBe('clavium-vault')
    expect(readFileSync(backup, 'utf8')).not.toContain(HOST) // encrypted
    await view().getByRole('button', { name: 'Restore…' }).click()
    await page.getByRole('button', { name: 'Choose Backup…' }).click()
    await page.getByText('Clavium Is Locked').waitFor()
    await page.getByPlaceholder('Master password').fill(MASTER)
    await page.keyboard.press('Enter')
    await sidebar().getByRole('button', { name: 'Hosts', exact: true }).click()
    await page.locator('.host-row', { hasText: HOST }).waitFor()

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
