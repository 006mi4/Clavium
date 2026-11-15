import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FtpSrv } from 'ftp-srv'
import { DEFAULT_TRANSFER_SETTINGS, type HostRecord, type TransferSettings, type TransferSnapshot } from '@shared/types'
import { PART_SUFFIX } from '../src/main/core/queue'
import { Throttle } from '../src/main/core/remotefs'
import { FileManager } from '../src/main/files'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer
let ftpRoot: string
let ftp: FtpSrv
const ftpPort = 36000 + Math.floor(Math.random() * 3000)
const open: FileManager[] = []

beforeAll(async () => {
  srv = await startTestSshServer()
  ftpRoot = mkdtempSync(join(tmpdir(), 'clavium-queue-ftp-'))
  ftp = new FtpSrv({ url: `ftp://127.0.0.1:${ftpPort}`, pasv_url: '127.0.0.1', pasv_min: ftpPort + 1, pasv_max: ftpPort + 60, anonymous: false, greeting: 'test' })
  ftp.on('login', ({ username, password }, resolve, reject) => {
    if (username === 'ftpuser' && password === 'ftppass') resolve({ root: ftpRoot })
    else reject(new Error('bad login'))
  })
  await ftp.listen()
})
afterAll(async () => {
  await srv.close()
  await ftp.close()
  rmSync(ftpRoot, { recursive: true, force: true })
})
afterEach(() => {
  for (const fm of open.splice(0)) fm.closeAll()
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function setup(kind: 'sftp' | 'ftp' = 'sftp', patch: Partial<TransferSettings> = {}) {
  const { vault } = await newUnlockedVault()
  const local = mkdtempSync(join(tmpdir(), 'clavium-queue-'))
  const settings: TransferSettings = { ...DEFAULT_TRANSFER_SETTINGS, ...patch }
  const snapshots: TransferSnapshot[] = []
  const changed: string[] = []
  const fm = new FileManager(
    vault,
    recordingPrompter(),
    (channel, payload) => {
      if (channel === 'files:queue') snapshots.push(payload as TransferSnapshot)
      if (channel === 'files:changed') changed.push(payload as string)
    },
    undefined,
    () => settings
  )
  open.push(fm)
  const host: HostRecord = kind === 'sftp' ? sshHost(srv.port) : sshHost(ftpPort, { protocol: 'ftp', username: 'ftpuser', password: 'ftppass' })
  const id = await fm.open(host)
  const remoteRoot = kind === 'sftp' ? srv.root : ftpRoot
  /** A folder on the server that only this test uses. */
  const dir = '/' + randomBytes(4).toString('hex')
  mkdirSync(join(remoteRoot, dir))
  const until = async (what: (s: TransferSnapshot) => unknown, ms = 15_000): Promise<TransferSnapshot> => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      const s = fm.transfers()
      if (what(s)) return s
      await sleep(15)
    }
    throw new Error('Timed out. Queue: ' + JSON.stringify(fm.transfers().items))
  }
  return { fm, id, local, settings, snapshots, changed, dir, onServer: (...p: string[]) => join(remoteRoot, dir, ...p), until, fs: fm.get(id) }
}

const file = (path: string, bytes: number): Buffer => {
  const data = randomBytes(bytes)
  writeFileSync(path, data)
  return data
}

describe('throttle', () => {
  it('lets data through at the allowed speed, and at once without a limit', async () => {
    let rate = 100_000
    const throttle = new Throttle(() => rate)
    const start = Date.now()
    for (let i = 0; i < 6; i++) await throttle.take(10_000)
    expect(Date.now() - start).toBeGreaterThanOrEqual(450)
    rate = 0
    const free = Date.now()
    for (let i = 0; i < 100; i++) await throttle.take(1_000_000)
    expect(Date.now() - free).toBeLessThan(100)
  })
})

