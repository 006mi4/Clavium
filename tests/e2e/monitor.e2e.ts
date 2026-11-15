// The monitor of a server, driven in the real Electron app against a test server that answers
// the measuring command the way a Linux machine does. Run with `npm run test:e2e` (builds first).
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
/** how often the server was measured, and what kind of system it pretends to be */
let measured = 0
let system: 'linux' | 'bsd' = 'linux'

const panes = (): Locator => page.locator('.pane:not(.hidden)')

/**
 * A server whose processor is 40 % busy and that receives 2 MB and sends 1 MB every second
 * between the first two measurements. After that the load moves, so the charts have a shape.
 */
const wave = (n: number): number => (n < 2 ? 1 : 0.9 + 0.7 * Math.sin(n / 2.2) + 0.25 * Math.sin(n / 0.7))
const sums: { busy: number; cores: number[]; rx: number; tx: number; read: number; write: number }[] = [{ busy: 1000, cores: [250, 250, 250, 250], rx: 0, tx: 0, read: 0, write: 0 }]
function total(n: number): (typeof sums)[number] {
  for (let i = sums.length; i <= n; i++) {
    const p = sums[i - 1]
    const w = wave(i)
    sums.push({
      busy: p.busy + Math.round(120 * w),
      cores: p.cores.map((c, k) => c + Math.min(75, Math.round((k === 0 ? 72 : 16) * w))),
      rx: p.rx + Math.round(6 * 1024 * 1024 * w),
      tx: p.tx + Math.round(3 * 1024 * 1024 * (2 - w)),
      read: p.read + Math.round(6000 * (2 - w)),
      write: p.write + Math.round(12000 * w)
    })
  }
  return sums[n]
}
function linuxAnswer(n: number): string {
  const t = total(n)
  return [
    '##host', 'web-01',
    '##kernel', '6.8.0-45-generic',
    '##os', 'PRETTY_NAME="Ubuntu 24.04.1 LTS"',
    '##uptime', `${(200000 + n * 3).toFixed(2)} 1.00`,
    '##load', '1.24 0.96 0.71 2/613 4242',
    '##stat', `cpu  ${t.busy} 0 0 ${10000 + n * 300 - t.busy} 0 0 0 0 0 0`, ...t.cores.map((c, k) => `cpu${k} ${c} 0 0 ${2500 + n * 75 - c} 0 0 0 0 0 0`),
    '##mem', 'MemTotal: 16000000 kB', 'MemFree: 800000 kB', `MemAvailable: ${6400000 - (n < 2 ? 0 : Math.round(900000 * (wave(n) - 1)))} kB`, 'Buffers: 400000 kB', 'Cached: 5000000 kB', 'SwapTotal: 4000000 kB', 'SwapFree: 3000000 kB',
    '##net', `  eth0: ${t.rx} 1 0 0 0 0 0 0 ${t.tx} 1 0 0 0 0 0 0`, '    lo: 5 1 0 0 0 0 0 0 5 1 0 0 0 0 0 0',
    '##io', `   8 0 sda 1 0 ${t.read} 0 1 0 ${t.write} 0 0 0 0`,
    '##df', 'Filesystem Type 1024-blocks Used Available Capacity Mounted on', '/dev/sda2 ext4 100000000 42000000 53000000 45% /', '/dev/sdb1 xfs 500000000 470000000 30000000 94% /srv/data', '/dev/sdc1 ext4 200000000 150000000 40000000 79% /var/backups', 'tmpfs tmpfs 1600000 0 1600000 0% /run',
    '##temp', 'hwmon|coretemp|Package id 0|58000', 'hwmon|nvme|Composite|39850',
    '##nvidia', `NVIDIA RTX A4000, ${Math.round(Math.min(100, 63 * wave(n)))}, 9000, 16376, 71, 118.20`,
    '##amd',
    '##end', ''
  ].join('\n')
}

