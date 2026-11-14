// Drives the app against a real server with GNU screen. It needs such a server, so it only runs
// when asked for:
//   CLAVIUM_SCREEN_TEST=user@host:port  CLAVIUM_SCREEN_KEY=path/to/private-key
// The user must be allowed to log in with that key, and `screen` must be on the PATH.
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { Client } from 'ssh2'

const target = /^(.+)@(.+):(\d+)$/.exec(process.env.CLAVIUM_SCREEN_TEST ?? '')
const root = resolve(__dirname, '../..')
const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const NAME = 'clavium-e2e-game'

let app: ElectronApplication
let page: Page
let server: Client
const view = (): Locator => page.locator('.view:not(.hidden)')

/** Run a command on the server, outside the app. */
const remote = (command: string): Promise<string> =>
  new Promise((res, rej) =>
    server.exec(command, (err, stream) => {
      if (err) return rej(err)
      let out = ''
      stream.on('data', (d: Buffer) => (out += d)).stderr.on('data', (d: Buffer) => (out += d))
      stream.on('close', () => res(out))
    })
  )
/** Everything the visible terminal holds, scrollback included. */
const terminalText = (): Promise<string[]> =>
  view()
    .locator('.term-wrap > div')
    .first()
    .evaluate((node) => {
      const buffer = (node as unknown as { term: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).term.buffer.active
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '')
    })
const until = async (what: () => Promise<boolean>, message: string): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (await what()) return
    await page.waitForTimeout(100)
  }
  throw new Error(message)
}
const numbered = (lines: string[]): number[] => lines.map((l) => /^\[Server\] line (\d+)$/.exec(l)?.[1]).filter(Boolean).map(Number)

const expectUnbroken = (seen: number[]): void => {
  expect(seen.length).toBeGreaterThanOrEqual(100)
  expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => 200 - seen.length + 1 + i))
}

