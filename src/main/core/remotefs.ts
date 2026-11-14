import { posix } from 'node:path'
import { Readable, Writable } from 'node:stream'
import type { TLSSocket, ConnectionOptions as TLSConnectionOptions } from 'node:tls'
import { Client as FtpClient, FileType } from 'basic-ftp'
import type { Client as SshClient, SFTPWrapper, Stats, FileEntryWithStats } from 'ssh2'
import type { HostRecord, RemoteEntry } from '@shared/types'
import { verifyPresentedKey } from './hostkeys'
import type { Prompter } from './prompter'
import { connectSsh } from './ssh'
import type { Vault } from './vault'

export type ProgressFn = (transferred: number, total: number) => void

export interface ReadResult {
  data: Buffer
  size: number
  truncated: boolean
}

/** Protocol-independent remote file system used by the UI and by MCP tools. */
export interface RemoteFs {
  readonly protocol: 'sftp' | 'ftp'
  home(): Promise<string>
  list(path: string): Promise<RemoteEntry[]>
  stat(path: string): Promise<RemoteEntry>
  readFile(path: string, maxBytes: number): Promise<ReadResult>
  writeFile(path: string, data: Buffer, overwrite: boolean): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string, recursive: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>
  download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void>
  upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void>
  close(): void
  onClose(fn: () => void): void
}

export function assertSafeRemotePath(p: string): string {
  if (typeof p !== 'string' || p.length === 0) throw new Error('Path must not be empty')
  if (p.length > 4096) throw new Error('Path too long')
  // CR/LF/NUL would allow command injection into the FTP control channel.
  if (/[\r\n\0]/.test(p)) throw new Error('Path contains forbidden control characters')
  return p
}

// ---------------------------------------------------------------- SFTP ----

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const S_IFREG = 0o100000

function typeFromMode(mode: number): RemoteEntry['type'] {
  switch (mode & S_IFMT) {
    case S_IFDIR:
      return 'dir'
    case S_IFLNK:
      return 'link'
    case S_IFREG:
      return 'file'
    default:
      return 'other'
  }
}

function permString(mode: number): string {
  const chars = 'rwxrwxrwx'
  let s = ''
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-'
  return s
}

function p<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v))))
}

export class SftpFs implements RemoteFs {
  readonly protocol = 'sftp' as const
  private closed = false
  private closeHandlers: (() => void)[] = []

  private constructor(
    private readonly client: SshClient,
    private readonly sftp: SFTPWrapper,
    private readonly ownsClient: boolean
  ) {
    const done = (): void => {
      if (this.closed) return
      this.closed = true
      for (const fn of this.closeHandlers) fn()
    }
    sftp.on('close', done)
    client.on('close', done)
  }

  static async open(client: SshClient, ownsClient: boolean): Promise<SftpFs> {
    const sftp = await p<SFTPWrapper>((cb) => client.sftp((err, s) => cb(err, s)))
    return new SftpFs(client, sftp, ownsClient)
  }

  onClose(fn: () => void): void {
    this.closeHandlers.push(fn)
  }

  async home(): Promise<string> {
    return p<string>((cb) => this.sftp.realpath('.', cb))
  }

