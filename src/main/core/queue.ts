import { chmod, mkdir, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, extname, join, posix } from 'node:path'
import type {
  ExistingRule,
  QueueAction,
  RemoteEntry,
  TransferConflict,
  TransferCounts,
  TransferItem,
  TransferSettings,
  TransferSnapshot,
  TransferState
} from '@shared/types'
import { randomId } from './crypto'
import { Throttle, type RemoteFs } from './remotefs'

/** A download is written to this name first, so an existing file stays intact until the new one is complete. */
export const PART_SUFFIX = '.clavium-part'

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

/** "report.txt", then "report (1).txt", "report (2).txt", ... until `taken` says no. */
function freeName(name: string, taken: (candidate: string) => boolean): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let candidate = name
  for (let i = 1; taken(candidate); i++) candidate = `${stem} (${i})${ext}`
  return candidate
}

/** "rwxr-xr-x" as a number. */
function modeOf(permissions: string | undefined): number | undefined {
  if (!permissions || permissions.length !== 9) return undefined
  let mode = 0
  for (let i = 0; i < 9; i++) if (permissions[i] !== '-') mode |= 1 << (8 - i)
  return mode
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )

const FINAL: ReadonlySet<TransferState> = new Set(['done', 'failed', 'cancelled', 'skipped'])
/** A transfer that broke off because of the connection is tried again this often before it counts as failed. */
const AUTO_RETRIES = 2
const RETRY_DELAY_MS = 800
const TICK_MS = 400
/** Finished entries beyond this number are only counted. */
const KEEP_FINISHED = 200
const SHOW = { queued: 100, finished: 30, failed: 100 }

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED', 'ENETRESET', 'ENETUNREACH', 'EHOSTUNREACH', 421, 425, 426, 450, 451])

interface Batch {
  sessionId: string
  /** The session of the user. Used to read folders; transfers run on connections of their own. */
  fs: RemoteFs
  rule: ExistingRule
  cancelled: boolean
  /** Running scans, and entries that are not finished. The batch is done when both are zero. */
  scans: number
  open: number
  settle: () => void
  /** What is in the folders on the server that this batch uploads into. */
  listings: Map<string, Promise<Map<string, RemoteEntry>>>
  /** Local names handed out per folder (lower case), with the server path each one stands for. */
  names: Map<string, Map<string, string>>
  /** Keep times and permissions whatever the settings say (synchronising depends on the times). */
  preserve?: boolean
}

/** One file and the exact place it goes to. */
export interface PairSpec {
  direction: 'upload' | 'download'
  local: string
  remote: string
  size: number
  modifiedAt: number
  mode?: number
}

export interface PairOutcome {
  state: 'done' | 'failed' | 'cancelled' | 'skipped'
  error?: string
}

interface Entry {
  id: string
  batch: Batch | null
  direction: TransferItem['direction']
  name: string
  local: string
  remote: string
  size: number
  mtime: number
  mode?: number
  state: TransferState
  transferred: number
  speed: number
  error?: string
  attempts: number
  /** Something of this transfer has been written to the target. */
  started: boolean
  /** The target was there before this transfer. */
  replaces: boolean
  /** Decided for this entry: by the user, or because the exact target was chosen in a dialog. */
  rule?: ExistingRule
  /** Continue an existing file at this byte (rule "resume"). */
  resumeAt?: number
  /** The file that was there became the part file of this download (rule "resume"). */
  adopted?: boolean
  conflict?: TransferConflict
  /** Set while running. */
  stop?: (why: 'pause' | 'cancel' | 'requeue') => void
  why?: 'pause' | 'cancel' | 'requeue'
  /** Read the folder again (entries that stand for a folder that could not be read). */
  rescan?: () => Promise<void>
  /** Stops a transfer that does not run in the queue (copy between servers). */
  external?: () => void
  lastBytes: number
  lastTick: number
}

export interface QueueHost {
  settings(): TransferSettings
  emit(snapshot: TransferSnapshot): void
  /** Something on the server of this session has changed. */
  changed(sessionId: string): void
  /** False once the session was closed. */
  alive(sessionId: string): boolean
}

