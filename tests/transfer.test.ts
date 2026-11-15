import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TransferProgress } from '@shared/types'
import { watchForDrop } from '../src/main/core/dropwatch'
import { openRemoteFs, type RemoteFs } from '../src/main/core/remotefs'
import { conflictsIn, copyEntries, isInside, measure, moveEntries } from '../src/main/core/transfer'
import { FileManager, type Desktop } from '../src/main/files'
import { readClipboardFiles, writeClipboardFiles } from '../src/main/fileclipboard'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer
let fs: RemoteFs
const text = (path: string): Promise<string> => fs.readFile(path, 1000).then((r) => r.data.toString())
const names = async (dir: string): Promise<string[]> => (await fs.list(dir)).map((e) => e.name).sort()

beforeAll(async () => {
  srv = await startTestSshServer()
  const { vault } = await newUnlockedVault()
  fs = await openRemoteFs(sshHost(srv.port), { vault, prompter: recordingPrompter(), interactive: true })
  await fs.mkdir('/site')
  await fs.mkdir('/site/css')
  await fs.writeFile('/site/index.html', Buffer.from('<h1>hi</h1>'), false)
  await fs.writeFile('/site/css/main.css', Buffer.from('body{}'), false)
  await fs.mkdir('/archive')
})
afterAll(async () => {
  fs.close()
  await srv.close()
})

describe('moving on the server', () => {
  it('moves items, reports what moved, and the reverse pairs undo it', async () => {
    const r = await moveEntries(fs, [{ from: '/site/index.html', to: '/archive/index.html' }])
    expect(r).toEqual({ moved: [{ from: '/site/index.html', to: '/archive/index.html' }], failed: [] })
    expect(await names('/archive')).toEqual(['index.html'])

    const back = await moveEntries(fs, r.moved.map((p) => ({ from: p.to, to: p.from })))
    expect(back.failed).toEqual([])
    expect(await names('/archive')).toEqual([])
    expect(await text('/site/index.html')).toBe('<h1>hi</h1>')
  })

  it('never replaces an existing item and never moves a folder into itself', async () => {
    await fs.writeFile('/archive/index.html', Buffer.from('older'), false)
    const r = await moveEntries(fs, [
      { from: '/site/index.html', to: '/archive/index.html' },
      { from: '/site', to: '/site/css/site' }
    ])
    expect(r.moved).toEqual([])
    expect(r.failed.map((f) => f.error)).toEqual([expect.stringMatching(/already exists/), expect.stringMatching(/into itself/)])
    expect(await text('/archive/index.html')).toBe('older')
    expect(await text('/site/index.html')).toBe('<h1>hi</h1>')
    await fs.remove('/archive/index.html', false)
  })

  it('knows what lies inside what', () => {
    expect(isInside('/a', '/a/b')).toBe(true)
    expect(isInside('/a', '/a')).toBe(true)
    expect(isInside('/a', '/ab')).toBe(false)
    expect(isInside('/', '/x')).toBe(true)
  })
})

describe('copying on the server', () => {
  it('copies folders with their content and numbers the copy instead of replacing', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'clavium-copytest-'))
    const site = await fs.stat('/site')
    expect(await copyEntries(fs, fs, [site], '/archive', tmp)).toEqual(['/archive/site'])
    expect(await text('/archive/site/css/main.css')).toBe('body{}')

    expect(await copyEntries(fs, fs, [site], '/archive', tmp)).toEqual(['/archive/site (2)'])
    const index = await fs.stat('/site/index.html')
    expect(await copyEntries(fs, fs, [index], '/site', tmp)).toEqual(['/site/index (2).html'])
    expect(await text('/site/index (2).html')).toBe('<h1>hi</h1>')
    await expect(copyEntries(fs, fs, [site], '/site/css', tmp)).rejects.toThrow(/into itself/)
    expect(readdirSync(tmp)).toEqual([]) // nothing is left behind on this computer
  })

  it('reports name clashes and measures sizes with a limit', async () => {
    expect(await conflictsIn(fs, '/site', ['index.html', 'new.txt', 'css'])).toEqual(['index.html', 'css'])
    const site = await fs.stat('/site')
    expect(await measure(fs, [site], { bytes: 1000, files: 10 })).toEqual({ bytes: 11 + 11 + 6, files: 3 })
    expect(await measure(fs, [site], { bytes: 20, files: 10 })).toBeNull()
    expect(await measure(fs, [site], { bytes: 1000, files: 2 })).toBeNull()
  })
})