  private entry(path: string, attrs: Stats): RemoteEntry {
    return {
      name: posix.basename(path) || path,
      path,
      type: typeFromMode(attrs.mode),
      size: attrs.size,
      modifiedAt: attrs.mtime * 1000,
      permissions: permString(attrs.mode)
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    assertSafeRemotePath(path)
    const items = await p<FileEntryWithStats[]>((cb) => this.sftp.readdir(path, cb))
    return items
      .filter((i) => i.filename !== '.' && i.filename !== '..')
      .map((i) => this.entry(posix.join(path, i.filename), i.attrs as Stats))
  }

  async stat(path: string): Promise<RemoteEntry> {
    assertSafeRemotePath(path)
    const attrs = await p<Stats>((cb) => this.sftp.lstat(path, cb))
    return this.entry(path, attrs)
  }

  async readFile(path: string, maxBytes: number): Promise<ReadResult> {
    assertSafeRemotePath(path)
    const st = await p<Stats>((cb) => this.sftp.stat(path, cb))
    if (typeFromMode(st.mode) === 'dir') throw new Error('Path is a directory')
    const handle = await p<Buffer>((cb) => this.sftp.open(path, 'r', cb))
    const chunks: Buffer[] = []
    let pos = 0
    try {
      while (pos < maxBytes) {
        const want = Math.min(32768, maxBytes - pos)
        const buf = Buffer.alloc(want)
        const n = await new Promise<number>((resolve, reject) =>
          this.sftp.read(handle, buf, 0, want, pos, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)))
        )
        if (n <= 0) break
        chunks.push(buf.subarray(0, n))
        pos += n
      }
    } finally {
      await p<void>((cb) => this.sftp.close(handle, (err) => cb(err, undefined))).catch(() => undefined)
    }
    const data = Buffer.concat(chunks)
    return { data, size: st.size, truncated: st.size > data.length }
  }

  async writeFile(path: string, data: Buffer, overwrite: boolean): Promise<void> {
    assertSafeRemotePath(path)
    await p<void>((cb) =>
      this.sftp.writeFile(path, data, { flag: overwrite ? 'w' : 'wx' }, (err) => cb(err, undefined))
    )
  }

  async mkdir(path: string): Promise<void> {
    assertSafeRemotePath(path)
    await p<void>((cb) => this.sftp.mkdir(path, (err) => cb(err, undefined)))
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    assertSafeRemotePath(path)
    const st = await this.stat(path)
    if (st.type !== 'dir') {
      await p<void>((cb) => this.sftp.unlink(path, (err) => cb(err, undefined)))
      return
    }
    if (recursive) {
      for (const child of await this.list(path)) {
        // Symlinks are unlinked, never followed.
        await this.remove(child.path, child.type === 'dir')
      }
    }
    await p<void>((cb) => this.sftp.rmdir(path, (err) => cb(err, undefined)))
  }

  async rename(from: string, to: string): Promise<void> {
    assertSafeRemotePath(from)
    assertSafeRemotePath(to)
    await p<void>((cb) => this.sftp.rename(from, to, (err) => cb(err, undefined)))
  }

  async download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void> {
    assertSafeRemotePath(remotePath)
    await p<void>((cb) =>
      this.sftp.fastGet(
        remotePath,
        localPath,
        { step: (t: number, _c: number, total: number) => onProgress?.(t, total) },
        (err) => cb(err, undefined)
      )
    )
  }

  async upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void> {
    assertSafeRemotePath(remotePath)
    await p<void>((cb) =>
      this.sftp.fastPut(
        localPath,
        remotePath,
        { step: (t: number, _c: number, total: number) => onProgress?.(t, total) },
        (err) => cb(err, undefined)
      )
    )
  }

  close(): void {
    try {
      this.sftp.end()
    } catch {
      /* ignore */
    }
    if (this.ownsClient) this.client.end()
  }
}

// ----------------------------------------------------------------- FTP ----

const TLS_TRUST_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED'
])

class Mutex {
  private chain: Promise<unknown> = Promise.resolve()
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }
}

export interface FtpConnectContext {
  vault: Vault
  prompter: Prompter
  interactive: boolean
}

export class FtpFs implements RemoteFs {
  readonly protocol = 'ftp' as const
  private readonly lock = new Mutex()
  private closeHandlers: (() => void)[] = []
  private closed = false

  private constructor(private readonly client: FtpClient) {
    client.ftp.socket.on('close', () => this.markClosed())
  }

  private markClosed(): void {
    if (this.closed) return
    this.closed = true
    for (const fn of this.closeHandlers) fn()
  }

  onClose(fn: () => void): void {
    this.closeHandlers.push(fn)
  }

