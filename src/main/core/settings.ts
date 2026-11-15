import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DEFAULT_SETTINGS, EXISTING_RULES, type AppSettings } from '@shared/types'

export const settingsSchema = z.object({
  autoLockMinutes: z.number().int().min(0).max(24 * 60),
  lockOnSystemLock: z.boolean(),
  mcpEnabled: z.boolean(),
  mcpPort: z.number().int().min(1024).max(65535),
  mcpTokenHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  closeToTray: z.boolean(),
  terminalFontSize: z.number().int().min(8).max(32),
  autoCheckUpdates: z.boolean(),
  transferConcurrency: z.number().int().min(1).max(10),
  transferLimitKbps: z.number().int().min(0).max(10_000_000),
  transferExisting: z.enum(EXISTING_RULES),
  transferPreserve: z.boolean()
})

/** Non-secret preferences, stored as plain JSON next to the vault. */
export class SettingsStore {
  private current: AppSettings
  private listeners = new Set<(s: AppSettings) => void>()

  constructor(private readonly filePath: string) {
    this.current = { ...DEFAULT_SETTINGS }
    if (existsSync(filePath)) {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
        const parsed = settingsSchema.partial().safeParse(raw)
        if (parsed.success) this.current = { ...DEFAULT_SETTINGS, ...parsed.data }
      } catch {
        // fall back to defaults on a damaged file
      }
    }
  }

  get(): AppSettings {
    return { ...this.current }
  }

  onChange(fn: (s: AppSettings) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async set(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = settingsSchema.parse({ ...this.current, ...patch })
    this.current = next
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await rename(tmp, this.filePath)
    for (const fn of this.listeners) fn(this.get())
    return this.get()
  }
}