/** Handle for a transfer that is only shown in the queue and runs elsewhere. */
export interface ExternalTransfer {
  id: string
  progress(transferred: number, total: number): void
  finish(state: 'done' | 'failed' | 'cancelled', error?: string): void
}

/**
 * The transfer queue: every file is an entry of its own, a few of them run at the same time, each
 * on a connection of its own. Entries can be paused, continued where they stopped, retried,
 * reordered and cancelled.
 */
export class TransferQueue {
  private entries: Entry[] = []
  private running = 0
  private paused = false
  private pool = new Map<string, RemoteFs[]>()
  private forks = new Map<string, Set<RemoteFs>>()
  private pruned = { done: 0, skipped: 0, cancelled: 0, bytes: 0 }
  private readonly throttle: Throttle
  private emitTimer: NodeJS.Timeout | null = null
  private ticker: NodeJS.Timeout | null = null
  private changedTimers = new Map<string, NodeJS.Timeout>()
  private scans = 0

  constructor(private readonly host: QueueHost) {
    this.throttle = new Throttle(() => host.settings().transferLimitKbps * 1024)
  }

  // ------------------------------------------------------------ adding ----

  private batch(sessionId: string, fs: RemoteFs, rule?: ExistingRule): { batch: Batch; done: Promise<void> } {
    let settle = (): void => undefined
    const done = new Promise<void>((r) => (settle = r))
    return {
      batch: { sessionId, fs, rule: rule ?? this.host.settings().transferExisting, cancelled: false, scans: 0, open: 0, settle, listings: new Map(), names: new Map() },
      done
    }
  }

  /**
   * Download files and folders into `localDir`, or one file to exactly `localFile`.
   * Resolves when every entry has finished, failed, or was skipped or cancelled.
   */
  download(
    sessionId: string,
    fs: RemoteFs,
    entries: RemoteEntry[],
    target: { localDir?: string; localFile?: string },
    rule?: ExistingRule
  ): Promise<void> {
    const { batch, done } = this.batch(sessionId, fs, rule)
    const single = target.localFile && entries.length === 1 && entries[0].type !== 'dir' ? target.localFile : null
    void this.scan(batch, async () => {
      if (single) {
        // The save dialog has already asked whether to replace the file.
        this.add(batch, 'download', entries[0], single, 'overwrite')
      } else if (target.localDir) {
        for (const entry of entries) await this.scanDownload(batch, entry, target.localDir, 0)
      }
    })
    return done
  }

  upload(sessionId: string, fs: RemoteFs, localPaths: string[], remoteDir: string, rule?: ExistingRule): Promise<void> {
    const { batch, done } = this.batch(sessionId, fs, rule)
    void this.scan(batch, async () => {
      for (const path of localPaths) await this.scanUpload(batch, path, posix.join(remoteDir, basename(path)), 0)
    })
    return done
  }

  /**
   * Transfer exactly these files, each to exactly its target, replacing what is there. The folders
   * they go into must exist. Resolves with how each one ended, in the order given.
   */
  async pairs(sessionId: string, fs: RemoteFs, items: PairSpec[], options: { rule?: ExistingRule; preserve?: boolean } = {}): Promise<PairOutcome[]> {
    const { batch, done } = this.batch(sessionId, fs, options.rule ?? 'overwrite')
    batch.preserve = options.preserve
    const added: (Entry | null)[] = []
    void this.scan(batch, async () => {
      for (const item of items) {
        const name = item.direction === 'upload' ? basename(item.local) : posix.basename(item.remote)
        added.push(this.add(batch, item.direction, { name, path: item.direction === 'upload' ? item.local : item.remote, size: item.size, modifiedAt: item.modifiedAt, mode: item.mode }, item.direction === 'upload' ? item.remote : item.local))
      }
    })
    await done
    return items.map((_, i) => {
      const entry = added[i]
      if (!entry || entry.state === 'cancelled') return { state: 'cancelled' }
      if (entry.state === 'done' || entry.state === 'skipped') return { state: entry.state }
      return { state: 'failed', error: entry.error }
    })
  }

