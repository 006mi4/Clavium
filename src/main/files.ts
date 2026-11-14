import { existsSync } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, extname, join, posix } from 'node:path'
import type { HostRecord, RemoteEntry, TransferProgress } from '@shared/types'
import { randomId } from './core/crypto'
import type { Prompter } from './core/prompter'
import { openRemoteFs, type RemoteFs } from './core/remotefs'
import type { Vault } from './core/vault'

type Send = (channel: 'files:progress' | 'files:closed', ...args: unknown[]) => void

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

function uniqueLocalPath(dir: string, name: string): string {
  let candidate = join(dir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; existsSync(candidate); i++) candidate = join(dir, `${stem} (${i})${ext}`)
  return candidate
}

export class FileManager {
  private sessions = new Map<string, RemoteFs>()

  constructor(
    private readonly vault: Vault,
    private readonly prompter: Prompter,
    private readonly send: Send
  ) {}

  async open(host: HostRecord): Promise<string> {
    const fs = await openRemoteFs(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const id = randomId()
    this.sessions.set(id, fs)
    fs.onClose(() => {
      if (this.sessions.delete(id)) this.send('files:closed', id)
    })
    return id
  }

  get(id: string): RemoteFs {
    const fs = this.sessions.get(id)
    if (!fs) throw new Error('File session is closed — reconnect')
    return fs
  }

  close(id: string): void {
    const fs = this.sessions.get(id)
    this.sessions.delete(id)
    fs?.close()
  }

  /** Close every session (vault locked, app quitting) and tell the interface about each one. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
      this.send('files:closed', id)
    }
  }

  private progress(p: TransferProgress): void {
    this.send('files:progress', p)
  }

  /** Download files/folders into `localDir` (or exactly to `localFile` for a single file). */
  async download(id: string, entries: RemoteEntry[], target: { localDir?: string; localFile?: string }): Promise<void> {
    const fs = this.get(id)
    for (const entry of entries) {
      const transferId = randomId()
      const report = (transferred: number, total: number, done = false, error?: string): void =>
        this.progress({ transferId, name: entry.name, direction: 'download', transferred, total, done, error })
      try {
        if (target.localFile && entries.length === 1 && entry.type !== 'dir') {
          await fs.download(entry.path, target.localFile, (t, tot) => report(t, tot))
        } else if (target.localDir) {
          await this.downloadRecursive(fs, entry, target.localDir, report, 0)
        }
        report(entry.size, entry.size, true)
      } catch (e) {
        report(0, entry.size, true, (e as Error).message)
      }
    }
  }

  private async downloadRecursive(
    fs: RemoteFs,
    entry: RemoteEntry,
    localDir: string,
    report: (t: number, total: number) => void,
    depth: number
  ): Promise<void> {
    if (depth > 64) throw new Error('Directory tree too deep')
    const local = uniqueLocalPath(localDir, safeLocalName(entry.name))
    if (entry.type === 'dir') {
      await mkdir(local, { recursive: true })
      for (const child of await fs.list(entry.path)) {
        await this.downloadRecursive(fs, child, local, report, depth + 1)
      }
    } else if (entry.type === 'file') {
      await fs.download(entry.path, local, report)
    }
    // links and special files are skipped on purpose
  }

  async upload(id: string, localPaths: string[], remoteDir: string): Promise<void> {
    const fs = this.get(id)
    for (const localPath of localPaths) {
      const transferId = randomId()
      const name = basename(localPath)
      const report = (transferred: number, total: number, done = false, error?: string): void =>
        this.progress({ transferId, name, direction: 'upload', transferred, total, done, error })
      try {
        const st = await stat(localPath)
        await this.uploadRecursive(fs, localPath, posix.join(remoteDir, name), report, 0)
        report(st.size, st.size, true)
      } catch (e) {
        report(0, 0, true, (e as Error).message)
      }
    }
  }

  private async uploadRecursive(
    fs: RemoteFs,
    localPath: string,
    remotePath: string,
    report: (t: number, total: number) => void,
    depth: number
  ): Promise<void> {
    if (depth > 64) throw new Error('Directory tree too deep')
    const st = await stat(localPath)
    if (st.isDirectory()) {
      await fs.mkdir(remotePath).catch(() => undefined) // may already exist
      for (const child of await readdir(localPath)) {
        await this.uploadRecursive(fs, join(localPath, child), posix.join(remotePath, child), report, depth + 1)
      }
    } else if (st.isFile()) {
      await fs.upload(localPath, remotePath, report)
    }
  }
}
