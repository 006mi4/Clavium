import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FtpSrv } from 'ftp-srv'
import type { RemoteEntry, SearchUpdate } from '@shared/types'
import { FtpFs, openRemoteFs, type RemoteFs } from '../src/main/core/remotefs'
import { chmodTree, chownTree, folderSize, modeFor, nameMatcher, searchTree } from '../src/main/core/remotetools'
import { FileManager } from '../src/main/files'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer
let fs: RemoteFs
const never = new AbortController().signal
const mode = (...p: string[]): number => statSync(join(srv.root, ...p)).mode & 0o777
const unix = process.platform !== 'win32'

beforeAll(async () => {
  srv = await startTestSshServer()
  const { vault } = await newUnlockedVault()
  fs = await openRemoteFs(sshHost(srv.port), { vault, prompter: recordingPrompter(), interactive: true })
  mkdirSync(join(srv.root, 'site', 'css', 'deep'), { recursive: true })
  mkdirSync(join(srv.root, 'site', 'logs'))
  writeFileSync(join(srv.root, 'site', 'index.html'), 'x'.repeat(100))
  writeFileSync(join(srv.root, 'site', 'css', 'main.css'), 'x'.repeat(20))
  writeFileSync(join(srv.root, 'site', 'css', 'deep', 'Print.CSS'), 'x'.repeat(3))
  writeFileSync(join(srv.root, 'site', 'logs', 'access.log'), 'x'.repeat(7))
  writeFileSync(join(srv.root, 'other.css'), 'x')
  // a link that points upwards must not send a walk in circles
  if (unix) symlinkSync(join(srv.root, 'site'), join(srv.root, 'site', 'css', 'loop'))
})
afterAll(async () => {
  fs.close()
  await srv.close()
})

