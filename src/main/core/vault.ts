import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { HostRecord, KnownHost, SshKeyRecord, VaultState } from '@shared/types'
import { DEFAULT_KDF, deriveKey, newKdfParams, open, seal, type KdfParams } from './crypto'

export interface VaultData {
  hosts: HostRecord[]
  keys: SshKeyRecord[]
  knownHosts: KnownHost[]
  mcpToken?: string
}

interface VaultFile {
  format: 'clavium-vault'
  version: 1
  kdf: KdfParams
  iv: string
  tag: string
  data: string
}

export const MIN_MASTER_PASSWORD_LENGTH = 10

function emptyData(): VaultData {
  return { hosts: [], keys: [], knownHosts: [] }
}

function headerAad(kdf: KdfParams): Buffer {
  return Buffer.from(JSON.stringify({ format: 'clavium-vault', version: 1, kdf }), 'utf8')
}

export class VaultError extends Error {
  constructor(
    message: string,
    readonly code: 'locked' | 'bad-password' | 'exists' | 'weak-password' | 'throttled' | 'corrupt'
  ) {
    super(message)
  }
}

/**
 * Encrypted on-disk store for hosts, keys, known host keys and the MCP token.
 * The derived key lives only in memory while unlocked and is zeroed on lock.
 */
export class Vault {
  private key: Buffer | null = null
  private kdf: KdfParams | null = null
  private contents: VaultData | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private failedAttempts = 0
  private blockedUntil = 0
  private listeners = new Set<(s: VaultState) => void>()

  constructor(
    private readonly filePath: string,
    private readonly kdfBase: Omit<KdfParams, 'salt'> = DEFAULT_KDF
  ) {}

  state(): VaultState {
    if (this.contents) return 'unlocked'
    return existsSync(this.filePath) ? 'locked' : 'uninitialized'
  }

  onStateChange(fn: (s: VaultState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    const s = this.state()
    for (const fn of this.listeners) fn(s)
  }

  get data(): VaultData {
    if (!this.contents) throw new VaultError('Vault is locked', 'locked')
    return this.contents
  }

  async create(password: string): Promise<void> {
    if (existsSync(this.filePath)) throw new VaultError('A vault already exists', 'exists')
    assertStrong(password)
    this.kdf = newKdfParams(this.kdfBase)
    this.key = await deriveKey(password, this.kdf)
    this.contents = emptyData()
    await this.save()
    this.emit()
  }

  async unlock(password: string): Promise<void> {
    if (this.contents) return
    const now = Date.now()
    if (now < this.blockedUntil) {
      throw new VaultError(
        `Too many failed attempts. Try again in ${Math.ceil((this.blockedUntil - now) / 1000)} s`,
        'throttled'
      )
    }
    let file: VaultFile
    try {
      file = JSON.parse(await readFile(this.filePath, 'utf8')) as VaultFile
      if (file.format !== 'clavium-vault' || file.version !== 1) throw new Error('format')
    } catch {
      throw new VaultError('Vault file is unreadable or corrupt', 'corrupt')
    }
    const key = await deriveKey(password, file.kdf)
    let plain: Buffer
    try {
      plain = open(key, file, headerAad(file.kdf))
    } catch {
      key.fill(0)
      this.failedAttempts++
      if (this.failedAttempts >= 3) {
        const delay = Math.min(2 ** (this.failedAttempts - 3), 60) * 1000
        this.blockedUntil = Date.now() + delay
      }
      throw new VaultError('Wrong master password', 'bad-password')
    }
    this.failedAttempts = 0
    this.blockedUntil = 0
    this.key = key
    this.kdf = file.kdf
    this.contents = { ...emptyData(), ...(JSON.parse(plain.toString('utf8')) as VaultData) }
    plain.fill(0)
    this.emit()
  }

  lock(): void {
    if (this.key) this.key.fill(0)
    this.key = null
    this.kdf = null
    this.contents = null
    this.emit()
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    if (!this.contents) throw new VaultError('Vault is locked', 'locked')
    assertStrong(newPassword)
    // Re-verify the old password against the file, not just the in-memory state.
    const file = JSON.parse(await readFile(this.filePath, 'utf8')) as VaultFile
    const oldKey = await deriveKey(oldPassword, file.kdf)
    try {
      open(oldKey, file, headerAad(file.kdf)).fill(0)
    } catch {
      throw new VaultError('Current master password is wrong', 'bad-password')
    } finally {
      oldKey.fill(0)
    }
    const kdf = newKdfParams(this.kdfBase)
    const key = await deriveKey(newPassword, kdf)
    this.key?.fill(0)
    this.key = key
    this.kdf = kdf
    await this.save()
  }

  /** Apply a change to the decrypted data and persist it. */
  async update<T>(mutator: (d: VaultData) => T): Promise<T> {
    const result = mutator(this.data)
    await this.save()
    return result
  }

  private save(): Promise<void> {
    const run = async (): Promise<void> => {
      if (!this.key || !this.kdf || !this.contents) throw new VaultError('Vault is locked', 'locked')
      const plain = Buffer.from(JSON.stringify(this.contents), 'utf8')
      const sealed = seal(this.key, plain, headerAad(this.kdf))
      plain.fill(0)
      const file: VaultFile = { format: 'clavium-vault', version: 1, kdf: this.kdf, ...sealed }
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(file), { mode: 0o600 })
      if (existsSync(this.filePath)) await copyFile(this.filePath, `${this.filePath}.bak`)
      await rename(tmp, this.filePath)
    }
    const next = this.writeChain.then(run, run)
    this.writeChain = next.catch(() => undefined)
    return next
  }
}

function assertStrong(password: string): void {
  if (password.length < MIN_MASTER_PASSWORD_LENGTH) {
    throw new VaultError(
      `The master password must have at least ${MIN_MASTER_PASSWORD_LENGTH} characters`,
      'weak-password'
    )
  }
}
