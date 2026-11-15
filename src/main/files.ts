import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { DEFAULT_TRANSFER_SETTINGS, type ClipboardCopyResult, type CopyResult, type ExistingRule, type HostRecord, type MovePair, type MoveResult, type QueueAction, type RemoteEntry, type TransferSettings, type TransferSnapshot } from '@shared/types'
import { randomId } from './core/crypto'
import { driveRoots, watchForDrop } from './core/dropwatch'
import { safeLocalName, TransferQueue } from './core/queue'
import { copyEntries, measure, moveEntries } from './core/transfer'
import type { Prompter } from './core/prompter'
import { openRemoteFs, type RemoteFs } from './core/remotefs'
import type { Vault } from './core/vault'

type Send = (channel: 'files:queue' | 'files:changed' | 'files:closed', ...args: unknown[]) => void

export { safeLocalName }

/** One spelling per path: Windows may hand out the short form (RUNNER~1) of a folder name. */
function canonical(path: string): string {
  try {
    return realpathSync.native(path).toLowerCase()
  } catch {
    return resolve(path).toLowerCase()
  }
}

function isWithin(dir: string, path: string): boolean {
  return canonical(path).startsWith(canonical(dir) + sep)
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
  /** Folder holding the server files that are currently on the system clipboard. */
  private clipDir: string | null = null
  private clipJob = 0
  private drag: { cancel: () => void } | null = null
  private readonly queue: TransferQueue

  constructor(
    private readonly vault: Vault,
    private readonly prompter: Prompter,
    private readonly send: Send,
    private readonly desktop: Desktop = NO_DESKTOP,
    settings: () => TransferSettings = () => DEFAULT_TRANSFER_SETTINGS
  ) {
    this.queue = new TransferQueue({
      settings,
      // Both fire from timers, possibly after the window is gone.
      emit: (snapshot) => this.quietly(() => this.send('files:queue', snapshot)),
      changed: (sessionId) => this.quietly(() => this.send('files:changed', sessionId)),
      alive: (sessionId) => this.sessions.has(sessionId)
    })
  }

  private quietly(fn: () => void): void {
    try {
      fn()
    } catch {
      /* nobody is listening any more */
    }
  }

  async open(host: HostRecord): Promise<string> {
    const fs = await openRemoteFs(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const id = randomId()
    this.sessions.set(id, fs)
    fs.onClose(() => {
      if (!this.sessions.delete(id)) return
      this.queue.sessionClosed(id)
      this.send('files:closed', id)
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
    this.queue.sessionClosed(id)
    fs?.close()
  }

  /** Close every session (vault locked, app quitting) and tell the interface about each one. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
      this.send('files:closed', id)
    }
    this.queueAction('cancel')
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

  /** Copy within one server or from one server to another. */
  async copy(srcId: string, entries: RemoteEntry[], dstId: string, dstDir: string): Promise<CopyResult> {
    const src = this.get(srcId)
    const dst = this.get(dstId)
    const tmp = await mkdtemp(join(this.desktop.tempRoot, 'clavium-copy-'))
    const created: string[] = []
    const round = this.cancelRound
    try {
      for (const entry of entries) {
        if (round !== this.cancelRound) break
        let cancel = (): void => undefined
        const shown = this.queue.external('copy', entry.name, entry.path, entry.size, () => cancel())
        try {
          const outcome = await this.job(
            [src, dst],
            async ([s, d], cancelled) => {
              created.push(...(await copyEntries(s, d, [entry], dstDir, tmp, (_e, t, total) => shown.progress(t, total), cancelled)))
            },
            (c) => (cancel = c)
          )
          shown.finish(outcome)
        } catch (e) {
          shown.finish('failed', (e as Error).message)
        }
      }
    } finally {
      await rm(tmp, { recursive: true, force: true })
      this.send('files:changed', dstId)
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
   * put on the system clipboard, so they can be pasted in Explorer or Finder. The folder is removed with the
   * next copy, when the vault is locked and when the app quits.
   */
  async copyToClipboard(id: string, entries: RemoteEntry[], forWindows: boolean): Promise<ClipboardCopyResult> {
    const fs = this.get(id)
    await this.forgetClipboard()
    // Otherwise a later paste would pick up whatever was copied in Explorer or Finder before.
    this.desktop.clearClipboard()
    if (!forWindows) return 'internal'
    const job = this.clipJob
    if (!(await measure(fs, entries, CLIPBOARD_LIMIT))) return 'too-large'
    const dir = await mkdtemp(join(this.desktop.tempRoot, 'clavium-clip-'))
    const staged: string[] = []
    try {
      for (const entry of entries) {
        if (entry.type !== 'dir' && entry.type !== 'file') continue
        staged.push(await this.stage(fs, entry, dir, 0))
      }
      if (job !== this.clipJob) throw new Error('superseded')
      // Set before the clipboard changes: a paste that arrives while the clipboard is being
      // written must already recognise these files as our own copies.
      this.clipDir = dir
      await this.desktop.writeClipboardFiles(staged)
      return 'ready'
    } catch {
      // Copying inside the app still works; only pasting in Explorer or Finder is not available.
      if (this.clipDir === dir) this.clipDir = null
      await rm(dir, { recursive: true, force: true })
      return 'internal'
    }
  }

  /** Local files on the clipboard that the user copied in Explorer or Finder (not our own copies). */
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

  /** Fetch a file or folder into a private folder, without showing it as a transfer. */
  private async stage(fs: RemoteFs, entry: RemoteEntry, localDir: string, depth: number): Promise<string> {
    if (depth > 64) throw new Error('Directory tree too deep')
    const local = uniqueLocalPath(localDir, safeLocalName(entry.name))
    if (entry.type === 'dir') {
      await mkdir(local, { recursive: true })
      for (const child of await fs.list(entry.path)) await this.stage(fs, child, local, depth + 1)
    } else if (entry.type === 'file') {
      await fs.download(entry.path, local)
    }
    // links and special files are skipped on purpose
    return local
  }

  // ------------------------------------------------- download and upload ----

  /** Raised by "cancel all", so that the remaining items of a running copy don't start. */
  private cancelRound = 0

  /**
   * Run one copy on connections of its own, so it can be stopped: cancelling closes those
   * connections, which ends the copy at once and leaves the session the user browses with
   * alone. Without a second connection (some FTP servers allow only one) the copy still
   * runs, and cancelling takes effect before the next file.
   */
  private async job(
    sources: RemoteFs[],
    run: (handles: RemoteFs[], cancelled: () => boolean) => Promise<void>,
    onCancel: (cancel: () => void) => void
  ): Promise<'done' | 'cancelled'> {
    const forks = new Map<RemoteFs, RemoteFs | null>()
    let cancelled = false
    const closeForks = (): void => forks.forEach((f) => f?.close())
    onCancel(() => {
      cancelled = true
      closeForks()
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
      closeForks()
    }
  }

  /** Download files and folders into `localDir` (or exactly to `localFile` for a single file). Resolves when all of it has settled. */
  download(id: string, entries: RemoteEntry[], target: { localDir?: string; localFile?: string }, rule?: ExistingRule): Promise<void> {
    return this.queue.download(id, this.get(id), entries, target, rule)
  }

  /** Upload local files and folders into `remoteDir`. Resolves when all of it has settled. */
  upload(id: string, localPaths: string[], remoteDir: string, rule?: ExistingRule): Promise<void> {
    return this.queue.upload(id, this.get(id), localPaths, remoteDir, rule)
  }

  /** Pause, resume, retry, cancel or move one transfer, or all of them when no id is given. */
  queueAction(action: QueueAction, transferId?: string): void {
    if (action === 'cancel' && !transferId) this.cancelRound++
    this.queue.act(action, transferId)
  }

  answerConflict(transferId: string, rule: Exclude<ExistingRule, 'ask'>, all: boolean): void {
    this.queue.answer(transferId, rule, all)
  }

  clearFinishedTransfers(): void {
    this.queue.clearFinished()
  }

  transfers(): TransferSnapshot {
    return this.queue.snapshot()
  }
}
