// Split view, focus mode, saved workspaces, the tabs of the last session and the suggestions
// of the terminal, driven in the real Electron app. Run with `npm run test:e2e` (builds first).
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { startTestSshServer, TEST_PASSWORD, TEST_USER, type TestSshServer } from '../helpers/testServer'

const root = resolve(__dirname, '../..')
const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const shots = join(root, 'docs', 'screenshots')
const MASTER = 'e2e master password 123'

let srv: TestSshServer
let app: ElectronApplication
let page: Page
let dataDir: string

const panes = (): Locator => page.locator('.pane:not(.hidden)')
const sidebar = (): Locator => page.locator('.sidebar')
const terminal = (pane: Locator, text: string): Locator => pane.locator('.xterm-rows', { hasText: text })

async function launch(): Promise<void> {
  app = await _electron.launch({
    executablePath: electronPath,
    args: ['.'],
    cwd: root,
    env: { ...process.env, CLAVIUM_DATA_DIR: dataDir, CLAVIUM_NO_NOTIFICATIONS: '1', CLAVIUM_NO_AUTOLOCK: '1', CLAVIUM_NO_EXTERNAL_EDITOR: '1', ELECTRON_RENDERER_URL: '' }
  })
  page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.emulateMedia({ colorScheme: 'light' })
}

async function addHost(name: string): Promise<void> {
  await page.getByRole('button', { name: /New Host|Add a Host/ }).first().click()
  const sheet = page.getByRole('dialog')
  await sheet.getByLabel('Name', { exact: true }).fill(name)
  await sheet.getByLabel('Host', { exact: true }).fill('127.0.0.1')
  await sheet.getByLabel('Port', { exact: true }).fill(String(srv.port))
  await sheet.getByLabel('User', { exact: true }).fill(TEST_USER)
  await sheet.getByLabel(/^Password/).fill(TEST_PASSWORD)
  await sheet.getByRole('button', { name: 'Save' }).click()
  await page.locator('.host-row', { hasText: name }).waitFor()
}

