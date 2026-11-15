import type { SyncAction, SyncItem, SyncMode } from './types'

/** What can be done about a difference. Deleting is only offered for what exists on one side alone. */
export function allowedActions(item: Pick<SyncItem, 'kind'>): SyncAction[] {
  if (item.kind === 'onlyLocal') return ['upload', 'deleteLocal', 'skip']
  if (item.kind === 'onlyRemote') return ['download', 'deleteRemote', 'skip']
  return ['upload', 'download', 'skip']
}

/** What a way of synchronising does about a difference, before the user changes anything. */
export function defaultAction(item: Pick<SyncItem, 'kind'>, mode: SyncMode): SyncAction {
  switch (mode) {
    case 'upload':
      return item.kind === 'onlyLocal' || item.kind === 'localNewer' || item.kind === 'different' ? 'upload' : 'skip'
    case 'download':
      return item.kind === 'onlyRemote' || item.kind === 'remoteNewer' || item.kind === 'different' ? 'download' : 'skip'
    case 'both':
      if (item.kind === 'onlyLocal' || item.kind === 'localNewer') return 'upload'
      if (item.kind === 'onlyRemote' || item.kind === 'remoteNewer') return 'download'
      // Same time, other content: nobody can tell which side is right.
      return 'skip'
    case 'mirrorUpload':
      return item.kind === 'onlyRemote' ? 'deleteRemote' : 'upload'
    case 'mirrorDownload':
      return item.kind === 'onlyLocal' ? 'deleteLocal' : 'download'
  }
}

export const isDelete = (action: SyncAction): boolean => action === 'deleteLocal' || action === 'deleteRemote'