  private async scan(batch: Batch, work: () => Promise<void>): Promise<void> {
    batch.scans++
    this.scans++
    this.touch()
    try {
      await work()
    } catch {
      // every step reports its own problems as entries of the queue
    } finally {
      batch.scans--
      this.scans--
      this.settleIfDone(batch)
      this.touch()
    }
  }

  private settleIfDone(batch: Batch): void {
    if (batch.scans === 0 && batch.open === 0) batch.settle()
  }

  private add(batch: Batch, direction: 'upload' | 'download', source: { name: string; path: string; size: number; modifiedAt: number; mode?: number }, target: string, rule?: ExistingRule): Entry | null {
    if (batch.cancelled) return null
    batch.open++
    const entry: Entry = {
      id: randomId(),
      batch,
      direction,
      name: source.name,
      local: direction === 'download' ? target : source.path,
      remote: direction === 'download' ? source.path : target,
      size: source.size,
      mtime: source.modifiedAt,
      mode: source.mode,
      state: 'queued',
      transferred: 0,
      speed: 0,
      attempts: 0,
      started: false,
      replaces: false,
      rule,
      lastBytes: 0,
      lastTick: 0
    }
    this.entries.push(entry)
    this.pump()
    return entry
  }

  /** An entry for a folder or file that could not even be read. Retrying it reads it again. */
  private problem(batch: Batch, direction: 'upload' | 'download', name: string, remote: string, error: unknown, rescan: () => Promise<void>): void {
    if (batch.cancelled) return
    this.entries.push({
      id: randomId(),
      batch,
      direction,
      name,
      local: '',
      remote,
      size: 0,
      mtime: 0,
      state: 'failed',
      transferred: 0,
      speed: 0,
      error: (error as Error).message,
      attempts: 0,
      started: false,
      replaces: false,
      rescan,
      lastBytes: 0,
      lastTick: 0
    })
    this.touch()
  }

  /** The local name for an item of the server: safe, and not shared with another item of this batch. */
  private localName(batch: Batch, dir: string, entry: RemoteEntry): string {
    let names = batch.names.get(dir)
    if (!names) batch.names.set(dir, (names = new Map()))
    const taken = names
    // Two names on the server can fall together here: after cleaning, or because this computer ignores case.
    const name = freeName(safeLocalName(entry.name), (c) => {
      const owner = taken.get(c.toLowerCase())
      return owner !== undefined && owner !== entry.path
    })
    taken.set(name.toLowerCase(), entry.path)
    return name
  }

  private async scanDownload(batch: Batch, entry: RemoteEntry, localDir: string, depth: number): Promise<void> {
    if (batch.cancelled) return
    const local = join(localDir, this.localName(batch, localDir, entry))
    if (entry.type === 'file') return void this.add(batch, 'download', { ...entry, mode: modeOf(entry.permissions) }, local)
    // links and special files are skipped on purpose
    if (entry.type !== 'dir') return
    let children: RemoteEntry[]
    try {
      if (depth > 64) throw new Error('Directory tree too deep')
      await mkdir(local, { recursive: true })
      children = await batch.fs.list(entry.path)
    } catch (e) {
      return this.problem(batch, 'download', entry.name, entry.path, e, () => this.scanDownload(batch, entry, localDir, depth))
    }
    for (const child of children) await this.scanDownload(batch, child, local, depth + 1)
  }

  /** The content of a folder on the server, read once per batch. */
  private listing(batch: Batch, dir: string): Promise<Map<string, RemoteEntry>> {
    let known = batch.listings.get(dir)
    if (!known) {
      known = batch.fs.list(dir).then((items) => new Map(items.map((i) => [i.name, i])))
      batch.listings.set(dir, known)
      known.catch(() => batch.listings.delete(dir))
    }
    return known
  }

