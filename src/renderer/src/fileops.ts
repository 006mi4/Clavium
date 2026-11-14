import type { MovePair, RemoteEntry } from '@shared/types'

/**
 * State of the file browser that has to outlive a single tab: what can be undone on each host and
 * what was last copied or cut. It lives as long as the app runs and is never written to disk.
 */

export type UndoStep =
  | { kind: 'move'; label: string; pairs: MovePair[] }
  | { kind: 'copy'; label: string; created: string[] }

export interface RemoteClip {
  hostId: string
  /** file session the items were copied in */
  sid: string
  entries: RemoteEntry[]
  mode: 'copy' | 'cut'
}

const MAX_STEPS = 100
const history = new Map<string, UndoStep[]>()
let clip: RemoteClip | null = null
const listeners = new Set<() => void>()
const changed = (): void => listeners.forEach((fn) => fn())

export function subscribeFileOps(fn: () => void): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

export function pushUndo(hostId: string, step: UndoStep): void {
  const steps = history.get(hostId) ?? []
  steps.push(step)
  history.set(hostId, steps.slice(-MAX_STEPS))
  changed()
}

export function lastUndo(hostId: string): UndoStep | undefined {
  return history.get(hostId)?.at(-1)
}

export function popUndo(hostId: string): void {
  history.get(hostId)?.pop()
  changed()
}

export function getRemoteClip(): RemoteClip | null {
  return clip
}

export function setRemoteClip(next: RemoteClip | null): void {
  clip = next
  changed()
}