describe('going through folders on the server', () => {
  it('adds up the size of a folder and of several items', async () => {
    const site = await fs.stat('/site')
    expect(await folderSize(fs, [site], never)).toEqual({ bytes: 130, files: unix ? 5 : 4, folders: 4, unreadable: 0, complete: true })
    const more = await folderSize(fs, [site, await fs.stat('/other.css')], never)
    expect(more.bytes).toBe(131)

    const stopped = new AbortController()
    stopped.abort()
    expect((await folderSize(fs, [site], stopped.signal)).complete).toBe(false)
    // a folder that is gone is counted as unreadable, the rest still adds up
    const ghost: RemoteEntry = { name: 'ghost', path: '/site/ghost', type: 'dir', size: 0, modifiedAt: 0 }
    expect(await folderSize(fs, [ghost, await fs.stat('/other.css')], never)).toMatchObject({ bytes: 1, unreadable: 1, complete: true })
  })

  it('matches names by text and by pattern, whatever the case', () => {
    expect(nameMatcher('css')('Main.CSS')).toBe(true)
    expect(nameMatcher('css')('main.js')).toBe(false)
    expect(nameMatcher('*.log')('access.log')).toBe(true)
    expect(nameMatcher('*.log')('access.log.1')).toBe(false)
    expect(nameMatcher('a?c')('abc')).toBe(true)
    expect(nameMatcher('a?c')('abbc')).toBe(false)
    expect(nameMatcher('a.c')('abc')).toBe(false) // a dot is a dot
    expect(nameMatcher('(x')('file(x).txt')).toBe(true)
    expect(nameMatcher('  ')('anything')).toBe(false)
  })

  it('searches a tree by name, reports hits while running, and stops at the limit', async () => {
    const hits: string[] = []
    const r = await searchTree(fs, '/site', '*.css', never, (u) => hits.push(...u.hits.map((h) => h.path)))
    expect(hits.sort()).toEqual(['/site/css/deep/Print.CSS', '/site/css/main.css'])
    expect(r).toMatchObject({ found: 2, ended: 'complete', unreadable: 0 })
    expect(r.scanned).toBeGreaterThanOrEqual(7)

    const few: string[] = []
    expect((await searchTree(fs, '/', 'css', never, (u) => few.push(...u.hits.map((h) => h.path)), 2)).ended).toBe('limit')
    expect(few).toHaveLength(2)

    const stopped = new AbortController()
    stopped.abort()
    expect((await searchTree(fs, '/site', 'css', stopped.signal, () => undefined)).ended).toBe('stopped')
  })

  it('works out the permissions for files and folders', () => {
    const base = { recursive: true, target: 'all' as const, foldersOpen: true }
    expect(modeFor('file', { ...base, mode: 0o640 })).toBe(0o640)
    expect(modeFor('dir', { ...base, mode: 0o640 })).toBe(0o750)
    expect(modeFor('dir', { ...base, mode: 0o644, foldersOpen: false })).toBe(0o644)
    expect(modeFor('dir', { ...base, mode: 0o600, target: 'files' })).toBeNull()
    expect(modeFor('file', { ...base, mode: 0o600, target: 'folders' })).toBeNull()
    expect(modeFor('dir', { ...base, mode: 0o644, recursive: false })).toBe(0o644)
  })

  it.runIf(unix)('changes permissions of a folder with everything inside, and leaves links alone', async () => {
    const site = await fs.stat('/site')
    const r = await chmodTree(fs, [site], { mode: 0o640, recursive: true, target: 'all', foldersOpen: true }, never)
    expect(r).toEqual({ changed: 8, failed: [], complete: true })
    expect(mode('site')).toBe(0o750)
    expect(mode('site', 'css', 'deep')).toBe(0o750)
    expect(mode('site', 'index.html')).toBe(0o640)
    expect(mode('site', 'css', 'deep', 'Print.CSS')).toBe(0o640)
    expect(mode('other.css')).not.toBe(0o640)

    // only the files inside; the folder that was selected itself always changes
    await chmodTree(fs, [site], { mode: 0o755, recursive: true, target: 'files', foldersOpen: false }, never)
    expect(mode('site')).toBe(0o755)
    expect(mode('site', 'css')).toBe(0o750)
    expect(mode('site', 'index.html')).toBe(0o755)

    // without "everything inside" only the item itself
    await chmodTree(fs, [site], { mode: 0o700, recursive: false, target: 'all', foldersOpen: true }, never)
    expect(mode('site')).toBe(0o700)
    expect(mode('site', 'css')).toBe(0o750)
    await chmodTree(fs, [site], { mode: 0o755, recursive: true, target: 'all', foldersOpen: true }, never)
  })

  it('reports what could not be changed and goes on', async () => {
    const ghost: RemoteEntry = { name: 'ghost.txt', path: '/ghost.txt', type: 'file', size: 0, modifiedAt: 0 }
    const r = await chmodTree(fs, [ghost, await fs.stat('/other.css')], { mode: 0o644, recursive: false, target: 'all', foldersOpen: false }, never)
    expect(r.changed).toBe(1)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].path).toBe('/ghost.txt')
  })

  it('tells owner and group and changes them, for one item or a whole folder', async () => {
    const entry = await fs.stat('/other.css')
    const real = statSync(join(srv.root, 'other.css'))
    expect(entry.uid).toBe(real.uid)
    expect(entry.gid).toBe(real.gid)

    srv.chown.length = 0
    await chownTree(fs, [entry], { uid: 1001 }, false, never)
    // the group stays what it is when only the owner is given
    expect(srv.chown).toEqual([{ path: '/other.css', uid: 1001, gid: real.gid }])
    srv.chown.length = 0
    const r = await chownTree(fs, [await fs.stat('/site/logs')], { uid: 33, gid: 33 }, true, never)
    expect(r.changed).toBe(2)
    expect(srv.chown).toEqual([
      { path: '/site/logs', uid: 33, gid: 33 },
      { path: '/site/logs/access.log', uid: 33, gid: 33 }
    ])
  })

  it('runs searches and counts through the file manager and can stop them', async () => {
    const { vault } = await newUnlockedVault()
    const updates: SearchUpdate[] = []
    const fm = new FileManager(vault, recordingPrompter(), (channel, payload) => channel === 'files:searchHits' && updates.push(payload as SearchUpdate))
    const id = await fm.open(sshHost(srv.port))
    expect(await fm.search(id, '/site', 'access', 'search-1')).toMatchObject({ found: 1, ended: 'complete' })
    expect(updates.flatMap((u) => u.hits.map((h) => h.path))).toEqual(['/site/logs/access.log'])
    expect(updates.every((u) => u.token === 'search-1')).toBe(true)
    expect((await fm.folderSize(id, [await fs.stat('/site')], 'size-1')).bytes).toBe(130)

    const running = fm.folderSize(id, [await fs.stat('/site')], 'size-2')
    fm.cancelWork('size-2')
    expect((await running).complete).toBe(false)
    // the session the user browses with is untouched
    expect((await fm.get(id).list('/site')).length).toBeGreaterThan(0)
    fm.closeAll()
  })
})

describe('FTP', () => {
  it('reads file names in the character set of the host, and refuses to change owners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-ftp-enc-'))
    writeFileSync(join(root, 'käse.txt'), 'x')
    const port = 39000 + Math.floor(Math.random() * 900)
    const server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: port + 1, pasv_max: port + 40, anonymous: false, greeting: 'test' })
    server.on('login', (_data, resolve) => resolve({ root }))
    await server.listen()
    try {
      const { vault } = await newUnlockedVault()
      const ctx = { vault, prompter: recordingPrompter(), interactive: false }
      const host = sshHost(port, { protocol: 'ftp', username: 'u', password: 'p' })
      const utf8 = await FtpFs.connect(host, ctx)
      expect((await utf8.list('/')).map((e) => e.name)).toEqual(['käse.txt'])
      await expect(utf8.chown('/käse.txt', 1, 1)).rejects.toThrow(/FTP/)
      utf8.close()
      // Asked to, the test server sends one byte per letter. Read as UTF-8 the "ä" would be lost.
      const latin = await FtpFs.connect({ ...host, ftpEncoding: 'latin1' }, ctx)
      expect((await latin.list('/')).map((e) => e.name)).toEqual(['käse.txt'])
      latin.close()
    } finally {
      await server.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