  private async scanUpload(batch: Batch, localPath: string, remotePath: string, depth: number): Promise<void> {
    if (batch.cancelled) return
    const name = basename(localPath)
    let children: string[]
    try {
      if (depth > 64) throw new Error('Directory tree too deep')
      const st = await stat(localPath)
      if (st.isFile()) {
        return void this.add(batch, 'upload', { name, path: localPath, size: st.size, modifiedAt: st.mtimeMs, mode: process.platform === 'win32' ? undefined : st.mode & 0o777 }, remotePath)
      }
      if (!st.isDirectory()) return
      const siblings = await this.listing(batch, posix.dirname(remotePath))
      const there = siblings.get(name)
      if (there && there.type === 'file') throw new Error('A file with this name is in the way on the server')
      if (!there) {
        await batch.fs.mkdir(remotePath)
        siblings.set(name, { name, path: remotePath, type: 'dir', size: 0, modifiedAt: 0 })
        // Nothing can be in the way inside a folder that was just made.
        batch.listings.set(remotePath, Promise.resolve(new Map()))
        this.changed(batch.sessionId)
      }
      children = await readdir(localPath)
    } catch (e) {
      return this.problem(batch, 'upload', name, remotePath, e, () => this.scanUpload(batch, localPath, remotePath, depth))
    }
    for (const child of children) await this.scanUpload(batch, join(localPath, child), posix.join(remotePath, child), depth + 1)
  }

  // ---------------------------------------------------------- running ----

  private pump(): void {
    const limit = this.paused ? 0 : this.host.settings().transferConcurrency
    while (this.running < limit) {
      const next = this.entries.find((e) => e.state === 'queued')
      if (!next) break
      next.state = 'running'
      this.running++
      void this.run(next).finally(() => {
        this.running--
        this.pump()
      })
    }
    this.closeIdle()
    this.touch()
  }

  private finish(entry: Entry, state: TransferState, error?: string): void {
    const wasFinal = FINAL.has(entry.state)
    entry.state = state
    entry.error = error
    entry.speed = 0
    entry.stop = undefined
    entry.why = undefined
    if (FINAL.has(state) && !wasFinal && entry.batch && !entry.rescan) {
      entry.batch.open--
      this.settleIfDone(entry.batch)
    }
    if (FINAL.has(state)) this.prune()
    this.touch()
  }

  private prune(): void {
    const finished = this.entries.filter((e) => e.state === 'done' || e.state === 'skipped' || e.state === 'cancelled')
    for (const e of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) {
      this.pruned[e.state as 'done' | 'skipped' | 'cancelled']++
      this.pruned.bytes += e.state === 'done' ? e.size : 0
      this.entries.splice(this.entries.indexOf(e), 1)
    }
  }

  /** A connection for one transfer: a spare one of this session, a new one, or as a last resort the session itself. */
  private async acquire(sessionId: string, main: RemoteFs): Promise<{ fs: RemoteFs; own: boolean }> {
    const spare = this.pool.get(sessionId)?.pop()
    if (spare) return { fs: spare, own: true }
    // Some FTP servers allow only one connection: then the transfer shares the session.
    const fork = await main.fork().catch(() => null)
    if (!fork) return { fs: main, own: false }
    let all = this.forks.get(sessionId)
    if (!all) this.forks.set(sessionId, (all = new Set()))
    const set = all
    set.add(fork)
    fork.onClose(() => {
      set.delete(fork)
      const idle = this.pool.get(sessionId)
      const i = idle?.indexOf(fork) ?? -1
      if (i >= 0) idle?.splice(i, 1)
    })
    return { fs: fork, own: true }
  }

  private release(sessionId: string, fs: RemoteFs): void {
    if (!this.forks.get(sessionId)?.has(fs)) return
    let idle = this.pool.get(sessionId)
    if (!idle) this.pool.set(sessionId, (idle = []))
    idle.push(fs)
  }

  /** Spare connections are closed as soon as nothing waits for them. */
  private closeIdle(): void {
    for (const [sessionId, idle] of this.pool) {
      if (this.entries.some((e) => e.batch?.sessionId === sessionId && (e.state === 'queued' || e.state === 'running'))) continue
      for (const fs of idle.splice(0)) fs.close()
    }
  }

