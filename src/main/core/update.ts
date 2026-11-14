import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

/**
 * Signed updates.
 *
 * Every release ships `update-manifest.json` (version, installer name, size, SHA-512) and
 * `update-manifest.json.sig`, an Ed25519 signature over the exact manifest bytes.
 * The app only installs an installer that matches a manifest signed with the key below.
 * So a download is trusted because of the signature, not because of where it came from.
 */

/** Ed25519 public key (SPKI, base64). The private key never enters the repository. */
export const UPDATE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAHC3/i4FpcHPG2vV8mmgBGPlFF6aDh7b80bT+TYbva2Y='

export const UPDATE_REPO = { owner: '006mi4', repo: 'Clavium' }
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const MAX_MANIFEST_BYTES = 16 * 1024
const MAX_INSTALLER_BYTES = 600 * 1024 * 1024

export interface UpdateManifest {
  format: 'clavium-update'
  version: string
  /** file name of the installer, e.g. Clavium-Setup-1.2.3.exe */
  file: string
  size: number
  /** base64 */
  sha512: string
  createdAt: string
}

export class UpdateVerificationError extends Error {}

const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

export function parseVersion(v: string): [number, number, number] {
  const m = VERSION.exec(v)
  if (!m) throw new UpdateVerificationError(`Not a release version: ${v}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** true if `candidate` is strictly newer than `current` (plain x.y.z only, no pre-releases). */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/** Verify the signature over the raw manifest bytes, then parse and validate the manifest. */
export function verifySignedManifest(manifestBytes: Buffer, signatureBase64: string, publicKeyBase64 = UPDATE_PUBLIC_KEY): UpdateManifest {
  let ok = false
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' })
    const sig = Buffer.from(signatureBase64.trim(), 'base64')
    ok = sig.length === 64 && cryptoVerify(null, manifestBytes, key, sig)
  } catch {
    ok = false
  }
  if (!ok) throw new UpdateVerificationError('The update is not signed by the Clavium release key')

  let m: UpdateManifest
  try {
    m = JSON.parse(manifestBytes.toString('utf8')) as UpdateManifest
  } catch {
    throw new UpdateVerificationError('The update manifest is not valid JSON')
  }
  if (
    m.format !== 'clavium-update' ||
    typeof m.version !== 'string' ||
    typeof m.file !== 'string' ||
    !/^Clavium-Setup-[0-9.]+\.exe$/.test(m.file) ||
    !Number.isSafeInteger(m.size) ||
    m.size <= 0 ||
    m.size > MAX_INSTALLER_BYTES ||
    typeof m.sha512 !== 'string' ||
    Buffer.from(m.sha512, 'base64').length !== 64
  ) {
    throw new UpdateVerificationError('The update manifest is malformed')
  }
  parseVersion(m.version)
  return m
}

/**
 * A signed manifest is only acceptable for the update we asked for:
 * the exact offered version, and strictly newer than what is installed (no downgrade, no replay).
 */
export function assertManifestFor(m: UpdateManifest, offeredVersion: string, installedVersion: string): void {
  if (m.version !== offeredVersion) {
    throw new UpdateVerificationError(`Signed manifest is for version ${m.version}, not ${offeredVersion}`)
  }
  if (!isNewer(m.version, installedVersion)) {
    throw new UpdateVerificationError(`Version ${m.version} is not newer than the installed ${installedVersion}`)
  }
  if (m.file !== `Clavium-Setup-${m.version}.exe`) {
    throw new UpdateVerificationError('Signed manifest names an unexpected installer file')
  }
}

export function sha512File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512')
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('base64')))
  })
}

/** The downloaded installer must be byte-for-byte the file described by the signed manifest. */
export async function verifyInstallerFile(path: string, m: UpdateManifest): Promise<void> {
  if (basename(path) !== m.file) throw new UpdateVerificationError('Downloaded file has an unexpected name')
  const st = await stat(path)
  if (!st.isFile() || st.size !== m.size) throw new UpdateVerificationError('Downloaded installer has the wrong size')
  if ((await sha512File(path)) !== m.sha512) throw new UpdateVerificationError('Downloaded installer does not match the signed checksum')
}

type FetchLike = (url: string, init?: { redirect?: 'follow'; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  url: string
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

async function fetchSmall(url: string, fetchImpl: FetchLike): Promise<Buffer> {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) })
  const final = new URL(res.url || url)
  if (final.protocol !== 'https:' || !ALLOWED_HOSTS.has(final.hostname)) {
    throw new UpdateVerificationError(`Update server redirected to an unexpected address (${final.hostname})`)
  }
  if (!res.ok) throw new UpdateVerificationError(`Could not load the update signature (HTTP ${res.status})`)
  if (Number(res.headers.get('content-length') ?? 0) > MAX_MANIFEST_BYTES) throw new UpdateVerificationError('Update manifest is too large')
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > MAX_MANIFEST_BYTES) throw new UpdateVerificationError('Update manifest is too large')
  return buf
}

/** Download and verify the signed manifest of one release from the project's GitHub releases. */
export async function fetchSignedManifest(
  version: string,
  installedVersion: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  publicKeyBase64 = UPDATE_PUBLIC_KEY
): Promise<UpdateManifest> {
  parseVersion(version)
  const base = `https://github.com/${UPDATE_REPO.owner}/${UPDATE_REPO.repo}/releases/download/v${version}`
  const [manifest, sig] = await Promise.all([
    fetchSmall(`${base}/update-manifest.json`, fetchImpl),
    fetchSmall(`${base}/update-manifest.json.sig`, fetchImpl)
  ])
  const m = verifySignedManifest(manifest, sig.toString('utf8'), publicKeyBase64)
  assertManifestFor(m, version, installedVersion)
  return m
}
