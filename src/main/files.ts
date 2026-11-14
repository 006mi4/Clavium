import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join, posix, resolve, sep } from 'node:path'
import type { ClipboardCopyResult, CopyResult, HostRecord, MovePair, MoveResult, RemoteEntry, TransferProgress } from '@shared/types'
import { randomId } from './core/crypto'
import { driveRoots, watchForDrop } from './core/dropwatch'
import { conflictsIn, copyEntries, measure, moveEntries } from './core/transfer'
import type { Prompter } from './core/prompter'
import { openRemoteFs, type RemoteFs } from './core/remotefs'
import type { Vault } from './core/vault'

type Send = (channel: 'files:progress' | 'files:closed', ...args: unknown[]) => void

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/**
 * Turn a remote file name into a safe local file name. A malicious server could
 * otherwise return names like "..\\..\\AppData\\evil.exe" and write outside the target folder.
 */
export function safeLocalName(remoteName: string): string {
  let name = remoteName.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
  if (name === '' || name === '.' || name === '..') name = '_'
  if (WINDOWS_RESERVED.test(name)) name = '_' + name
  return name.slice(0, 200)
}

function isWithin(dir: string, path: string): boolean {
  return resolve(path).toLowerCase().startsWith(resolve(dir).toLowerCase() + sep)
}

