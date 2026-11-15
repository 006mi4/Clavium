import { createReadStream, createWriteStream } from 'node:fs'
import { open as openLocal, stat as statLocal } from 'node:fs/promises'
import { posix } from 'node:path'
import { PassThrough, Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { TLSSocket, ConnectionOptions as TLSConnectionOptions } from 'node:tls'
import { Client as FtpClient, FileType } from 'basic-ftp'
import type { Client as SshClient, SFTPWrapper, Stats, FileEntryWithStats } from 'ssh2'
import type { HostRecord, RemoteEntry } from '@shared/types'
import { verifyPresentedKey } from './hostkeys'
import type { Prompter } from './prompter'
import { connectSsh } from './ssh'
import type { Vault } from './vault'

/**
 * `transferred` counts the bytes that have safely arrived without a gap from the start of the file,
 * so after an interruption the transfer can continue exactly there.
 */
export type ProgressFn = (transferred: number, total: number) => void

/** Slows transfers down to a number of bytes per second. One instance may be shared by many transfers. */
export class Throttle {
  private next = 0
  /** @param rate bytes per second right now; 0 means no limit */
  constructor(private readonly rate: () => number) {}

  /** Bytes per second allowed right now; 0 means no limit. */
  get limit(): number {
    const rate = this.rate()
    return rate > 0 ? rate : 0
  }

  async take(bytes: number): Promise<void> {
    const rate = this.rate()
    if (!(rate > 0)) return
    const now = Date.now()
    const start = Math.max(now, this.next)
    this.next = start + (bytes / rate) * 1000
    if (start > now) await new Promise((r) => setTimeout(r, start - now))
  }

  /** A stream stage that lets data through at the allowed speed. */
  gate(): Transform {
    const take = (n: number): Promise<void> => this.take(n)
    return new Transform({
      transform(chunk: Buffer, _enc, cb) {
        take(chunk.length).then(() => cb(null, chunk), cb)
      }
    })
  }
}

export interface TransferOptions {
  onProgress?: ProgressFn
  /** Continue at this byte. The target must already hold the bytes before it. */
  offset?: number
  /** Stop early. What has arrived so far is kept, so the transfer can be continued. */
  signal?: AbortSignal
  throttle?: Throttle
}

/** Thrown by a transfer that was stopped through its signal. */
export class TransferStopped extends Error {
  constructor() {
    super('The transfer was stopped')
  }
}

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
  /** Set the permission bits (0o000 - 0o777). */
  chmod(path: string, mode: number): Promise<void>
  /**
   * A second, independent handle to the same server, used for one transfer. Closing it aborts
   * whatever it is doing without touching the session the user is browsing with.
   */
  fork(): Promise<RemoteFs>
  /** A transfer that fails or is stopped leaves the part that arrived in place. */
  download(remotePath: string, localPath: string, options?: TransferOptions): Promise<void>
  upload(localPath: string, remotePath: string, options?: TransferOptions): Promise<void>
  /** Set the modification time. Rejects when the server cannot do that. */
  setModified(path: string, mtimeMs: number): Promise<void>
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

/** Size of one read or write request, and how many of them are on their way at once. */
const CHUNK = 32768
const PARALLEL_REQUESTS = 64

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
  private readonly onEnd: () => void

  private constructor(
    private readonly client: SshClient,
    private readonly sftp: SFTPWrapper,
    private readonly ownsClient: boolean
  ) {
    this.onEnd = (): void => {
      if (this.closed) return
      this.closed = true
      client.removeListener('close', this.onEnd)
      for (const fn of this.closeHandlers) fn()
    }
    sftp.on('close', this.onEnd)
    client.on('close', this.onEnd)
  }

  fork(): Promise<RemoteFs> {
    return SftpFs.open(this.client, false)
  }

  /**
   * Settle as soon as this handle is closed. A transfer that is cut off by closing its channel is
   * not reliably reported back by the SSH library; without this the caller could wait forever.
   */
  private untilClosed<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onClose = (): void => reject(new Error('The connection was closed'))
      if (this.closed) return onClose()
      this.closeHandlers.push(onClose)
      const forget = (): void => {
        const i = this.closeHandlers.indexOf(onClose)
        if (i >= 0) this.closeHandlers.splice(i, 1)
      }
      work.then(
        (v) => (forget(), resolve(v)),
        (e) => (forget(), reject(e))
      )
    })
  }

  async chmod(path: string, mode: number): Promise<void> {
    assertSafeRemotePath(path)
    await p<void>((cb) => this.sftp.chmod(path, mode & 0o777, (err) => cb(err, undefined)))
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

  async setModified(path: string, mtimeMs: number): Promise<void> {
    assertSafeRemotePath(path)
    const seconds = Math.floor(mtimeMs / 1000)
    await p<void>((cb) => this.sftp.utimes(path, seconds, seconds, (err) => cb(err, undefined)))
  }

  /** One request to the server that also settles when the connection goes away. */
  private op<T>(fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
    return this.untilClosed(p<T>(fn))
  }

  /**
   * Move a file in chunks, many requests at a time, like `fastGet` and `fastPut` of the SSH
   * library, but able to start at an offset, to slow down and to stop cleanly.
   * `move` transfers one chunk and returns the number of bytes it got (less than asked at the end
   * of the file). Returns the position up to which everything arrived without a gap.
   */
  private async chunked(
    total: number,
    o: TransferOptions,
    move: (buf: Buffer, pos: number, len: number) => Promise<number>
  ): Promise<number> {
    let next = Math.min(o.offset ?? 0, total)
    let end = total
    let failure: unknown
    const inFlight = new Set<number>()
    const mark = (): number => (inFlight.size ? Math.min(...inFlight) : Math.min(next, end))
    o.onProgress?.(next, total)
    const worker = async (index: number): Promise<void> => {
      const buf = Buffer.allocUnsafe(CHUNK)
      const running = (): boolean => failure === undefined && !o.signal?.aborted && next < end
      while (running()) {
        // Under a speed limit only about a second of data is on its way at once. Otherwise the
        // requests would queue up for their turn and the transfer could not be stopped in time.
        const rate = o.throttle?.limit ?? 0
        if (rate > 0 && index >= Math.max(1, Math.ceil(rate / CHUNK))) {
          await new Promise((r) => setTimeout(r, 200))
          continue
        }
        await o.throttle?.take(Math.min(CHUNK, end - next))
        if (!running()) break
        const pos = next
        const len = Math.min(CHUNK, end - pos)
        next += len
        inFlight.add(pos)
        try {
          let got = 0
          while (got < len) {
            const n = await move(buf.subarray(got, len), pos + got, len - got)
            if (n <= 0) break
            got += n
          }
          // The file is shorter than it was when the transfer started.
          if (got < len) end = Math.min(end, pos + got)
        } catch (e) {
          failure ??= e
          return
        }
        inFlight.delete(pos)
        o.onProgress?.(mark(), end)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(PARALLEL_REQUESTS, Math.ceil((end - next) / CHUNK))) }, (_, i) => worker(i)))
    const reached = mark()
    if (failure !== undefined) throw Object.assign(failure as Error, { reached })
    if (o.signal?.aborted && reached < end) throw Object.assign(new TransferStopped(), { reached })
    return reached
  }

  async download(remotePath: string, localPath: string, o: TransferOptions = {}): Promise<void> {
    assertSafeRemotePath(remotePath)
    if (o.signal?.aborted) throw new TransferStopped()
    const handle = await this.op<Buffer>((cb) => this.sftp.open(remotePath, 'r', cb))
    try {
      const total = (await this.op<Stats>((cb) => this.sftp.fstat(handle, cb))).size
      const local = await openLocal(localPath, o.offset ? 'r+' : 'w')
      try {
        const reached = await this.chunked(total, o, (buf, pos, len) =>
          this.op<number>((cb) => this.sftp.read(handle, buf, 0, len, pos, (err, n) => cb(err, n))).then(async (n) => {
            if (n > 0) await local.write(buf, 0, n, pos)
            return n
          })
        ).catch(async (e: { reached?: number }) => {
          // Chunks arrive in any order: keep only what is complete from the start.
          if (typeof e.reached === 'number') await local.truncate(e.reached).catch(() => undefined)
          throw e
        })
        await local.truncate(reached)
      } finally {
        await local.close()
      }
    } finally {
      if (!this.closed) this.sftp.close(handle, () => undefined)
    }
  }

  async upload(localPath: string, remotePath: string, o: TransferOptions = {}): Promise<void> {
    assertSafeRemotePath(remotePath)
    if (o.signal?.aborted) throw new TransferStopped()
    const local = await openLocal(localPath, 'r')
    try {
      const total = (await local.stat()).size
      const handle = await this.op<Buffer>((cb) => this.sftp.open(remotePath, o.offset ? 'r+' : 'w', cb))
      try {
        await this.chunked(total, o, async (buf, pos, len) => {
          const { bytesRead } = await local.read(buf, 0, len, pos)
          if (bytesRead > 0) await this.op<void>((cb) => this.sftp.write(handle, buf, 0, bytesRead, pos, (err) => cb(err, undefined)))
          return bytesRead
        })
      } finally {
        if (!this.closed) await this.op<void>((cb) => this.sftp.close(handle, (err) => cb(err, undefined))).catch(() => undefined)
      }
    } finally {
      await local.close()
    }
  }

  close(): void {
    try {
      this.sftp.end()
    } catch {
      /* ignore */
    }
    if (this.ownsClient) this.client.end()
    this.onEnd()
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

  private constructor(
    private readonly client: FtpClient,
    private readonly reconnect: () => Promise<FtpFs>
  ) {
    client.ftp.socket.on('close', () => this.markClosed())
  }

  /** FTP can do one thing per connection, so a transfer gets a connection of its own. */
  fork(): Promise<RemoteFs> {
    return this.reconnect()
  }

  async chmod(path: string, mode: number): Promise<void> {
    assertSafeRemotePath(path)
    return this.run(async () => {
      await this.client.send(`SITE CHMOD ${(mode & 0o777).toString(8).padStart(3, '0')} ${path}`)
    })
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
    return new FtpFs(client, () => FtpFs.connect({ ...host, password }, { ...ctx, interactive: false }))
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

  async download(remotePath: string, localPath: string, o: TransferOptions = {}): Promise<void> {
    assertSafeRemotePath(remotePath)
    return this.run(async () => {
      if (o.signal?.aborted) throw new TransferStopped()
      const offset = o.offset ?? 0
      let total = 0
      try {
        total = await this.client.size(remotePath)
      } catch {
        /* SIZE not supported */
      }
      // Written through a stream of our own: given a path, the FTP library deletes a file that did not arrive completely.
      const gate = o.throttle?.gate() ?? new PassThrough()
      const written = pipeline(gate, createWriteStream(localPath, { flags: offset ? 'r+' : 'w', start: offset }))
      written.catch(() => undefined)
      o.onProgress?.(offset, total)
      this.client.trackProgress((info) => o.onProgress?.(offset + info.bytes, total))
      try {
        await this.client.downloadTo(gate, remotePath, offset)
      } catch (e) {
        gate.destroy(e as Error)
        await written.catch(() => undefined)
        throw e
      } finally {
        this.client.trackProgress()
      }
      await written
    })
  }

  async upload(localPath: string, remotePath: string, o: TransferOptions = {}): Promise<void> {
    assertSafeRemotePath(remotePath)
    return this.run(async () => {
      if (o.signal?.aborted) throw new TransferStopped()
      const offset = o.offset ?? 0
      const total = (await statLocal(localPath)).size
      const gate = o.throttle?.gate() ?? new PassThrough()
      const read = pipeline(createReadStream(localPath, { start: offset }), gate)
      read.catch(() => undefined)
      o.onProgress?.(offset, total)
      this.client.trackProgress((info) => o.onProgress?.(offset + info.bytes, total))
      try {
        // APPE continues at the end of the file on the server, which is where `offset` points.
        if (offset) await this.client.appendFrom(gate, remotePath)
        else await this.client.uploadFrom(gate, remotePath)
        await read
      } finally {
        gate.destroy()
        this.client.trackProgress()
      }
    })
  }

  async setModified(path: string, mtimeMs: number): Promise<void> {
    assertSafeRemotePath(path)
    return this.run(async () => {
      if (!(await this.client.features()).has('MFMT')) throw new Error('The server cannot set modification times')
      const stamp = new Date(mtimeMs).toISOString().replace(/[-:T]/g, '').slice(0, 14)
      await this.client.send(`MFMT ${stamp} ${path}`)
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
