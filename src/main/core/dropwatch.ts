import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

/**
 * Finds the folder a file was dropped into.
 *
 * Windows only tells a program that a drag has ended, not where the item landed. So a small marker
 * file with an unguessable name is dragged, and the drives are watched for the moment Windows
 * copies it somewhere. The folder it appears in is the drop target. The marker is then removed
 * again — but only after its content has been checked, so that no other file is ever deleted.
 */
export interface DropWatch {
  /** Resolves with the folder the marker was copied to, or null when `stop` is called first. */
  readonly found: Promise<string | null>
  stop(): void
}

/** Roots of all drives that currently exist (Windows), or the file system root elsewhere. */
export function driveRoots(): string[] {
  if (process.platform !== 'win32') return ['/']
  return 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((letter) => `${letter}:\\`)
    .filter((root) => existsSync(root))
}

export function watchForDrop(opts: { markerName: string; markerContent: string; ignoreDir: string; roots: string[] }): DropWatch {
  const watchers: FSWatcher[] = []
  const ignore = resolve(opts.ignoreDir).toLowerCase()
  let finish: (dir: string | null) => void = () => undefined
  let settled = false
  const found = new Promise<string | null>((res) => {
    finish = (dir) => {
      if (settled) return
      settled = true
      for (const w of watchers) w.close()
      res(dir)
    }
  })

  const check = async (file: string): Promise<void> => {
    if (settled || dirname(file).toLowerCase() === ignore) return
    // The copy may still be in progress when the event arrives.
    for (let attempt = 0; attempt < 20 && !settled; attempt++) {
      try {
        if ((await readFile(file, 'utf8')) === opts.markerContent) {
          await unlink(file).catch(() => undefined)
          finish(dirname(file))
          return
        }
      } catch {
        /* not readable yet */
      }
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  for (const root of opts.roots) {
    try {
      const w = watch(root, { recursive: true }, (_event, name) => {
        if (typeof name === 'string' && name.endsWith(opts.markerName)) void check(join(root, name))
      })
      w.on('error', () => undefined) // e.g. a drive that was removed
      watchers.push(w)
    } catch {
      /* a drive that can't be watched is skipped */
    }
  }

  return { found, stop: () => finish(null) }
}
