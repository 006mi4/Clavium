import type { AppInfo, EventChannel, InvokeChannel, McpSnippets } from '@shared/ipc'
import type { CompletionNeed } from '@shared/complete'
import type {
  ActiveForward,
  CompletionContext,
  SavedWorkspace,
  SessionSnapshot,
  WorkspaceTab,
  AppSettings,
  AuditEntry,
  ClipboardCopyResult,
  DockerAction,
  DockerCreateSpec,
  DockerDetails,
  DockerImage,
  DockerOverview,
  DockerRestartPolicy,
  ChmodOptions,
  DockerStats,
  ExistingRule,
  ExternalEditStatus,
  FolderSize,
  CopyResult,
  HostInput,
  HostSummary,
  KnownHost,
  McpStatus,
  MovePair,
  MoveResult,
  PromptResponse,
  QueueAction,
  RemoteEntry,
  ScreenList,
  SearchResult,
  SyncAction,
  SyncComparison,
  SyncOptions,
  SyncResult,
  WatchStatus,
  TerminalTarget,
  SshKeySummary,
  TextEncoding,
  TextFile,
  TextFileVersion,
  TextWriteResult,
  TransferSnapshot,
  TreeChange,
  UpdateState,
  VaultState
} from '@shared/types'

export type UiSettings = Omit<AppSettings, 'mcpTokenHash'>

async function call<T>(channel: InvokeChannel, ...args: unknown[]): Promise<T> {
  try {
    return (await window.clavium.invoke(channel, ...args)) as T
  } catch (e) {
    // "Error invoking remote method 'x': Error: message" -> "message"
    const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
    throw new Error(msg)
  }
}

export function on(channel: EventChannel, fn: (...args: never[]) => void): () => void {
  return window.clavium.on(channel, fn as (...args: unknown[]) => void)
}

