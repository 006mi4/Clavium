import type { ChmodOptions, FolderSize, RemoteEntry, TreeChange } from '@shared/types'
import type { RemoteFs } from './remotefs'

const MAX_DEPTH = 64

class Stopped extends Error {
  constructor() {
    super('Stopped')
  }
}

/**
 * Visit everything below `dir`, folders before their content. Links are reported but never
 * followed, so a link that points upwards cannot make the walk run in circles or leave the tree.
 * A folder that cannot be read is passed to `unreadable` and the walk goes on.
 */
async function walk(
  fs: RemoteFs,
  dir: string,
  signal: AbortSignal,
  visit: (entry: RemoteEntry) => void | Promise<void>,
  unreadable: (path: string, error: Error) => void,
  depth = 0
): Promise<void> {
  if (signal.aborted) throw new Stopped()
  if (depth > MAX_DEPTH) return unreadable(dir, new Error('Directory tree too deep'))
  let children: RemoteEntry[]
  try {
    children = await fs.list(dir)
  } catch (e) {
    if (signal.aborted) throw new Stopped()
    return unreadable(dir, e as Error)
  }
  for (const child of children) {
    if (signal.aborted) throw new Stopped()
    await visit(child)
    if (child.type === 'dir') await walk(fs, child.path, signal, visit, unreadable, depth + 1)
  }
}

/** Total size of files and folders with everything inside. Stops quietly when the signal fires and reports what it has. */
export async function folderSize(fs: RemoteFs, entries: RemoteEntry[], signal: AbortSignal): Promise<FolderSize> {
  const total: FolderSize = { bytes: 0, files: 0, folders: 0, unreadable: 0, complete: true }
  const count = (e: RemoteEntry): void => {
    if (e.type === 'dir') total.folders++
    else {
      total.files++
      if (e.type === 'file') total.bytes += e.size
    }
  }
  try {
    for (const entry of entries) {
      count(entry)
      if (entry.type === 'dir') await walk(fs, entry.path, signal, count, () => void total.unreadable++)
    }
  } catch (e) {
    if (!(e instanceof Stopped)) throw e
    total.complete = false
  }
  return total
}

/**
 * Turn what the user typed into a test for names. With `*` or `?` it is a pattern for the whole
 * name, otherwise the name only has to contain it. Upper and lower case make no difference.
 */
export function nameMatcher(query: string): (name: string) => boolean {
  const q = query.trim().toLowerCase()
  if (!q) return () => false
  if (!/[*?]/.test(q)) return (name) => name.toLowerCase().includes(q)
  const pattern = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  return (name) => pattern.test(name.toLowerCase())
}

export interface SearchReport {
  hits: RemoteEntry[]
  /** Items looked at so far. */
  scanned: number
}

/**
 * Search by name below `root`. Hits are handed over in small groups while the search runs.
 * Returns how it ended: all of the tree was searched, the limit of hits was reached, or it was stopped.
 */
export async function searchTree(
  fs: RemoteFs,
  root: string,
  query: string,
  signal: AbortSignal,
  report: (r: SearchReport) => void,
  limit = 2000
): Promise<{ scanned: number; found: number; unreadable: number; ended: 'complete' | 'limit' | 'stopped' }> {
  const matches = nameMatcher(query)
  let scanned = 0
  let found = 0
  let unreadable = 0
  let pending: RemoteEntry[] = []
  let last = Date.now()
  const flush = (): void => {
    report({ hits: pending, scanned })
    pending = []
    last = Date.now()
  }
  const full = new Stopped()
  let ended: 'complete' | 'limit' | 'stopped' = 'complete'
  try {
    await walk(
      fs,
      root,
      signal,
      (entry) => {
        scanned++
        if (matches(entry.name)) {
          pending.push(entry)
          if (++found >= limit) throw full
        }
        if (pending.length >= 50 || Date.now() - last > 250) flush()
      },
      () => void unreadable++
    )
  } catch (e) {
    if (!(e instanceof Stopped)) throw e
    ended = e === full ? 'limit' : 'stopped'
  }
  flush()
  return { scanned, found, unreadable, ended }
}

/** Run `change` on the items and, when asked, on everything inside the folders among them. */
async function changeTree(
  fs: RemoteFs,
  entries: RemoteEntry[],
  recursive: boolean,
  signal: AbortSignal,
  change: (entry: RemoteEntry) => Promise<void> | undefined
): Promise<TreeChange> {
  const result: TreeChange = { changed: 0, failed: [], complete: true }
  const apply = async (entry: RemoteEntry): Promise<void> => {
    // A change to a link would land on whatever it points to, possibly outside of the tree.
    if (entry.type === 'link' && recursive) return
    try {
      const work = change(entry)
      if (!work) return
      await work
      result.changed++
    } catch (e) {
      if (result.failed.length < 100) result.failed.push({ path: entry.path, error: (e as Error).message })
      else result.failed[99] = { path: '…', error: 'More items failed' }
    }
  }
  try {
    for (const entry of entries) {
      if (signal.aborted) throw new Stopped()
      await apply(entry)
      if (recursive && entry.type === 'dir') {
        await walk(fs, entry.path, signal, apply, (path, error) => void result.failed.push({ path, error: error.message }))
      }
    }
  } catch (e) {
    if (!(e instanceof Stopped)) throw e
    result.complete = false
  }
  return result
}

/** The permission bits an item gets: folders can keep "open folder" wherever they may be read. */
export function modeFor(type: RemoteEntry['type'], o: ChmodOptions): number | null {
  const isDir = type === 'dir'
  if (o.recursive && ((o.target === 'files' && isDir) || (o.target === 'folders' && !isDir))) return null
  let mode = o.mode & 0o777
  if (isDir && o.recursive && o.foldersOpen) mode |= (mode & 0o444) >> 2
  return mode
}

export function chmodTree(fs: RemoteFs, entries: RemoteEntry[], options: ChmodOptions, signal: AbortSignal): Promise<TreeChange> {
  // What was selected itself is always changed; `target` only narrows down the content of folders.
  const top = new Set(entries.map((e) => e.path))
  return changeTree(fs, entries, options.recursive, signal, (entry) => {
    const mode = top.has(entry.path) ? modeFor(entry.type, { ...options, target: 'all' }) : modeFor(entry.type, options)
    return mode === null ? undefined : fs.chmod(entry.path, mode)
  })
}

export function chownTree(
  fs: RemoteFs,
  entries: RemoteEntry[],
  owner: { uid?: number; gid?: number },
  recursive: boolean,
  signal: AbortSignal
): Promise<TreeChange> {
  return changeTree(fs, entries, recursive, signal, (entry) => fs.chown(entry.path, owner.uid, owner.gid))
}
