import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FtpSrv } from 'ftp-srv'
import { DEFAULT_TRANSFER_SETTINGS, type HostRecord, type ReconnectStatus, type TransferSettings } from '@shared/types'
import { FtpFs, openRemoteFs } from '../src/main/core/remotefs'
import { connectSsh } from '../src/main/core/ssh'
import { FileManager } from '../src/main/files'
import { freePort, newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { startHttpProxy, startSocksProxy, type TestProxy } from './helpers/testProxy'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer
let jump: TestSshServer
let ftpRoot: string
let ftp: FtpSrv
const ftpPort = 44000 + Math.floor(Math.random() * 3000)
const proxies: TestProxy[] = []
const open: FileManager[] = []
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  srv = await startTestSshServer()
  jump = await startTestSshServer()
  ftpRoot = mkdtempSync(join(tmpdir(), 'clavium-connect-ftp-'))
  // The server drops a connection that says nothing for two seconds.
  ftp = new FtpSrv({ url: `ftp://127.0.0.1:${ftpPort}`, pasv_url: '127.0.0.1', pasv_min: ftpPort + 1, pasv_max: ftpPort + 60, anonymous: false, greeting: 'test', timeout: 2000 })
  ftp.on('login', ({ username, password }, resolve, reject) => {
    if (username === 'ftpuser' && password === 'ftppass') resolve({ root: ftpRoot })
    else reject(new Error('bad login'))
  })
  await ftp.listen()
})
afterAll(async () => {
  await srv.close()
  await jump.close()
  await ftp.close()
  rmSync(ftpRoot, { recursive: true, force: true })
})
afterEach(async () => {
  for (const fm of open.splice(0)) fm.closeAll()
  for (const p of proxies.splice(0)) await p.close()
  FtpFs.keepaliveMs = 30_000
})

const ftpHost = (patch: Partial<HostRecord> = {}): HostRecord => sshHost(ftpPort, { protocol: 'ftp', username: 'ftpuser', password: 'ftppass', ...patch })
const proxy = async (kind: 'socks5' | 'http', login?: { username: string; password: string }): Promise<TestProxy> => {
  const p = await (kind === 'socks5' ? startSocksProxy(login) : startHttpProxy(login))
  proxies.push(p)
  return p
}

describe('reaching a server through a proxy', () => {
  for (const kind of ['socks5', 'http'] as const) {
    it(`SSH and SFTP through a ${kind} proxy, with and without a login`, async () => {
      const { vault } = await newUnlockedVault()
      const ctx = { vault, prompter: recordingPrompter(), interactive: true }
      const plain = await proxy(kind)
      // "localhost" on purpose: the proxy resolves the name, not this computer
      const client = await connectSsh(sshHost(srv.port, { hostname: 'localhost', proxy: { type: kind, host: '127.0.0.1', port: plain.port } }), ctx)
      client.end()
      expect(plain.targets).toEqual([`localhost:${srv.port}`])

      const locked = await proxy(kind, { username: 'pu', password: 'p w:1' })
      const host = sshHost(srv.port, { proxy: { type: kind, host: '127.0.0.1', port: locked.port, username: 'pu' }, proxyPassword: 'p w:1' })
      const fs = await openRemoteFs(host, ctx)
      const name = `/via-${kind}-${randomBytes(3).toString('hex')}.txt`
      await fs.writeFile(name, randomBytes(200_000), false)
      expect((await fs.readFile(name, 1_000_000)).size).toBe(200_000)
      fs.close()
      expect(locked.targets).toEqual([`127.0.0.1:${srv.port}`])

      await expect(connectSsh({ ...host, proxyPassword: 'wrong' }, ctx)).rejects.toThrow(/did not accept the user name or password/)
      await expect(connectSsh({ ...host, proxy: { ...host.proxy!, username: undefined } }, ctx)).rejects.toThrow(/asks for a user name and password/)
    })

    it(`FTP through a ${kind} proxy: listing, upload and download go through it too`, async () => {
      const { vault } = await newUnlockedVault()
      const p = await proxy(kind)
      const fs = await openRemoteFs(ftpHost({ proxy: { type: kind, host: '127.0.0.1', port: p.port } }), { vault, prompter: recordingPrompter(), interactive: true })
      const local = mkdtempSync(join(tmpdir(), 'clavium-connect-'))
      const data = randomBytes(300_000)
      writeFileSync(join(local, 'up.bin'), data)
      const name = `p-${kind}-${randomBytes(3).toString('hex')}.bin`
      await fs.upload(join(local, 'up.bin'), '/' + name)
      expect((await fs.list('/')).map((e) => e.name)).toContain(name)
      await fs.download('/' + name, join(local, 'down.bin'))
      expect(readFileSync(join(local, 'down.bin')).equals(data)).toBe(true)
      fs.close()
      // the control connection and one data connection for each of the three steps
      expect(p.targets[0]).toBe(`127.0.0.1:${ftpPort}`)
      expect(p.targets.length).toBeGreaterThanOrEqual(4)
      expect(p.targets.slice(1).every((t) => t.startsWith('127.0.0.1:') && t !== p.targets[0])).toBe(true)
    })
  }

  it('says what is wrong when the proxy cannot be reached or cannot reach the server', async () => {
    const { vault } = await newUnlockedVault()
    const ctx = { vault, prompter: recordingPrompter(), interactive: true }
    const dead = await freePort()
    await expect(connectSsh(sshHost(srv.port, { proxy: { type: 'socks5', host: '127.0.0.1', port: dead } }), ctx)).rejects.toThrow(/Cannot reach the proxy/)
    for (const kind of ['socks5', 'http'] as const) {
      const p = await proxy(kind)
      await expect(connectSsh(sshHost(dead, { proxy: { type: kind, host: '127.0.0.1', port: p.port } }), ctx)).rejects.toThrow(/proxy could not connect to 127\.0\.0\.1/)
    }
    // an SSH server is not a proxy
    await expect(connectSsh(sshHost(srv.port, { proxy: { type: 'http', host: '127.0.0.1', port: srv.port } }), ctx)).rejects.toThrow(/not an HTTP proxy/)
    await expect(connectSsh(sshHost(srv.port, { proxy: { type: 'socks5', host: '127.0.0.1', port: srv.port } }), ctx)).rejects.toThrow(/not a SOCKS5 proxy/)
  })
})

