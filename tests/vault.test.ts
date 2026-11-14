import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Vault } from '../src/main/core/vault'
import { MASTER, TEST_KDF } from './helpers/fixtures'

function fresh(): { vault: Vault; file: string } {
  const file = join(mkdtempSync(join(tmpdir(), 'clavium-vault-')), 'vault.json')
  return { vault: new Vault(file, TEST_KDF), file }
}

describe('vault backup', () => {
  it('writes a backup that restores hosts under the password of the backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clavium-backup-'))
    const a = new Vault(join(dir, 'a', 'vault.json'), TEST_KDF)
    await a.create('first master password')
    await a.update((d) => void d.knownHosts.push({ id: 'ssh:example:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:abc', addedAt: 1 }))
    const backup = join(dir, 'backup.clavium-vault')
    await a.exportTo(backup)
    expect(readFileSync(backup, 'utf8')).not.toContain('example') // still encrypted

    // restoring on a fresh computer
    const b = new Vault(join(dir, 'b', 'vault.json'), TEST_KDF)
    expect(await b.importFrom(backup)).toBeNull()
    expect(b.state()).toBe('locked')
    await expect(b.unlock('some other password')).rejects.toThrow(/Wrong master password/)
    await b.unlock('first master password')
    expect(b.data.knownHosts[0].id).toBe('ssh:example:22')

    // restoring over an existing vault locks it and keeps the replaced file
    const c = new Vault(join(dir, 'c', 'vault.json'), TEST_KDF)
    await c.create('second master password')
    const kept = await c.importFrom(backup)
    expect(c.state()).toBe('locked')
    expect(kept && existsSync(kept)).toBe(true)
    await c.unlock('first master password')
    expect(c.data.knownHosts).toHaveLength(1)
  })

  it('refuses files that are not a vault and keeps the current vault', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clavium-backup-'))
    const v = new Vault(join(dir, 'vault.json'), TEST_KDF)
    await v.create('first master password')
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ hello: 'world' }))
    writeFileSync(join(dir, 'text.txt'), 'not json at all')
    await expect(v.importFrom(join(dir, 'other.json'))).rejects.toThrow(/not a Clavium vault backup/)
    await expect(v.importFrom(join(dir, 'text.txt'))).rejects.toThrow(/not a Clavium vault backup/)
    expect(v.state()).toBe('unlocked')
  })
})

describe('Vault', () => {
  it('creates, persists, locks and unlocks', async () => {
    const { vault, file } = fresh()
    expect(vault.state()).toBe('uninitialized')
    await vault.create(MASTER)
    await vault.update((d) => {
      d.mcpToken = 'clv_secret-token'
    })
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('clv_secret-token')
    vault.lock()
    expect(vault.state()).toBe('locked')
    expect(() => vault.data).toThrow(/locked/)

    const again = new Vault(file, TEST_KDF)
    await again.unlock(MASTER)
    expect(again.data.mcpToken).toBe('clv_secret-token')
  })

  it('rejects weak and wrong passwords and throttles brute force', async () => {
    const { vault } = fresh()
    await expect(vault.create('short')).rejects.toThrow(/at least/)
    await vault.create(MASTER)
    vault.lock()
    await expect(vault.unlock('wrong password 1')).rejects.toThrow(/Wrong master password/)
    await expect(vault.unlock('wrong password 2')).rejects.toThrow(/Wrong/)
    await expect(vault.unlock('wrong password 3')).rejects.toThrow(/Wrong/)
    await expect(vault.unlock(MASTER)).rejects.toThrow(/Too many failed attempts/)
  })

  it('detects tampering with ciphertext or header', async () => {
    const { vault, file } = fresh()
    await vault.create(MASTER)
    vault.lock()
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    parsed.kdf.N = 2 ** 15 // header is authenticated via AAD
    writeFileSync(file, JSON.stringify(parsed))
    await expect(new Vault(file, TEST_KDF).unlock(MASTER)).rejects.toThrow()

    parsed.kdf.N = 2 ** 40 // absurd KDF parameters must be refused, not computed
    writeFileSync(file, JSON.stringify(parsed))
    await expect(new Vault(file, TEST_KDF).unlock(MASTER)).rejects.toThrow(/out of allowed range/)
  })

  it('changes the master password', async () => {
    const { vault, file } = fresh()
    await vault.create(MASTER)
    await expect(vault.changePassword('nope nope nope', 'new-password-123')).rejects.toThrow(/wrong/)
    await vault.changePassword(MASTER, 'new-password-123')
    vault.lock()
    const v2 = new Vault(file, TEST_KDF)
    await expect(v2.unlock(MASTER)).rejects.toThrow()
    await v2.unlock('new-password-123')
    expect(v2.state()).toBe('unlocked')
  })
})