/** What runs on the pretend server. Ending a process removes it here, as it would there. */
const running = new Set([1, 2, 800, 900, 901, 1200, 1201, 1500, 1600])
const signals: string[] = []
let looked = 0
function procStat(pid: number, name: string, ppid: number, used: number, kernel = false): string {
  const f = new Array<string | number>(50).fill(0)
  f[0] = ppid
  f[5] = kernel ? 0x00200040 : 0x400000
  f[10] = used
  f[18] = pid * 10
  return `${pid} (${name}) S ${f.join(' ')}`
}
function activityAnswer(n: number): string {
  const all: [number, string][] = [
    [1, `0 12000 ${procStat(1, 'systemd', 0, 500)}`],
    [2, `0 0 ${procStat(2, 'kthreadd', 0, 0, true)}`],
    [800, `0 9000 ${procStat(800, 'sshd', 1, 10)}`],
    [900, `1000 7000 ${procStat(900, 'sshd', 800, 10)}`],
    [901, `1000 1500 ${procStat(901, 'sh', 900, 1)}`],
    [1200, `0 250000 ${procStat(1200, 'nginx', 1, 4000 + n * 60)}`],
    [1201, `33 90000 ${procStat(1201, 'nginx', 1200, 100 + n * 30)}`],
    [1500, `1000 480000 ${procStat(1500, 'node', 1, 2000 + n * 300)}`],
    [1600, `0 3000000 ${procStat(1600, 'postgres', 1, 900 + n * 6)}`]
  ]
  const head = (pid: number, c: string): string => `==> /proc/${pid}/cmdline <==\n${c}`
  return [
    '##self', '901 1000',
    '##cpu', `cpu  ${100000 + n * 1200} 0 0 0 0 0 0 0 0 0`, '4',
    '##mem', 'MemTotal:       16000000 kB',
    '##hide', 'proc /proc proc rw,relatime 0 0',
    '##passwd', 'root:0', 'www-data:33', 'tester:1000',
    '##proc', ...all.filter(([pid]) => running.has(pid)).map(([, line]) => line),
    '##tcp',
    '   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5001 1 0 100 0 0 10 0',
    ...(running.has(1500) ? ['   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0 100 0 0 10 0'] : []),
    '   2: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5004 1 0 100 0 0 10 0',
    '##tcp6', '   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5005 1 0 100 0 0 10 0',
    '##udp', '##udp6',
    '##ss', 'found', 'tcp LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=1500,fd=21)) ino:5003',
    '##fd',
    '##cmd', [head(1, '/sbin/init\0'), head(2, ''), head(1200, 'nginx: master process /usr/sbin/nginx\0'), head(1500, 'node\0/srv/app/server.js\0'), head(1600, 'postgres\0-D\0/var/lib/postgresql\0')].join('\n'),
    '', '##end', ''
  ].join('\n')
}

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

