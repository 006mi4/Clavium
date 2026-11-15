import { lstat, mkdir, readdir, rmdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { allowedActions, isDelete } from '@shared/sync'
import type { RemoteEntry, SyncAction, SyncComparison, SyncItem, SyncKind, SyncOptions, SyncResult, SyncSide } from '@shared/types'
import { PART_SUFFIX, safeLocalName, type PairOutcome, type PairSpec } from './queue'
import type { RemoteFs } from './remotefs'

const MAX_DEPTH = 64
/** More differences than this are not listed; the comparison says so. */
const MAX_ITEMS = 50_000
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
/** Local file systems and SFTP keep seconds; FAT keeps even seconds only. */
const BASE_TOLERANCE = 2000

/** Files that the operating system or a running download puts into folders. They are never compared or uploaded. */
export function ignoredName(name: string): boolean {
  return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini' || name.endsWith(PART_SUFFIX)
}

/** Whether this computer treats "Readme" and "readme" as one name. */
const FOLDS_CASE = process.platform === 'win32' || process.platform === 'darwin'

class Stopped extends Error {}

export interface FilePair {
  rel: string
  local: SyncSide
  remote: SyncSide
  precision?: RemoteEntry['timePrecision']
}

function toleranceOf(precision: RemoteEntry['timePrecision']): number {
  return precision === 'day' ? DAY : precision === 'minute' ? MINUTE : BASE_TOLERANCE
}

/**
 * Find out by how much the clock of an FTP server is shifted. Plain listings give times in the
 * time zone of the server without naming it, so every file seems to be some whole hours older or
 * newer. When most files of equal size are apart by the same number of quarter hours, that is
 * the shift. Returns minutes; 0 when there is no clear answer.
 */
export function detectOffsetMinutes(pairs: FilePair[]): number {
  const votes = new Map<number, number>()
  let candidates = 0
  for (const p of pairs) {
    if (p.local.size !== p.remote.size || !p.remote.modifiedAt || p.precision === 'day') continue
    candidates++
    const delta = p.remote.modifiedAt - p.local.modifiedAt
    const quarters = Math.round(delta / (15 * MINUTE))
    if (Math.abs(quarters) > 14 * 4) continue
    if (Math.abs(delta - quarters * 15 * MINUTE) > toleranceOf(p.precision)) continue
    votes.set(quarters, (votes.get(quarters) ?? 0) + 1)
  }
  let best = 0
  let count = 0
  for (const [quarters, n] of votes) if (n > count) [best, count] = [quarters, n]
  // A few files are not enough to tell a shifted clock from files that were simply changed.
  if (best === 0 || count < 3 || count < candidates * 0.6) return 0
  return best * 15
}

/** How two files with the same name differ, or null when they count as equal. */
export function classify(pair: FilePair, options: { compareBy: SyncOptions['compareBy']; offsetMinutes: number }): SyncKind | null {
  const sameSize = pair.local.size === pair.remote.size
  if (options.compareBy === 'size' && sameSize) return null
  // A server that tells no time: only the size can be compared.
  if (!pair.remote.modifiedAt) return sameSize ? null : 'different'
  const delta = pair.local.modifiedAt - (pair.remote.modifiedAt - options.offsetMinutes * MINUTE)
  const tolerance = toleranceOf(pair.precision)
  if (delta > tolerance) return 'localNewer'
  if (delta < -tolerance) return 'remoteNewer'
  return sameSize ? null : 'different'
}

interface LocalEntry {
  type: 'file' | 'dir' | 'other'
  size: number
  modifiedAt: number
}

async function localList(dir: string): Promise<Map<string, LocalEntry>> {
  const out = new Map<string, LocalEntry>()
  for (const name of (await readdir(dir)).sort()) {
    if (ignoredName(name)) continue
    const st = await lstat(join(dir, name)).catch(() => null)
    // Gone between listing and looking at it.
    if (!st) continue
    out.set(name, { type: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other', size: st.size, modifiedAt: st.mtimeMs })
  }
  return out
}

/**
 * The local path of an item. No part of `rel` may lead out of the folder. Names that come from the
 * server were already checked with `safeLocalName` when the folders were compared.
 */
export function localPathOf(localDir: string, rel: string): string {
  const parts = rel.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\0') || (process.platform === 'win32' && /[\\:]/.test(part))) throw new Error(`Not a safe local name: ${rel}`)
  }
  return join(localDir, ...parts)
}

const remotePathOf = (remoteDir: string, rel: string): string => posix.join(remoteDir, rel)

function bySegments(a: string, b: string): number {
  const x = a.split('/')
  const y = b.split('/')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  }
  return x.length - y.length
}

/**
 * Compare a local folder with a folder on the server, with everything inside. Nothing is changed.
 * Links are never followed and never listed as a difference.
 */
export async function compareTrees(
  fs: RemoteFs,
  localDir: string,
  remoteDir: string,
  options: SyncOptions,
  signal: AbortSignal,
  progress: (scanned: number) => void = () => undefined
): Promise<Omit<SyncComparison, 'id'>> {
  const items: SyncItem[] = []
  const pairs: FilePair[] = []
  const skipped: SyncComparison['skipped'] = []
  const unreadable: string[] = []
  let truncated = false
  let scanned = 0

  const check = (): void => {
    if (signal.aborted) throw new Stopped()
  }
  const seen = (): void => {
    if (++scanned % 50 === 0) progress(scanned)
  }
  const add = (item: SyncItem): void => {
    if (items.length >= MAX_ITEMS) truncated = true
    else items.push(item)
  }
  const child = (rel: string, name: string): string => (rel ? `${rel}/${name}` : name)
  const skip = (rel: string, reason: string): void => void skipped.push({ rel, reason })
  const LINK = 'Links and special files are left alone'

  const remoteList = async (rel: string): Promise<RemoteEntry[] | null> => {
    try {
      return (await fs.list(remotePathOf(remoteDir, rel))).filter((e) => !ignoredName(e.name)).sort((a, b) => (a.name < b.name ? -1 : 1))
    } catch {
      check()
      unreadable.push(rel || '.')
      return null
    }
  }
  const localOf = async (rel: string): Promise<Map<string, LocalEntry> | null> => {
    try {
      return await localList(rel ? localPathOf(localDir, rel) : localDir)
    } catch {
      unreadable.push(rel || '.')
      return null
    }
  }
  /** A name of the server that can be a name on this computer as it is. */
  const usable = (name: string): boolean => safeLocalName(name) === name

  const onlyLocal = async (rel: string, entry: LocalEntry, depth: number): Promise<void> => {
    check()
    seen()
    if (/[\r\n\0]/.test(rel)) return skip(rel, 'This name cannot be used on a server')
    if (entry.type === 'other') return skip(rel, LINK)
    add({ rel, type: entry.type, kind: 'onlyLocal', local: { size: entry.type === 'file' ? entry.size : 0, modifiedAt: entry.modifiedAt } })
    if (entry.type !== 'dir') return
    if (depth >= MAX_DEPTH) return void unreadable.push(rel)
    const children = await localOf(rel)
    for (const [name, e] of children ?? []) await onlyLocal(child(rel, name), e, depth + 1)
  }

  const onlyRemote = async (rel: string, entry: RemoteEntry, depth: number): Promise<void> => {
    check()
    seen()
    if (!usable(entry.name)) return skip(rel, 'This name cannot be used on this computer')
    if (entry.type !== 'file' && entry.type !== 'dir') return skip(rel, LINK)
    add({ rel, type: entry.type, kind: 'onlyRemote', remote: { size: entry.type === 'file' ? entry.size : 0, modifiedAt: entry.modifiedAt } })
    if (entry.type !== 'dir') return
    if (depth >= MAX_DEPTH) return void unreadable.push(rel)
    const children = await remoteList(rel)
    const taken = new Set<string>()
    for (const e of children ?? []) {
      const key = FOLDS_CASE ? e.name.toLowerCase() : e.name
      if (taken.has(key)) skip(child(rel, e.name), 'Another name in this folder differs only in upper and lower case')
      else await onlyRemote(child(rel, e.name), e, depth + 1)
      taken.add(key)
    }
  }

  const both = async (rel: string, depth: number): Promise<void> => {
    check()
    if (depth > MAX_DEPTH) return void unreadable.push(rel)
    const remote = await remoteList(rel)
    if (!remote) return
    const local = await localOf(rel)
    if (!local) return
    const folded = new Map<string, string>()
    if (FOLDS_CASE) for (const name of local.keys()) folded.set(name.toLowerCase(), name)
    const matched = new Set<string>()
    const taken = new Set<string>()
    for (const r of remote) {
      check()
      const path = child(rel, r.name)
      const key = FOLDS_CASE ? r.name.toLowerCase() : r.name
      if (taken.has(key)) {
        skip(path, 'Another name in this folder differs only in upper and lower case')
        continue
      }
      taken.add(key)
      const localName = local.has(r.name) ? r.name : folded.get(key)
      const l = localName === undefined ? undefined : local.get(localName)
      if (localName !== undefined) matched.add(localName)
      if (!l) {
        await onlyRemote(path, r, depth + 1)
        continue
      }
      seen()
      if (!usable(r.name)) skip(path, 'This name cannot be used on this computer')
      else if (l.type === 'other' || (r.type !== 'file' && r.type !== 'dir')) skip(path, LINK)
      else if (l.type !== r.type) skip(path, 'A file on one side and a folder on the other')
      else if (l.type === 'dir') await both(path, depth + 1)
      else pairs.push({ rel: path, local: { size: l.size, modifiedAt: l.modifiedAt }, remote: { size: r.size, modifiedAt: r.modifiedAt }, precision: r.timePrecision })
    }
    for (const [name, l] of local) if (!matched.has(name)) await onlyLocal(child(rel, name), l, depth + 1)
  }

  let ended: SyncComparison['ended'] = 'done'
  try {
    await both('', 0)
  } catch (e) {
    if (!(e instanceof Stopped)) throw e
    ended = 'stopped'
  }

  // SFTP always tells the time in UTC; only FTP servers answer in their own time zone.
  const detected = options.offsetMinutes === null && fs.protocol === 'ftp' ? detectOffsetMinutes(pairs) : 0
  const offsetMinutes = options.offsetMinutes ?? detected
  let same = 0
  for (const pair of pairs) {
    const kind = classify(pair, { compareBy: options.compareBy, offsetMinutes })
    if (kind) add({ rel: pair.rel, type: 'file', kind, local: pair.local, remote: pair.remote })
    else same++
  }
  items.sort((a, b) => bySegments(a.rel, b.rel))
  progress(scanned)
  return { localDir, remoteDir, items, same, skipped, unreadable, offsetMinutes, offsetDetected: options.offsetMinutes === null && detected !== 0, truncated, ended }
}

// ------------------------------------------------------------------ applying ----

export interface SyncRunner {
  /** The session of the user: used to make and remove folders and to delete. */
  fs: RemoteFs
  /** Transfer exactly these files through the queue. */
  transfer(items: PairSpec[]): Promise<PairOutcome[]>
  /** Move a local file or folder to the trash of the system. */
  trash(path: string): Promise<void>
}

const depthOf = (rel: string): number => rel.split('/').length
const parentsOf = (rel: string): string[] => {
  const parts = rel.split('/')
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
}

/**
 * Carry out what the user chose for the differences of a comparison. Transfers run first and
 * deleting comes last. Folders on the server are only removed when they are empty, so a file
 * that appeared after the comparison is never lost.
 */
export async function applySync(runner: SyncRunner, comparison: SyncComparison, chosen: { rel: string; action: SyncAction }[]): Promise<SyncResult> {
  const byRel = new Map(comparison.items.map((i) => [i.rel, i]))
  const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, cancelled: 0, deletesSkipped: 0, failed: [] }
  const fail = (rel: string, e: unknown): void => void result.failed.push({ rel, error: (e as Error).message || String(e) })
  const actions = new Map<string, SyncAction>()
  for (const c of chosen) {
    const item = byRel.get(c.rel)
    if (!item) throw new Error(`Not part of this comparison: ${c.rel}`)
    if (!allowedActions(item).includes(c.action)) throw new Error(`"${c.action}" is not possible for ${c.rel}`)
    if (c.action !== 'skip') actions.set(c.rel, c.action)
  }
  const local = (rel: string): string => localPathOf(comparison.localDir, rel)
  const remote = (rel: string): string => remotePathOf(comparison.remoteDir, rel)
  const withAction = (action: SyncAction): SyncItem[] => comparison.items.filter((i) => actions.get(i.rel) === action)

  // --- folders the uploads need on the server
  const uploads = withAction('upload')
  const missingOnServer = new Set(comparison.items.filter((i) => i.type === 'dir' && i.kind === 'onlyLocal').map((i) => i.rel))
  const toMake = new Set<string>()
  for (const item of uploads) for (const dir of [...parentsOf(item.rel), ...(item.type === 'dir' ? [item.rel] : [])]) if (missingOnServer.has(dir)) toMake.add(dir)
  const notMade = new Set<string>()
  for (const dir of [...toMake].sort((a, b) => depthOf(a) - depthOf(b))) {
    try {
      await runner.fs.mkdir(remote(dir))
      if (actions.get(dir) === 'upload') result.uploaded++
    } catch (e) {
      // Someone else may have made it in the meantime.
      const there = await runner.fs.stat(remote(dir)).catch(() => null)
      if (there?.type !== 'dir') {
        notMade.add(dir)
        fail(dir, e)
      }
    }
  }

  // --- transfers
  const specs: PairSpec[] = []
  const specRel: string[] = []
  for (const item of uploads) {
    if (item.type !== 'file') continue
    if (parentsOf(item.rel).some((d) => notMade.has(d))) continue
    try {
      const st = await lstat(local(item.rel))
      if (!st.isFile()) throw new Error('This is no longer a file')
      specs.push({ direction: 'upload', local: local(item.rel), remote: remote(item.rel), size: st.size, modifiedAt: st.mtimeMs, mode: process.platform === 'win32' ? undefined : st.mode & 0o777 })
      specRel.push(item.rel)
    } catch (e) {
      fail(item.rel, e)
    }
  }
  for (const item of withAction('download')) {
    try {
      if (item.type === 'dir') {
        await mkdir(local(item.rel), { recursive: true })
        result.downloaded++
        continue
      }
      const target = local(item.rel)
      await mkdir(join(target, '..'), { recursive: true })
      specs.push({ direction: 'download', local: target, remote: remote(item.rel), size: item.remote?.size ?? 0, modifiedAt: item.remote?.modifiedAt ?? 0 })
      specRel.push(item.rel)
    } catch (e) {
      fail(item.rel, e)
    }
  }
  const outcomes = specs.length ? await runner.transfer(specs) : []
  outcomes.forEach((o, i) => {
    if (o.state === 'done') result[specs[i].direction === 'upload' ? 'uploaded' : 'downloaded']++
    else if (o.state === 'failed') fail(specRel[i], new Error(o.error ?? 'The transfer failed'))
    else result.cancelled++
  })

  // Cancelling the transfers means "stop": nothing is deleted after that.
  if (result.cancelled > 0) {
    result.deletesSkipped = withAction('deleteRemote').length + withAction('deleteLocal').length
    return result
  }

  // --- deleting on the server: files first, then folders from the deepest up
  const remoteDeletes = withAction('deleteRemote')
  for (const item of [...remoteDeletes.filter((i) => i.type === 'file'), ...remoteDeletes.filter((i) => i.type === 'dir').sort((a, b) => depthOf(b.rel) - depthOf(a.rel))]) {
    try {
      await runner.fs.remove(remote(item.rel), false)
      result.deleted++
    } catch (e) {
      fail(item.rel, e)
    }
  }

  // --- deleting here: into the trash
  const localDeletes = withAction('deleteLocal')
  const covered = new Set<string>()
  const partly = (dir: string): boolean =>
    comparison.truncated || [...comparison.skipped.map((s) => s.rel), ...comparison.unreadable].some((r) => r.startsWith(dir + '/')) || comparison.items.some((i) => i.rel.startsWith(dir + '/') && actions.get(i.rel) !== 'deleteLocal')
  // A folder that goes as a whole is moved to the trash in one piece, so it can be put back as it was.
  for (const item of localDeletes.filter((i) => i.type === 'dir').sort((a, b) => depthOf(a.rel) - depthOf(b.rel))) {
    if (parentsOf(item.rel).some((d) => covered.has(d)) || partly(item.rel)) continue
    try {
      await runner.trash(local(item.rel))
      covered.add(item.rel)
      result.deleted += 1 + comparison.items.filter((i) => i.rel.startsWith(item.rel + '/')).length
    } catch (e) {
      fail(item.rel, e)
    }
  }
  const rest = localDeletes.filter((i) => !covered.has(i.rel) && !parentsOf(i.rel).some((d) => covered.has(d)))
  for (const item of rest.filter((i) => i.type === 'file')) {
    try {
      await runner.trash(local(item.rel))
      result.deleted++
    } catch (e) {
      fail(item.rel, e)
    }
  }
  for (const item of rest.filter((i) => i.type === 'dir').sort((a, b) => depthOf(b.rel) - depthOf(a.rel))) {
    try {
      // Only when empty: something in it was kept on purpose.
      await rmdir(local(item.rel))
      result.deleted++
    } catch (e) {
      fail(item.rel, e)
    }
  }
  return result
}

/** How many of the chosen actions delete something. */
export function deleteCount(chosen: { action: SyncAction }[]): number {
  return chosen.filter((c) => isDelete(c.action)).length
}