  private async run(entry: Entry): Promise<void> {
    const batch = entry.batch as Batch
    const abort = new AbortController()
    let handle: { fs: RemoteFs; own: boolean } | null = null
    const lost = (): boolean => !this.host.alive(batch.sessionId) || (!!handle?.own && !this.forks.get(batch.sessionId)?.has(handle.fs))
    entry.why = undefined
    entry.lastBytes = entry.transferred
    entry.lastTick = Date.now()
    entry.stop = (why) => {
      entry.why = why
      abort.abort()
      // FTP can only stop a transfer by dropping its connection.
      if (handle?.own && handle.fs.protocol === 'ftp') handle.fs.close()
    }
    try {
      if (!this.host.alive(batch.sessionId)) throw new Error('The connection was closed')
      if (!(await this.decide(entry))) {
        // Stopped while the question was being prepared.
        if (entry.state === 'asking' && abort.signal.aborted) throw new Error('Stopped')
        return
      }
      if (abort.signal.aborted) throw new Error('Stopped')
      handle = await this.acquire(batch.sessionId, batch.fs)
      if (abort.signal.aborted) throw new Error('Stopped')
      const options = {
        signal: abort.signal,
        throttle: this.throttle,
        onProgress: (transferred: number, total: number): void => {
          if (transferred > (entry.resumeAt ?? 0)) entry.started = true
          entry.transferred = transferred
          if (total > 0) entry.size = total
        }
      }
      if (entry.direction === 'download') await this.runDownload(entry, handle.fs, options)
      else await this.runUpload(entry, handle.fs, options)
      entry.transferred = entry.size
      this.finish(entry, 'done')
    } catch (e) {
      const why = entry.why
      const broken = lost()
      if (why === 'cancel') {
        await this.discard(entry)
        this.finish(entry, 'cancelled')
      } else if (why === 'pause') {
        this.finish(entry, 'paused')
      } else if (why === 'requeue') {
        this.finish(entry, 'queued')
      } else if (this.transient(e, broken) && entry.attempts < AUTO_RETRIES && this.host.alive(batch.sessionId)) {
        entry.attempts++
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
        // `why` may have been set while waiting.
        if (entry.why === 'cancel') {
          await this.discard(entry)
          this.finish(entry, 'cancelled')
        } else this.finish(entry, entry.why === 'pause' ? 'paused' : 'queued')
      } else {
        this.finish(entry, 'failed', (e as Error).message)
      }
    } finally {
      if (handle?.own) {
        if (lost() || (entry.why && handle.fs.protocol === 'ftp')) handle.fs.close()
        else this.release(batch.sessionId, handle.fs)
      }
    }
  }

  private transient(e: unknown, connectionLost: boolean): boolean {
    return connectionLost || TRANSIENT_CODES.has((e as { code?: string | number }).code ?? '')
  }

  /**
   * Find out whether the target exists and what follows from that.
   * Returns false when the entry does not run now: it was skipped, or the user is asked first.
   */
  private async decide(entry: Entry): Promise<boolean> {
    const batch = entry.batch as Batch
    // Our own unfinished part: continue it.
    if (entry.started) return true
    let existing: { size: number; modifiedAt: number } | null = null
    if (entry.direction === 'download') {
      const st = await stat(entry.local).catch(() => null)
      if (st?.isDirectory()) throw new Error('A folder with this name is in the way')
      if (st) existing = { size: st.size, modifiedAt: st.mtimeMs }
    } else {
      const there = (await this.listing(batch, posix.dirname(entry.remote))).get(posix.basename(entry.remote))
      if (there?.type === 'dir') throw new Error('A folder with this name is in the way on the server')
      if (there) existing = { size: there.size, modifiedAt: there.modifiedAt }
    }
    if (!existing) return true
    entry.replaces = true
    const rule = entry.rule ?? batch.rule
    switch (rule) {
      case 'overwrite':
        return true
      case 'skip':
        this.finish(entry, 'skipped')
        return false
      case 'newer': {
        // FTP listings often give times to the minute only.
        const tolerance = batch.fs.protocol === 'ftp' ? 60_000 : 1000
        if (entry.mtime > existing.modifiedAt + tolerance) return true
        this.finish(entry, 'skipped')
        return false
      }
      case 'resume':
        if (existing.size === entry.size) {
          this.finish(entry, 'skipped')
          return false
        }
        if (existing.size < entry.size) {
          entry.resumeAt = existing.size
          if (entry.direction === 'download' && !(await exists(entry.local + PART_SUFFIX))) {
            await rename(entry.local, entry.local + PART_SUFFIX)
            entry.adopted = true
          }
        }
        return true
      case 'rename':
        if (entry.direction === 'download') {
          const dir = dirname(entry.local)
          const taken = new Set((await readdir(dir)).map((n) => n.toLowerCase()))
          entry.local = join(dir, freeName(basename(entry.local), (c) => taken.has(c.toLowerCase()) || taken.has((c + PART_SUFFIX).toLowerCase())))
          entry.name = basename(entry.local)
        } else {
          const dir = posix.dirname(entry.remote)
          const siblings = await this.listing(batch, dir)
          entry.name = freeName(posix.basename(entry.remote), (c) => siblings.has(c))
          entry.remote = posix.join(dir, entry.name)
          siblings.set(entry.name, { name: entry.name, path: entry.remote, type: 'file', size: 0, modifiedAt: 0 })
        }
        entry.replaces = false
        return true
      default:
        entry.conflict = {
          id: entry.id,
          name: entry.name,
          direction: entry.direction as 'upload' | 'download',
          target: entry.direction === 'download' ? entry.local : entry.remote,
          source: { size: entry.size, modifiedAt: entry.mtime },
          existing,
          waiting: 0
        }
        // Not `finish`: the entry stays open and gives its place to the next one.
        entry.state = 'asking'
        entry.stop = undefined
        this.touch()
        return false
    }
  }

