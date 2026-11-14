import type { AppInfo, EventChannel, InvokeChannel, McpSnippets } from '@shared/ipc'
import type {
  ActiveForward,
  AppSettings,
  AuditEntry,
  HostInput,
  HostSummary,
  KnownHost,
  McpStatus,
  PromptResponse,
  RemoteEntry,
  SshKeySummary,
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
    open: (hostId: string, cols: number, rows: number) => call<string>('term:open', hostId, cols, rows),
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
    remove: (id: string, path: string, recursive: boolean) => call<void>('files:remove', id, path, recursive),
    download: (id: string, entries: RemoteEntry[]) => call<boolean>('files:download', id, entries),
    upload: (id: string, dir: string, kind: 'files' | 'folder') => call<boolean>('files:upload', id, dir, kind),
    uploadPaths: (id: string, dir: string, paths: string[]) => call<boolean>('files:uploadPaths', id, dir, paths),
    close: (id: string) => call<void>('files:close', id)
  },
  fwd: {
    list: () => call<ActiveForward[]>('fwd:list'),
    start: (hostId: string, fwdId: string) => call<void>('fwd:start', hostId, fwdId),
    stop: (hostId: string, fwdId: string) => call<void>('fwd:stop', hostId, fwdId)
  },
  prompt: {
    respond: (id: string, r: PromptResponse) => call<void>('prompt:respond', id, r)
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