export const api = {
  vault: {
    state: () => call<VaultState>('vault:state'),
    create: (pw: string) => call<void>('vault:create', pw),
    unlock: (pw: string) => call<void>('vault:unlock', pw),
    lock: () => call<void>('vault:lock'),
    /** false when the file dialog was cancelled */
    exportBackup: () => call<boolean>('vault:export'),
    importBackup: () => call<boolean>('vault:import'),
    changePassword: (oldPw: string, newPw: string) => call<void>('vault:changePassword', oldPw, newPw)
  },
  hosts: {
    list: () => call<HostSummary[]>('hosts:list'),
    save: (h: HostInput) => call<HostSummary>('hosts:save', h),
    setBookmarks: (id: string, paths: string[]) => call<void>('hosts:setBookmarks', id, paths),
    rememberPath: (id: string, path: string) => call<void>('hosts:rememberPath', id, path),
    remove: (id: string) => call<void>('hosts:delete', id),
    duplicate: (id: string) => call<HostSummary>('hosts:duplicate', id)
  },
  keys: {
    list: () => call<SshKeySummary[]>('keys:list'),
    importFile: (name: string, passphrase: string) => call<SshKeySummary | null>('keys:importFile', name, passphrase),
    importText: (name: string, text: string, passphrase: string) =>
      call<SshKeySummary>('keys:importText', name, text, passphrase),
    generate: (name: string, type: 'ed25519' | 'ecdsa' | 'rsa', passphrase: string) =>
      call<SshKeySummary>('keys:generate', name, type, passphrase),
    remove: (id: string) => call<void>('keys:delete', id)
  },
  knownHosts: {
    list: () => call<KnownHost[]>('knownHosts:list'),
    remove: (id: string) => call<void>('knownHosts:remove', id)
  },
  settings: {
    pickProgram: () => call<string | null>('settings:pickProgram'),
    get: () => call<UiSettings>('settings:get'),
    set: (patch: Partial<UiSettings>) => call<UiSettings>('settings:set', patch)
  },
  mcp: {
    status: () => call<McpStatus>('mcp:status'),
    token: () => call<string>('mcp:token'),
    regenerate: () => call<string>('mcp:regenerate'),
    snippets: () => call<McpSnippets>('mcp:snippets')
  },
  term: {
    open: (hostId: string, cols: number, rows: number, target?: TerminalTarget) => call<string>('term:open', hostId, cols, rows, target),
    hasDocker: (id: string) => call<boolean>('term:hasDocker', id),
    screens: (id: string) => call<ScreenList>('term:screens', id),
    endScreen: (id: string, screenId: string) => call<void>('term:endScreen', id, screenId),
    completeContext: (id: string) => call<CompletionContext>('term:completeContext', id),
    completeList: (id: string, need: CompletionNeed) => call<string[]>('term:completeList', id, need),
    completeHistory: (id: string) => call<string[]>('term:completeHistory', id),
    write: (id: string, data: string) => call<void>('term:write', id, data),
    resize: (id: string, cols: number, rows: number) => call<void>('term:resize', id, cols, rows),
    close: (id: string) => call<void>('term:close', id)
  },
  docker: {
    open: (hostId: string) => call<string>('docker:open', hostId),
    overview: (id: string) => call<DockerOverview>('docker:overview', id),
    stats: (id: string) => call<DockerStats[]>('docker:stats', id),
    images: (id: string) => call<DockerImage[]>('docker:images', id),
    inspect: (id: string, container: string) => call<DockerDetails>('docker:inspect', id, container),
    action: (id: string, action: DockerAction, containers: string[]) => call<void>('docker:action', id, action, containers),
    restartPolicy: (id: string, container: string, policy: DockerRestartPolicy) => call<void>('docker:restartPolicy', id, container, policy),
    removeImage: (id: string, image: string) => call<void>('docker:removeImage', id, image),
    pull: (id: string, image: string) => call<void>('docker:pull', id, image),
    create: (id: string, spec: DockerCreateSpec) => call<string>('docker:create', id, spec),
    close: (id: string) => call<void>('docker:close', id)
  },
  files: {
    open: (hostId: string) => call<string>('files:open', hostId),
    home: (id: string) => call<string>('files:home', id),
    list: (id: string, path: string) => call<RemoteEntry[]>('files:list', id, path),
    mkdir: (id: string, path: string) => call<void>('files:mkdir', id, path),
    rename: (id: string, from: string, to: string) => call<void>('files:rename', id, from, to),
    stat: (id: string, path: string) => call<RemoteEntry>('files:stat', id, path),
    createFile: (id: string, path: string) => call<void>('files:createFile', id, path),
    readText: (id: string, path: string, encoding?: TextEncoding) => call<TextFile>('files:readText', id, path, encoding ?? null),
    writeText: (id: string, path: string, file: Pick<TextFile, 'text' | 'eol' | 'bom' | 'encoding'>, expected: TextFileVersion, force: boolean) =>
      call<TextWriteResult>('files:writeText', id, path, file, expected, force),
    remove: (id: string, path: string, recursive: boolean) => call<void>('files:remove', id, path, recursive),
    download: (id: string, entries: RemoteEntry[]) => call<boolean>('files:download', id, entries),
    pickLocal: (kind: 'files' | 'folder' | 'sync') => call<string[]>('files:pickLocal', kind),
    move: (id: string, pairs: MovePair[]) => call<MoveResult>('files:move', id, pairs),
    copy: (srcId: string, entries: RemoteEntry[], dstId: string, dir: string) => call<CopyResult>('files:copy', srcId, entries, dstId, dir),
    clipboardCopy: (id: string, entries: RemoteEntry[], forWindows: boolean) =>
      call<ClipboardCopyResult>('files:clipboardCopy', id, entries, forWindows),
    clipboardFiles: () => call<string[]>('files:clipboardFiles'),
    dragOut: (id: string, entries: RemoteEntry[]) => call<string | null>('files:dragOut', id, entries),
    dragCancel: () => call<void>('files:dragCancel'),
    chmodTree: (id: string, entries: RemoteEntry[], options: ChmodOptions, token: string) => call<TreeChange>('files:chmodTree', id, entries, options, token),
    chownTree: (id: string, entries: RemoteEntry[], owner: { uid?: number; gid?: number }, recursive: boolean, token: string) =>
      call<TreeChange>('files:chownTree', id, entries, owner, recursive, token),
    folderSize: (id: string, entries: RemoteEntry[], token: string) => call<FolderSize>('files:folderSize', id, entries, token),
    search: (id: string, root: string, query: string, token: string) => call<SearchResult>('files:search', id, root, query, token),
    cancelWork: (token: string) => call<void>('files:cancelWork', token),
    syncCompare: (id: string, remoteDir: string, localDir: string, options: SyncOptions, token: string) =>
      call<SyncComparison>('files:syncCompare', id, remoteDir, localDir, options, token),
    syncApply: (planId: string, chosen: { rel: string; action: SyncAction }[], confirmedDeletes: number) =>
      call<SyncResult>('files:syncApply', planId, chosen, confirmedDeletes),
    watchStart: (id: string, remoteDir: string, localDir: string) => call<WatchStatus>('files:watchStart', id, remoteDir, localDir),
    watchStop: (watchId: string) => call<void>('files:watchStop', watchId),
    watchList: () => call<WatchStatus[]>('files:watchList'),
    readImage: (id: string, path: string) => call<{ dataUrl: string; size: number }>('files:readImage', id, path),
    externalEdit: (id: string, entry: RemoteEntry) => call<ExternalEditStatus>('files:externalEdit', id, entry),
    externalUpload: (editId: string) => call<void>('files:externalUpload', editId),
    externalStop: (editId: string) => call<void>('files:externalStop', editId),
    externalList: () => call<ExternalEditStatus[]>('files:externalList'),
    queue: () => call<TransferSnapshot>('files:queueGet'),
    queueAction: (action: QueueAction, transferId?: string) => call<void>('files:queueAction', action, transferId ?? null),
    queueAnswer: (transferId: string, rule: Exclude<ExistingRule, 'ask'>, all: boolean) => call<void>('files:queueAnswer', transferId, rule, all),
    queueClear: () => call<void>('files:queueClear'),
    uploadPaths: (id: string, dir: string, paths: string[]) => call<boolean>('files:uploadPaths', id, dir, paths),
    close: (id: string) => call<void>('files:close', id)
  },
  workspaces: {
    list: () => call<SavedWorkspace[]>('workspace:list'),
    /** creates a workspace, or replaces the one with `id` */
    save: (name: string, tab: WorkspaceTab, id?: string) => call<SavedWorkspace>('workspace:save', name, tab, id ?? null),
    remove: (id: string) => call<void>('workspace:delete', id)
  },
  session: {
    get: () => call<SessionSnapshot | null>('session:get'),
    set: (snapshot: SessionSnapshot) => call<void>('session:set', snapshot)
  },
  fwd: {
    list: () => call<ActiveForward[]>('fwd:list'),
    start: (hostId: string, fwdId: string) => call<void>('fwd:start', hostId, fwdId),
    stop: (hostId: string, fwdId: string) => call<void>('fwd:stop', hostId, fwdId)
  },
  editor: {
    respond: (id: string, ok: boolean, payload: unknown) => call<void>('editor:respond', id, ok, payload)
  },
  prompt: {
    respond: (id: string, r: PromptResponse) => call<void>('prompt:respond', id, r)
  },
  update: {
    state: () => call<UpdateState>('update:state'),
    check: () => call<UpdateState>('update:check'),
    download: () => call<UpdateState>('update:download'),
    install: () => call<void>('update:install')
  },
  audit: { list: (limit = 300) => call<AuditEntry[]>('audit:list', limit) },
  app: {
    info: () => call<AppInfo>('app:info'),
    openExternal: (url: string) => call<void>('app:openExternal', url)
  },
  clipboard: {
    read: () => call<string>('clipboard:read'),
    write: (t: string) => call<void>('clipboard:write', t)
  }
}

export function hostToInput(h: HostSummary): HostInput {
  const { hasPassword: _p, hasProxyPassword: _pp, createdAt: _c, updatedAt: _u, bookmarks: _b, lastPath: _l, ...rest } = h
  return { ...rest, password: undefined, proxyPassword: undefined }
}
