import { useState, type FormEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import type { VaultState } from '@shared/types'
import { api } from '../api'
import { Logo } from './Logo'

export function passwordScore(pw: string): number {
  let s = 0
  if (pw.length >= 10) s++
  if (pw.length >= 14) s++
  if (pw.length >= 20) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw) && /\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  return Math.min(4, s)
}

export function StrengthBar({ pw }: { pw: string }) {
  const s = passwordScore(pw)
  const tone = s <= 1 ? 'weak' : s <= 2 ? 'fair' : 'good'
  const label = pw.length === 0 ? '' : s <= 1 ? 'Weak' : s <= 2 ? 'Fair' : 'Strong'
  return (
    <div className="strength" role="img" aria-label={`Password strength: ${label || 'none'}`}>
      {[1, 2, 3, 4].map((i) => (
        <i key={i} className={i <= s ? `on ${tone}` : ''} />
      ))}
    </div>
  )
}

export function LockScreen({ state, onDone }: { state: VaultState; onDone: () => void }) {
  const creating = state === 'uninitialized'
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError('')
    if (creating) {
      if (pw.length < 10) return setError('Use at least 10 characters.')
      if (pw !== pw2) return setError('The passwords don’t match.')
    }
    setBusy(true)
    try {
      if (creating) await api.vault.create(pw)
      else await api.vault.unlock(pw)
      setPw('')
      setPw2('')
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lock">
      <div className="drag" />
      <div className="lock-center">
        <form className="lock-form" onSubmit={submit}>
          <Logo size={60} />
          <h1>{creating ? 'Welcome to Clavium' : 'Clavium Is Locked'}</h1>
          <p>
            {creating
              ? 'Choose a master password. It encrypts your hosts, passwords and keys on this PC.'
              : 'Enter your master password to unlock your vault.'}
          </p>

          {creating ? (
            <div className="fields">
              <input
                className="field large"
                type="password"
                autoFocus
                placeholder="Master password"
                aria-label="Master password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                autoComplete="new-password"
              />
              <StrengthBar pw={pw} />
              <input
                className="field large"
                type="password"
                placeholder="Repeat master password"
                aria-label="Repeat master password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                autoComplete="new-password"
              />
              <button className="btn prominent large" type="submit" disabled={busy || !pw || !pw2}>
                {busy ? 'Creating…' : 'Create Vault'}
              </button>
              <button
                type="button"
                className="link"
                onClick={() =>
                  void api.vault
                    .importBackup() // the screen switches to "locked" by itself once the vault is there
                    .catch((err: Error) => setError(err.message))
                }
              >
                Restore from a Backup…
              </button>
            </div>
          ) : (
            <div className="fields">
              <div className="pw">
                <input
                  className="field large"
                  type="password"
                  autoFocus
                  placeholder="Master password"
                  aria-label="Master password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  autoComplete="current-password"
                />
                <button className="go" type="submit" aria-label="Unlock" disabled={busy || !pw}>
                  <ArrowRight size={15} />
                </button>
              </div>
            </div>
          )}

          <div className="error" role="alert">
            {error}
          </div>
          {creating && (
            <p className="caption">
              There is no password recovery. If you forget the master password, the vault can’t be opened by anyone.
            </p>
          )}
        </form>
      </div>
    </div>
  )
}
