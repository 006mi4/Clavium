import { watch, type FSWatcher } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { basename, join, posix, sep } from 'node:path'
import type { WatchStatus } from '@shared/types'
import { readableNow } from './localfile'
import type { PairOutcome, PairSpec } from './queue'
import type { RemoteFs } from './remotefs'
import { ignoredName } from './sync'

/** Changes are collected for this long, so a file that is being saved is uploaded once. */
const SETTLE_MS = 400
/**
 * Right after the start the system may still report changes from before it (macOS does, and on
 * a busy machine seconds late). A report that arrives in this time for a file that was not
 * touched since the start is such an old change.
 */
const WARMUP_MS = 5000
/** How often a watch looks whether a lost connection is back. */
const OFFLINE_RETRY_MS = 1500
/** A file that another program still holds is looked at again after this time, this often. */
const IN_USE_RETRY_MS = 1500
const IN_USE_RETRIES = 20

export interface KeepUpHost {
  /** The session of the user, as it is connected right now. */
  fs(): RemoteFs
  /** False while the connection is lost and being opened again. Changes wait until it is back. */
  online(): boolean
  /** Upload exactly these files through the queue. */
  transfer(items: PairSpec[]): Promise<PairOutcome[]>
  /** Upload a whole new folder into a folder on the server. */
  uploadFolder(localPath: string, remoteParent: string): Promise<void>
  /** The status has changed. */
  changed(): void
}

/**
 * Watches a local folder and uploads what changes in it. Nothing is ever deleted on the server:
 * a file that is removed here stays there.
 */
export class FolderWatch {
  readonly status: WatchStatus
  private watcher: FSWatcher | null = null
  private pending = new Set<string>()
  /** paths the system reported during the warm-up: possibly changes from before the start */
  private early = new Set<string>()
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private stopped = false
  /** Folders (relative) that are known to exist on the server. */
  private knownDirs = new Set<string>([''])
  /** Files that could not be read because a program holds them, with the number of attempts. */
  private inUse = new Map<string, number>()

  constructor(
    id: string,
    sessionId: string,
    localDir: string,
    remoteDir: string,
    private readonly host: KeepUpHost,
    private readonly ended: (error?: Error) => void
  ) {
    this.status = { id, sessionId, localDir, remoteDir, state: 'watching', uploaded: 0, failed: 0, startedAt: Date.now() }
  }

  start(): void {
    this.watcher = watch(this.status.localDir, { recursive: true }, (_event, filename) => {
      if (typeof filename === 'string' && filename) this.note(filename)
    })
    this.watcher.on('error', (e) => {
      this.stop()
      this.ended(e)
    })
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.watcher?.close()
    this.watcher = null
  }

  private note(filename: string): void {
    const parts = filename.split(sep).filter(Boolean)
    if (!parts.length || parts.some((p) => ignoredName(p) || p === '..' || /[\r\n\0]/.test(p))) return
    const rel = parts.join('/')
    if (Date.now() - this.status.startedAt < WARMUP_MS) this.early.add(rel)
    this.pending.add(rel)
    this.schedule()
  }

  private schedule(ms = SETTLE_MS): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), ms)
  }

  private async ensureRemoteDir(rel: string): Promise<void> {
    if (this.knownDirs.has(rel)) return
    const parts = rel.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/')
      if (this.knownDirs.has(dir)) continue
      const path = posix.join(this.status.remoteDir, dir)
      try {
        await this.host.fs().mkdir(path)
      } catch (e) {
        const there = await this.host.fs().stat(path).catch(() => null)
        if (there?.type !== 'dir') throw e
      }
      this.knownDirs.add(dir)
    }
  }

  private async flush(): Promise<void> {
    this.timer = null
    if (this.busy) return this.schedule()
    if (!this.host.online() && !this.stopped) {
      this.timer = setTimeout(() => void this.flush(), OFFLINE_RETRY_MS)
      return
    }
    const rels = [...this.pending].sort((a, b) => a.split('/').length - b.split('/').length)
    this.pending.clear()
    if (!rels.length || this.stopped) return
    this.busy = true
    this.status.state = 'uploading'
    this.host.changed()
    const specs: PairSpec[] = []
    const wholeDirs: string[] = []
    const held: string[] = []
    const problem = (name: string, e: unknown): void => {
      this.status.failed++
      this.status.lastError = `${name}: ${(e as Error).message}`
    }
    try {
      for (const rel of rels) {
        if (this.stopped) return
        // A new folder is uploaded as a whole; what is inside needs no upload of its own.
        if (wholeDirs.some((d) => rel.startsWith(d + '/'))) continue
        const local = join(this.status.localDir, ...rel.split('/'))
        const st = await lstat(local).catch(() => null)
        // Removed here: it stays on the server.
        if (!st) continue
        // What counts is when the report arrived, not when it is worked on: an upload before it may take long.
        const start = this.status.startedAt
        const old = this.early.delete(rel) && st.ctimeMs < start && st.mtimeMs < start
        if (old) continue
        const parent = posix.dirname(rel) === '.' ? '' : posix.dirname(rel)
        const remote = posix.join(this.status.remoteDir, rel)
        try {
          if (st.isDirectory()) {
            if (this.knownDirs.has(rel)) continue
            const there = await this.host.fs().stat(remote).catch(() => null)
            if (there?.type !== 'dir') {
              await this.ensureRemoteDir(parent)
              wholeDirs.push(rel)
              await this.host.uploadFolder(local, posix.dirname(remote))
              this.status.uploaded++
              this.status.lastName = basename(local)
            }
            this.knownDirs.add(rel)
          } else if (st.isFile()) {
            await this.ensureRemoteDir(parent)
            const there = await this.host.fs().stat(remote).catch(() => null)
            // Already the same there (for instance a file that was just downloaded into this folder).
            if (there?.type === 'file' && there.size === st.size && there.modifiedAt && !there.timePrecision && Math.abs(there.modifiedAt - st.mtimeMs) <= 2000) continue
            // Still being written or open in a program that shares it with nobody (Windows): later.
            if (!(await readableNow(local))) {
              held.push(rel)
              continue
            }
            this.inUse.delete(rel)
            specs.push({ direction: 'upload', local, remote, size: st.size, modifiedAt: st.mtimeMs, mode: process.platform === 'win32' ? undefined : st.mode & 0o777 })
          }
        } catch (e) {
          problem(rel, e)
        }
      }
      if (specs.length && !this.stopped) {
        const outcomes = await this.host.transfer(specs)
        outcomes.forEach((o, i) => {
          if (o.state === 'done') {
            this.status.uploaded++
            this.status.lastName = basename(specs[i].local)
          } else if (o.state === 'failed') problem(basename(specs[i].local), new Error(o.error ?? 'The upload failed'))
        })
      }
    } finally {
      for (const rel of held) {
        const attempts = (this.inUse.get(rel) ?? 0) + 1
        if (attempts > IN_USE_RETRIES) {
          this.inUse.delete(rel)
          problem(rel, new Error('Another program keeps this file locked'))
        } else {
          this.inUse.set(rel, attempts)
          this.pending.add(rel)
        }
      }
      this.busy = false
      this.status.state = 'watching'
      if (!this.stopped) this.host.changed()
      // A change that arrives in the meantime shortens the wait, which is fine.
      if (this.pending.size && !this.timer) this.schedule(held.length ? IN_USE_RETRY_MS : SETTLE_MS)
    }
  }
}