  private async runDownload(entry: Entry, fs: RemoteFs, options: { signal: AbortSignal; throttle: Throttle; onProgress: (t: number, total: number) => void }): Promise<void> {
    const part = entry.local + PART_SUFFIX
    let offset = 0
    if (entry.started || entry.resumeAt !== undefined) {
      offset = await stat(part).then(
        (s) => s.size,
        () => 0
      )
      if (offset > entry.size) offset = 0
    }
    entry.resumeAt = offset
    await fs.download(entry.remote, part, { ...options, offset })
    await rename(part, entry.local)
    if (entry.batch?.preserve ?? this.host.settings().transferPreserve) {
      if (entry.mtime > 0) await utimes(entry.local, new Date(), new Date(entry.mtime)).catch(() => undefined)
      // The owner keeps access to what was just downloaded.
      if (entry.mode !== undefined && process.platform !== 'win32') await chmod(entry.local, entry.mode | 0o600).catch(() => undefined)
    }
  }

  private async runUpload(entry: Entry, fs: RemoteFs, options: { signal: AbortSignal; throttle: Throttle; onProgress: (t: number, total: number) => void }): Promise<void> {
    let offset = entry.resumeAt ?? 0
    if (entry.started) {
      // Only what was acknowledged and is really there counts.
      const there = await fs.stat(entry.remote).catch(() => null)
      offset = there ? Math.min(there.size, entry.transferred) : 0
    }
    entry.resumeAt = offset
    try {
      await fs.upload(entry.local, entry.remote, { ...options, offset })
    } finally {
      if (entry.started) this.changed((entry.batch as Batch).sessionId)
    }
    if (entry.batch?.preserve ?? this.host.settings().transferPreserve) {
      if (entry.mtime > 0) await fs.setModified(entry.remote, entry.mtime).catch(() => undefined)
      // An existing file keeps the permissions it has on the server.
      if (entry.mode !== undefined && !entry.replaces && fs.protocol === 'sftp') await fs.chmod(entry.remote, entry.mode).catch(() => undefined)
    }
  }

  /** Remove what a cancelled transfer has left at the target. */
  private async discard(entry: Entry): Promise<void> {
    if (entry.direction === 'download' && entry.local) {
      // What was there before the download continued it is given back, not deleted.
      if (entry.adopted) await rename(entry.local + PART_SUFFIX, entry.local).catch(() => undefined)
      else await rm(entry.local + PART_SUFFIX, { force: true }).catch(() => undefined)
    }
    // Half of a file is worse than no file. Only when the upload had begun: otherwise the file
    // on the server may be an older, intact one.
    else if (entry.direction === 'upload' && entry.started && entry.batch && this.host.alive(entry.batch.sessionId)) {
      await entry.batch.fs.remove(entry.remote, false).catch(() => undefined)
      this.changed(entry.batch.sessionId)
    }
    entry.started = false
  }