describe('finding the folder of a drop', () => {
  it('finds the marker, removes it, and ignores files that only share its name', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-droptest-'))
    const stage = join(root, 'stage')
    const wrong = join(root, 'wrong')
    const target = join(root, 'some', 'folder')
    for (const d of [stage, wrong, target]) mkdirSync(d, { recursive: true })
    writeFileSync(join(stage, 'x.marker'), 'secret-token')

    const watch = watchForDrop({ markerName: 'x.marker', markerContent: 'secret-token', ignoreDir: stage, roots: [root] })
    await new Promise((r) => setTimeout(r, 200))
    writeFileSync(join(wrong, 'x.marker'), 'something else')
    await new Promise((r) => setTimeout(r, 300))
    copyFileSync(join(stage, 'x.marker'), join(target, 'x.marker'))

    expect(await watch.found).toBe(target)
    expect(existsSync(join(target, 'x.marker'))).toBe(false)
    expect(readFileSync(join(wrong, 'x.marker'), 'utf8')).toBe('something else')
    expect(existsSync(join(stage, 'x.marker'))).toBe(true)
  })

  it('gives up when stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-droptest-'))
    const watch = watchForDrop({ markerName: 'y.marker', markerContent: 't', ignoreDir: root, roots: [root] })
    watch.stop()
    expect(await watch.found).toBeNull()
  })
})

