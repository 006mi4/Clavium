// Drives the app against a real server with Docker. It needs such a server, so it only runs when
// asked for:
//   CLAVIUM_DOCKER_TEST=user@host:port  CLAVIUM_DOCKER_KEY=path/to/private-key  CLAVIUM_DOCKER_IMAGE=alpine
// The user must be allowed to log in with that key and to use Docker. The image must already be on
// the server and contain `sh`. The test creates two containers named clavium-e2e-* and removes
// them again; it touches nothing else.
import { mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { _electron, type ElectronApplication, type Locator, type Page } from 'playwright-core'
import { Client } from 'ssh2'

const target = /^(.+)@(.+):(\d+)$/.exec(process.env.CLAVIUM_DOCKER_TEST ?? '')
const IMAGE = process.env.CLAVIUM_DOCKER_IMAGE ?? 'alpine'
const root = resolve(__dirname, '../..')
const electronPath = createRequire(import.meta.url)('electron') as unknown as string
const WEB = 'clavium-e2e-web'
const DB = 'clavium-e2e-db'
const NEW = 'clavium-e2e-new'
/** a very small image that is downloaded for the test (and deleted again, unless it was there before) */
const SMALL = 'busybox'
const DIR = '/tmp/clavium-e2e-dir'

let app: ElectronApplication
let page: Page
let server: Client
let volumes = ''
let hadSmall = false
const view = (): Locator => page.locator('.view:not(.hidden)')
const row = (name: string): Locator => view().getByRole('group', { name, exact: true })

const remote = (command: string): Promise<string> =>
  new Promise((res, rej) =>
    server.exec(command, (err, stream) => {
      if (err) return rej(err)
      let out = ''
      stream.on('data', (d: Buffer) => (out += d)).stderr.on('data', (d: Buffer) => (out += d))
      stream.on('close', () => res(out.trim()))
    })
  )
const running = (name: string): Promise<string> => remote(`docker inspect -f '{{.State.Running}}' ${name}`)
const until = async (what: () => Promise<boolean>, message: string): Promise<void> => {
  for (let i = 0; i < 150; i++) {
    if (await what()) return
    await page.waitForTimeout(200)
  }
  throw new Error(message)
}
const terminalText = (): Promise<string> =>
  view()
    .locator('.term-wrap > div')
    .first()
    .evaluate((node) => {
      const buffer = (node as unknown as { term: { buffer: { active: { length: number; getLine(i: number): { translateToString(trim: boolean): string } | undefined } } } }).term.buffer.active
      return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? '').join('\n')
    })

