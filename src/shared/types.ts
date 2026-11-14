// Types shared between the main process and the renderer.
// Anything marked "secret" never leaves the main process.

export type Protocol = 'ssh' | 'ftps' | 'ftps-implicit' | 'ftp'
export type AuthMethod = 'password' | 'key' | 'agent' | 'keyboard-interactive'
/** What an AI client (via MCP) may do on a host. */
export type AiAccess = 'none' | 'read' | 'full'
/** Which AI actions require a click on "Allow" in the Clavium window. */
export type AiConfirm = 'all' | 'changes' | 'none'

export interface PortForward {
  id: string
  /** Bound on 127.0.0.1 only. */
  localPort: number
  remoteHost: string
  remotePort: number
}

/** Host as stored inside the encrypted vault (main process only). */
export interface HostRecord {
  id: string
  name: string
  group: string
  protocol: Protocol
  hostname: string
  port: number
  username: string
  authMethod: AuthMethod
  /** secret */
  password?: string
  keyId?: string
  allowLegacyAlgorithms: boolean
  aiAccess: AiAccess
  aiConfirm: AiConfirm
  notes: string
  forwards: PortForward[]
  createdAt: number
  updatedAt: number
}

/** Host as seen by the renderer: no secrets, only a flag. */
export type HostSummary = Omit<HostRecord, 'password'> & { hasPassword: boolean }

/** Input from the host editor. `password: undefined` keeps the stored one, `null` clears it. */
export type HostInput = Omit<HostRecord, 'id' | 'createdAt' | 'updatedAt' | 'password'> & {
  id?: string
  password?: string | null
}

export interface SshKeyRecord {
  id: string
  name: string
  type: string
  publicKey: string
  fingerprint: string
  /** secret: OpenSSH/PEM private key text */
  privateKey: string
  /** secret */
  passphrase?: string
  createdAt: number
}

export type SshKeySummary = Omit<SshKeyRecord, 'privateKey' | 'passphrase'> & { encrypted: boolean }

export interface KnownHost {
  /** e.g. "ssh:example.com:22" or "ftps:example.com:21" */
  id: string
  keyType: string
  /** "SHA256:..." */
  fingerprint: string
  addedAt: number
}

export interface AppSettings {
  /** 0 disables auto-lock. */
  autoLockMinutes: number
  lockOnSystemLock: boolean
  mcpEnabled: boolean
  mcpPort: number
  /** sha256 hex of the current MCP token; used only while the vault is locked. */
  mcpTokenHash?: string
  closeToTray: boolean
  terminalFontSize: number
  /** Ask GitHub for a newer release on start and twice a day. */
  autoCheckUpdates: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoLockMinutes: 15,
  lockOnSystemLock: true,
  mcpEnabled: false,
  mcpPort: 47821,
  closeToTray: true,
  terminalFontSize: 14,
  autoCheckUpdates: true
}

export type VaultState = 'uninitialized' | 'locked' | 'unlocked'

export interface RemoteEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  modifiedAt: number
  permissions?: string
}

export interface AuditEntry {
  ts: number
  source: 'mcp' | 'app'
  action: string
  hostId?: string
  hostName?: string
  detail: string
  result: 'ok' | 'denied' | 'error'
}

export interface TransferProgress {
  transferId: string
  name: string
  direction: 'upload' | 'download'
  transferred: number
  total: number
  done: boolean
  error?: string
}

// ---- prompts the main process asks the user to answer -------------------

export type PromptRequest =
  | {
      kind: 'hostKey'
      id: string
      host: string
      keyType: string
      fingerprint: string
      /** set when a different key was stored before -> possible MITM */
      previousFingerprint?: string
    }
  | {
      kind: 'keyboardInteractive'
      id: string
      host: string
      name: string
      instructions: string
      prompts: { prompt: string; echo: boolean }[]
    }
  | {
      kind: 'mcpConfirm'
      id: string
      hostName: string
      tool: string
      summary: string
      detail: string
      destructive: boolean
      timeoutMs: number
    }

export type PromptResponse =
  | { kind: 'hostKey'; accept: boolean }
  | { kind: 'keyboardInteractive'; answers: string[] | null }
  | { kind: 'mcpConfirm'; allow: boolean }

export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  hasToken: boolean
  error?: string
}

export interface ActiveForward {
  hostId: string
  forwardId: string
  localPort: number
  remoteHost: string
  remotePort: number
}

export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'verifying' | 'ready' | 'error'
  currentVersion: string
  /** version offered / being downloaded / ready to install */
  version?: string
  /** download progress in percent */
  progress?: number
  error?: string
  checkedAt?: number
  /** why updates are unsupported */
  reason?: 'portable' | 'development'
}

/** Identifies the state of a remote file when it was opened, to detect changes by others. */
export interface TextFileVersion {
  size: number
  modifiedAt: number
}

export interface TextFile {
  /** always uses 
 line breaks; `eol` remembers what the file had */
  text: string
  eol: 'lf' | 'crlf' | 'mixed'
  bom: boolean
  version: TextFileVersion
}

export type TextWriteResult = { saved: true; version: TextFileVersion } | { saved: false; conflict: 'changed' | 'deleted' }

// ---- editor <-> MCP -------------------------------------------------------

/** A file that is open in the built-in editor. */
export interface EditorFileInfo {
  hostId: string
  path: string
  name: string
  /** has changes that are not saved to the server yet */
  unsaved: boolean
}

/** A change an AI client wants to make to the text in the editor (never saved automatically). */
export type EditorEdit = { kind: 'replace'; oldText: string; newText: string; all: boolean } | { kind: 'all'; newText: string }

export type EditorRequest =
  | { op: 'list' }
  | { op: 'open'; hostId: string; path: string }
  | { op: 'read'; hostId: string; path: string }
  | { op: 'edit'; hostId: string; path: string; edit: EditorEdit }
