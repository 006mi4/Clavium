import { open, rename as renameFile } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * What the system answers while a file cannot be touched right now. On Windows a program can hold
 * a file so that nobody else may read or replace it (editors and office programs do, and a virus
 * scanner does for a moment after a file was written). Elsewhere the same codes come from a file
 * without the permission to read it.
 */
const IN_USE = new Set(['EBUSY', 'EPERM', 'EACCES'])

export function inUse(e: unknown): boolean {
  return IN_USE.has((e as { code?: string } | null)?.code ?? '')
}

/** False while another program holds the file so that it cannot be read. */
export async function readableNow(path: string): Promise<boolean> {
  try {
    await (await open(path, 'r')).close()
    return true
  } catch (e) {
    // Anything else (the file is gone, for instance) is for the caller to find out.
    return !inUse(e)
  }
}

const RENAME_RETRY_MS = [50, 100, 200, 400, 800]

/**
 * Rename a file, replacing the target. A target that is held by another program for a moment is
 * waited for; one that stays held ends in a message that says so.
 */
export async function renameWhenFree(from: string, to: string, options: { rename?: (from: string, to: string) => Promise<void>; delays?: number[] } = {}): Promise<void> {
  const rename = options.rename ?? renameFile
  const delays = options.delays ?? RENAME_RETRY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (e) {
      if (!inUse(e)) throw e
      if (attempt >= delays.length) {
        throw Object.assign(new Error(`"${basename(to)}" cannot be replaced: it is open in another program or write-protected. Close it there and retry`), { code: (e as { code?: string }).code })
      }
      await new Promise((r) => setTimeout(r, delays[attempt]))
    }
  }
}