describe.runIf(!!target)('screens on a real server', () => {
  beforeAll(async () => {
    const [, username, host, port] = target as RegExpExecArray
    const key = readFileSync(process.env.CLAVIUM_SCREEN_KEY as string, 'utf8')
    server = new Client()
    await new Promise<void>((res, rej) => server.on('ready', res).on('error', rej).connect({ host, port: Number(port), username, privateKey: key }))
    // a "game server": prints its log, then answers what is typed into its console
    await remote(`screen -S ${NAME} -X quit; screen -S ${NAME}-new -X quit; sleep 0.3; screen -dmS ${NAME} bash -c 'for i in $(seq 1 200); do echo "[Server] line $i"; done; while read l; do echo "you said: $l"; done'; sleep 1`)

    app = await _electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: root,
      env: { ...process.env, CLAVIUM_DATA_DIR: mkdtempSync(join(tmpdir(), 'clavium-screen-')), CLAVIUM_NO_NOTIFICATIONS: '1', CLAVIUM_NO_AUTOLOCK: '1', ELECTRON_RENDERER_URL: '' }
    })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByLabel('Master password', { exact: true }).fill('screen test password 1')
    await page.getByLabel('Repeat master password').fill('screen test password 1')
    await page.getByRole('button', { name: 'Create Vault' }).click()
    await page.getByText('No Hosts Yet').waitFor()
    await page.evaluate(
      async ({ key, host, port, username }) => {
        const window = globalThis as unknown as { clavium: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } }
        const k = (await window.clavium.invoke('keys:importText', 'test key', key, '')) as { id: string }
        await window.clavium.invoke('hosts:save', { name: 'game-box', group: '', protocol: 'ssh', hostname: host, port, username, authMethod: 'key', keyId: k.id, allowLegacyAlgorithms: false, aiAccess: 'none', aiConfirm: 'all', notes: '', forwards: [] })
      },
      { key, host, port: Number(port), username }
    )
    await page.reload()
    await page.locator('.host-row', { hasText: 'game-box' }).click()
    await view().getByRole('button', { name: 'Connect' }).click()
    await page.getByRole('button', { name: 'Trust and Connect' }).click()
  })

  afterAll(async () => {
    await remote(`screen -S ${NAME} -X quit; screen -S ${NAME}-new -X quit`).catch(() => undefined)
    server?.end()
    await app?.close()
  })

  it('offers the running screens and opens one with its whole log in the scrollback', async () => {
    await view().getByRole('button', { name: /Screens · \d+/ }).click()
    if (process.env.SCREEN_SHOT) await page.screenshot({ path: process.env.SCREEN_SHOT.replace('.png', '-menu.png') })
    await page.getByRole('menuitem', { name: new RegExp(NAME) }).click()
    await view().getByText('keeps running when you close this tab').waitFor()
    await until(async () => (await terminalText()).some((l) => l === '[Server] line 200'), 'the screen did not show up')

    // Every line screen still has is there exactly once and in order: nothing lost, nothing doubled.
    // (A screen keeps 100 lines of history by default, so the log starts somewhere before line 100.)
    expectUnbroken(numbered(await terminalText()))

    // the mouse wheel scrolls back, as in any terminal
    const box = (await view().locator('.xterm-screen').boundingBox()) as { x: number; y: number; width: number; height: number }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -400)
    await view().locator('.xterm-rows', { hasText: '[Server] line 90' }).waitFor()
  })

  it('passes the keyboard on to the program in the screen', async () => {
    await view().locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('say hello')
    await page.keyboard.press('Enter')
    await until(async () => (await terminalText()).includes('you said: say hello'), 'the program did not answer')
  })

  it('leaves the screen running when the tab is closed, and shows the log again on return', async () => {
    await view().getByRole('button', { name: 'Close Tab (the screen keeps running)' }).click()
    await until(async () => (await remote('LC_ALL=C screen -ls')).includes(`${NAME}\t`) && /Detached/.test(await remote(`LC_ALL=C screen -ls | grep ${NAME}`)), 'the screen is not detached')
    // the program is still alive: it answers something sent from outside the app
    await remote(`screen -S ${NAME} -X stuff 'while away\\n'`)

    await page.locator('.side-item', { hasText: 'game-box' }).first().click()
    await view().getByRole('button', { name: /Screens · \d+/ }).click()
    await page.getByRole('menuitem', { name: new RegExp(NAME) }).click()
    await until(async () => (await terminalText()).includes('you said: while away'), 'the screen did not come back')
    const text = await terminalText()
    if (process.env.SCREEN_SHOT) await page.screenshot({ path: process.env.SCREEN_SHOT })
    expectUnbroken(numbered(text))
    expect(text.filter((l) => l === 'you said: say hello')).toHaveLength(1)
  })

  it('ends a screen only after asking', async () => {
    await view().getByRole('button', { name: 'End Screen…' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(await remote('LC_ALL=C screen -ls')).toContain(NAME)
    await view().getByRole('button', { name: 'End Screen…' }).click()
    await page.getByRole('button', { name: 'End Screen', exact: true }).click()
    await view().getByText('Session Ended').waitFor()
    expect(await remote('LC_ALL=C screen -ls')).not.toContain(`${NAME}\t`)
    await view().getByRole('button', { name: /Close Tab/ }).click()
  })

  it('creates a new screen that outlives its tab', async () => {
    await page.locator('.side-item', { hasText: 'game-box' }).first().click()
    await view().getByRole('button', { name: /Screens/ }).click()
    await page.getByRole('menuitem', { name: 'New Screen…' }).click()
    await page.getByLabel('Name of the screen').fill(`${NAME}-new`)
    await page.getByRole('button', { name: 'Create' }).click()
    await view().getByText('keeps running when you close this tab').waitFor()
    await until(async () => (await remote('LC_ALL=C screen -ls')).includes(`${NAME}-new`), 'the screen was not created')
    await view().getByRole('button', { name: /Close Tab/ }).click()
    await page.waitForTimeout(800)
    expect(await remote(`LC_ALL=C screen -ls | grep ${NAME}-new`)).toMatch(/Detached/)
  })
})
