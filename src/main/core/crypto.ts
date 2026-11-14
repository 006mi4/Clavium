import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual
} from 'node:crypto'

export interface KdfParams {
  name: 'scrypt'
  N: number
  r: number
  p: number
  /** base64 */
  salt: string
}

/** scrypt N=2^17, r=8, p=1 (~128 MiB, a few hundred ms) — OWASP-recommended minimum is 2^17. */
export const DEFAULT_KDF: Omit<KdfParams, 'salt'> = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 }

export function newKdfParams(base: Omit<KdfParams, 'salt'> = DEFAULT_KDF): KdfParams {
  return { ...base, salt: randomBytes(32).toString('base64') }
}

export function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  if (params.name !== 'scrypt') throw new Error(`Unsupported KDF: ${params.name}`)
  // Guard against a tampered vault header forcing absurd parameters (DoS) or weak ones.
  const powerOfTwo = Number.isInteger(Math.log2(params.N))
  if (
    !powerOfTwo ||
    params.N < 2 ** 14 ||
    params.r < 8 ||
    params.p < 1 ||
    params.p > 4 ||
    128 * params.N * params.r > 1024 * 1024 * 1024
  ) {
    throw new Error('Vault KDF parameters out of allowed range')
  }
  const salt = Buffer.from(params.salt, 'base64')
  if (salt.length < 16) throw new Error('Vault salt too short')
  return new Promise((resolve, reject) => {
    scrypt(
      password.normalize('NFKC'),
      salt,
      32,
      { N: params.N, r: params.r, p: params.p, maxmem: 160 * params.N * params.r },
      (err, key) => (err ? reject(err) : resolve(key))
    )
  })
}

export interface Sealed {
  iv: string
  tag: string
  data: string
}

/** AES-256-GCM with a fresh 96-bit IV per call. `aad` binds the header to the ciphertext. */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

export function open(key: Buffer, sealed: Sealed, aad: Buffer): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAAD(aad)
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()])
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Constant-time comparison of two secrets of arbitrary length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb) && a.length === b.length
}

export function randomToken(prefix = 'clv_'): string {
  return prefix + randomBytes(32).toString('base64url')
}

export function randomId(): string {
  return randomBytes(9).toString('base64url')
}
