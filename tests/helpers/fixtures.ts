import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HostRecord } from '@shared/types'
import { Vault } from '../../src/main/core/vault'
import type { Prompter } from '../../src/main/core/prompter'

/** Fast KDF for tests only (production uses N=2^17). */
export const TEST_KDF = { name: 'scrypt' as const, N: 2 ** 14, r: 8, p: 1 }
export const MASTER = 'test-master-password'

export async function newUnlockedVault(): Promise<{ vault: Vault; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'clavium-test-'))
  const vault = new Vault(join(dir, 'vault.json'), TEST_KDF)
  await vault.create(MASTER)
  return { vault, dir }
}

export interface RecordingPrompter extends Prompter {
  hostKeyCalls: number
  confirmCalls: { tool: string; detail: string }[]
  acceptHostKey: boolean
  allow: boolean
}

export function recordingPrompter(): RecordingPrompter {
  const p: RecordingPrompter = {
    hostKeyCalls: 0,
    confirmCalls: [],
    acceptHostKey: true,
    allow: true,
    async hostKey() {
      p.hostKeyCalls++
      return p.acceptHostKey
    },
    async keyboardInteractive() {
      return null
    },
    async mcpConfirm(q) {
      p.confirmCalls.push({ tool: q.tool, detail: q.detail })
      return p.allow
    }
  }
  return p
}

export function sshHost(port: number, patch: Partial<HostRecord> = {}): HostRecord {
  return {
    id: 'h1',
    name: 'test-box',
    group: '',
    protocol: 'ssh',
    hostname: '127.0.0.1',
    port,
    username: 'tester',
    authMethod: 'password',
    password: 'correct horse battery',
    allowLegacyAlgorithms: false,
    aiAccess: 'full',
    aiConfirm: 'changes',
    notes: '',
    forwards: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

/**
 * A port that is free right now, chosen by the operating system. A random number is not good
 * enough: Windows reserves ranges of ports (for Hyper-V, among others) and answers with
 * "permission denied" when a test happens to pick one of those.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('no port'))))
    })
  })
}
