import { createHash } from 'node:crypto'
import { utils } from 'ssh2'
import type { SshKeyRecord, SshKeySummary } from '@shared/types'
import { randomId } from './crypto'

export function fingerprintOf(publicKeyBlob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(publicKeyBlob).digest('base64').replace(/=+$/, '')
}

/** Read the key type string from an SSH wire-format public key blob. */
export function keyTypeOf(blob: Buffer): string {
  if (blob.length < 4) return 'unknown'
  const len = blob.readUInt32BE(0)
  if (len <= 0 || len > 64 || blob.length < 4 + len) return 'unknown'
  return blob.subarray(4, 4 + len).toString('ascii')
}

/**
 * Validate a private key (optionally passphrase protected) and build a vault record.
 * Throws a readable error for unsupported formats or a wrong passphrase.
 */
export function buildKeyRecord(name: string, privateKey: string, passphrase?: string): SshKeyRecord {
  const parsed = utils.parseKey(privateKey, passphrase || undefined)
  if (parsed instanceof Error) {
    const msg = /passphrase|encrypted/i.test(parsed.message)
      ? 'The key is encrypted: wrong or missing passphrase'
      : `Unsupported or invalid private key: ${parsed.message}`
    throw new Error(msg)
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed
  if (!key || !key.isPrivateKey()) throw new Error('This is not a private key')
  const blob = key.getPublicSSH()
  return {
    id: randomId(),
    name: name.trim() || key.type,
    type: key.type,
    publicKey: `${key.type} ${blob.toString('base64')} ${name.trim() || 'clavium'}`,
    fingerprint: fingerprintOf(blob),
    privateKey,
    passphrase: passphrase || undefined,
    createdAt: Date.now()
  }
}

export function generateKey(name: string, type: 'ed25519' | 'ecdsa' | 'rsa', passphrase?: string): SshKeyRecord {
  const comment = name.trim() || 'clavium'
  const opts: Record<string, unknown> = { comment }
  if (type === 'rsa') opts.bits = 4096
  if (type === 'ecdsa') opts.bits = 256
  if (passphrase) {
    opts.passphrase = passphrase
    opts.cipher = 'aes256-ctr'
    opts.rounds = 64
  }
  // ssh2 typings are narrower than what generateKeyPairSync accepts at runtime
  const pair = (utils.generateKeyPairSync as (t: string, o: unknown) => { private: string; public: string })(
    type,
    opts
  )
  return buildKeyRecord(comment, pair.private, passphrase)
}

export function summarizeKey(k: SshKeyRecord): SshKeySummary {
  return {
    id: k.id,
    name: k.name,
    type: k.type,
    publicKey: k.publicKey,
    fingerprint: k.fingerprint,
    createdAt: k.createdAt,
    encrypted: !!k.passphrase
  }
}