beforeAll(async () => {
  srv = await startTestSshServer()
  // What a server answers to the questions of the suggestions.
  srv.onExec = (command) => {
    if (command.includes('__clavium_ctx__')) return '__clavium_ctx__\nbash\n/srv\n/home/tester\n'
    if (command.includes('for d in $PATH')) return 'git\ngrep\nls\ncat\n'
    if (command.includes('ls -1Ap')) return command.includes("'/srv/./'") ? 'www/\nreadme.txt\nreport 2026.txt\n' : ''
    if (command.includes('.bash_history')) return 'ls -la /var/log\ngit status\n'
    if (command.includes('git branch')) return 'main\nfeature/login\n'
    return undefined
  }
  dataDir = mkdtempSync(join(tmpdir(), 'clavium-e2e-ws-'))
  await launch()
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

describe('workspaces and terminal suggestions', () => {
  it('opens a terminal', async () => {
    await page.getByText('Welcome to Clavium').waitFor()
    await page.getByLabel('Master password', { exact: true }).fill(MASTER)
    await page.getByLabel('Repeat master password').fill(MASTER)
    await page.getByRole('button', { name: 'Create Vault' }).click()
    await page.getByText('No Hosts Yet').waitFor()
    await addHost('web-01')
    await addHost('db-01')
    await page.locator('.host-row', { hasText: 'web-01' }).click()
    await page.locator('.view:not(.hidden)').getByRole('button', { name: 'Connect' }).click()
    await page.getByRole('button', { name: 'Trust and Connect' }).click()
    await terminal(panes(), 'Welcome to the Clavium test server').waitFor()
  })

  it('suggests commands, subcommands, branches, paths and history, and inserts them with Tab', async () => {
    const list = page.getByRole('listbox', { name: 'Suggestions' })
    await page.keyboard.type('gi')
    await list.locator('li', { hasText: 'Version control' }).waitFor()
    expect(await list.getByRole('option').first().getAttribute('aria-selected')).toBe('true')
    // the history line that starts with what is typed comes first
    expect(await list.getByRole('option').allInnerTexts()).toEqual(['git status', 'git\nVersion control'])
    await page.keyboard.press('ArrowDown') // start using the list: stays on the first entry
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Tab')
    await terminal(panes(), '$ git ').waitFor()

    await page.keyboard.type('che')
    await list.getByRole('option', { name: /^checkout/ }).waitFor()
    await page.screenshot({ path: join(shots, '13-terminal-suggestions.png') })
    await page.keyboard.press('Tab')
    await terminal(panes(), '$ git checkout ').waitFor()

    await page.keyboard.type('fe')
    await list.getByRole('option', { name: 'feature/login' }).waitFor()
    await page.keyboard.press('Tab')
    await terminal(panes(), '$ git checkout feature/login ').waitFor()
    // Escape closes the list for the rest of the line; Enter then simply runs the line
    await page.keyboard.type('-')
    await page.keyboard.press('Escape')
    await expect.poll(() => list.count()).toBe(0)
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Enter')
    await terminal(panes(), 'echo:git checkout feature/login').waitFor()

    // paths, with a space in the name
    await page.keyboard.type('cat re')
    await list.getByRole('option', { name: 'report 2026.txt' }).waitFor()
    expect(await list.getByRole('option').allInnerTexts()).toEqual(['readme.txt', 'report 2026.txt'])
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter') // the list is in use, so Enter inserts
    await terminal(panes(), '$ cat report\\ 2026.txt').waitFor()
    await page.keyboard.press('Enter')
    await terminal(panes(), 'echo:cat report\\ 2026.txt').waitFor()

    // the line just typed is now part of the history of this session
    await page.keyboard.type('cat rep')
    await list.getByRole('option', { name: 'cat report\\ 2026.txt' }).waitFor()
    await page.keyboard.press('Control+c')
    await expect.poll(() => list.count()).toBe(0)
    await page.keyboard.press('Enter')

    // asked for with the shortcut on an empty line: the last commands, the newest first
    await page.waitForTimeout(300)
    await page.keyboard.press('Control+Space')
    await list.getByRole('option').first().waitFor()
    expect((await list.getByRole('option').allInnerTexts()).slice(0, 2)).toEqual(['cat report\\ 2026.txt', 'git checkout feature/login'])
    await page.keyboard.press('Tab')
    await expect.poll(async () => (await panes().locator('.xterm-rows').innerText()).trimEnd().endsWith('$ cat report\\ 2026.txt')).toBe(true)
    await page.keyboard.press('Control+c')
    await page.keyboard.press('Enter')
  })

  it('shows nothing while the setting is off', async () => {
    await sidebar().getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('switch', { name: /Suggestions in the terminal/ }).or(page.locator('.row', { hasText: 'Suggestions in the terminal' }).getByRole('switch')).first().click()
    await sidebar().locator('.side-item', { hasText: 'web-01' }).click()
    await page.keyboard.type('gi')
    await terminal(panes(), '$ gi').waitFor()
    await page.waitForTimeout(400)
    expect(await page.getByRole('listbox', { name: 'Suggestions' }).count()).toBe(0)
    await page.keyboard.press('Enter')
    await sidebar().getByRole('button', { name: 'Settings' }).click()
    await page.locator('.row', { hasText: 'Suggestions in the terminal' }).getByRole('switch').click()
    await sidebar().locator('.side-item', { hasText: 'web-01' }).click()
  })

  it('splits the tab, resizes with the keyboard and zooms into one pane', async () => {
    const logins = srv.logins
    await panes().getByRole('button', { name: 'Split View and Workspace' }).click()
    await page.getByRole('menuitem', { name: /Terminal to the Right/ }).or(page.locator('.menu button', { hasText: 'Terminal to the Right' })).first().click()
    await expect.poll(() => panes().count()).toBe(2)
    await expect.poll(() => srv.logins).toBe(logins + 1)
    await terminal(panes().nth(1), 'Welcome to the Clavium test server').waitFor()
    // the first terminal was not connected again
    await terminal(panes().nth(0), 'echo:git checkout feature/login').waitFor()

    // a third connection, to another host, below the second one
    await panes().nth(1).getByRole('button', { name: 'Split View and Workspace' }).click()
    await page.locator('.menu button', { hasText: 'Another Host Below' }).click()
    const picker = page.getByRole('dialog')
    await picker.getByLabel('Search hosts').fill('db')
    await picker.getByRole('button', { name: /db-01/ }).click()
    await expect.poll(() => panes().count()).toBe(3)
    await terminal(panes().nth(2), 'Welcome to the Clavium test server').waitFor()
    expect(await sidebar().locator('.side-item', { hasText: 'web-01 + db-01' }).count()).toBe(1)

    // each pane types into its own connection
    await page.keyboard.type('third')
    await page.keyboard.press('Enter')
    await terminal(panes().nth(2), 'echo:third').waitFor()
    expect(await terminal(panes().nth(0), 'echo:third').count()).toBe(0)
    // the keyboard moves between the panes by their position
    await page.keyboard.press('ControlOrMeta+Alt+ArrowLeft')
    await page.keyboard.type('first')
    await page.keyboard.press('Enter')
    await terminal(panes().nth(0), 'echo:first').waitFor()
    await page.keyboard.press('ControlOrMeta+Alt+ArrowRight')
    await page.keyboard.type('second')
    await page.keyboard.press('Enter')
    await terminal(panes().nth(1), 'echo:second').waitFor()

    // the dividers are separators that the arrow keys move
    const divider = page.getByRole('separator', { name: 'Resize the panes left and right' })
    expect(await divider.getAttribute('aria-valuenow')).toBe('50')
    const before = (await panes().nth(0).boundingBox())!.width
    await divider.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    expect(await divider.getAttribute('aria-valuenow')).toBe('54')
    expect((await panes().nth(0).boundingBox())!.width).toBeGreaterThan(before)
    await page.screenshot({ path: join(shots, '14-split-view.png') })

    // focus mode shows only the pane that has the keyboard, and gives everything back afterwards
    await panes().nth(2).locator('.xterm').click()
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    await expect.poll(() => panes().count()).toBe(1)
    await terminal(panes(), 'echo:third').waitFor()
    expect(await panes().getByRole('button', { name: /Leave Focus Mode/ }).getAttribute('aria-pressed')).toBe('true')
    await panes().getByRole('button', { name: /Leave Focus Mode/ }).click()
    await expect.poll(() => panes().count()).toBe(3)
    expect(srv.logins).toBe(logins + 2)
  })

  it('saves the tab as a workspace and opens it again from the library', async () => {
    await panes().nth(0).getByRole('button', { name: 'Split View and Workspace' }).click()
    await page.locator('.menu button', { hasText: 'Save Workspace…' }).click()
    await page.getByRole('dialog').getByLabel('Name of the workspace').fill('Shop production')
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await sidebar().locator('.side-item', { hasText: 'Shop production' }).waitFor()

    await sidebar().locator('.side-item', { hasText: 'Shop production' }).hover() // the button appears on hover and on keyboard focus
    await sidebar().getByRole('button', { name: 'Close Shop production', exact: true }).click()
    await expect.poll(() => panes().count()).toBe(0)
    await sidebar().getByRole('button', { name: 'Workspaces' }).click()
    const row = page.locator('.view:not(.hidden) .item', { hasText: 'Shop production' })
    await row.waitFor()
    expect(await row.locator('.secondary').innerText()).toBe('Terminal on web-01, Terminal on web-01, Terminal on db-01')
    await row.getByRole('button', { name: 'Open the workspace Shop production' }).click()
    await expect.poll(() => panes().count()).toBe(3)
    // the divider is where it was saved
    expect(await page.getByRole('separator', { name: 'Resize the panes left and right' }).getAttribute('aria-valuenow')).toBe('54')
    for (let i = 0; i < 3; i++) await terminal(panes().nth(i), 'Welcome to the Clavium test server').waitFor()
  })

  it('opens the tabs of the last session again after a restart', async () => {
    // focus mode on the third pane is part of what is remembered
    await panes().nth(2).locator('.xterm').click()
    await page.keyboard.press('ControlOrMeta+Shift+Enter')
    await expect.poll(() => panes().count()).toBe(1)
    await page.waitForTimeout(1200) // the tabs are written a moment after the last change
    await app.close()
    const logins = srv.logins
    await launch()
    await page.getByPlaceholder('Master password').fill(MASTER)
    await page.keyboard.press('Enter')
    await sidebar().locator('.side-item', { hasText: 'Shop production' }).waitFor()
    await expect.poll(() => srv.logins).toBe(logins + 3)
    await expect.poll(() => panes().count()).toBe(1)
    await terminal(panes(), 'Welcome to the Clavium test server').waitFor()
    await panes().getByRole('button', { name: /Leave Focus Mode/ }).click()
    await expect.poll(() => panes().count()).toBe(3)
    expect(await page.getByRole('separator', { name: 'Resize the panes left and right' }).getAttribute('aria-valuenow')).toBe('54')

    // closing a pane gives its room to the others; the last one closes the tab
    await panes().nth(0).getByRole('button', { name: 'Close Session' }).click()
    await expect.poll(() => panes().count()).toBe(2)
    await sidebar().locator('.side-item', { hasText: 'Shop production' }).hover() // the button appears on hover and on keyboard focus
    await sidebar().getByRole('button', { name: 'Close Shop production', exact: true }).click()
    await expect.poll(() => sidebar().locator('.side-item', { hasText: 'Shop production' }).count()).toBe(0)
  })
})
