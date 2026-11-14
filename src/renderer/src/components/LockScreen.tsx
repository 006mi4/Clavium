import { useState, type FormEvent } from 'react'
import type { VaultState } from '@shared/types'
import { api } from '../api'
import { Logo } from './Logo'

export function passwordScore(pw: string): number {
  let s = 0
  if (pw.length >= 10) s++
  if (pw.length >= 14) s++
  if (pw.length >= 20) s++
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++
  if (/\d/.test(pw)) s++
  if (/[^A-Za-z0-9]/.test(pw)) s++
  return Math.min(5, s)
}

export function StrengthBar({ pw }: { pw: string }) {
  const s = passwordScore(pw)
  const colors = ['#ff5d6c', '#ff5d6c', '#f5b94a', '#f5b94a', '#3ccf8e', '#3ccf8e']
  return (
    <div className="strength" aria-label="password strength">
      <div style={{ width: `${(s / 5) * 100}%`, background: colors[s] }} />
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
      if (pw !== pw2) return setError('The passwords do not match.')
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
      <form className="lock-card" onSubmit={submit}>
        <div className="logo">
          <Logo size={64} />
        </div>
        <h1>{creating ? 'Welcome to Clavium' : 'Clavium is locked'}</h1>
        <p>
          {creating
            ? 'Choose a master password. It encrypts all hosts, passwords and keys on this computer.'
            : 'Enter your master password to unlock your vault.'}
        </p>
        <input
          className="input"
          type="password"
          autoFocus
          placeholder="Master password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoComplete={creating ? 'new-password' : 'current-password'}
        />
        {creating && (
          <>
            <StrengthBar pw={pw} />
            <input
              className="input"
              type="password"
              placeholder="Repeat master password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              autoComplete="new-password"
            />
            <div className="callout warn small">
              There is no password recovery. If you forget the master password, the vault cannot be decrypted —
              not by you, not by anyone.
            </div>
          </>
        )}
        {error && <div className="callout danger small">{error}</div>}
        <button className="btn primary" type="submit" disabled={busy || !pw} style={{ justifyContent: 'center' }}>
          {busy ? 'Working…' : creating ? 'Create vault' : 'Unlock'}
        </button>
      </form>
    </div>
  )
}