beforeAll(async () => {
  srv = await startTestSshServer()
  srv.onExec = (command) => {
    const kill = /(sudo -n )?kill -(TERM|KILL) (\d+)$/.exec(command.replace(/'$/, ''))
    if (kill) {
      signals.push(`${kill[1] ? 'sudo ' : ''}${kill[2]} ${kill[3]}`)
      if (kill[1]) return { err: 'sudo: a password is required\n', code: 1 }
      running.delete(Number(kill[3]))
      return ''
    }
    if (command.includes('##proc')) return system === 'bsd' ? '##unsupported\nFreeBSD\n' : activityAnswer(looked++)
    if (command.includes('##unsupported')) return system === 'bsd' ? '##unsupported\nFreeBSD\n' : linuxAnswer(measured++)
    if (command.includes('__clavium_ctx__')) return '__clavium_ctx__\nbash\n/srv\n/home/tester\n'
    return undefined
  }
  dataDir = mkdtempSync(join(tmpdir(), 'clavium-e2e-mon-'))
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

describe('monitor of a server', () => {
  it('opens from the page of a host and shows processor, memory, network, disks and graphics card', async () => {
    await page.getByText('Welcome to Clavium').waitFor()
    await page.getByLabel('Master password', { exact: true }).fill(MASTER)
    await page.getByLabel('Repeat master password').fill(MASTER)
    await page.getByRole('button', { name: 'Create Vault' }).click()
    await page.getByText('No Hosts Yet').waitFor()
    await page.getByRole('button', { name: /New Host|Add a Host/ }).first().click()
    const sheet = page.getByRole('dialog')
    await sheet.getByLabel('Name', { exact: true }).fill('web-01')
    await sheet.getByLabel('Host', { exact: true }).fill('127.0.0.1')
    await sheet.getByLabel('Port', { exact: true }).fill(String(srv.port))
    await sheet.getByLabel('User', { exact: true }).fill(TEST_USER)
    await sheet.getByLabel(/^Password/).fill(TEST_PASSWORD)
    await sheet.getByRole('button', { name: 'Save' }).click()
    await page.locator('.host-row', { hasText: 'web-01' }).click()
    await page.locator('.view:not(.hidden)').getByRole('button', { name: 'Monitor' }).click()
    await page.getByRole('button', { name: 'Trust and Connect' }).click()

    const pane = panes()
    const card = (title: string): Locator => pane.getByRole('region', { name: title, exact: true })
    await card('Processor').waitFor()
    // rates need two measurements; the second follows after a second
    await card('Processor').getByText('40 %').first().waitFor()
    expect(await card('Processor').getByRole('meter', { name: 'Processor in use' }).getAttribute('aria-valuenow')).toBe('40')
    expect(await card('Processor').getByRole('group', { name: 'In use per core' }).getByRole('meter').count()).toBe(4)
    expect(await card('Processor').getByRole('meter', { name: 'Core 1' }).getAttribute('aria-valuetext')).toBe('96 %')
    expect(await card('Processor').innerText()).toContain('1.24 · 0.96 · 0.71')

    expect(await card('Memory').getByRole('meter', { name: 'Memory in use' }).getAttribute('aria-valuetext')).toBe('9.2 GB of 15 GB')
    expect(await card('Memory').getByRole('meter', { name: 'Swap in use' }).getAttribute('aria-valuenow')).toBe('25')
    expect(await card('Network').innerText()).toMatch(/Receiving\s+2\.0 MB\/s/)
    expect(await card('Network').innerText()).toMatch(/Sending\s+1\.0 MB\/s/)
    expect(await card('Disk Activity').innerText()).toMatch(/Reading\s+1000 KB\/s/)
    expect(await card('Graphics Card').innerText()).toContain('NVIDIA RTX A4000')
    expect(await card('Graphics Card').innerText()).toContain('71 °C')
    expect(await card('Temperatures').innerText()).toMatch(/CPU\s+58 °C/)

    // disks: the full one is marked in words, not by colour alone, and the tmpfs is left out
    const disks = card('Storage').getByRole('listitem')
    expect(await disks.count()).toBe(3)
    expect(await disks.nth(1).innerText()).toContain('Almost full')
    expect(await disks.nth(0).innerText()).not.toMatch(/Almost full|Filling up/)
    expect(await disks.nth(2).innerText()).toContain('Filling up')
    expect(await disks.nth(1).getByRole('meter').getAttribute('aria-valuenow')).toBe('94')

    expect(await pane.locator('.toolbar .subtitle').innerText()).toContain('Ubuntu 24.04.1 LTS · up for 2 d 7 h')
    expect(await page.locator('.sidebar .side-item[title^="Monitor: "]').count()).toBe(1)
  })

  it('offers the values as a table and can be paused', async () => {
    const pane = panes()
    await pane.getByText('Recent Values as a Table').click()
    const rows = pane.getByRole('table').getByRole('row')
    expect(await rows.nth(0).innerText()).toMatch(/Time\s+Processor\s+Memory\s+Receiving\s+Sending\s+Reading\s+Writing/)
    expect(await pane.getByRole('table').innerText()).toMatch(/40 %\s+60 %\s+2\.0 MB\/s\s+1\.0 MB\/s\s+1000 KB\/s\s+2\.0 MB\/s/)
    await pane.getByText('Recent Values as a Table').click()

    await pane.getByRole('button', { name: 'Pause Measuring' }).click()
    await page.waitForTimeout(500) // a measurement that was on its way arrives
    const before = measured
    await page.waitForTimeout(4000)
    expect(measured).toBe(before)
    expect(await pane.locator('.toolbar .subtitle').innerText()).toContain('paused')
    await pane.getByRole('button', { name: 'Resume Measuring' }).click()
    await expect.poll(() => measured, { timeout: 8000 }).toBeGreaterThan(before)
  })

  it('works with the keyboard alone and fits a narrow pane without scrolling sideways', { timeout: 120000 }, async () => {
    const pane = panes()
    await pane.getByRole('button', { name: 'Pause Measuring' }).focus()
    await page.keyboard.press('Enter')
    await pane.getByRole('button', { name: 'Resume Measuring' }).waitFor()
    await page.keyboard.press('Space')
    await pane.getByRole('button', { name: 'Pause Measuring' }).waitFor()

    // a chart tells its values to the arrow keys: the newest first, then the one before
    const plot = pane.getByRole('group', { name: /^Processor in use, last minute\. Processor: now \d/ })
    await plot.focus()
    await page.keyboard.press('ArrowLeft')
    const tip = plot.locator('.mon-tip')
    expect(await tip.innerText()).toMatch(/\d+:\d+:\d+.*\s+Processor\s+[\d.]+ %/)
    const newest = await pane.getByRole('region', { name: 'Processor', exact: true }).locator('[aria-live]').innerText()
    expect(newest).toMatch(/Processor [\d.]+ %$/)
    await page.keyboard.press('ArrowLeft')
    expect(await pane.getByRole('region', { name: 'Processor', exact: true }).locator('[aria-live]').innerText()).not.toBe(newest)
    await page.keyboard.press('Escape')
    expect(await tip.count()).toBe(0)
    // and to the mouse
    const network = pane.getByRole('group', { name: /^Network, last minute/ })
    await network.hover({ position: { x: ((await network.boundingBox())?.width ?? 10) - 3, y: 40 } })
    expect(await pane.locator('.mon-tip').innerText()).toMatch(/Receiving\s+[\d.]+ [KM]?B\/s\s+Sending\s+[\d.]+ [KM]?B\/s/)
    await page.mouse.move(5, 5)

    await expect.poll(() => measured, { timeout: 60000, interval: 1000 }).toBeGreaterThan(17)
    await page.screenshot({ path: join(shots, '15-monitor.png') })
    await pane.locator('.view-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await page.screenshot({ path: join(shots, '15b-monitor-storage.png') })
    await pane.locator('.view-scroll').evaluate((el) => el.scrollTo(0, 0))

    await page.setViewportSize({ width: 560, height: 800 })
    const scroll = pane.locator('.view-scroll')
    await expect.poll(() => scroll.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
    await page.setViewportSize({ width: 1280, height: 800 })
  })

  it('lists processes with their load, and ends one after asking', async () => {
    const pane = panes()
    await pane.getByRole('button', { name: 'Processes', exact: true }).click()
    const table = pane.getByRole('region', { name: 'Processes' }).getByRole('table')
    const row = (name: string): Locator => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${name}`) }) })
    await row('node').waitFor()
    // shares need two readings; node used 300 of the 300 ticks one core had: one whole core
    await expect.poll(() => row('node').first().innerText(), { timeout: 10000 }).toMatch(/tester\s+100 %\s+469 MB · 3\.0 %\s+1500/)
    // sorted by processor, highest first
    expect(await table.getByRole('rowheader').first().innerText()).toMatch(/^node/)
    expect(await table.getByRole('columnheader', { name: 'Processor' }).getAttribute('aria-sort')).toBe('descending')
    expect(await row('node').first().innerText()).toContain('node /srv/app/server.js')
    // what cannot be ended offers no actions: the first process, threads of the kernel
    expect(await row('systemd').getByRole('button').count()).toBe(0)
    expect(await row('\\[kthreadd\\]').getByRole('button').count()).toBe(0)
    expect(await row('sh').innerText()).toContain('this connection')
    expect(await pane.getByRole('status').first().innerText()).toBe('9 processes')

    await table.getByRole('columnheader', { name: 'Memory' }).getByRole('button').click()
    expect(await table.getByRole('rowheader').first().innerText()).toMatch(/^postgres/)
    await pane.getByLabel('Search processes').fill('nginx')
    await expect.poll(() => table.getByRole('row').count()).toBe(3)
    expect(await pane.getByRole('status').first().innerText()).toBe('2 of 9 processes')
    await pane.getByLabel('Search processes').fill('')
    await pane.getByRole('button', { name: 'Only Mine' }).click()
    await expect.poll(() => table.getByRole('rowheader').allInnerTexts().then((t) => t.map((x) => x.split(/\s/)[0]).sort())).toEqual(['node', 'sh', 'sshd'])
    await pane.getByRole('button', { name: 'Only Mine' }).click()
    await page.screenshot({ path: join(shots, '17-monitor-processes.png') })

    // a process of another user: sudo is tried, and its refusal is explained
    await row('postgres').getByRole('button', { name: 'Actions for postgres, process 1600' }).click()
    await page.getByRole('menuitem', { name: 'End…' }).click()
    const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog'))
    expect(await dialog.innerText()).toContain('It belongs to root, not to tester')
    await dialog.getByRole('button', { name: 'End', exact: true }).click()
    await page.getByText('only use sudo with a password').waitFor()
    expect(signals).toEqual(['sudo TERM 1600'])
    await row('postgres').waitFor()

    // the user's own process, with the keyboard
    await row('node').first().getByRole('button', { name: /Actions for node/ }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Force Quit…' }).click()
    expect(await dialog.innerText()).toContain('stopped at once')
    expect(await dialog.innerText()).not.toContain('sudo')
    await dialog.getByRole('button', { name: 'Force Quit' }).click()
    await expect.poll(() => row('node').count(), { timeout: 8000 }).toBe(0)
    expect(signals).toEqual(['sudo TERM 1600', 'KILL 1500'])
  })

  it('lists open ports with owner and program, and says what this user may not see', async () => {
    running.add(1500)
    const pane = panes()
    await pane.getByRole('button', { name: 'Ports', exact: true }).click()
    const table = pane.getByRole('region', { name: 'Open ports' }).getByRole('table')
    const row = (port: number): Locator => table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${port}\\b`) }) })
    await expect.poll(() => row(3000).count(), { timeout: 10000 }).toBe(1)
    // the user's own program is named; IPv4 and IPv6 of sshd are one line, its program is hidden
    expect(await row(3000).innerText()).toMatch(/3000\s+TCP\s+usually a web app\s+Every network\s+0\.0\.0\.0\s+node\s+node \/srv\/app\/server\.js\s+tester/)
    expect(await row(22).innerText()).toMatch(/22\s+TCP\s+usually SSH\s+Every network\s+0\.0\.0\.0, ::\s+A program of root\. tester may not see which one\.\s+root/)
    expect(await row(5432).innerText()).toMatch(/This server only\s+127\.0\.0\.1/)
    expect(await pane.locator('.note').innerText()).toContain('2 ports belong to other users')
    await page.screenshot({ path: join(shots, '18-monitor-ports.png') })

    // a port whose program is hidden offers nothing that would need the program
    await row(22).getByRole('button', { name: 'Actions for port 22 (TCP)' }).click()
    expect(await page.getByRole('menuitem').allInnerTexts()).toEqual(['Copy Port'])
    await page.keyboard.press('Escape')

    await row(3000).getByRole('button', { name: 'Actions for port 3000 (TCP)' }).click()
    await page.getByRole('menuitem', { name: 'Show in Processes' }).click()
    const processes = pane.getByRole('region', { name: 'Processes' }).getByRole('table')
    await expect.poll(() => processes.getByRole('rowheader').allInnerTexts().then((t) => t.map((x) => x.split(/\s/)[0]))).toEqual(['node'])

    await pane.getByRole('button', { name: 'Ports', exact: true }).click()
    await row(3000).getByRole('button', { name: 'Actions for port 3000 (TCP)' }).click()
    await page.getByRole('menuitem', { name: 'End “node”…' }).click()
    await page.getByRole('alertdialog').or(page.getByRole('dialog')).getByRole('button', { name: 'End', exact: true }).click()
    await expect.poll(() => row(3000).count(), { timeout: 8000 }).toBe(0)
    expect(signals.at(-1)).toBe('TERM 1500')
    await pane.getByRole('button', { name: 'Overview', exact: true }).click()
  })

  it('opens next to a terminal and comes back after a restart', async () => {
    await page.locator('.sidebar').getByRole('button', { name: 'Hosts', exact: true }).click()
    await page.locator('.view:not(.hidden)').getByRole('button', { name: 'Connect' }).click()
    await page.locator('.pane:not(.hidden) .xterm-rows', { hasText: 'Welcome to the Clavium test server' }).waitFor()
    await panes().getByRole('button', { name: 'Split View and Workspace' }).click()
    await page.getByRole('menuitem', { name: 'Monitor to the Right' }).click()
    await expect.poll(() => panes().count()).toBe(2)
    await expect.poll(() => panes().nth(1).getByRole('meter', { name: 'Processor in use' }).getAttribute('aria-valuetext'), { timeout: 15000 }).toMatch(/\d %$/)
    await page.screenshot({ path: join(shots, '16-monitor-split.png') })

    await page.waitForTimeout(1500) // the tabs of the session are saved shortly after they change
    await app.close()
    await launch()
    await page.getByLabel('Master password', { exact: true }).fill(MASTER)
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect.poll(() => panes().count(), { timeout: 15000 }).toBe(2)
    await panes().nth(1).getByRole('region', { name: 'Processor', exact: true }).waitFor()
  })

  it('says so on a server that is not Linux', async () => {
    system = 'bsd'
    await panes().first().getByRole('button', { name: /^Monitor/ }).click()
    await page.getByText('The Monitor Works on Linux Servers').waitFor()
    expect(await panes().innerText()).toContain('This server runs FreeBSD')
    const before = measured
    await page.waitForTimeout(3500)
    expect(measured).toBe(before)
  })
})