function uniqueLocalPath(dir: string, name: string): string {
  let candidate = join(dir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`)
  return candidate
}

/** What the file manager needs from the desktop. Kept separate so the logic runs in tests. */
export interface Desktop {
  /** Folder for short-lived private files. */
  tempRoot: string
  /** Paths of the files on the system clipboard. */
  readClipboardFiles(): Promise<string[]>
  writeClipboardFiles(paths: string[]): Promise<void>
  clearClipboard(): void
  /** Folders that are watched to find out where dragged items were dropped. Default: all drives. */
  dropRoots?(): string[]
}

const NO_DESKTOP: Desktop = {
  tempRoot: tmpdir(),
  readClipboardFiles: async () => [],
  writeClipboardFiles: async () => undefined,
  clearClipboard: () => undefined
}

/** Larger selections are not copied to this computer just because someone pressed Ctrl+C. */
const CLIPBOARD_LIMIT = { bytes: 200 * 1024 * 1024, files: 2000 }
/** How long to wait after a drag ended for the dropped marker to show up. */
const DROP_WAIT_MS = 3000

export class FileManager {
  private sessions = new Map<string, RemoteFs>()
  /** Folder holding the server files that are currently on the Windows clipboard. */
  private clipDir: string | null = null
  private clipJob = 0
  private drag: { cancel: () => void } | null = null

  constructor(
    private readonly vault: Vault,
    private readonly prompter: Prompter,
    private readonly send: Send,
    private readonly desktop: Desktop = NO_DESKTOP
  ) {}

  async open(host: HostRecord): Promise<string> {
    const fs = await openRemoteFs(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const id = randomId()
    this.sessions.set(id, fs)
    fs.onClose(() => {
      if (this.sessions.delete(id)) this.send('files:closed', id)
    })
    return id
  }

  get(id: string): RemoteFs {
    const fs = this.sessions.get(id)
    if (!fs) throw new Error('File session is closed — reconnect')
    return fs
  }

  close(id: string): void {
    const fs = this.sessions.get(id)
    this.sessions.delete(id)
    fs?.close()
  }

  /** Close every session (vault locked, app quitting) and tell the interface about each one. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
      this.send('files:closed', id)
    }
    this.cancelAllTransfers()
    this.drag?.cancel()
    void this.forgetClipboard()
  }

  chmod(id: string, path: string, mode: number): Promise<void> {
    return this.get(id).chmod(path, mode)
  }

  // ------------------------------------------------- move, copy, conflicts ----

  move(id: string, pairs: MovePair[]): Promise<MoveResult> {
    return moveEntries(this.get(id), pairs)
  }

  /** Which of these local files or folders would replace something in `remoteDir`. */
  uploadConflicts(id: string, remoteDir: string, localPaths: string[]): Promise<string[]> {
    return conflictsIn(
      this.get(id),
      remoteDir,
      localPaths.map((p) => basename(p))
    )
  }

  /** Copy within one server or from one server to another. */
  async copy(srcId: string, entries: RemoteEntry[], dstId: string, dstDir: string): Promise<CopyResult> {
    const src = this.get(srcId)
    const dst = this.get(dstId)
    const tmp = await mkdtemp(join(this.desktop.tempRoot, 'clavium-copy-'))
    const created: string[] = []
    const round = this.cancelRound
    try {
      for (const entry of entries) {
        const transferId = randomId()
        const report = (transferred: number, total: number, done = false, error?: string, cancelled = false): void =>
          this.progress({ transferId, name: entry.name, direction: 'copy', transferred, total, done, error, cancelled })
        if (round !== this.cancelRound) break
        try {
          report(0, entry.size)
          const outcome = await this.job(transferId, [src, dst], async ([s, d], cancelled) => {
            created.push(...(await copyEntries(s, d, [entry], dstDir, tmp, (_e, t, total) => report(t, total), cancelled)))
          })
          report(entry.size, entry.size, true, undefined, outcome === 'cancelled')
        } catch (e) {
          report(0, entry.size, true, (e as Error).message)
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
    return { created }
  }

  // ------------------------------------------------------------ clipboard ----

  private async forgetClipboard(): Promise<void> {
    this.clipJob++
    const dir = this.clipDir
    this.clipDir = null
    if (!dir) return
    // Don't leave paths on the clipboard that are about to disappear.
    const onClipboard = await this.desktop.readClipboardFiles().catch(() => [])
    if (onClipboard.some((p) => isWithin(dir, p))) this.desktop.clearClipboard()
    await rm(dir, { recursive: true, force: true })
  }

  /**
   * "Copy" in the file browser. Files up to a size limit are also fetched into a private folder and
   * put on the Windows clipboard, so they can be pasted in Explorer. The folder is removed with the
   * next copy, when the vault is locked and when the app quits.
   */
  async copyToClipboard(id: string, entries: RemoteEntry[], forWindows: boolean): Promise<ClipboardCopyResult> {
    const fs = this.get(id)
    await this.forgetClipboard()
    // Otherwise a later paste would pick up whatever was copied in Windows before.
    this.desktop.clearClipboard()
    if (!forWindows) return 'internal'
    const job = this.clipJob
    if (!(await measure(fs, entries, CLIPBOARD_LIMIT))) return 'too-large'
    const dir = await mkdtemp(join(this.desktop.tempRoot, 'clavium-clip-'))
    const staged: string[] = []
    try {
      for (const entry of entries) {
        if (entry.type !== 'dir' && entry.type !== 'file') continue
        staged.push(await this.downloadRecursive(fs, entry, dir, () => undefined, 0))
      }
      if (job !== this.clipJob) throw new Error('superseded')
      await this.desktop.writeClipboardFiles(staged)
      this.clipDir = dir
      return 'ready'
    } catch {
      // Copying inside the app still works; only pasting in Windows is not available.
      await rm(dir, { recursive: true, force: true })
      return 'internal'
    }
  }

  /** Local files on the clipboard that the user copied in Windows (not our own copies). */
  async clipboardFiles(): Promise<string[]> {
    const paths = await this.desktop.readClipboardFiles().catch(() => [])
    const own = this.clipDir
    return own && paths.every((p) => isWithin(own, p)) ? [] : paths
  }

  // ------------------------------------------------------------- drag out ----

  /**
   * Let the user drag server files out of the window, e.g. onto the desktop.
   * `startDrag` must begin a native file drag of the given file and return when the mouse button
   * is released. Resolves with the folder the items are being downloaded to, or null when the drag
   * ended somewhere else (inside the app, cancelled, or on a target that takes no files).
   *
   * Everything up to `startDrag` runs synchronously on purpose. The drag blocks until the mouse
   * button is released, and file system events only keep arriving during that time when it was
   * started directly from the message of the window, not from a continuation of file I/O.
   */
  dragOut(id: string, entries: RemoteEntry[], startDrag: (markerFile: string) => void): Promise<string | null> {
    this.get(id)
    this.drag?.cancel()
    const dir = mkdtempSync(join(this.desktop.tempRoot, 'clavium-drag-'))
    const token = randomBytes(32).toString('hex')
    const label = entries.length === 1 ? safeLocalName(entries[0].name).slice(0, 80) : `${entries.length} items`
    const markerName = `${label} (Clavium download ${token.slice(0, 8)}).tmp`
    const marker = join(dir, markerName)
    writeFileSync(marker, token)
    const watch = watchForDrop({ markerName, markerContent: token, ignoreDir: dir, roots: this.desktop.dropRoots?.() ?? driveRoots() })
    const drag = {
      cancelled: false,
      cancel: (): void => {
        drag.cancelled = true
        watch.stop()
      }
    }
    this.drag = drag
    const finish = async (): Promise<string | null> => {
      try {
        const timeout = setTimeout(() => watch.stop(), DROP_WAIT_MS)
        const target = await watch.found
        clearTimeout(timeout)
        if (!target || drag.cancelled) return null
        void this.download(id, entries, { localDir: target })
        return target
      } finally {
        watch.stop()
        if (this.drag === drag) this.drag = null
        await rm(dir, { recursive: true, force: true })
      }
    }
    try {
      startDrag(marker)
    } catch (e) {
      drag.cancel()
      return finish().then(() => Promise.reject(e))
    }
    return finish()
  }

  /** The drag ended inside the app: there is nothing to download. */
  cancelDrag(): void {
    this.drag?.cancel()
  }

  // ------------------------------------------------- download and upload ----

  private progress(p: TransferProgress): void {
    this.send('files:progress', p)
  }

  /** Transfers that are running right now, by transfer id. */
  private jobs = new Map<string, { cancel: () => void }>()
  /** Raised by "cancel all", so that queued items of a running batch don't start. */
  private cancelRound = 0

  /**
   * Run one transfer on connections of its own, so it can be stopped: cancelling closes those
   * connections, which ends the transfer at once and leaves the session the user browses with
   * alone. Without a second connection (some FTP servers allow only one) the transfer still
   * runs, and cancelling takes effect before the next file.
   */
  private async job(
    transferId: string,
    sources: RemoteFs[],
    run: (handles: RemoteFs[], cancelled: () => boolean) => Promise<void>
  ): Promise<'done' | 'cancelled'> {
    const forks = new Map<RemoteFs, RemoteFs | null>()
    let cancelled = false
    const closeForks = (): void => forks.forEach((f) => f?.close())
    this.jobs.set(transferId, {
      cancel: () => {
        cancelled = true
        closeForks()
      }
    })
    try {
      for (const fs of sources) if (!forks.has(fs)) forks.set(fs, await fs.fork().catch(() => null))
      if (cancelled) return 'cancelled'
      await run(
        sources.map((fs) => forks.get(fs) ?? fs),
        () => cancelled
      )
      return 'done'
    } catch (e) {
      if (cancelled) return 'cancelled'
      throw e
    } finally {
      this.jobs.delete(transferId)
      closeForks()
    }
  }

  cancelTransfer(transferId: string): void {
    this.jobs.get(transferId)?.cancel()
  }

  cancelAllTransfers(): void {
    this.cancelRound++
    for (const job of [...this.jobs.values()]) job.cancel()
  }

  /** Download files/folders into `localDir` (or exactly to `localFile` for a single file). */
  async download(id: string, entries: RemoteEntry[], target: { localDir?: string; localFile?: string }): Promise<void> {
    const fs = this.get(id)
    const round = this.cancelRound
    for (const entry of entries) {
      if (round !== this.cancelRound) return
      const transferId = randomId()
      const report = (transferred: number, total: number, extra: Partial<TransferProgress> = {}): void =>
        this.progress({ transferId, name: entry.name, direction: 'download', transferred, total, done: false, ...extra })
      try {
        report(0, entry.size)
        const outcome = await this.job(transferId, [fs], async ([h], cancelled) => {
          if (target.localFile && entries.length === 1 && entry.type !== 'dir') {
            await h.download(entry.path, target.localFile, (t, tot) => report(t, tot)).catch(async (e) => {
              await rm(target.localFile!, { force: true })
              throw e
            })
          } else if (target.localDir) {
            await this.downloadRecursive(h, entry, target.localDir, (t, tot) => report(t, tot), 0, cancelled)
          }
        })
        report(entry.size, entry.size, { done: true, cancelled: outcome === 'cancelled' })
      } catch (e) {
        report(0, entry.size, { done: true, error: (e as Error).message })
      }
    }
  }

  private async downloadRecursive(
    fs: RemoteFs,
    entry: RemoteEntry,
    localDir: string,
    report: (t: number, total: number) => void,
    depth: number,
    cancelled: () => boolean = () => false
  ): Promise<string> {
    if (depth > 64) throw new Error('Directory tree too deep')
    if (cancelled()) throw new Error('Cancelled')
    const local = uniqueLocalPath(localDir, safeLocalName(entry.name))
    if (entry.type === 'dir') {
      await mkdir(local, { recursive: true })
      for (const child of await fs.list(entry.path)) {
        await this.downloadRecursive(fs, child, local, report, depth + 1, cancelled)
      }
    } else if (entry.type === 'file') {
      // a file that did not arrive completely is not left behind
      await fs.download(entry.path, local, report).catch(async (e) => {
        await rm(local, { force: true })
        throw e
      })
    }
    // links and special files are skipped on purpose
    return local
  }

  async upload(id: string, localPaths: string[], remoteDir: string): Promise<void> {
    const fs = this.get(id)
    const round = this.cancelRound
    for (const localPath of localPaths) {
      if (round !== this.cancelRound) return
      const transferId = randomId()
      const name = basename(localPath)
      const report = (transferred: number, total: number, extra: Partial<TransferProgress> = {}): void =>
        this.progress({ transferId, name, direction: 'upload', transferred, total, done: false, ...extra })
      try {
        const st = await stat(localPath)
        report(0, st.size)
        const outcome = await this.job(transferId, [fs], ([h], cancelled) =>
          this.uploadRecursive(h, fs, localPath, posix.join(remoteDir, name), (t, tot) => report(t, tot), 0, cancelled)
        )
        report(st.size, st.size, { done: true, cancelled: outcome === 'cancelled' })
      } catch (e) {
        report(0, 0, { done: true, error: (e as Error).message })
      }
    }
  }

  /** @param main the session of the user, used to tidy up after a cancelled file */
  private async uploadRecursive(
    fs: RemoteFs,
    main: RemoteFs,
    localPath: string,
    remotePath: string,
    report: (t: number, total: number) => void,
    depth: number,
    cancelled: () => boolean
  ): Promise<void> {
    if (depth > 64) throw new Error('Directory tree too deep')
    if (cancelled()) throw new Error('Cancelled')
    const st = await stat(localPath)
    if (st.isDirectory()) {
      await fs.mkdir(remotePath).catch(() => undefined) // may already exist
      for (const child of await readdir(localPath)) {
        await this.uploadRecursive(fs, main, join(localPath, child), posix.join(remotePath, child), report, depth + 1, cancelled)
      }
    } else if (st.isFile()) {
      let started = false
      await fs
        .upload(localPath, remotePath, (t, total) => {
          started = true
          report(t, total)
        })
        .catch(async (e) => {
          // Half of a file is worse than no file. Only when the user stopped a running upload:
          // after any other error the file on the server may be an older, intact one.
          if (cancelled() && started) await main.remove(remotePath, false).catch(() => undefined)
          throw e
        })
    }
  }
}