  static async connect(host: HostRecord, ctx: FtpConnectContext): Promise<FtpFs> {
    if (!host.password && host.authMethod === 'password' && !ctx.interactive) {
      throw new Error('No password stored for this host')
    }
    let password = host.password ?? ''
    if (!host.password && ctx.interactive) {
      const answers = await ctx.prompter.keyboardInteractive({
        host: `${host.username}@${host.hostname}`,
        name: 'FTP login',
        instructions: '',
        prompts: [{ prompt: 'Password', echo: false }]
      })
      if (!answers) throw new Error('Login cancelled')
      password = answers[0] ?? ''
    }

    const keyId = `ftps:${host.hostname}:${host.port}`
    const pinned = host.protocol === 'ftp' ? undefined : ctx.vault.data.knownHosts.find((k) => k.id === keyId)

    const attempt = async (pinMode: boolean): Promise<FtpClient> => {
      const client = new FtpClient(30000)
      const tls: TLSConnectionOptions = {
        servername: host.hostname,
        rejectUnauthorized: !pinMode,
        minVersion: 'TLSv1.2'
      }
      try {
        if (host.protocol === 'ftps-implicit') {
          await client.connectImplicitTLS(host.hostname, host.port, tls)
        } else {
          await client.connect(host.hostname, host.port)
          if (host.protocol === 'ftps') await client.useTLS(tls)
        }
        if (pinMode) {
          // Certificate is not CA-trusted: verify it against the pinned / user-approved fingerprint
          // BEFORE sending any credentials.
          const cert = (client.ftp.socket as TLSSocket).getPeerCertificate()
          const fp = 'SHA256:' + Buffer.from(cert.fingerprint256.replace(/:/g, ''), 'hex').toString('base64').replace(/=+$/, '')
          const ok = await verifyPresentedKey(
            ctx.vault,
            ctx.prompter,
            { id: keyId, displayHost: `${host.hostname}:${host.port} (TLS certificate)`, keyType: 'x509', fingerprint: fp },
            ctx.interactive
          )
          if (!ok) throw new Error('TLS certificate was not accepted — connection aborted')
        }
        await client.login(host.username, password)
        await client.useDefaultSettings()
        return client
      } catch (e) {
        client.close()
        throw e
      }
    }

    let client: FtpClient
    if (host.protocol === 'ftp') {
      client = await attempt(false)
    } else if (pinned) {
      client = await attempt(true)
    } else {
      try {
        client = await attempt(false)
      } catch (e) {
        const code = (e as { code?: string }).code ?? ''
        if (!TLS_TRUST_ERRORS.has(code)) throw e
        client = await attempt(true)
      }
    }
    return new FtpFs(client)
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('FTP connection is closed'))
    return this.lock.run(fn)
  }

  async home(): Promise<string> {
    return this.run(() => this.client.pwd())
  }

  private toEntry(dir: string, i: { name: string; type: FileType; size: number; modifiedAt?: Date; permissions?: { user: number; group: number; world: number } }): RemoteEntry {
    const type: RemoteEntry['type'] =
      i.type === FileType.Directory ? 'dir' : i.type === FileType.SymbolicLink ? 'link' : i.type === FileType.File ? 'file' : 'other'
    const perm = i.permissions
      ? [i.permissions.user, i.permissions.group, i.permissions.world]
          .map((v) => `${v & 4 ? 'r' : '-'}${v & 2 ? 'w' : '-'}${v & 1 ? 'x' : '-'}`)
          .join('')
      : undefined
    return {
      name: i.name,
      path: posix.join(dir, i.name),
      type,
      size: i.size,
      modifiedAt: i.modifiedAt ? i.modifiedAt.getTime() : 0,
      permissions: perm
    }
  }

  async list(path: string): Promise<RemoteEntry[]> {
    assertSafeRemotePath(path)
    return this.run(async () => {
      const items = await this.client.list(path)
      return items.filter((i) => i.name !== '.' && i.name !== '..').map((i) => this.toEntry(path, i))
    })
  }

  async stat(path: string): Promise<RemoteEntry> {
    assertSafeRemotePath(path)
    const parent = posix.dirname(path)
    const name = posix.basename(path)
    const items = await this.list(parent)
    const hit = items.find((i) => i.name === name)
    if (!hit) {
      if (path === '/' || path === parent) return { name: path, path, type: 'dir', size: 0, modifiedAt: 0 }
      throw new Error(`No such file or directory: ${path}`)
    }
    return hit
  }

  async readFile(path: string, maxBytes: number): Promise<ReadResult> {
    const st = await this.stat(path)
    if (st.type === 'dir') throw new Error('Path is a directory')
    if (st.size > 64 * 1024 * 1024) throw new Error('File too large to read inline (> 64 MiB); download it instead')
    const chunks: Buffer[] = []
    let kept = 0
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (kept < maxBytes) {
          const part = chunk.subarray(0, maxBytes - kept)
          chunks.push(part)
          kept += part.length
        }
        cb()
      }
    })
    await this.run(() => this.client.downloadTo(sink, path))
    const data = Buffer.concat(chunks)
    return { data, size: st.size, truncated: st.size > data.length }
  }

  async writeFile(path: string, data: Buffer, overwrite: boolean): Promise<void> {
    assertSafeRemotePath(path)
    if (!overwrite) {
      const exists = await this.stat(path).then(
        () => true,
        () => false
      )
      if (exists) throw new Error(`File already exists: ${path}`)
    }
    await this.run(() => this.client.uploadFrom(Readable.from(data), path))
  }

  async mkdir(path: string): Promise<void> {
    assertSafeRemotePath(path)
    return this.run(async () => {
      await this.client.send('MKD ' + (await this.client.protectWhitespace(path)))
    })
  }

  async remove(path: string, recursive: boolean): Promise<void> {
    const st = await this.stat(path)
    await this.run(async () => {
      if (st.type !== 'dir') {
        await this.client.remove(path)
      } else if (recursive) {
        await this.client.removeDir(path)
      } else {
        await this.client.send('RMD ' + (await this.client.protectWhitespace(path)))
      }
    })
  }

  async rename(from: string, to: string): Promise<void> {
    assertSafeRemotePath(from)
    assertSafeRemotePath(to)
    return this.run(async () => {
      await this.client.rename(from, to)
    })
  }

  async download(remotePath: string, localPath: string, onProgress?: ProgressFn): Promise<void> {
    assertSafeRemotePath(remotePath)
    return this.run(async () => {
      let total = 0
      try {
        total = await this.client.size(remotePath)
      } catch {
        /* SIZE not supported */
      }
      this.client.trackProgress((info) => onProgress?.(info.bytes, total))
      try {
        await this.client.downloadTo(localPath, remotePath)
      } finally {
        this.client.trackProgress()
      }
    })
  }

  async upload(localPath: string, remotePath: string, onProgress?: ProgressFn): Promise<void> {
    assertSafeRemotePath(remotePath)
    return this.run(async () => {
      const { statSync } = await import('node:fs')
      const total = statSync(localPath).size
      this.client.trackProgress((info) => onProgress?.(info.bytes, total))
      try {
        await this.client.uploadFrom(localPath, remotePath)
      } finally {
        this.client.trackProgress()
      }
    })
  }

  close(): void {
    this.client.close()
    this.markClosed()
  }
}

/** Open a file-system session for any host type. */
export async function openRemoteFs(
  host: HostRecord,
  ctx: { vault: Vault; prompter: Prompter; interactive: boolean }
): Promise<RemoteFs> {
  if (host.protocol === 'ssh') {
    const client = await connectSsh(host, ctx)
    try {
      return await SftpFs.open(client, true)
    } catch (e) {
      client.end()
      throw e
    }
  }
  return FtpFs.connect(host, ctx)
}
