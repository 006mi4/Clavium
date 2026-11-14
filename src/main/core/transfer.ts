import { rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { MovePair, MoveResult, RemoteEntry } from '@shared/types'
import { randomId } from './crypto'
import type { RemoteFs } from './remotefs'

/** True when `child` is `parent` itself or lies somewhere below it. */
export function isInside(parent: string, child: string): boolean {
  const p = parent.replace(/\/+$/, '')
  return child === parent || child === p || child.startsWith(p + '/')
}

export async function remoteExists(fs: RemoteFs, path: string): Promise<boolean> {
  return fs.stat(path).then(
    () => true,
    () => false
  )
}

/** A free name in `dir`: "report.txt", then "report (2).txt", "report (3).txt", ... */
export async function uniqueRemotePath(fs: RemoteFs, dir: string, name: string): Promise<string> {
  const taken = new Set((await fs.list(dir)).map((e) => e.name))
  if (!taken.has(name)) return posix.join(dir, name)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!taken.has(candidate)) return posix.join(dir, candidate)
  }
  throw new Error(`No free name for ${name}`)
}

/**
 * Move or rename items on the server. Nothing is ever overwritten: an item whose target name is
 * taken stays where it is and is reported as failed. Items that did move are returned, so the
 * caller can offer to undo exactly those.
 */
export async function moveEntries(fs: RemoteFs, pairs: MovePair[]): Promise<MoveResult> {
  const result: MoveResult = { moved: [], failed: [] }
  for (const pair of pairs) {
    const name = posix.basename(pair.from)
    try {
      if (pair.from === pair.to) continue
      if (isInside(pair.from, pair.to)) throw new Error('A folder can’t be moved into itself')
      // FTP servers replace an existing target without asking, so this is checked here.
      if (await remoteExists(fs, pair.to)) throw new Error('An item with this name already exists there')
      await fs.rename(pair.from, pair.to)
      result.moved.push(pair)
    } catch (e) {
      result.failed.push({ name, error: (e as Error).message })
    }
  }
  return result
}

/** Which of these names already exist in `dir`. */
export async function conflictsIn(fs: RemoteFs, dir: string, names: string[]): Promise<string[]> {
  const taken = new Set((await fs.list(dir)).map((e) => e.name))
  return names.filter((n) => taken.has(n))
}

export interface Size {
  bytes: number
  files: number
}

/** Total size of files and folders; null as soon as one of the limits is exceeded. */
export async function measure(fs: RemoteFs, entries: RemoteEntry[], limit: Size): Promise<Size | null> {
  const total: Size = { bytes: 0, files: 0 }
  const walk = async (entry: RemoteEntry, depth: number): Promise<boolean> => {
    if (depth > 64) return false
    if (entry.type === 'dir') {
      for (const child of await fs.list(entry.path)) if (!(await walk(child, depth + 1))) return false
      return true
    }
    if (entry.type !== 'file') return true // links and special files are never transferred
    total.bytes += entry.size
    total.files += 1
    return total.bytes <= limit.bytes && total.files <= limit.files
  }
  for (const e of entries) if (!(await walk(e, 0))) return null
  return total
}

/**
 * Copy files and folders to `dstDir`, on the same server or on another one. Neither SFTP nor FTP
 * can copy on the server, so every file passes through a private temporary file on this computer,
 * which is deleted right after. Existing names are never replaced; the copy gets a numbered name.
 * Returns the paths of the new top-level items.
 */
export async function copyEntries(
  src: RemoteFs,
  dst: RemoteFs,
  entries: RemoteEntry[],
  dstDir: string,
  tmpDir: string,
  onProgress?: (entry: RemoteEntry, transferred: number, total: number) => void,
  cancelled: () => boolean = () => false
): Promise<string[]> {
  const created: string[] = []
  const copy = async (entry: RemoteEntry, target: string, top: RemoteEntry, depth: number): Promise<void> => {
    if (depth > 64) throw new Error('Directory tree too deep')
    if (cancelled()) throw new Error('Cancelled')
    if (entry.type === 'dir') {
      await dst.mkdir(target)
      for (const child of await src.list(entry.path)) await copy(child, posix.join(target, child.name), top, depth + 1)
    } else if (entry.type === 'file') {
      const tmp = join(tmpDir, randomId())
      try {
        await src.download(entry.path, tmp, (t, total) => onProgress?.(top, t / 2, total))
        await dst.upload(tmp, target, (t, total) => onProgress?.(top, total / 2 + t / 2, total))
      } finally {
        await rm(tmp, { force: true })
      }
    }
  }
  for (const entry of entries) {
    if (entry.type === 'dir' && src === dst && isInside(entry.path, dstDir)) {
      throw new Error(`“${entry.name}” can’t be copied into itself`)
    }
    const target = await uniqueRemotePath(dst, dstDir, entry.name)
    created.push(target)
    await copy(entry, target, entry, 0)
  }
  return created
}
