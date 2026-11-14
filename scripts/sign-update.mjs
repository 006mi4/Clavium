// Creates dist/update-manifest.json and dist/update-manifest.json.sig for the built installer.
// The Ed25519 private key (PKCS#8 PEM) comes from the UPDATE_SIGNING_KEY environment variable
// or from a file:  node scripts/sign-update.mjs --key C:\path\to\update-signing-key.pem
// The result is verified against the public key compiled into the app before the script succeeds.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const file = `Clavium-Setup-${version}.exe`
const dist = process.env.CLAVIUM_DIST || 'dist'
const installer = join(dist, file)

const keyArg = process.argv.indexOf('--key')
const pem = keyArg > 0 ? readFileSync(process.argv[keyArg + 1], 'utf8') : process.env.UPDATE_SIGNING_KEY
if (!pem || !pem.includes('PRIVATE KEY')) {
  console.error('No signing key: set the UPDATE_SIGNING_KEY secret (or pass --key <file>).')
  process.exit(1)
}
const privateKey = createPrivateKey(pem.replace(/\\n/g, '\n'))
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The update signing key must be an Ed25519 key')

const manifest = Buffer.from(
  JSON.stringify(
    {
      format: 'clavium-update',
      version,
      file,
      size: statSync(installer).size,
      sha512: createHash('sha512').update(readFileSync(installer)).digest('base64'),
      createdAt: new Date().toISOString()
    },
    null,
    2
  ) + '\n'
)
const signature = sign(null, manifest, privateKey)

// The key that signed must be the one the app trusts, otherwise no installed copy could update.
const source = readFileSync(join('src', 'main', 'core', 'update.ts'), 'utf8')
const embedded = /UPDATE_PUBLIC_KEY = '([A-Za-z0-9+/=]+)'/.exec(source)?.[1]
if (!embedded) throw new Error('UPDATE_PUBLIC_KEY not found in src/main/core/update.ts')
const trusted = createPublicKey({ key: Buffer.from(embedded, 'base64'), format: 'der', type: 'spki' })
if (!verify(null, manifest, trusted, signature)) {
  console.error('The signing key does not match UPDATE_PUBLIC_KEY in the app. Refusing to publish an update nobody could install.')
  process.exit(1)
}

writeFileSync(join(dist, 'update-manifest.json'), manifest)
writeFileSync(join(dist, 'update-manifest.json.sig'), signature.toString('base64') + '\n')
console.log(`signed ${file} (${version})`)
