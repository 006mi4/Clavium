// Generates an Ed25519 key pair for signing updates.
//   node scripts/generate-update-key.mjs <private-key-output.pem>
// Keep the private key OUT of the repository. Put the printed public key into
// UPDATE_PUBLIC_KEY in src/main/core/update.ts (only needed for forks / key rotation).
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'

const out = process.argv[2]
if (!out) throw new Error('usage: node scripts/generate-update-key.mjs <private-key-output.pem>')
if (existsSync(out)) throw new Error(`${out} already exists - refusing to overwrite a signing key`)
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
console.log(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'))
