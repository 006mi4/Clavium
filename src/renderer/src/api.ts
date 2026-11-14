import type { AppInfo, EventChannel, InvokeChannel, McpSnippets } from '@shared/ipc'
import type {
  ActiveForward,
  AppSettings,
  AuditEntry,
  ClipboardCopyResult,
  CopyResult,
  HostInput,
  HostSummary,
  KnownHost,
  McpStatus,
  MovePair,
  MoveResult,
  PromptResponse,
  RemoteEntry,
  ScreenList,
  ScreenTarget,
  SshKeySummary,
  TextFile,
  TextFileVersion,
  TextWriteResult,
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
    open: (hostId: string, cols: number, rows: number, screen?: ScreenTarget) => call<string>('term:open', hostId, cols, rows, screen),
    screens: (id: string) => call<ScreenList>('term:screens', id),
    endScreen: (id: string, screenId: string) => call<void>('term:endScreen', id, screenId),
    write: (id: string, data: string) => call<void>('term:write', id, data),
    resize: (id: string, cols: number, rows: number) => call<void>('term:resize', id, cols, rows),
    close: (id: string) => call<void>('term:close', id)
  },
  files: {
    open: (hostId: string) => call<string>('files:open', hostId),
    home: (id: string) => call<string>('files:home', id),
    list: (id: string, path: string) => call<RemoteEntry[]>('files:list', id, path),
    mkdir: (id: string, path: string) => call<void>('files:mkdir', id, path),
    rename: (id: string, from: string, to: string) => call<void>('files:rename', id, from, to),
    stat: (id: string, path: string) => call<RemoteEntry>('files:stat', id, path),
    createFile: (id: string, path: string) => call<void>('files:createFile', id, path),
    readText: (id: string, path: string) => call<TextFile>('files:readText', id, path),
    writeText: (id: string, path: string, file: Pick<TextFile, 'text' | 'eol' | 'bom'>, expected: TextFileVersion, force: boolean) =>
      call<TextWriteResult>('files:writeText', id, path, file, expected, force),
    remove: (id: string, path: string, recursive: boolean) => call<void>('files:remove', id, path, recursive),
    download: (id: string, entries: RemoteEntry[]) => call<boolean>('files:download', id, entries),
    pickLocal: (kind: 'files' | 'folder') => call<string[]>('files:pickLocal', kind),
    uploadConflicts: (id: string, dir: string, paths: string[]) => call<string[]>('files:uploadConflicts', id, dir, paths),
    move: (id: string, pairs: MovePair[]) => call<MoveResult>('files:move', id, pairs),
    copy: (srcId: string, entries: RemoteEntry[], dstId: string, dir: string) => call<CopyResult>('files:copy', srcId, entries, dstId, dir),
    clipboardCopy: (id: string, entries: RemoteEntry[], forWindows: boolean) =>
      call<ClipboardCopyResult>('files:clipboardCopy', id, entries, forWindows),
    clipboardFiles: () => call<string[]>('files:clipboardFiles'),
    dragOut: (id: string, entries: RemoteEntry[]) => call<string | null>('files:dragOut', id, entries),
    dragCancel: () => call<void>('files:dragCancel'),
    chmod: (id: string, path: string, mode: number) => call<void>('files:chmod', id, path, mode),
    cancelTransfer: (transferId: string) => call<void>('files:cancelTransfer', transferId),
    cancelAll: () => call<void>('files:cancelAll'),
    uploadPaths: (id: string, dir: string, paths: string[]) => call<boolean>('files:uploadPaths', id, dir, paths),
    close: (id: string) => call<void>('files:close', id)
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
  const { hasPassword: _p, createdAt: _c, updatedAt: _u, ...rest } = h
  return { ...rest, password: undefined }
}