describe.runIf(!!target)('Docker on a real server', () => {
  beforeAll(async () => {
    const [, username, host, port] = target as RegExpExecArray
    const key = readFileSync(process.env.CLAVIUM_DOCKER_KEY as string, 'utf8')
    server = new Client()
    await new Promise<void>((res, rej) => server.on('ready', res).on('error', rej).connect({ host, port: Number(port), username, privateKey: key }))
    // Both programs end at once when asked to; otherwise every stop would take Docker ten seconds.
    const compose = '--label com.docker.compose.project=clavium-e2e'
    await remote(`docker rm -f -v ${WEB} ${DB} 2>/dev/null; docker run -d --name ${WEB} ${compose} --label com.docker.compose.service=web -p 127.0.0.1:18080:80 --entrypoint sh ${IMAGE} -c 'trap "exit 0" TERM; while true; do echo "tick $(date +%s)"; sleep 1 & wait $!; done' && docker create --name ${DB} ${compose} --label com.docker.compose.service=db --entrypoint sh ${IMAGE} -c 'trap "exit 0" TERM; sleep 3600 & wait $!'`)
    expect(await running(WEB)).toBe('true')
    hadSmall = (await remote(`docker images -q ${SMALL}:latest`)) !== ''
    await remote(`docker rm -f -v ${NEW} 2>/dev/null; mkdir -p ${DIR} && echo from-the-server > ${DIR}/file.txt`)
    // some images declare volumes; the ones made for these two containers are removed at the end
    volumes = await remote(`docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' ${WEB} ${DB} | tr '\n' ' '`)

    app = await _electron.launch({
      executablePath: electronPath,
      args: ['.'],
      cwd: root,
      env: { ...process.env, CLAVIUM_DATA_DIR: mkdtempSync(join(tmpdir(), 'clavium-docker-')), CLAVIUM_NO_NOTIFICATIONS: '1', CLAVIUM_NO_AUTOLOCK: '1', ELECTRON_RENDERER_URL: '' }
    })
    page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.getByLabel('Master password', { exact: true }).fill('docker test password 1')
    await page.getByLabel('Repeat master password').fill('docker test password 1')
    await page.getByRole('button', { name: 'Create Vault' }).click()
    await page.getByText('No Hosts Yet').waitFor()
    await page.evaluate(
      async ({ key, host, port, username }) => {
        const window = globalThis as unknown as { clavium: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } }
        const k = (await window.clavium.invoke('keys:importText', 'test key', key, '')) as { id: string }
        await window.clavium.invoke('hosts:save', { name: 'docker-box', group: '', protocol: 'ssh', hostname: host, port, username, authMethod: 'key', keyId: k.id, allowLegacyAlgorithms: false, aiAccess: 'none', aiConfirm: 'all', notes: '', forwards: [] })
      },
      { key, host, port: Number(port), username }
    )
    await page.reload()
    await page.locator('.host-row', { hasText: 'docker-box' }).click()
    await view().getByRole('button', { name: 'Connect' }).click()
    await page.getByRole('button', { name: 'Trust and Connect' }).click()
  })

  afterAll(async () => {
    await remote(`docker rm -f -v ${WEB} ${DB} ${NEW}; for v in ${volumes}; do docker volume rm $v; done; rm -rf ${DIR}`).catch(() => undefined)
    if (!hadSmall) await remote(`docker rmi ${SMALL}:latest`).catch(() => undefined)
    server?.end()
    await app?.close()
  })

  it('offers Docker in the terminal and lists the containers by compose project', async () => {
    await view().getByRole('button', { name: 'Docker' }).click()
    await view().getByText(/Docker \d+\.\d+.* running, \d+ stopped/).waitFor()
    await view().getByLabel('Filter').fill('clavium-e2e')
    const project = view().getByRole('region', { name: 'clavium-e2e' })
    await project.getByText('1 of 2 running').waitFor()
    await row(WEB).getByText('18080 → 80').waitFor()
    expect(await row(WEB).locator('.status-dot.on').count()).toBe(1)
    expect(await row(DB).locator('.status-dot.on').count()).toBe(0)
    // the figures for processor and memory arrive a moment later
    await row(WEB).locator('.usage', { hasText: '%' }).waitFor()
    if (process.env.DOCKER_SHOT) await page.screenshot({ path: process.env.DOCKER_SHOT })
  })

  it('starts, stops and restarts containers, one by one and as a project', async () => {
    await row(DB).getByRole("button", { name: `Start ${DB}`, exact: true }).click()
    await until(async () => (await running(DB)) === 'true', 'the container did not start')
    await row(DB).locator('.status-dot.on').waitFor()

    const before = await remote(`docker inspect -f '{{.State.StartedAt}}' ${WEB}`)
    await row(WEB).getByRole('button', { name: `Restart ${WEB}` }).click()
    await until(async () => (await remote(`docker inspect -f '{{.State.StartedAt}}' ${WEB}`)) !== before && (await running(WEB)) === 'true', 'the container was not restarted')

    await view().getByRole('button', { name: 'Stop All', exact: true }).click()
    await until(async () => (await running(WEB)) === 'false' && (await running(DB)) === 'false', 'the project did not stop')
    await view().getByText('0 of 2 running').waitFor()
    await view().getByRole('button', { name: 'Start All', exact: true }).click()
    await until(async () => (await running(WEB)) === 'true' && (await running(DB)) === 'true', 'the project did not start')
    await view().getByText('2 of 2 running').waitFor()
  })

  it('pauses and resumes, and changes when a container starts by itself', async () => {
    await row(WEB).getByRole('button', { name: `More for ${WEB}` }).click()
    await page.getByRole('menuitem', { name: 'Pause' }).click()
    await until(async () => (await remote(`docker inspect -f '{{.State.Paused}}' ${WEB}`)) === 'true', 'the container was not paused')
    await row(WEB).getByText(/Paused/).waitFor()
    await row(WEB).getByRole('button', { name: `More for ${WEB}` }).click()
    await page.getByRole('menuitem', { name: 'Resume' }).click()
    await until(async () => (await remote(`docker inspect -f '{{.State.Paused}}' ${WEB}`)) === 'false', 'the container was not resumed')

    await row(WEB).getByRole('button', { name: `More for ${WEB}` }).click()
    await page.getByRole('menuitem', { name: 'Details and Settings…' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByText('18080 → 80').waitFor()
    expect(await sheet.getByLabel('Start again by itself').inputValue()).toBe('no')
    await sheet.getByLabel('Start again by itself').selectOption('unless-stopped')
    if (process.env.DOCKER_SHOT) await page.screenshot({ path: process.env.DOCKER_SHOT.replace('.png', '-details.png') })
    await sheet.getByRole('button', { name: 'Save' }).click()
    await until(async () => (await remote(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${WEB}`)) === 'unless-stopped', 'the restart policy was not changed')
  })

  it('shows the log of a container and opens a shell inside it', async () => {
    await row(WEB).getByRole('button', { name: `Log of ${WEB}` }).click()
    await view().getByText('Log of a container').waitFor()
    await until(async () => /tick \d+\ntick \d+/.test(await terminalText()), 'the log did not show up')
    await view().getByRole('button', { name: 'Close Tab' }).click()
    expect(await running(WEB)).toBe('true') // closing the log does not touch the container

    await page.locator('.side-item', { hasText: 'docker-box' }).last().click()
    await row(WEB).getByRole('button', { name: `Shell in ${WEB}` }).click()
    await view().getByText('Shell in a container').waitFor()
    await view().locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('echo inside-$((6*7)) && hostname')
    await page.keyboard.press('Enter')
    await until(async () => (await terminalText()).includes('inside-42'), 'the shell did not answer')
    expect(await terminalText()).toContain((await remote(`docker inspect -f '{{.Config.Hostname}}' ${WEB}`)).slice(0, 12))
    await view().getByRole('button', { name: 'Close Tab' }).click()
    expect(await running(WEB)).toBe('true')
    await page.locator('.side-item', { hasText: 'docker-box' }).last().click()
  })

  it('removes a container only when it is stopped, and only after asking', async () => {
    await row(DB).getByRole('button', { name: `More for ${DB}` }).click()
    expect(await page.getByRole('menuitem', { name: 'Remove…' }).isDisabled()).toBe(true) // it is running
    await page.keyboard.press('Escape')
    await row(DB).getByRole("button", { name: `Stop ${DB}`, exact: true }).click()
    await until(async () => (await running(DB)) === 'false', 'the container did not stop')
    await row(DB).getByRole("button", { name: `Start ${DB}`, exact: true }).waitFor()
    await row(DB).getByRole('button', { name: `More for ${DB}` }).click()
    await page.getByRole('menuitem', { name: 'Remove…' }).click()
    await page.getByRole('button', { name: 'Cancel' }).click()
    expect(await remote(`docker ps -aq -f name=^${DB}$`)).not.toBe('')
    await row(DB).getByRole('button', { name: `More for ${DB}` }).click()
    await page.getByRole('menuitem', { name: 'Remove…' }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await until(async () => (await remote(`docker ps -aq -f name=^${DB}$`)) === '', 'the container was not removed')
    await row(DB).waitFor({ state: 'detached' })
  })

  it('lists images and protects those in use', async () => {
    await view().getByRole('button', { name: 'Images' }).click()
    const [repository, tag = 'latest'] = IMAGE.split(':')
    await view().getByLabel('Filter').fill(IMAGE)
    const image = view().getByRole('group', { name: `${repository}:${tag}`, exact: true })
    await image.getByText('in use').waitFor()
    expect(await image.getByRole('button', { name: 'In use by a container' }).isDisabled()).toBe(true)
  })

  it('downloads an image and shows the progress', async () => {
    await view().getByRole('button', { name: 'Download Image' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByLabel('Image name').fill('Not A Valid Name')
    expect(await sheet.getByRole('button', { name: 'Download', exact: true }).isDisabled()).toBe(true)
    await sheet.getByLabel('Image name').fill(SMALL)
    await sheet.getByRole('button', { name: 'Download', exact: true }).click()
    await page.getByText(`Downloaded “${SMALL}”.`).waitFor({ timeout: 180_000 })
    expect(await remote(`docker images -q ${SMALL}:latest`)).not.toBe('')
    await view().getByLabel('Filter').fill(SMALL)
    await view().getByRole('group', { name: `${SMALL}:latest`, exact: true }).waitFor()
  })

  it('creates a container with ports, a folder and settings, exactly as entered', async () => {
    const greeting = String.raw`hello $HOME 'single' "double" \n; rm -rf /data`
    await view().getByRole('button', { name: 'New Container' }).click()
    const sheet = page.getByRole('dialog')
    await sheet.getByRole('combobox', { name: 'Image' }).selectOption(`${SMALL}:latest`)
    await sheet.getByLabel('Name', { exact: true }).fill(NEW)
    await sheet.getByRole('button', { name: 'Add Port' }).click()
    await sheet.getByLabel('Port on the server').fill('18081')
    await sheet.getByLabel('Port in the container').fill('99999')
    await sheet.getByText('Ports are numbers from 1 to 65535.').waitFor()
    expect(await sheet.getByRole('button', { name: 'Create and Start' }).isDisabled()).toBe(true)
    await sheet.getByLabel('Port in the container').fill('80')
    await sheet.getByLabel('Reachable from').selectOption('local')
    await sheet.getByRole('button', { name: 'Add Folder' }).click()
    await sheet.getByLabel('Folder on the server').fill(DIR)
    await sheet.getByLabel('Path in the container').fill('/data')
    await sheet.getByText('Read only').click()
    await sheet.getByRole('button', { name: 'Add Variable' }).click()
    await sheet.getByLabel('Name of the variable').fill('GREETING')
    await sheet.getByLabel('Value of the variable').fill(greeting)
    await sheet.getByLabel('Command', { exact: true }).fill('sleep 3600')
    if (process.env.DOCKER_SHOT) await page.screenshot({ path: process.env.DOCKER_SHOT.replace('.png', '-new.png') })
    await sheet.getByRole('button', { name: 'Create and Start' }).click()
    await page.getByText(`Created and started “${NEW}”.`).waitFor()

    expect(await running(NEW)).toBe('true')
    await row(NEW).getByText('18081 → 80').waitFor()
    // the value arrived unchanged: nothing in it was run or expanded on the server
    expect(await remote(`docker exec ${NEW} printenv GREETING`)).toBe(greeting)
    expect(await remote(`docker inspect -f '{{json .HostConfig.PortBindings}}' ${NEW}`)).toBe('{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"18081"}]}')
    expect(await remote(`docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' ${NEW}`)).toBe('unless-stopped')
    expect(await remote(`docker exec ${NEW} cat /data/file.txt`)).toBe('from-the-server')
    expect(await remote(`docker exec ${NEW} touch /data/new 2>&1`)).toMatch(/Read-only/)
    // it is not part of the command line, where other users of the server could read it
    expect(await remote(`docker inspect -f '{{.Config.Cmd}}' ${NEW}`)).toBe('[sleep 3600]')

    // a second container with the same name: Docker's explanation is shown, nothing else happens
    await view().getByRole('button', { name: 'New Container' }).click()
    await sheet.getByRole('combobox', { name: 'Image' }).selectOption(`${SMALL}:latest`)
    await sheet.getByLabel('Name', { exact: true }).fill(NEW)
    await sheet.getByRole('button', { name: 'Create and Start' }).click()
    await page.getByText(/is already in use/).waitFor()
    await sheet.getByRole('button', { name: 'Cancel' }).click()
  })

  it('deletes an image that no container uses any more', async () => {
    await remote(`docker rm -f ${NEW}`)
    await view().getByRole('button', { name: 'Images' }).click()
    await view().getByLabel('Filter').fill(SMALL)
    await view().getByRole('button', { name: 'Reload' }).click()
    const image = view().getByRole('group', { name: `${SMALL}:latest`, exact: true })
    await image.getByRole('button', { name: `Delete ${SMALL}:latest` }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await page.getByText(`Deleted “${SMALL}:latest”.`).waitFor()
    expect(await remote(`docker images -q ${SMALL}:latest`)).toBe('')
    hadSmall = true // nothing left to tidy up
  })
})
