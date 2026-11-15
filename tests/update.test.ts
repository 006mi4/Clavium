import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertManifestFor,
  fetchSignedManifest,
  isNewer,
  UPDATE_PUBLIC_KEY,
  verifyInstallerFile,
  verifySignedManifest,
  type UpdateManifest
} from '../src/main/core/update'

const pair = generateKeyPairSync('ed25519')
const PUB = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const installer = Buffer.from('pretend this is an installer')

function manifestBytes(patch: Partial<UpdateManifest> = {}): Buffer {
  const m: UpdateManifest = {
    format: 'clavium-update',
    version: '1.2.0',
    file: 'Clavium-Setup-1.2.0.exe',
    size: installer.length,
    sha512: createHash('sha512').update(installer).digest('base64'),
    createdAt: '2026-11-14T00:00:00.000Z',
    ...patch
  }
  return Buffer.from(JSON.stringify(m))
}
const sigOf = (bytes: Buffer, key = pair.privateKey): string => sign(null, bytes, key).toString('base64')

function fakeFetch(files: Record<string, Buffer>, finalHost = 'release-assets.githubusercontent.com') {
  return async (url: string) => {
    const name = url.split('/').pop() as string
    const body = files[name]
    return {
      ok: !!body,
      status: body ? 200 : 404,
      url: `https://${finalHost}/x/${name}`,
      headers: { get: () => null },
      arrayBuffer: async () => (body ?? Buffer.alloc(0)).buffer.slice((body ?? Buffer.alloc(0)).byteOffset, (body ?? Buffer.alloc(0)).byteOffset + (body ?? Buffer.alloc(0)).length) as ArrayBuffer
    }
  }
}

describe('version comparison', () => {
  it('only accepts strictly newer plain versions', () => {
    expect(isNewer('1.2.0', '1.1.9')).toBe(true)
    expect(isNewer('1.10.0', '1.9.0')).toBe(true)
    expect(isNewer('1.2.0', '1.2.0')).toBe(false)
    expect(isNewer('1.1.9', '1.2.0')).toBe(false)
    expect(() => isNewer('1.2.0-beta.1', '1.0.0')).toThrow()
    expect(() => isNewer('../../evil', '1.0.0')).toThrow()
  })
})

describe('signed manifest', () => {
  it('accepts a correctly signed manifest', () => {
    const bytes = manifestBytes()
    expect(verifySignedManifest(bytes, sigOf(bytes), PUB).version).toBe('1.2.0')
  })

  it('rejects a modified manifest, a foreign key and garbage signatures', () => {
    const bytes = manifestBytes()
    const sig = sigOf(bytes)
    expect(() => verifySignedManifest(manifestBytes({ sha512: createHash('sha512').update('evil').digest('base64') }), sig, PUB)).toThrow(/not signed/)
    const attacker = generateKeyPairSync('ed25519').privateKey
    expect(() => verifySignedManifest(bytes, sigOf(bytes, attacker), PUB)).toThrow(/not signed/)
    expect(() => verifySignedManifest(bytes, '', PUB)).toThrow(/not signed/)
    expect(() => verifySignedManifest(bytes, 'AAAA', PUB)).toThrow(/not signed/)
    // signed with the test key, but the app's real key must not accept it
    expect(() => verifySignedManifest(bytes, sig, UPDATE_PUBLIC_KEY)).toThrow(/not signed/)
  })

  it('rejects correctly signed but malformed manifests', () => {
    for (const patch of [{ file: '..\\..\\evil.exe' }, { file: 'other.exe' }, { size: -1 }, { sha512: 'short' }, { version: '1.2' }] as Partial<UpdateManifest>[]) {
      const bytes = manifestBytes(patch)
      expect(() => verifySignedManifest(bytes, sigOf(bytes), PUB)).toThrow()
    }
  })

  it('blocks downgrades, replays of other versions and mismatched file names', () => {
    const m = verifySignedManifest(manifestBytes(), sigOf(manifestBytes()), PUB)
    expect(() => assertManifestFor(m, '1.2.0', '1.1.0', 'win32')).not.toThrow()
    expect(() => assertManifestFor(m, '1.3.0', '1.1.0', 'win32')).toThrow(/not 1\.3\.0/) // old signed manifest offered as a newer version
    expect(() => assertManifestFor(m, '1.2.0', '1.2.0', 'win32')).toThrow(/not newer/)
    expect(() => assertManifestFor(m, '1.2.0', '2.0.0', 'win32')).toThrow(/not newer/)
    const odd = { ...m, file: 'Clavium-Setup-9.9.9.exe' }
    expect(() => assertManifestFor(odd, '1.2.0', '1.1.0', 'win32')).toThrow(/unexpected installer/)
  })
})

