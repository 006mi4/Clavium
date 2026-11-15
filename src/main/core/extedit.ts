import { watch, type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExternalEditStatus, RemoteEntry } from '@shared/types'
import { readableNow } from './localfile'
import { safeLocalName, type PairOutcome, type PairSpec } from './queue'
import type { RemoteFs } from './remotefs'

/** A program writes a file in several steps; wait until it is done. */
const SETTLE_MS = 500
/**
 * The system does not report every change: on a busy machine a report can get lost, above all
 * right after the watching began (measured on macOS). So the file is also looked at this often.
 */
const LOOK_MS = 2000
/** How often to look again while the program still holds the file after saving (Windows). */
const IN_USE_RETRIES = 60

export interface ExternalEditHost {
  /** The session of the user, as it is connected right now. */
  fs(): RemoteFs
  /** Upload exactly this file through the queue. */
  transfer(items: PairSpec[]): Promise<PairOutcome[]>
  /** Open the local copy in the editor. The file is passed to an editor, never started itself. */
  launch(localPath: string): Promise<void>
  /** Folder for the local copies. */
  tempRoot: string
  changed(): void
}

/** Extensions whose pictures the preview can show, with their media type. */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml'
}
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/** Read a picture from the server for the preview, as a data URL. */
export async function readImage(fs: RemoteFs, path: string): Promise<{ dataUrl: string; size: number }> {
  const mime = IMAGE_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
  if (!mime) throw new Error('This kind of file cannot be shown as a picture.')
  const st = await fs.stat(path)
  if (st.size > MAX_IMAGE_BYTES) throw new Error('This picture is larger than 16 MB. Download it to look at it.')
  const r = await fs.readFile(path, MAX_IMAGE_BYTES + 1)
  if (r.truncated || r.data.length > MAX_IMAGE_BYTES) throw new Error('This picture is larger than 16 MB. Download it to look at it.')
  return { dataUrl: `data:${mime};base64,${r.data.toString('base64')}`, size: r.data.length }
}

/**
 * A file of the server that is open in a program on this computer. Every time the program saves,
 * the file is uploaded. If the file on the server was changed by someone else in the meantime,
 * nothing is uploaded until the user says so.
 */
export class ExternalEdit {
  readonly status: ExternalEditStatus
  private dir = ''
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private looker: NodeJS.Timeout | null = null
  /** the local copy as it was when it was last looked at, so one change is handled once */
  private seen = { size: -1, mtimeMs: -1 }
  private stopped = false
  private busy = false
  private heldTries = 0
  /** What the file on the server looked like after the last download or upload. */
  private remote = { size: -1, modifiedAt: -1 }
  /** What the local copy looked like when it was last in step with the server. */
  private local = { size: -1, mtimeMs: -1 }

  constructor(
    id: string,
    sessionId: string,
    private readonly entry: RemoteEntry,
    private readonly host: ExternalEditHost
  ) {
    this.status = { id, sessionId, remote: entry.path, name: entry.name, localPath: '', state: 'open', uploads: 0 }
  }

  async start(): Promise<void> {
    await mkdir(this.host.tempRoot, { recursive: true })
    this.dir = await mkdtemp(join(this.host.tempRoot, 'edit-'))
    const localPath = join(this.dir, safeLocalName(this.entry.name))
    this.status.localPath = localPath
    try {
      const fs = this.host.fs()
      const before = await fs.stat(this.entry.path)
      if (before.type === 'dir') throw new Error('This is a folder.')
      await fs.download(this.entry.path, localPath)
      this.remote = { size: before.size, modifiedAt: before.modifiedAt }
      const st = await stat(localPath)
      this.local = { size: st.size, mtimeMs: st.mtimeMs }
      this.seen = { ...this.local }
      // The folder is watched, not the file: many programs save by writing a new file and renaming it.
      this.watcher = watch(this.dir, () => this.schedule())
      this.watcher.on('error', () => undefined)
      this.looker = setInterval(() => void this.look(), LOOK_MS)
      this.looker.unref()
      await this.host.launch(localPath)
    } catch (e) {
      await this.stop()
      throw e
    }
  }

  /** Catch a change the system did not report. */
  private async look(): Promise<void> {
    if (this.stopped || this.timer || this.busy) return
    const st = await stat(this.status.localPath).catch(() => null)
    if (st?.isFile() && (st.size !== this.seen.size || st.mtimeMs !== this.seen.mtimeMs)) this.schedule()
  }

  private schedule(force = false): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync(force), SETTLE_MS)
  }

  /** Upload the local copy if it changed. `force` also replaces changes someone else made on the server. */
  async sync(force: boolean): Promise<void> {
    this.timer = null
    if (this.stopped) return
    if (this.busy) return this.schedule(force)
    this.busy = true
    let again = false
    try {
      const st = await stat(this.status.localPath).catch(() => null)
      // In the middle of a save the file may be gone for a moment.
      if (!st?.isFile()) return
      this.seen = { size: st.size, mtimeMs: st.mtimeMs }
      if (!force && st.size === this.local.size && st.mtimeMs === this.local.mtimeMs) return
      // Some programs keep the file to themselves for a while after saving. Wait for them.
      if (!(await readableNow(this.status.localPath))) {
        if (++this.heldTries > IN_USE_RETRIES) throw new Error('The program keeps the file locked. Close the file there, then upload again')
        again = true
        return
      }
      this.heldTries = 0
      const fs = this.host.fs()
      if (!force) {
        const now = await fs.stat(this.status.remote).catch(() => null)
        if (!now || now.size !== this.remote.size || now.modifiedAt !== this.remote.modifiedAt) {
          this.status.state = 'conflict'
          this.status.lastError = now ? 'The file was changed on the server in the meantime.' : 'The file no longer exists on the server.'
          return
        }
      }
      this.status.state = 'uploading'
      this.status.lastError = undefined
      this.host.changed()
      const [outcome] = await this.host.transfer([{ direction: 'upload', local: this.status.localPath, remote: this.status.remote, size: st.size, modifiedAt: st.mtimeMs }])
      if (outcome.state !== 'done') throw new Error(outcome.error ?? 'The upload did not finish')
      const after = await fs.stat(this.status.remote)
      this.remote = { size: after.size, modifiedAt: after.modifiedAt }
      this.local = { size: st.size, mtimeMs: st.mtimeMs }
      this.status.uploads++
      this.status.state = 'open'
    } catch (e) {
      this.status.state = 'error'
      this.status.lastError = (e as Error).message
    } finally {
      this.busy = false
      if (again) this.schedule(force)
      else {
        this.heldTries = 0
        if (!this.stopped) this.host.changed()
      }
    }
  }

  /** Stop watching and remove the local copy. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.looker) clearInterval(this.looker)
    this.watcher?.close()
    this.watcher = null
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
