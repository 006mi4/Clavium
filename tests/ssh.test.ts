import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectSsh, execCommand } from '../src/main/core/ssh'
import { openRemoteFs } from '../src/main/core/remotefs'
import { buildKeyRecord, generateKey } from '../src/main/core/keys'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer

beforeAll(async () => {
  srv = await startTestSshServer()
})
afterAll(async () => {
  await srv.close()
})

describe('SSH host key verification (TOFU)', () => {
  it('asks once, remembers the key, then connects silently', async () => {
    const { vault } = await newUnlockedVault()
    const prompter = recordingPrompter()
    const c1 = await connectSsh(sshHost(srv.port), { vault, prompter, interactive: true })
    c1.end()
    expect(prompter.hostKeyCalls).toBe(1)
    expect(vault.data.knownHosts[0].fingerprint).toMatch(/^SHA256:/)
    expect(vault.data.knownHosts[0].keyType).toBe('ssh-ed25519')

    const c2 = await connectSsh(sshHost(srv.port), { vault, prompter, interactive: true })
    c2.end()
    expect(prompter.hostKeyCalls).toBe(1)
  })

  it('aborts when the user rejects an unknown key', async () => {
    const { vault } = await newUnlockedVault()
    const prompter = recordingPrompter()
    prompter.acceptHostKey = false
    await expect(connectSsh(sshHost(srv.port), { vault, prompter, interactive: true })).rejects.toThrow(/Host key/)
    expect(vault.data.knownHosts).toHaveLength(0)
  })

  it('refuses a changed host key for non-interactive (AI) sessions without asking', async () => {
    const { vault } = await newUnlockedVault()
    await vault.update((d) => {
      d.knownHosts.push({ id: `ssh:127.0.0.1:${srv.port}`, keyType: 'ssh-ed25519', fingerprint: 'SHA256:somethingelse', addedAt: 1 })
    })
    const prompter = recordingPrompter()
    await expect(connectSsh(sshHost(srv.port), { vault, prompter, interactive: false })).rejects.toThrow(/Host key/)
    expect(prompter.hostKeyCalls).toBe(0)
  })

  it('reports wrong passwords clearly', async () => {
    const { vault } = await newUnlockedVault()
    const prompter = recordingPrompter()
    await expect(
      connectSsh(sshHost(srv.port, { password: 'wrong' }), { vault, prompter, interactive: false })
    ).rejects.toThrow(/Authentication failed/)
  })
})

describe('exec', () => {
  it('returns stdout, stderr and the exit code; enforces timeouts', async () => {
    const { vault } = await newUnlockedVault()
    const client = await connectSsh(sshHost(srv.port), { vault, prompter: recordingPrompter(), interactive: true })
    const r = await execCommand(client, 'uname -a', { timeoutMs: 5000, maxBytes: 1000 })
    expect(r).toMatchObject({ stdout: 'ran: uname -a\n', stderr: 'warn\n', exitCode: 3, timedOut: false })

    const cut = await execCommand(client, 'x'.repeat(50), { timeoutMs: 5000, maxBytes: 10 })
    expect(cut.truncated).toBe(true)
    expect(cut.stdout).toHaveLength(10)

    const slow = await execCommand(client, 'sleep', { timeoutMs: 300, maxBytes: 1000 })
    expect(slow.timedOut).toBe(true)
    client.end()
  })
})

describe('SFTP', () => {
  it('lists, writes, reads, renames and deletes', async () => {
    const { vault } = await newUnlockedVault()
    const fs = await openRemoteFs(sshHost(srv.port), { vault, prompter: recordingPrompter(), interactive: true })
    expect(await fs.home()).toBe('/')
    await fs.mkdir('/dir')
    await fs.writeFile('/dir/a.txt', Buffer.from('hello world'), false)
    await expect(fs.writeFile('/dir/a.txt', Buffer.from('x'), false)).rejects.toThrow()
    const listing = await fs.list('/dir')
    expect(listing.map((e) => [e.name, e.type, e.size])).toEqual([['a.txt', 'file', 11]])

    const part = await fs.readFile('/dir/a.txt', 5)
    expect(part.data.toString()).toBe('hello')
    expect(part.truncated).toBe(true)

    await fs.rename('/dir/a.txt', '/dir/b.txt')
    expect((await fs.stat('/dir/b.txt')).type).toBe('file')
    await expect(fs.remove('/dir', false)).rejects.toThrow()
    await fs.remove('/dir', true)
    expect(await fs.list('/')).toEqual([])
    await expect(fs.list('/x\r\nDELE y')).rejects.toThrow(/control characters/)
    fs.close()
  })
})

describe('keys', () => {
  it('generates and re-imports ed25519 keys, with passphrase', () => {
    const k = generateKey('laptop', 'ed25519', 'pass phrase')
    expect(k.type).toBe('ssh-ed25519')
    expect(k.publicKey.startsWith('ssh-ed25519 ')).toBe(true)
    // a wrong passphrase fails in different ways inside the parser; the message must always say so
    for (let i = 0; i < 3; i++) expect(() => buildKeyRecord('x', k.privateKey, `wrong-${i}`)).toThrow(/passphrase/i)
    expect(() => buildKeyRecord('x', 'not a key at all')).toThrow(/Unsupported or invalid/)
    expect(buildKeyRecord('x', k.privateKey, 'pass phrase').fingerprint).toBe(k.fingerprint)
  })
})