  // ---------------------------------------------------------- control ----

  /** Answer the question about an existing target. With `all`, the answer also goes for every other waiting question. */
  answer(id: string, rule: Exclude<ExistingRule, 'ask'>, all: boolean): void {
    const asked = this.entries.find((e) => e.id === id && e.state === 'asking')
    if (!asked) return
    const targets = all ? this.entries.filter((e) => e.state === 'asking') : [asked]
    if (all) for (const batch of new Set(this.entries.map((e) => e.batch))) if (batch && batch.rule === 'ask') batch.rule = rule
    for (const e of targets) {
      e.rule = rule
      e.conflict = undefined
      e.state = 'queued'
    }
    this.pump()
  }

  /** Apply an action to one entry, or to all entries it fits when no id is given. */
  act(action: QueueAction, id?: string): void {
    const targets = id ? this.entries.filter((e) => e.id === id) : [...this.entries]
    if (!id && action === 'pause') this.paused = true
    if (!id && action === 'resume') this.paused = false
    for (const e of targets) {
      switch (action) {
        case 'pause':
          if (e.external) break
          if (e.state === 'running') e.stop?.(id ? 'pause' : 'requeue')
          else if (id && e.state === 'queued') e.state = 'paused'
          break
        case 'resume':
          if (e.state === 'paused') e.state = 'queued'
          break
        case 'retry':
          if (e.state !== 'failed') break
          if (e.rescan) {
            const { batch, rescan } = e
            this.entries.splice(this.entries.indexOf(e), 1)
            if (batch) void this.scan(batch, rescan)
          } else if (e.batch && this.host.alive(e.batch.sessionId)) {
            e.batch.open++
            e.attempts = 0
            e.error = undefined
            e.state = 'queued'
          }
          break
        case 'cancel':
          this.cancel(e)
          break
        default:
          if (id) this.reorder(e, action)
      }
    }
    if (!id && action === 'cancel') for (const batch of new Set(this.entries.map((e) => e.batch))) if (batch) batch.cancelled = true
    this.pump()
  }

  private cancel(e: Entry): void {
    if (e.external) return e.external()
    if (e.state === 'running') return e.stop?.('cancel')
    if (FINAL.has(e.state)) return
    e.conflict = undefined
    void this.discard(e)
    this.finish(e, 'cancelled')
  }

  private reorder(e: Entry, where: 'top' | 'up' | 'down' | 'bottom'): void {
    if (e.state !== 'queued' && e.state !== 'paused') return
    const movable = (x: Entry): boolean => x.state === 'queued' || x.state === 'paused'
    const from = this.entries.indexOf(e)
    const others = this.entries.map((x, i) => (movable(x) && x !== e ? i : -1)).filter((i) => i >= 0)
    const before = others.filter((i) => i < from)
    const after = others.filter((i) => i > from)
    const to = where === 'top' ? before[0] : where === 'up' ? before.at(-1) : where === 'down' ? after[0] : after.at(-1)
    if (to === undefined) return
    this.entries.splice(from, 1)
    this.entries.splice(to, 0, e)
  }

  /** Forget everything that is finished. */
  clearFinished(): void {
    this.entries = this.entries.filter((e) => !FINAL.has(e.state))
    this.pruned = { done: 0, skipped: 0, cancelled: 0, bytes: 0 }
    this.touch()
  }

  /** The session is gone: nothing of it can run any more. */
  sessionClosed(sessionId: string): void {
    for (const e of this.entries) {
      if (e.batch?.sessionId !== sessionId) continue
      e.batch.cancelled = true
      if (e.state === 'running') continue // fails by itself and is not tried again
      if (!FINAL.has(e.state)) {
        e.conflict = undefined
        this.finish(e, 'failed', 'The connection was closed')
      }
    }
    for (const fs of [...(this.forks.get(sessionId) ?? [])]) fs.close()
    this.forks.delete(sessionId)
    this.pool.delete(sessionId)
    this.touch()
  }

