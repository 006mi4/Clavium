import type { AiAccess, AiConfirm } from '@shared/types'

/** Kind of operation an MCP tool performs on a host. */
export type Operation = 'read' | 'exec' | 'write' | 'delete'

export function requiredAccess(op: Operation): Exclude<AiAccess, 'none'> {
  return op === 'read' ? 'read' : 'full'
}

export function accessAllows(granted: AiAccess, op: Operation): boolean {
  if (granted === 'none') return false
  if (granted === 'full') return true
  return requiredAccess(op) === 'read'
}

export function needsConfirmation(mode: AiConfirm, op: Operation): boolean {
  if (mode === 'all') return true
  if (mode === 'changes') return op !== 'read'
  return false
}