describe('file manager', () => {
  const setup = async () => {
    const { vault } = await newUnlockedVault()
    const root = mkdtempSync(join(tmpdir(), 'clavium-fm-'))
    const temp = join(root, 'temp')
    mkdirSync(temp)
    const progress: TransferProgress[] = []
    let clipboard: string[] = []
    const desktop: Desktop = {
      tempRoot: temp,
      readClipboardFiles: async () => clipboard,
      writeClipboardFiles: async (p) => void (clipboard = p),
      clearClipboard: () => void (clipboard = []),
      dropRoots: () => [root]
    }
    const fm = new FileManager(vault, recordingPrompter(), (channel, p) => channel === 'files:progress' && progress.push(p as TransferProgress), desktop)
    const id = await fm.open(sshHost(srv.port))
    const done = async (): Promise<void> => {
      for (let i = 0; i < 100 && !progress.some((p) => p.done); i++) await new Promise((r) => setTimeout(r, 50))
    }
    return { fm, id, root, temp, progress, done, clipboard: () => clipboard, setClipboard: (p: string[]) => void (clipboard = p) }
  }

  it('downloads dragged items into the folder they were dropped in', async () => {
    const t = await setup()
    const desktopDir = join(t.root, 'Desktop')
    mkdirSync(desktopDir)
    const site = await fs.stat('/site')
    let marker = ''
    const target = await t.fm.dragOut(t.id, [site], (file) => {
      marker = file
      // what Explorer does when the marker is dropped on a folder
      setTimeout(() => copyFileSync(file, join(desktopDir, basename(file))), 100)
    })
    expect(target).toBe(desktopDir)
    await t.done()
    expect(readFileSync(join(desktopDir, 'site', 'css', 'main.css'), 'utf8')).toBe('body{}')
    expect(readdirSync(desktopDir)).toEqual(['site']) // the marker is gone
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(t.temp)).toEqual([])
    t.fm.closeAll()
  })

  it('downloads nothing when the drag ends inside the app', async () => {
    const t = await setup()
    const site = await fs.stat('/site')
    const target = await t.fm.dragOut(t.id, [site], () => setTimeout(() => t.fm.cancelDrag(), 50))
    expect(target).toBeNull()
    expect(t.progress).toEqual([])
    expect(readdirSync(t.temp)).toEqual([])
    t.fm.closeAll()
  })

  it('puts copied server files on the clipboard and removes them again', async () => {
    const t = await setup()
    const index = await fs.stat('/site/index.html')
    t.setClipboard(['C:\\Users\\someone\\copied-in-windows.txt'])
    expect(await t.fm.clipboardFiles()).toEqual(['C:\\Users\\someone\\copied-in-windows.txt'])

    expect(await t.fm.copyToClipboard(t.id, [index], true)).toBe('ready')
    const staged = t.clipboard()
    expect(staged).toHaveLength(1)
    expect(readFileSync(staged[0], 'utf8')).toBe('<h1>hi</h1>')
    expect(await t.fm.clipboardFiles()).toEqual([]) // our own copy is not something to upload

    expect(await t.fm.copyToClipboard(t.id, [index], false)).toBe('internal') // "cut" stays inside the app
    expect(existsSync(staged[0])).toBe(false)
    expect(t.clipboard()).toEqual([])
    t.fm.closeAll()
  })

  it('stops a running upload and a running download, and leaves no half files behind', async () => {
    const t = await setup()
    const big = join(t.root, 'big.bin')
    writeFileSync(big, Buffer.alloc(96 * 1024 * 1024, 7))

    // cancel as soon as the first bytes are on their way
    const cancelWhenRunning = (direction: string): NodeJS.Timeout =>
      setInterval(() => {
        const p = t.progress.find((x) => x.direction === direction && x.transferred > 0 && !x.done)
        if (p) t.fm.cancelTransfer(p.transferId)
      }, 5)

    let timer = cancelWhenRunning('upload')
    await t.fm.upload(t.id, [big], '/')
    clearInterval(timer)
    expect(t.progress.at(-1)).toMatchObject({ direction: 'upload', done: true, cancelled: true })
    expect(t.progress.at(-1)?.error).toBeUndefined()
    expect(await names('/')).not.toContain('big.bin')
    await new Promise((r) => setTimeout(r, 300))
    rmSync(big) // the local file is not kept open

    // the session the user browses with was not touched and a new transfer works
    writeFileSync(join(srv.root, 'server-big.bin'), Buffer.alloc(96 * 1024 * 1024, 9))
    const entry = await fs.stat('/server-big.bin')
    const downloads = join(t.root, 'downloads')
    mkdirSync(downloads)
    t.progress.length = 0
    timer = cancelWhenRunning('download')
    await t.fm.download(t.id, [entry], { localDir: downloads })
    clearInterval(timer)
    expect(t.progress.at(-1)).toMatchObject({ direction: 'download', done: true, cancelled: true })
    expect(readdirSync(downloads)).toEqual([])

    t.progress.length = 0
    await t.fm.download(t.id, [await fs.stat('/site/index.html')], { localDir: downloads })
    expect(t.progress.at(-1)).toMatchObject({ done: true, cancelled: false })
    expect(readFileSync(join(downloads, 'index.html'), 'utf8')).toBe('<h1>hi</h1>')
    await fs.remove('/server-big.bin', false)
    t.fm.closeAll()
  })

  it('changes permissions', async () => {
    const t = await setup()
    await t.fm.chmod(t.id, '/site/index.html', 0o640)
    expect(srv.setstat.at(-1)).toEqual({ path: '/site/index.html', mode: 0o640 })
    t.fm.closeAll()
  })

  it('gives every transfer a connection of its own', async () => {
    const second = await fs.fork()
    expect(await second.list('/site/css')).toHaveLength(1)
    second.close()
    expect(await names('/site/css')).toEqual(['main.css']) // the first handle still works
  })

  it('copies between two sessions and reports what it created', async () => {
    const t = await setup()
    const index = await fs.stat('/site/index.html')
    await fs.mkdir('/inbox')
    expect(await t.fm.copy(t.id, [index], t.id, '/inbox')).toEqual({ created: ['/inbox/index.html'] })
    expect(await text('/inbox/index.html')).toBe('<h1>hi</h1>')
    expect(t.progress.at(-1)).toMatchObject({ direction: 'copy', done: true, name: 'index.html' })
    expect(await t.fm.uploadConflicts(t.id, '/inbox', [join(tmpdir(), 'x', 'index.html'), join(tmpdir(), 'x', 'other.txt')])).toEqual(['index.html'])
    t.fm.closeAll()
  })
})

// Uses the real clipboard of this computer, so it only runs when asked for.
describe.runIf((process.platform === 'win32' || process.platform === 'darwin') && process.env.CLAVIUM_TEST_CLIPBOARD)('System clipboard', () => {
  it('writes and reads file lists, including names with spaces and umlauts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clavium-clip test-'))
    const a = join(dir, 'Übersicht 2026.txt')
    const b = join(dir, "it's a folder")
    writeFileSync(a, 'a')
    mkdirSync(b)
    await writeClipboardFiles([a, b])
    expect(await readClipboardFiles()).toEqual([a, b])
    await writeClipboardFiles([a])
    expect(await readClipboardFiles()).toEqual([a])
  })
})