describe('reaching a server through a jump host', () => {
  it('opens the session through the other host, and checks both host keys', async () => {
    const { vault } = await newUnlockedVault()
    const jumpHost = sshHost(jump.port, { id: 'jump', name: 'bastion' })
    await vault.update((d) => void d.hosts.push(jumpHost))
    const prompter = recordingPrompter()
    const ctx = { vault, prompter, interactive: true }
    const before = { jump: jump.logins, srv: srv.logins }
    const client = await connectSsh(sshHost(srv.port, { id: 'target', jumpHostId: 'jump' }), ctx)
    expect(jump.tunnels.at(-1)).toEqual({ host: '127.0.0.1', port: srv.port })
    expect(jump.logins - before.jump).toBe(1)
    expect(srv.logins - before.srv).toBe(1)
    expect(vault.data.knownHosts.map((k) => k.id).sort()).toEqual([`ssh:127.0.0.1:${jump.port}`, `ssh:127.0.0.1:${srv.port}`].sort())
    const sftp = await openRemoteFs(sshHost(srv.port, { id: 'target', jumpHostId: 'jump' }), ctx)
    await sftp.writeFile('/via-jump.txt', Buffer.from('through the bastion'), true)
    expect(readFileSync(join(srv.root, 'via-jump.txt'), 'utf8')).toBe('through the bastion')
    sftp.close()
    client.end()
  })

  it('refuses circles, missing jump hosts and jump hosts that cannot reach the target', async () => {
    const { vault } = await newUnlockedVault()
    const a = sshHost(jump.port, { id: 'a', name: 'a', jumpHostId: 'b' })
    const b = sshHost(jump.port, { id: 'b', name: 'b', jumpHostId: 'a' })
    await vault.update((d) => void d.hosts.push(a, b, sshHost(jump.port, { id: 'jump', name: 'bastion' })))
    const ctx = { vault, prompter: recordingPrompter(), interactive: true }
    await expect(connectSsh(a, ctx)).rejects.toThrow(/circle/)
    await expect(connectSsh(sshHost(srv.port, { id: 't', jumpHostId: 'gone' }), ctx)).rejects.toThrow(/no longer exists/)
    await expect(connectSsh(sshHost(await freePort(), { id: 't', jumpHostId: 'jump' }), ctx)).rejects.toThrow(/Jump host bastion could not reach/)
  })
})

