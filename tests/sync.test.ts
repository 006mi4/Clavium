import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FtpSrv } from 'ftp-srv'
import { allowedActions, defaultAction } from '@shared/sync'
import { DEFAULT_TRANSFER_SETTINGS, type HostRecord, type SyncComparison, type SyncMode, type SyncOptions, type WatchStatus } from '@shared/types'
import { listTime } from '../src/main/core/remotefs'
import { classify, detectOffsetMinutes, localPathOf, type FilePair } from '../src/main/core/sync'
import { FileManager, type Desktop } from '../src/main/files'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { holdFile } from './helpers/holdFile'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer
let ftpRoot: string
let ftp: FtpSrv
const ftpPort = 40000 + Math.floor(Math.random() * 3000)
const open: FileManager[] = []
const HOUR = 3600_000
const T0 = Date.UTC(2026, 4, 1, 12, 0, 0)
const BY_TIME: SyncOptions = { compareBy: 'time', offsetMinutes: null }

beforeAll(async () => {
  srv = await startTestSshServer()
  ftpRoot = mkdtempSync(join(tmpdir(), 'clavium-sync-ftp-'))
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

async function setup(kind: 'sftp' | 'ftp' = 'sftp') {
  const { vault } = await newUnlockedVault()
  const local = mkdtempSync(join(tmpdir(), 'clavium-sync-'))
  const trashDir = mkdtempSync(join(tmpdir(), 'clavium-trash-'))
  const watches: WatchStatus[][] = []
  const desktop: Desktop = {
    tempRoot: tmpdir(),
    readClipboardFiles: async () => [],
    writeClipboardFiles: async () => undefined,
    clearClipboard: () => undefined,
    trash: async (path) => renameSync(path, join(trashDir, basename(path)))
  }
  const fm = new FileManager(
    vault,
    recordingPrompter(),
    (channel, payload) => {
      if (channel === 'files:watch') watches.push(payload as WatchStatus[])
    },
    desktop,
    () => DEFAULT_TRANSFER_SETTINGS
  )
  open.push(fm)
  const host: HostRecord = kind === 'sftp' ? sshHost(srv.port) : sshHost(ftpPort, { protocol: 'ftp', username: 'ftpuser', password: 'ftppass' })
  const id = await fm.open(host)
  const remoteRoot = kind === 'sftp' ? srv.root : ftpRoot
  const dir = '/' + randomBytes(4).toString('hex')
  mkdirSync(join(remoteRoot, dir))
  const onServer = (...p: string[]): string => join(remoteRoot, dir, ...p)
  const here = (...p: string[]): string => join(local, ...p)
  /** Write a file with a known modification time. */
  const put = (path: string, content: string, at = T0): void => {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
    utimesSync(path, new Date(at), new Date(at))
  }
  const compare = (options: SyncOptions = BY_TIME): Promise<SyncComparison> => fm.syncCompare(id, dir, local, options, randomBytes(4).toString('hex'))
  const kinds = (c: SyncComparison): Record<string, string> => Object.fromEntries(c.items.map((i) => [i.rel, i.kind]))
  const apply = (c: SyncComparison, mode: SyncMode, confirmedDeletes?: number) => {
    const chosen = c.items.map((i) => ({ rel: i.rel, action: defaultAction(i, mode) }))
    const deletes = chosen.filter((a) => a.action.startsWith('delete')).length
    return fm.syncApply(c.id, chosen, confirmedDeletes ?? deletes)
  }
  return { fm, id, local, dir, trashDir, watches, onServer, here, put, compare, kinds, apply }
}

/** A local folder and a server folder that differ in every way a comparison knows. */
function scenario(t: Awaited<ReturnType<typeof setup>>): void {
  t.put(t.here('same.txt'), 'equal')
  t.put(t.onServer('same.txt'), 'equal')
  t.put(t.here('edited-here.txt'), 'new text', T0 + HOUR)
  t.put(t.onServer('edited-here.txt'), 'old')
  t.put(t.here('edited-there.txt'), 'old')
  t.put(t.onServer('edited-there.txt'), 'new text', T0 + HOUR)
  t.put(t.here('clash.txt'), 'short')
  t.put(t.onServer('clash.txt'), 'much longer')
  t.put(t.here('only-here.txt'), 'local')
  t.put(t.here('new-dir', 'deep', 'a.txt'), 'a')
  t.put(t.onServer('only-there.txt'), 'remote')
  t.put(t.onServer('old-dir', 'b.txt'), 'b')
  t.put(t.here('shared', 'x.txt'), 'x')
  t.put(t.onServer('shared', 'x.txt'), 'x')
  // never compared
  t.put(t.here('.DS_Store'), 'junk')
  t.put(t.onServer('half.bin.clavium-part'), 'junk')
}

describe('telling files apart', () => {
  const pair = (localAt: number, remoteAt: number, sizes: [number, number] = [5, 5], precision?: FilePair['precision']): FilePair => ({
    rel: 'f',
    local: { size: sizes[0], modifiedAt: localAt },
    remote: { size: sizes[1], modifiedAt: remoteAt },
    precision
  })
  const byTime = { compareBy: 'time' as const, offsetMinutes: 0 }

  it('compares by time and size, with room for the coarse times of FTP', () => {
    expect(classify(pair(T0, T0 + 1500), byTime)).toBeNull()
    expect(classify(pair(T0 + 5000, T0), byTime)).toBe('localNewer')
    expect(classify(pair(T0, T0 + 5000), byTime)).toBe('remoteNewer')
    expect(classify(pair(T0, T0, [5, 9]), byTime)).toBe('different')
    // a listing that knows minutes only
    expect(classify(pair(T0 + 59_000, T0, [5, 5], 'minute'), byTime)).toBeNull()
    expect(classify(pair(T0 + 3 * 60_000, T0, [5, 5], 'minute'), byTime)).toBe('localNewer')
    // a listing that knows the day only
    expect(classify(pair(T0 + 20 * HOUR, T0, [5, 5], 'day'), byTime)).toBeNull()
    expect(classify(pair(T0 + 30 * HOUR, T0, [5, 5], 'day'), byTime)).toBe('localNewer')
    // a server that tells no time
    expect(classify(pair(T0, 0), byTime)).toBeNull()
    expect(classify(pair(T0, 0, [5, 9]), byTime)).toBe('different')
  })

  it('can ignore the time, and takes a shifted server clock into account', () => {
    expect(classify(pair(T0 + 9 * HOUR, T0), { compareBy: 'size', offsetMinutes: 0 })).toBeNull()
    expect(classify(pair(T0 + 9 * HOUR, T0, [5, 9]), { compareBy: 'size', offsetMinutes: 0 })).toBe('localNewer')
    // the server shows every time two hours ahead
    expect(classify(pair(T0, T0 + 2 * HOUR), { compareBy: 'time', offsetMinutes: 120 })).toBeNull()
    expect(classify(pair(T0, T0 + 2 * HOUR), byTime)).toBe('remoteNewer')
  })

  it('finds the shift of the server clock from the files, and only when it is clear', () => {
    const shifted = [0, 1, 2, 3].map((i) => pair(T0 + i * 1000, T0 + i * 1000 + 2 * HOUR + 20_000, [5, 5], 'minute'))
    expect(detectOffsetMinutes(shifted)).toBe(120)
    expect(detectOffsetMinutes(shifted.slice(0, 2))).toBe(0)
    expect(detectOffsetMinutes([0, 1, 2, 3].map((i) => pair(T0 + i, T0 + i + 500)))).toBe(0)
    // most files were simply changed at other times: no shift
    const mixed = [...shifted.slice(0, 3), ...[7, 11, 13, 17, 19].map((m) => pair(T0, T0 + m * 61_000 * 7))]
    expect(detectOffsetMinutes(mixed)).toBe(0)
    expect(detectOffsetMinutes([0, 1, 2].map((i) => pair(T0 + i, T0 - 330 * 60_000 + i)))).toBe(-330)
  })

  it('reads the times of plain FTP listings', () => {
    const now = Date.UTC(2026, 10, 15, 10, 0)
    expect(listTime('Mar  9 14:05', now)).toEqual({ modifiedAt: Date.UTC(2026, 2, 9, 14, 5), timePrecision: 'minute' })
    // no year: within the last twelve months
    expect(listTime('Dec 24 08:00', now)).toEqual({ modifiedAt: Date.UTC(2025, 11, 24, 8, 0), timePrecision: 'minute' })
    expect(listTime('Mar 9 2023', now)).toEqual({ modifiedAt: Date.UTC(2023, 2, 9), timePrecision: 'day' })
    expect(listTime('03-09-23 02:05PM', now)).toEqual({ modifiedAt: Date.UTC(2023, 2, 9, 14, 5), timePrecision: 'minute' })
    expect(listTime('12-31-99 12:30AM', now)).toEqual({ modifiedAt: Date.UTC(1999, 11, 31, 0, 30), timePrecision: 'minute' })
    expect(listTime('whatever', now)).toEqual({ modifiedAt: 0 })
  })

  it('offers deleting only for what exists on one side, and never by default outside a mirror', () => {
    expect(allowedActions({ kind: 'onlyLocal' })).toEqual(['upload', 'deleteLocal', 'skip'])
    expect(allowedActions({ kind: 'onlyRemote' })).toEqual(['download', 'deleteRemote', 'skip'])
    expect(allowedActions({ kind: 'different' })).toEqual(['upload', 'download', 'skip'])
    const all = ['onlyLocal', 'onlyRemote', 'localNewer', 'remoteNewer', 'different'] as const
    for (const mode of ['upload', 'download', 'both'] as const) for (const kind of all) expect(defaultAction({ kind }, mode)).not.toMatch(/delete/)
    expect(all.map((kind) => defaultAction({ kind }, 'upload'))).toEqual(['upload', 'skip', 'upload', 'skip', 'upload'])
    expect(all.map((kind) => defaultAction({ kind }, 'both'))).toEqual(['upload', 'download', 'upload', 'download', 'skip'])
    expect(all.map((kind) => defaultAction({ kind }, 'mirrorUpload'))).toEqual(['upload', 'deleteRemote', 'upload', 'upload', 'upload'])
    expect(all.map((kind) => defaultAction({ kind }, 'mirrorDownload'))).toEqual(['deleteLocal', 'download', 'download', 'download', 'download'])
  })

  it('never builds a local path that leaves the folder', () => {
    expect(() => localPathOf('/tmp/x', '../evil')).toThrow()
    expect(() => localPathOf('/tmp/x', 'a/../../evil')).toThrow()
    expect(() => localPathOf('/tmp/x', 'a//b')).toThrow()
    expect(localPathOf('/tmp/x', 'a/b.txt')).toBe(join('/tmp/x', 'a', 'b.txt'))
  })
})

describe('comparing folders', () => {
  it('lists what differs and changes nothing', async () => {
    const t = await setup()
    scenario(t)
    const c = await t.compare()
    expect(t.kinds(c)).toEqual({
      'clash.txt': 'different',
      'edited-here.txt': 'localNewer',
      'edited-there.txt': 'remoteNewer',
      'new-dir': 'onlyLocal',
      'new-dir/deep': 'onlyLocal',
      'new-dir/deep/a.txt': 'onlyLocal',
      'old-dir': 'onlyRemote',
      'old-dir/b.txt': 'onlyRemote',
      'only-here.txt': 'onlyLocal',
      'only-there.txt': 'onlyRemote'
    })
    expect(c).toMatchObject({ same: 2, unreadable: [], truncated: false, ended: 'done', offsetMinutes: 0, offsetDetected: false })
    expect(c.items.find((i) => i.rel === 'clash.txt')).toMatchObject({ type: 'file', local: { size: 5 }, remote: { size: 11 } })
    // nothing was touched
    expect(existsSync(t.onServer('only-here.txt'))).toBe(false)
    expect(existsSync(t.here('only-there.txt'))).toBe(false)
    expect(readFileSync(t.onServer('edited-here.txt'), 'utf8')).toBe('old')
  })

  it('by size only, a different time alone is no difference', async () => {
    const t = await setup()
    scenario(t)
    const c = await t.compare({ compareBy: 'size', offsetMinutes: null })
    expect(Object.keys(t.kinds(c)).filter((r) => r.startsWith('edited') || r === 'clash.txt')).toEqual(['clash.txt', 'edited-here.txt', 'edited-there.txt'])
    t.put(t.here('same.txt'), 'equal', T0 + 5 * HOUR)
    expect((await t.compare({ compareBy: 'size', offsetMinutes: null })).same).toBe(2)
    expect(t.kinds(await t.compare())['same.txt']).toBe('localNewer')
  })

  it.skipIf(process.platform === 'win32')('leaves links and names that cannot exist here alone', async () => {
    const t = await setup()
    t.put(t.here('real.txt'), 'x')
    symlinkSync(t.here('real.txt'), t.here('link-here'))
    symlinkSync('/etc', t.onServer('link-there'))
    t.put(t.onServer('bad:name.txt'), 'x')
    t.put(t.onServer('CON'), 'x')
    const c = await t.compare()
    expect(t.kinds(c)).toEqual({ 'real.txt': 'onlyLocal' })
    expect(c.skipped.map((s) => s.rel).sort()).toEqual(['CON', 'bad:name.txt', 'link-here', 'link-there'])
  })

  it('refuses a local folder that does not exist', async () => {
    const t = await setup()
    await expect(t.fm.syncCompare(t.id, t.dir, join(t.local, 'nope'), BY_TIME, 'tok')).rejects.toThrow(/does not exist/)
    await expect(t.fm.syncCompare(t.id, t.dir, 'relative/path', BY_TIME, 'tok')).rejects.toThrow(/full path/)
  })
})

describe('synchronising', () => {
  it('uploads what is new or newer here and leaves the rest of the server alone', async () => {
    const t = await setup()
    scenario(t)
    const r = await t.apply(await t.compare(), 'upload')
    expect(r).toMatchObject({ uploaded: 6, downloaded: 0, deleted: 0, failed: [] })
    expect(readFileSync(t.onServer('edited-here.txt'), 'utf8')).toBe('new text')
    expect(readFileSync(t.onServer('new-dir', 'deep', 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(t.onServer('clash.txt'), 'utf8')).toBe('short')
    // not touched: newer on the server, or only there
    expect(readFileSync(t.onServer('edited-there.txt'), 'utf8')).toBe('new text')
    expect(readFileSync(t.here('edited-there.txt'), 'utf8')).toBe('old')
    expect(existsSync(t.onServer('only-there.txt'))).toBe(true)
    // the times came along, so the next comparison finds these files equal
    expect(Math.abs(statSync(t.onServer('edited-here.txt')).mtimeMs - (T0 + HOUR))).toBeLessThan(2000)
    expect(t.kinds(await t.compare())).toEqual({ 'edited-there.txt': 'remoteNewer', 'old-dir': 'onlyRemote', 'old-dir/b.txt': 'onlyRemote', 'only-there.txt': 'onlyRemote' })
  })

  it('downloads the other way round', async () => {
    const t = await setup()
    scenario(t)
    const r = await t.apply(await t.compare(), 'download')
    expect(r).toMatchObject({ uploaded: 0, downloaded: 5, deleted: 0, failed: [] })
    expect(readFileSync(t.here('edited-there.txt'), 'utf8')).toBe('new text')
    expect(readFileSync(t.here('old-dir', 'b.txt'), 'utf8')).toBe('b')
    expect(readFileSync(t.here('edited-here.txt'), 'utf8')).toBe('new text')
    expect(existsSync(t.onServer('only-here.txt'))).toBe(false)
    expect(Math.abs(statSync(t.here('edited-there.txt')).mtimeMs - (T0 + HOUR))).toBeLessThan(2000)
  })

  it('both ways: the newer file wins, and a clash without a newer side is left for the user', async () => {
    const t = await setup()
    scenario(t)
    const r = await t.apply(await t.compare(), 'both')
    expect(r).toMatchObject({ uploaded: 5, downloaded: 4, deleted: 0, failed: [] })
    const after = await t.compare()
    expect(t.kinds(after)).toEqual({ 'clash.txt': 'different' })
    expect(after.same).toBe(8)
    // the user decides the clash
    expect(await t.fm.syncApply(after.id, [{ rel: 'clash.txt', action: 'download' }], 0)).toMatchObject({ downloaded: 1, failed: [] })
    expect(readFileSync(t.here('clash.txt'), 'utf8')).toBe('much longer')
  })

  it('mirror to the server deletes there, but only what was confirmed', async () => {
    const t = await setup()
    scenario(t)
    const c = await t.compare()
    await expect(t.apply(c, 'mirrorUpload', 0)).rejects.toThrow(/not confirmed/)
    expect(existsSync(t.onServer('only-there.txt'))).toBe(true)
    const r = await t.apply(c, 'mirrorUpload')
    expect(r).toMatchObject({ uploaded: 7, deleted: 3, failed: [] })
    expect(existsSync(t.onServer('only-there.txt'))).toBe(false)
    expect(existsSync(t.onServer('old-dir'))).toBe(false)
    expect(readFileSync(t.onServer('edited-there.txt'), 'utf8')).toBe('old')
    expect((await t.compare()).items).toEqual([])
    // a comparison is good for one run
    await expect(t.apply(c, 'mirrorUpload')).rejects.toThrow(/no longer valid/)
  })

  it('a folder on the server that got a new file after the comparison is not removed', async () => {
    const t = await setup()
    t.put(t.onServer('old-dir', 'b.txt'), 'b')
    const c = await t.compare()
    t.put(t.onServer('old-dir', 'late.txt'), 'arrived after the comparison')
    const r = await t.apply(c, 'mirrorUpload')
    expect(r.deleted).toBe(1)
    expect(r.failed.map((f) => f.rel)).toEqual(['old-dir'])
    expect(readFileSync(t.onServer('old-dir', 'late.txt'), 'utf8')).toBe('arrived after the comparison')
  })

  it('mirror from the server moves local extras to the trash', async () => {
    const t = await setup()
    scenario(t)
    const r = await t.apply(await t.compare(), 'mirrorDownload')
    expect(r).toMatchObject({ downloaded: 6, deleted: 4, failed: [] })
    expect(existsSync(t.here('only-here.txt'))).toBe(false)
    expect(existsSync(t.here('new-dir'))).toBe(false)
    // the folder went as a whole and can be put back
    expect(readFileSync(join(t.trashDir, 'new-dir', 'deep', 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(join(t.trashDir, 'only-here.txt'), 'utf8')).toBe('local')
    expect((await t.compare()).items).toEqual([])
  })

  it('deletes nothing when the transfers were cancelled', async () => {
    const t = await setup()
    t.put(t.here('big.bin'), 'x'.repeat(16 * 1024 * 1024))
    t.put(t.onServer('only-there.txt'), 'remote')
    const c = await t.compare()
    const run = t.apply(c, 'mirrorUpload')
    for (let i = 0; i < 200 && !t.fm.transfers().items.length; i++) await sleep(5)
    t.fm.queueAction('cancel')
    const r = await run
    expect(r).toMatchObject({ uploaded: 0, deleted: 0, cancelled: 1, deletesSkipped: 1 })
    expect(existsSync(t.onServer('only-there.txt'))).toBe(true)
  })

  it('refuses actions that do not fit the difference, and paths outside the comparison', async () => {
    const t = await setup()
    scenario(t)
    let c = await t.compare()
    await expect(t.fm.syncApply(c.id, [{ rel: 'edited-here.txt', action: 'deleteRemote' }], 1)).rejects.toThrow(/not possible/)
    c = await t.compare()
    await expect(t.fm.syncApply(c.id, [{ rel: '../outside.txt', action: 'upload' }], 0)).rejects.toThrow(/Not part of this comparison/)
    expect(readFileSync(t.onServer('edited-here.txt'), 'utf8')).toBe('old')
  })

  it('works over FTP too, whatever time zone the listing of the server is in', async () => {
    const t = await setup('ftp')
    // Recent files: the listing of this server gives minutes for them, and only the day for old ones.
    const base = Math.floor((Date.now() - 2 * 24 * HOUR) / 60_000) * 60_000
    const later = base + 5 * HOUR + 7 * 60_000
    for (const n of [1, 2, 3, 4, 5]) {
      t.put(t.here(`same${n}.txt`), 'equal', base + n * 60_000)
      t.put(t.onServer(`same${n}.txt`), 'equal', base + n * 60_000)
    }
    t.put(t.here('edited-here.txt'), 'new', later)
    t.put(t.onServer('edited-here.txt'), 'old', base)
    t.put(t.here('edited-there.txt'), 'old', base)
    t.put(t.onServer('edited-there.txt'), 'new', later)
    t.put(t.here('new-dir', 'deep', 'a.txt'), 'a', base)
    t.put(t.onServer('old-dir', 'b.txt'), 'b', base)
    const first = await t.compare()
    expect(t.kinds(first)).toEqual({
      'edited-here.txt': 'localNewer',
      'edited-there.txt': 'remoteNewer',
      'new-dir': 'onlyLocal',
      'new-dir/deep': 'onlyLocal',
      'new-dir/deep/a.txt': 'onlyLocal',
      'old-dir': 'onlyRemote',
      'old-dir/b.txt': 'onlyRemote'
    })
    expect(first.same).toBe(5)
    expect(first.offsetMinutes % 15).toBe(0)
    const r = await t.apply(first, 'both')
    expect(r).toMatchObject({ uploaded: 4, downloaded: 3, failed: [] })
    expect(readFileSync(t.onServer('new-dir', 'deep', 'a.txt'), 'utf8')).toBe('a')
    expect(readFileSync(t.onServer('edited-here.txt'), 'utf8')).toBe('new')
    expect(readFileSync(t.here('edited-there.txt'), 'utf8')).toBe('new')
    expect(readFileSync(t.here('old-dir', 'b.txt'), 'utf8')).toBe('b')
    expect((await t.compare({ compareBy: 'size', offsetMinutes: null })).items).toEqual([])
  })
})

describe('keeping a folder up to date', () => {
  const until = async (what: () => boolean, ms = 10_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (what()) return
    throw new Error('Timed out')
  }

  it('uploads what changes, never deletes on the server, and stops when told', async () => {
    const t = await setup()
    t.put(t.here('before.txt'), 'was here before')
    const w = await t.fm.watchStart(t.id, t.dir, t.local)
    expect(w).toMatchObject({ state: 'watching', uploaded: 0, localDir: expect.stringContaining(basename(t.local)), remoteDir: t.dir })
    await expect(t.fm.watchStart(t.id, t.dir, t.local)).rejects.toThrow(/already/)
    await sleep(200)

    writeFileSync(t.here('page.html'), '<p>one</p>')
    await until(() => existsSync(t.onServer('page.html')) && readFileSync(t.onServer('page.html'), 'utf8') === '<p>one</p>')
    writeFileSync(t.here('page.html'), '<p>two, longer</p>')
    await until(() => readFileSync(t.onServer('page.html'), 'utf8') === '<p>two, longer</p>')

    // a new folder with content
    mkdirSync(t.here('assets', 'img'), { recursive: true })
    writeFileSync(t.here('assets', 'img', 'logo.svg'), '<svg/>')
    await until(() => existsSync(t.onServer('assets', 'img', 'logo.svg')))
    writeFileSync(t.here('assets', 'style.css'), 'body{}')
    await until(() => existsSync(t.onServer('assets', 'style.css')))

    // what was there before the watch began is not uploaded, and a deletion is not carried over
    rmSync(t.here('page.html'))
    writeFileSync(t.here('.DS_Store'), 'junk')
    await sleep(900)
    expect(existsSync(t.onServer('page.html'))).toBe(true)
    expect(existsSync(t.onServer('before.txt'))).toBe(false)
    expect(existsSync(t.onServer('.DS_Store'))).toBe(false)

    await until(() => t.fm.watchList()[0]?.state === 'watching')
    const status = t.fm.watchList()[0]
    expect(status.uploaded).toBeGreaterThanOrEqual(4)
    expect(status.failed).toBe(0)
    expect(t.watches.some((list) => list[0]?.state === 'uploading')).toBe(true)

    t.fm.watchStop(w.id)
    expect(t.fm.watchList()).toEqual([])
    expect(t.watches.at(-1)).toEqual([])
    writeFileSync(t.here('after-stop.txt'), 'x')
    await sleep(900)
    expect(existsSync(t.onServer('after-stop.txt'))).toBe(false)
  })

  it('waits for a file another program still holds, and uploads it once it is free', async () => {
    const t = await setup()
    await t.fm.watchStart(t.id, t.dir, t.local)
    await sleep(200)
    writeFileSync(t.here('budget.xlsx'), 'saved, but still open in the program')
    const release = await holdFile(t.here('budget.xlsx'))
    try {
      // long enough for several attempts
      await sleep(2500)
      expect(existsSync(t.onServer('budget.xlsx'))).toBe(false)
      expect(t.fm.watchList()[0]).toMatchObject({ failed: 0 })
    } finally {
      await release()
    }
    await until(() => existsSync(t.onServer('budget.xlsx')) && readFileSync(t.onServer('budget.xlsx'), 'utf8') === 'saved, but still open in the program')
    await until(() => t.fm.watchList()[0]?.state === 'watching')
    expect(t.fm.watchList()[0]).toMatchObject({ uploaded: 1, failed: 0 })
  })

  it('ends with the connection', async () => {
    const t = await setup()
    await t.fm.watchStart(t.id, t.dir, t.local)
    t.fm.close(t.id)
    expect(t.fm.watchList()).toEqual([])
  })
})