  /** Show a transfer that runs elsewhere in the queue. */
  external(direction: TransferItem['direction'], name: string, remote: string, total: number, cancel: () => void): ExternalTransfer {
    const entry: Entry = {
      id: randomId(),
      batch: null,
      direction,
      name,
      local: '',
      remote,
      size: total,
      mtime: 0,
      state: 'running',
      transferred: 0,
      speed: 0,
      attempts: 0,
      started: false,
      replaces: false,
      external: cancel,
      lastBytes: 0,
      lastTick: Date.now()
    }
    this.entries.push(entry)
    this.touch()
    return {
      id: entry.id,
      progress: (transferred, size) => {
        entry.transferred = transferred
        entry.size = size
      },
      finish: (state, error) => {
        if (state === 'done') entry.transferred = entry.size
        this.finish(entry, state, error)
      }
    }
  }

  // --------------------------------------------------------- reporting ----

  private changed(sessionId: string): void {
    if (this.changedTimers.has(sessionId)) return
    this.changedTimers.set(
      sessionId,
      setTimeout(() => {
        this.changedTimers.delete(sessionId)
        this.host.changed(sessionId)
      }, 300)
    )
  }

  private touch(): void {
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = null
      this.host.emit(this.snapshot())
    }, 60)
    const busy = this.entries.some((e) => e.state === 'running')
    if (busy && !this.ticker) {
      this.ticker = setInterval(() => this.tick(), TICK_MS)
    } else if (!busy && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private tick(): void {
    const now = Date.now()
    for (const e of this.entries) {
      if (e.state !== 'running') continue
      const seconds = (now - e.lastTick) / 1000
      if (seconds <= 0) continue
      const current = Math.max(0, e.transferred - e.lastBytes) / seconds
      // Smoothed, so the number can be read.
      e.speed = e.speed ? e.speed * 0.6 + current * 0.4 : current
      e.lastBytes = e.transferred
      e.lastTick = now
    }
    this.touch()
  }

  snapshot(): TransferSnapshot {
    const counts: TransferCounts = { queued: 0, running: 0, paused: 0, asking: 0, done: this.pruned.done, failed: 0, cancelled: this.pruned.cancelled, skipped: this.pruned.skipped }
    let bytesDone = this.pruned.bytes
    let bytesTotal = this.pruned.bytes
    let speed = 0
    let remaining = 0
    for (const e of this.entries) {
      counts[e.state]++
      if (e.state === 'cancelled' || e.state === 'skipped' || e.rescan) continue
      bytesTotal += e.size
      bytesDone += e.state === 'done' ? e.size : Math.min(e.transferred, e.size)
      if (e.state === 'running') speed += e.speed
      if (e.state === 'running' || e.state === 'queued') remaining += Math.max(0, e.size - e.transferred)
    }
    const shown = { queued: 0, failed: 0 }
    const finished = this.entries.filter((e) => e.state === 'done' || e.state === 'skipped' || e.state === 'cancelled')
    const recent = new Set(finished.slice(-SHOW.finished))
    const visible = this.entries.filter((e) => {
      if (e.state === 'queued') return shown.queued++ < SHOW.queued
      if (e.state === 'failed') return shown.failed++ < SHOW.failed
      if (FINAL.has(e.state)) return recent.has(e)
      return true
    })
    const asking = this.entries.filter((e) => e.state === 'asking' && e.conflict)
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    return {
      items: visible.map((e) => ({
        id: e.id,
        name: e.name,
        remotePath: e.remote,
        direction: e.direction,
        state: e.state,
        transferred: e.transferred,
        total: e.size,
        speed: e.state === 'running' ? Math.round(e.speed) : 0,
        eta: e.state === 'running' && e.speed > 0 ? Math.ceil(Math.max(0, e.size - e.transferred) / e.speed) : undefined,
        error: e.error
      })),
      counts,
      hidden: total - visible.length,
      bytesDone,
      bytesTotal,
      speed: Math.round(speed),
      eta: speed > 0 && !this.paused ? Math.ceil(remaining / speed) : undefined,
      paused: this.paused,
      scanning: this.scans > 0,
      conflict: asking[0]?.conflict ? { ...asking[0].conflict, waiting: asking.length - 1 } : null
    }
  }
}