describe('staying connected', () => {
  it('an idle FTP connection is kept alive', async () => {
    const { vault } = await newUnlockedVault()
    const ctx = { vault, prompter: recordingPrompter(), interactive: true }
    FtpFs.keepaliveMs = 60_000
    const silent = await openRemoteFs(ftpHost(), ctx)
    let closed = false
    silent.onClose(() => (closed = true))
    FtpFs.keepaliveMs = 500
    const kept = await openRemoteFs(ftpHost(), ctx)
    await sleep(3500)
    // without a sign of life the server has hung up
    expect(closed).toBe(true)
    expect((await kept.list('/')).length).toBeGreaterThanOrEqual(0)
    kept.close()
  })

  async function manager(delays: number[], patch: Partial<TransferSettings> = {}) {
    const { vault } = await newUnlockedVault()
    const events: (ReconnectStatus | string)[] = []
    const fm = new FileManager(
      vault,
      recordingPrompter(),
      (channel, payload) => {
        if (channel === 'files:reconnecting') events.push(payload as ReconnectStatus)
        if (channel === 'files:reconnected') events.push(`back:${payload as string}`)
        if (channel === 'files:closed') events.push(`closed:${payload as string}`)
      },
      undefined,
      () => ({ ...DEFAULT_TRANSFER_SETTINGS, ...patch }),
      delays
    )
    open.push(fm)
    return { fm, events }
  }
  const until = async (what: () => unknown, ms = 15_000): Promise<void> => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (what()) return
    throw new Error('Timed out')
  }

  it('reconnects by itself after the connection broke off, and running transfers continue', async () => {
    const own = await startTestSshServer()
    try {
      const { fm, events } = await manager([150, 150, 150], { transferLimitKbps: 1024 })
      const id = await fm.open(sshHost(own.port))
      const local = mkdtempSync(join(tmpdir(), 'clavium-reconnect-'))
      const data = randomBytes(1024 * 1024)
      writeFileSync(join(local, 'big.bin'), data)
      mkdirSync(join(own.root, 'in'))
      const upload = fm.upload(id, [join(local, 'big.bin')], '/in')
      await until(() => fm.transfers().items.some((i) => i.state === 'running' && i.transferred > 150_000))

      own.dropClients()
      await until(() => events.length > 0)
      expect(events[0]).toMatchObject({ id, attempt: 1, attempts: 3 })
      // while the connection is away, the session says so and the transfer waits instead of failing
      expect(() => fm.get(id)).toThrow(/reconnecting/i)
      expect(fm.transfers().counts.failed).toBe(0)

      await until(() => events.includes(`back:${id}`))
      await upload
      expect(fm.transfers().counts).toMatchObject({ done: 1, failed: 0 })
      expect(readFileSync(join(own.root, 'in', 'big.bin')).equals(data)).toBe(true)
      expect((await fm.get(id).list('/in')).map((e) => e.name)).toEqual(['big.bin'])
      expect(events.filter((e) => typeof e === 'string')).toEqual([`back:${id}`])
      fm.close(id)
    } finally {
      await own.close()
    }
  })

  it('gives up after the last attempt and fails what was waiting', async () => {
    const own = await startTestSshServer()
    const { fm, events } = await manager([100, 100], { transferLimitKbps: 256 })
    const id = await fm.open(sshHost(own.port))
    const local = mkdtempSync(join(tmpdir(), 'clavium-reconnect-'))
    writeFileSync(join(local, 'big.bin'), randomBytes(1024 * 1024))
    const upload = fm.upload(id, [join(local, 'big.bin')], '/')
    await until(() => fm.transfers().items.some((i) => i.state === 'running' && i.transferred > 50_000))
    own.dropClients()
    await own.close()
    await until(() => events.includes(`closed:${id}`))
    await upload
    expect(events.filter((e) => typeof e !== 'string').map((e) => (e as ReconnectStatus).attempt)).toEqual([1, 2])
    expect(fm.transfers().counts.failed).toBe(1)
    expect(() => fm.get(id)).toThrow(/closed/)
  })

  it('an FTP session comes back too, also when the server hung up while nothing happened', async () => {
    const { fm, events } = await manager([100, 100])
    FtpFs.keepaliveMs = 60_000
    const id = await fm.open(ftpHost())
    // the server drops silent connections after two seconds
    await until(() => events.includes(`back:${id}`))
    expect(events[0]).toMatchObject({ id, attempt: 1 })
    expect(Array.isArray(await fm.get(id).list('/'))).toBe(true)
  })

  it('does not reconnect a session the user closed', async () => {
    const { fm, events } = await manager([50])
    const id = await fm.open(sshHost(srv.port))
    fm.close(id)
    await sleep(300)
    expect(events).toEqual([])
  })
})