describe('macOS manifest', () => {
  const macFile = { file: 'Clavium-1.2.0-mac.zip' }

  it('is accepted on macOS only, and the Windows one on Windows only', () => {
    const mac = verifySignedManifest(manifestBytes(macFile), sigOf(manifestBytes(macFile)), PUB)
    const win = verifySignedManifest(manifestBytes(), sigOf(manifestBytes()), PUB)
    expect(() => assertManifestFor(mac, '1.2.0', '1.1.0', 'darwin')).not.toThrow()
    expect(() => assertManifestFor(mac, '1.2.0', '1.1.0', 'win32')).toThrow(/unexpected installer/)
    expect(() => assertManifestFor(win, '1.2.0', '1.1.0', 'darwin')).toThrow(/unexpected installer/)
  })

  it('is fetched from its own file in the release', async () => {
    const bytes = manifestBytes(macFile)
    const files = { 'update-manifest-mac.json': bytes, 'update-manifest-mac.json.sig': Buffer.from(sigOf(bytes)) }
    expect((await fetchSignedManifest('1.2.0', '1.0.0', fakeFetch(files), PUB, 'darwin')).file).toBe('Clavium-1.2.0-mac.zip')
    // the Windows manifest of the same release is not there for it to fall back on
    await expect(fetchSignedManifest('1.2.0', '1.0.0', fakeFetch(files), PUB, 'win32')).rejects.toThrow(/HTTP 404/)
  })

  it('rejects other file names', () => {
    for (const file of ['Clavium-1.2.0-mac.dmg', 'Clavium-1.2.0-mac.zip.exe', '../Clavium-1.2.0-mac.zip', 'Other-1.2.0-mac.zip']) {
      const bytes = manifestBytes({ file })
      expect(() => verifySignedManifest(bytes, sigOf(bytes), PUB)).toThrow(/malformed/)
    }
  })
})

describe('installer file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'clavium-upd-'))
  const m = JSON.parse(manifestBytes().toString()) as UpdateManifest

  it('accepts the exact file and rejects any change', async () => {
    const good = join(dir, 'Clavium-Setup-1.2.0.exe')
    writeFileSync(good, installer)
    await expect(verifyInstallerFile(good, m)).resolves.toBeUndefined()

    const tampered = Buffer.from(installer)
    tampered[3] ^= 1 // same size, one bit flipped
    writeFileSync(good, tampered)
    await expect(verifyInstallerFile(good, m)).rejects.toThrow(/checksum/)

    writeFileSync(good, Buffer.concat([installer, Buffer.from('x')]))
    await expect(verifyInstallerFile(good, m)).rejects.toThrow(/size/)

    const renamed = join(dir, 'something-else.exe')
    writeFileSync(renamed, installer)
    await expect(verifyInstallerFile(renamed, m)).rejects.toThrow(/name/)
  })
})

describe('fetching the manifest', () => {
  const bytes = manifestBytes()
  const files = { 'update-manifest.json': bytes, 'update-manifest.json.sig': Buffer.from(sigOf(bytes)) }

  it('returns the verified manifest', async () => {
    expect((await fetchSignedManifest('1.2.0', '1.0.0', fakeFetch(files), PUB, 'win32')).file).toBe('Clavium-Setup-1.2.0.exe')
  })

  it('fails closed: missing signature, foreign redirect, wrong version, oversized manifest', async () => {
    await expect(fetchSignedManifest('1.2.0', '1.0.0', fakeFetch({ 'update-manifest.json': bytes }), PUB, 'win32')).rejects.toThrow(/HTTP 404/)
    await expect(fetchSignedManifest('1.2.0', '1.0.0', fakeFetch(files, 'evil.example'), PUB, 'win32')).rejects.toThrow(/unexpected address/)
    await expect(fetchSignedManifest('1.3.0', '1.0.0', fakeFetch(files), PUB, 'win32')).rejects.toThrow(/not 1\.3\.0/)
    await expect(fetchSignedManifest('1.2.0', '1.2.0', fakeFetch(files), PUB, 'win32')).rejects.toThrow(/not newer/)
    const big = { ...files, 'update-manifest.json': Buffer.alloc(20_000, 32) }
    await expect(fetchSignedManifest('1.2.0', '1.0.0', fakeFetch(big), PUB, 'win32')).rejects.toThrow(/too large/)
    await expect(fetchSignedManifest('1.2.0/../x', '1.0.0', fakeFetch(files), PUB, 'win32')).rejects.toThrow(/Not a release version/)
  })
})
