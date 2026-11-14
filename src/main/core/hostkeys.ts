import type { Vault } from './vault'
import type { Prompter } from './prompter'

export interface PresentedKey {
  /** "ssh:host:port" or "ftps:host:port" */
  id: string
  displayHost: string
  keyType: string
  fingerprint: string
}

/**
 * Trust-on-first-use host key verification.
 *  - known & matching      -> accept silently
 *  - unknown               -> ask the user (shows fingerprint)
 *  - known & DIFFERENT     -> possible man-in-the-middle. Non-interactive (AI) connections
 *                             are refused outright; the user gets a loud warning and must
 *                             explicitly replace the stored key.
 */
export async function verifyPresentedKey(
  vault: Vault,
  prompter: Prompter,
  key: PresentedKey,
  interactive: boolean
): Promise<boolean> {
  const known = vault.data.knownHosts.find((k) => k.id === key.id)
  if (known && known.fingerprint === key.fingerprint) return true
  if (known && !interactive) return false

  const accept = await prompter.hostKey({
    host: key.displayHost,
    keyType: key.keyType,
    fingerprint: key.fingerprint,
    previousFingerprint: known?.fingerprint
  })
  if (!accept) return false
  await vault.update((d) => {
    d.knownHosts = d.knownHosts.filter((k) => k.id !== key.id)
    d.knownHosts.push({ id: key.id, keyType: key.keyType, fingerprint: key.fingerprint, addedAt: Date.now() })
  })
  return true
}
