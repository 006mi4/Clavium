import { existsSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AuditEntry } from '@shared/types'

const MAX_BYTES = 5 * 1024 * 1024
const MAX_DETAIL = 2000

/** Append-only JSON-lines log of everything an AI client did (or tried to do). */
export class AuditLog {
  private chain: Promise<void> = Promise.resolve()
  private listeners = new Set<(e: AuditEntry) => void>()

  constructor(private readonly filePath: string) {}

  onEntry(fn: (e: AuditEntry) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  write(entry: Omit<AuditEntry, 'ts'>): Promise<void> {
    const full: AuditEntry = {
      ...entry,
      detail: entry.detail.length > MAX_DETAIL ? entry.detail.slice(0, MAX_DETAIL) + '…' : entry.detail,
      ts: Date.now()
    }
    for (const fn of this.listeners) fn(full)
    const run = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true })
      if (existsSync(this.filePath) && statSync(this.filePath).size > MAX_BYTES) {
        await rename(this.filePath, `${this.filePath}.1`)
      }
      await appendFile(this.filePath, JSON.stringify(full) + '\n', { mode: 0o600 })
    }
    this.chain = this.chain.then(run, run).catch(() => undefined)
    return this.chain
  }

  async recent(limit = 200): Promise<AuditEntry[]> {
    await this.chain
    if (!existsSync(this.filePath)) return []
    const lines = (await readFile(this.filePath, 'utf8')).split('\n').filter(Boolean)
    const out: AuditEntry[] = []
    for (const line of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(line) as AuditEntry)
      } catch {
        // skip damaged lines
      }
    }
    return out.reverse()
  }
}