describe('transfer queue', () => {
  it('runs several transfers at the same time, up to the limit', async () => {
    const t = await setup('sftp', { transferConcurrency: 3, transferLimitKbps: 600 })
    const src = join(t.local, 'many')
    mkdirSync(src)
    const data = Array.from({ length: 7 }, (_, i) => file(join(src, `f${i}.bin`), 150_000))
    await t.fm.upload(t.id, [src], t.dir)
    expect(Math.max(...t.snapshots.map((s) => s.counts.running))).toBe(3)
    data.forEach((d, i) => expect(readFileSync(t.onServer('many', `f${i}.bin`)).equals(d)).toBe(true))
    expect(t.fm.transfers().counts).toMatchObject({ done: 7, failed: 0, running: 0, queued: 0 })
    expect(t.changed).toContain(t.id)
  })

  it('reports speed and remaining time, and respects the speed limit', async () => {
    const t = await setup('sftp', { transferLimitKbps: 256 })
    file(join(t.local, 'slow.bin'), 512 * 1024)
    const start = Date.now()
    await t.fm.upload(t.id, [join(t.local, 'slow.bin')], t.dir)
    expect(Date.now() - start).toBeGreaterThanOrEqual(1500)
    const running = t.snapshots.flatMap((s) => s.items).filter((i) => i.state === 'running' && i.speed > 0)
    expect(running.length).toBeGreaterThan(0)
    expect(running.some((i) => i.eta !== undefined)).toBe(true)
    // the limit is 256 KiB per second; the smoothed display may be a little off
    expect(Math.max(...running.map((i) => i.speed))).toBeLessThan(400 * 1024)
    expect(t.snapshots.some((s) => s.speed > 0 && s.eta !== undefined)).toBe(true)
  })

  for (const kind of ['sftp', 'ftp'] as const) {
    it(`pauses an upload and a download and continues them where they stopped (${kind})`, async () => {
      const t = await setup(kind, { transferLimitKbps: 2048 })
      const size = 3 * 1024 * 1024
      const data = file(join(t.local, 'movie.bin'), size)

      const upload = t.fm.upload(t.id, [join(t.local, 'movie.bin')], t.dir)
      let item = (await t.until((s) => s.items.find((i) => i.state === 'running' && i.transferred > 200_000))).items[0]
      t.fm.queueAction('pause', item.id)
      item = (await t.until((s) => s.items[0].state === 'paused')).items[0]
      await sleep(200)
      const partial = statSync(t.onServer('movie.bin')).size
      expect(partial).toBeGreaterThan(0)
      expect(partial).toBeLessThan(size)
      t.snapshots.length = 0
      t.fm.queueAction('resume', item.id)
      await upload
      expect(t.fm.transfers().items[0].state).toBe('done')
      expect(readFileSync(t.onServer('movie.bin')).equals(data)).toBe(true)
      // it did not start again from the beginning
      const resumedAt = t.snapshots.flatMap((s) => s.items).find((i) => i.state === 'running' && i.transferred > 0)
      expect(resumedAt?.transferred).toBeGreaterThanOrEqual(Math.min(partial, item.transferred))

      t.fm.clearFinishedTransfers()
      const down = join(t.local, 'down')
      mkdirSync(down)
      const download = t.fm.download(t.id, [await t.fs.stat(`${t.dir}/movie.bin`)], { localDir: down })
      item = (await t.until((s) => s.items.find((i) => i.state === 'running' && i.transferred > 200_000))).items[0]
      t.fm.queueAction('pause', item.id)
      await t.until((s) => s.items[0].state === 'paused')
      // an unfinished download is kept under another name
      expect(readdirSync(down)).toEqual(['movie.bin' + PART_SUFFIX])
      const kept = statSync(join(down, 'movie.bin' + PART_SUFFIX)).size
      expect(kept).toBeGreaterThan(0)
      expect(kept).toBeLessThan(size)
      t.fm.queueAction('resume', item.id)
      await download
      expect(readdirSync(down)).toEqual(['movie.bin'])
      expect(readFileSync(join(down, 'movie.bin')).equals(data)).toBe(true)
    })
  }

  it('pauses and resumes the whole queue and moves entries', async () => {
    const t = await setup('sftp', { transferConcurrency: 1 })
    t.fm.queueAction('pause')
    for (const name of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(t.local, name), name)
    const upload = t.fm.upload(t.id, ['a.txt', 'b.txt', 'c.txt'].map((n) => join(t.local, n)), t.dir)
    let s = await t.until((x) => x.counts.queued === 3)
    expect(s.paused).toBe(true)
    await sleep(200)
    expect(readdirSync(t.onServer())).toEqual([])
    const order = (): string[] => t.fm.transfers().items.map((i) => i.name)
    const idOf = (name: string): string => t.fm.transfers().items.find((i) => i.name === name)!.id
    t.fm.queueAction('top', idOf('c.txt'))
    expect(order()).toEqual(['c.txt', 'a.txt', 'b.txt'])
    t.fm.queueAction('down', idOf('c.txt'))
    expect(order()).toEqual(['a.txt', 'c.txt', 'b.txt'])
    t.fm.queueAction('bottom', idOf('a.txt'))
    t.fm.queueAction('up', idOf('a.txt'))
    expect(order()).toEqual(['c.txt', 'a.txt', 'b.txt'])
    // one entry can be held and released on its own
    t.fm.queueAction('pause', idOf('b.txt'))
    expect(t.fm.transfers().items.find((i) => i.name === 'b.txt')?.state).toBe('paused')
    t.fm.queueAction('resume', idOf('b.txt'))
    s = t.fm.transfers()
    expect(s.items.find((i) => i.name === 'b.txt')?.state).toBe('queued')
    expect(s.paused).toBe(true)
    t.fm.queueAction('pause', idOf('b.txt'))
    // "resume all" also releases what was held
    t.fm.queueAction('resume')
    await upload
    expect(readdirSync(t.onServer()).sort()).toEqual(['a.txt', 'b.txt', 'c.txt'])
    t.fm.queueAction('pause') // an empty queue can be paused too
    t.fm.queueAction('resume')
  })

  it('applies the rules for files that already exist', async () => {
    const t = await setup()
    const local = join(t.local, 'notes.txt')
    const put = (text: string, rule: Parameters<FileManager['upload']>[3]): Promise<void> => {
      writeFileSync(local, text)
      return t.fm.upload(t.id, [local], t.dir, rule)
    }
    const remote = (name = 'notes.txt'): string => readFileSync(t.onServer(name), 'utf8')

    await put('first', 'skip')
    expect(remote()).toBe('first') // nothing was in the way
    await put('second', 'skip')
    expect(remote()).toBe('first')
    expect(t.fm.transfers().items.at(-1)?.state).toBe('skipped')
    await put('third', 'overwrite')
    expect(remote()).toBe('third')
    await put('fourth', 'rename')
    expect(remote()).toBe('third')
    expect(remote('notes (1).txt')).toBe('fourth')

    // only if newer
    writeFileSync(local, 'old')
    utimesSync(local, new Date('2001-01-01'), new Date('2001-01-01'))
    await t.fm.upload(t.id, [local], t.dir, 'newer')
    expect(remote()).toBe('third')
    utimesSync(local, new Date(Date.now() + 3_600_000), new Date(Date.now() + 3_600_000))
    await t.fm.upload(t.id, [local], t.dir, 'newer')
    expect(remote()).toBe('old')

    // continue a file that is partly there
    writeFileSync(t.onServer('notes.txt'), 'ABC')
    await put('abcdefgh', 'resume')
    expect(remote()).toBe('ABCdefgh')
    await put('12345678', 'resume') // same size: taken as complete
    expect(remote()).toBe('ABCdefgh')

    // the same rules for downloads
    const down = join(t.local, 'down')
    mkdirSync(down)
    const entry = await t.fs.stat(`${t.dir}/notes.txt`)
    const get = (rule: Parameters<FileManager['download']>[3]): Promise<void> => t.fm.download(t.id, [entry], { localDir: down }, rule)
    await get('skip')
    writeFileSync(join(down, 'notes.txt'), 'mine')
    await get('skip')
    expect(readFileSync(join(down, 'notes.txt'), 'utf8')).toBe('mine')
    await get('rename')
    expect(readFileSync(join(down, 'notes (1).txt'), 'utf8')).toBe('ABCdefgh')
    writeFileSync(join(down, 'notes.txt'), 'XYZ')
    await get('resume')
    expect(readFileSync(join(down, 'notes.txt'), 'utf8')).toBe('XYZdefgh')
    await get('overwrite')
    expect(readFileSync(join(down, 'notes.txt'), 'utf8')).toBe('ABCdefgh')
    expect(readdirSync(down).sort()).toEqual(['notes (1).txt', 'notes.txt'])
  })

  it('asks about existing files, one question at a time, and can apply the answer to all', async () => {
    const t = await setup()
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      writeFileSync(join(t.local, name), 'new ' + name)
      if (name !== 'c.txt') writeFileSync(t.onServer(name), 'old ' + name)
    }
    const upload = t.fm.upload(t.id, ['a.txt', 'b.txt', 'c.txt'].map((n) => join(t.local, n)), t.dir)
    // the file that is not in the way goes through while the questions are open
    let s = await t.until((x) => x.counts.asking === 2 && x.counts.done === 1)
    expect(s.conflict).toMatchObject({ name: 'a.txt', direction: 'upload', target: `${t.dir}/a.txt`, waiting: 1, existing: { size: 9 }, source: { size: 9 } })
    t.fm.answerConflict(s.conflict!.id, 'overwrite', false)
    s = await t.until((x) => x.counts.asking === 1 && x.counts.done === 2)
    expect(s.conflict).toMatchObject({ name: 'b.txt', waiting: 0 })
    t.fm.answerConflict(s.conflict!.id, 'skip', false)
    await upload
    expect(readFileSync(t.onServer('a.txt'), 'utf8')).toBe('new a.txt')
    expect(readFileSync(t.onServer('b.txt'), 'utf8')).toBe('old b.txt')
    expect(t.fm.transfers().conflict).toBeNull()

    // one answer for all that wait
    const again = t.fm.upload(t.id, ['a.txt', 'b.txt'].map((n) => join(t.local, n)), t.dir)
    s = await t.until((x) => x.counts.asking === 2)
    t.fm.answerConflict(s.conflict!.id, 'overwrite', true)
    await again
    expect(readFileSync(t.onServer('b.txt'), 'utf8')).toBe('new b.txt')

    // cancelling a question leaves the file alone
    writeFileSync(t.onServer('a.txt'), 'kept')
    const third = t.fm.upload(t.id, [join(t.local, 'a.txt')], t.dir)
    s = await t.until((x) => x.conflict)
    t.fm.queueAction('cancel', s.conflict!.id)
    await third
    expect(readFileSync(t.onServer('a.txt'), 'utf8')).toBe('kept')
  })

  it('keeps the modification time, and the permissions of new files', async () => {
    const t = await setup()
    const local = join(t.local, 'run.sh')
    writeFileSync(local, '#!/bin/sh\n')
    const when = new Date('2020-02-02T10:20:30Z')
    utimesSync(local, when, when)
    if (process.platform !== 'win32') chmodSync(local, 0o750)
    await t.fm.upload(t.id, [local], t.dir)
    expect(statSync(t.onServer('run.sh')).mtimeMs).toBe(when.getTime())
    if (process.platform !== 'win32') expect(statSync(t.onServer('run.sh')).mode & 0o777).toBe(0o750)

    const down = join(t.local, 'down')
    mkdirSync(down)
    await t.fm.download(t.id, [await t.fs.stat(`${t.dir}/run.sh`)], { localDir: down })
    expect(statSync(join(down, 'run.sh')).mtimeMs).toBe(when.getTime())
    if (process.platform !== 'win32') expect(statSync(join(down, 'run.sh')).mode & 0o777).toBe(0o750)

    // switched off, the file is simply new
    t.settings.transferPreserve = false
    await t.fm.upload(t.id, [local], t.dir, 'overwrite')
    expect(statSync(t.onServer('run.sh')).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  })

  it('goes on with the rest of a folder when one file fails, and can retry what failed', async () => {
    const t = await setup()
    mkdirSync(t.onServer('site', 'css'), { recursive: true })
    writeFileSync(t.onServer('site', 'index.html'), '<h1>hi</h1>')
    writeFileSync(t.onServer('site', 'css', 'main.css'), 'body{}')
    writeFileSync(t.onServer('site', 'z.txt'), 'last')
    const down = join(t.local, 'down')
    // a folder sits where a file is supposed to go
    mkdirSync(join(down, 'site', 'index.html'), { recursive: true })
    await t.fm.download(t.id, [await t.fs.stat(`${t.dir}/site`)], { localDir: down })
    let s = t.fm.transfers()
    expect(s.counts).toMatchObject({ done: 2, failed: 1 })
    expect(s.items.find((i) => i.state === 'failed')).toMatchObject({ name: 'index.html', error: 'A folder with this name is in the way' })
    expect(readFileSync(join(down, 'site', 'css', 'main.css'), 'utf8')).toBe('body{}')
    expect(readFileSync(join(down, 'site', 'z.txt'), 'utf8')).toBe('last')

    rmSync(join(down, 'site', 'index.html'), { recursive: true })
    t.fm.queueAction('retry')
    s = await t.until((x) => x.counts.done === 3)
    expect(s.counts.failed).toBe(0)
    expect(readFileSync(join(down, 'site', 'index.html'), 'utf8')).toBe('<h1>hi</h1>')

    // a folder that cannot be read is reported and read again on retry
    const gone = join(t.local, 'later')
    const upload = t.fm.upload(t.id, [gone, join(down, 'site', 'z.txt')], t.dir)
    await upload
    s = t.fm.transfers()
    expect(s.items.find((i) => i.name === 'later')?.state).toBe('failed')
    expect(readFileSync(t.onServer('z.txt'), 'utf8')).toBe('last')
    mkdirSync(gone)
    writeFileSync(join(gone, 'now.txt'), 'here')
    t.fm.queueAction('retry')
    await t.until((x) => x.counts.failed === 0 && x.counts.running + x.counts.queued === 0 && !x.scanning)
    expect(readFileSync(t.onServer('later', 'now.txt'), 'utf8')).toBe('here')
    t.fm.clearFinishedTransfers()
    expect(t.fm.transfers().items).toEqual([])
  })

  it('never lets names from the server leave the target folder or fall together', async () => {
    const t = await setup()
    mkdirSync(t.onServer('pack'))
    writeFileSync(t.onServer('pack', 'Readme.txt'), 'upper')
    writeFileSync(t.onServer('pack', 'a_b'), 'plain')
    const entries = await t.fs.list(`${t.dir}/pack`)
    // what a hostile or merely different server could send
    entries.push({ ...entries[0], name: '..\\..\\evil.txt' }, { ...entries.find((e) => e.name === 'a_b')!, name: 'a:b', path: `${t.dir}/pack/a_b` + ' ' })
    const down = join(t.local, 'down')
    mkdirSync(down)
    await t.fm.download(t.id, entries, { localDir: down })
    expect(existsSync(join(t.local, 'evil.txt'))).toBe(false)
    expect(readdirSync(t.local).sort()).toEqual(['down'])
    // "a:b" becomes "a_b" here and must not replace the real "a_b"
    expect(readdirSync(down)).toContain('a_b')
    expect(readFileSync(join(down, 'a_b'), 'utf8')).toBe('plain')
  })

  it('fails what is left when the session closes', async () => {
    const t = await setup('sftp', { transferLimitKbps: 64, transferConcurrency: 1 })
    file(join(t.local, 'one.bin'), 400_000)
    file(join(t.local, 'two.bin'), 400_000)
    const upload = t.fm.upload(t.id, [join(t.local, 'one.bin'), join(t.local, 'two.bin')], t.dir)
    await t.until((s) => s.counts.running === 1 && s.counts.queued === 1)
    t.fm.close(t.id)
    await upload
    expect(t.fm.transfers().counts).toMatchObject({ failed: 2, running: 0, queued: 0 })
  })

  it('leaves no unfinished downloads behind when the app quits, and gives back a file it was continuing', async () => {
    const t = await setup('sftp', { transferLimitKbps: 256, transferConcurrency: 2 })
    const data = file(t.onServer('running.bin'), 600_000)
    file(t.onServer('paused.bin'), 600_000)
    file(t.onServer('continued.bin'), 600_000)
    const down = join(t.local, 'down')
    mkdirSync(down)
    // half of a file from an earlier day, which the rule "resume" goes on with
    writeFileSync(join(down, 'continued.bin'), data.subarray(0, 100_000))
    const entry = (name: string) => t.fs.stat(`${t.dir}/${name}`)

    void t.fm.download(t.id, [await entry('paused.bin')], { localDir: down })
    const paused = (await t.until((s) => s.items.find((i) => i.state === 'running' && i.transferred > 50_000))).items[0]
    t.fm.queueAction('pause', paused.id)
    await t.until((s) => s.items[0].state === 'paused')
    void t.fm.download(t.id, [await entry('running.bin')], { localDir: down })
    void t.fm.download(t.id, [await entry('continued.bin')], { localDir: down }, 'resume')
    await t.until((s) => s.items.filter((i) => i.state === 'running' && i.transferred > 150_000).length === 2)
    expect(readdirSync(down).sort()).toEqual(['continued.bin', 'paused.bin', 'running.bin'].map((n) => n + PART_SUFFIX))

    // quitting does not wait for anything: the folder must be clean the moment this returns
    t.fm.closeAll()
    expect(readdirSync(down)).toEqual(['continued.bin'])
    expect(statSync(join(down, 'continued.bin')).size).toBeGreaterThanOrEqual(100_000)
    await sleep(500)
    expect(readdirSync(down)).toEqual(['continued.bin'])
  })
})
