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
  /** How an FTP server spells file names. Missing means UTF-8. */
  ftpEncoding?: FtpEncoding
  /** Reach the server through this other SSH host of the vault (SSH only). */
  jumpHostId?: string
  /** Reach the server through a proxy. Not used together with a jump host. */
  proxy?: ProxyConfig
  /** secret */
  proxyPassword?: string
  /** Folders the user marked in the file manager. */
  bookmarks?: string[]
  /** The folder the file manager showed last. */
  lastPath?: string
  createdAt: number
  updatedAt: number
}

export const PROXY_TYPES = ['socks5', 'http'] as const
export interface ProxyConfig {
  type: (typeof PROXY_TYPES)[number]
  host: string
  port: number
  username?: string
}

export const FTP_ENCODINGS = ['utf8', 'latin1'] as const
export type FtpEncoding = (typeof FTP_ENCODINGS)[number]

/** Host as seen by the renderer: no secrets, only a flag. */
export type HostSummary = Omit<HostRecord, 'password' | 'proxyPassword'> & { hasPassword: boolean; hasProxyPassword: boolean }

/** Input from the host editor. `password: undefined` keeps the stored one, `null` clears it. */
export type HostInput = Omit<HostRecord, 'id' | 'createdAt' | 'updatedAt' | 'password' | 'proxyPassword' | 'bookmarks' | 'lastPath'> & {
  id?: string
  password?: string | null
  proxyPassword?: string | null
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
  transferConcurrency: number
  /** KiB per second, 0 for no limit */
  transferLimitKbps: number
  transferExisting: ExistingRule
  /** Keep modification time and permissions of transferred files. */
  transferPreserve: boolean
  /** Program that opens files for "Open in External Editor". Empty: the text editor of the system. */
  externalEditor: string
  /** Suggest commands, options and paths while typing in a terminal. */
  terminalAutocomplete: boolean
  /** Open the tabs of the last session again after unlocking. */
  restoreSession: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoLockMinutes: 15,
  lockOnSystemLock: true,
  mcpEnabled: false,
  mcpPort: 47821,
  closeToTray: true,
  terminalFontSize: 14,
  autoCheckUpdates: true,
  transferConcurrency: 3,
  transferLimitKbps: 0,
  transferExisting: 'ask',
  transferPreserve: true,
  externalEditor: '',
  terminalAutocomplete: true,
  restoreSession: true
}

export type VaultState = 'uninitialized' | 'locked' | 'unlocked'

export interface RemoteEntry {
  name: string
  path: string
  type: 'file' | 'dir' | 'link' | 'other'
  size: number
  modifiedAt: number
  /** How exact `modifiedAt` is, when it is coarser than a second (plain FTP listings). */
  timePrecision?: 'minute' | 'day'
  permissions?: string
  /** Numeric owner and group (SFTP). */
  uid?: number
  gid?: number
  /** Names of owner and group, where the server tells them. */
  owner?: string
  group?: string
}

/** What a folder holds, with everything inside. */
export interface FolderSize {
  bytes: number
  files: number
  folders: number
  /** Folders that could not be read and are missing from the numbers. */
  unreadable: number
  /** False when the count was stopped early. */
  complete: boolean
}

export interface ChmodOptions {
  /** 0o000 to 0o777 */
  mode: number
  /** Also change what is inside of folders. */
  recursive: boolean
  /** Which of the content of folders is changed. */
  target: 'all' | 'files' | 'folders'
  /** Folders may be opened by whoever may read them, even when `mode` has no "run" bit. */
  foldersOpen: boolean
}

/** Result of a change that went over many items. */
export interface TreeChange {
  changed: number
  failed: { path: string; error: string }[]
  complete: boolean
}

/** News from a running search on the server. */
export interface SearchUpdate {
  token: string
  hits: RemoteEntry[]
  scanned: number
}

export interface SearchResult {
  scanned: number
  found: number
  unreadable: number
  ended: 'complete' | 'limit' | 'stopped'
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

/** What to do when the target of a transfer already exists. */
export const EXISTING_RULES = ['ask', 'overwrite', 'skip', 'rename', 'newer', 'resume'] as const
export type ExistingRule = (typeof EXISTING_RULES)[number]

export type TransferState = 'queued' | 'running' | 'paused' | 'asking' | 'done' | 'failed' | 'cancelled' | 'skipped'

export interface TransferItem {
  id: string
  name: string
  /** Where the file is or goes on the server. */
  remotePath: string
  direction: 'upload' | 'download' | 'copy'
  state: TransferState
  transferred: number
  total: number
  /** bytes per second, 0 while not running */
  speed: number
  /** seconds left, when it can be told */
  eta?: number
  error?: string
}

/** A question to the user: the target of a transfer exists already. */
export interface TransferConflict {
  id: string
  name: string
  direction: 'upload' | 'download'
  /** Full path of the existing file, on the server or on this computer. */
  target: string
  source: { size: number; modifiedAt: number }
  existing: { size: number; modifiedAt: number }
  /** How many more transfers wait for the same kind of answer. */
  waiting: number
}

export type TransferCounts = Record<TransferState, number>

/** The transfer queue as the interface shows it. Long queues are shortened; `counts` is complete. */
export interface TransferSnapshot {
  items: TransferItem[]
  counts: TransferCounts
  /** Entries of the queue that are not in `items`. */
  hidden: number
  bytesDone: number
  bytesTotal: number
  speed: number
  eta?: number
  paused: boolean
  /** Folders are still being read, so the totals will grow. */
  scanning: boolean
  conflict: TransferConflict | null
}

export type QueueAction = 'pause' | 'resume' | 'retry' | 'cancel' | 'top' | 'up' | 'down' | 'bottom'

/** The part of the settings the transfer queue works with. */
export interface TransferSettings {
  transferConcurrency: number
  /** KiB per second, 0 for no limit */
  transferLimitKbps: number
  transferExisting: ExistingRule
  /** Keep modification time and permissions of transferred files. */
  transferPreserve: boolean
}

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  transferConcurrency: 3,
  transferLimitKbps: 0,
  transferExisting: 'ask',
  transferPreserve: true
}

/** A GNU screen session of the logged-in user on a server. */
export interface ScreenInfo {
  /** "1234.minecraft" */
  id: string
  name: string
  /** someone is attached to it right now */
  attached: boolean
  /** when it was started, as the server prints it */
  started?: string
}

export interface ScreenList {
  /** false when screen is not installed on the server */
  installed: boolean
  screens: ScreenInfo[]
}

/** What a terminal tab shows instead of a plain shell. */
export type ScreenTarget = { attach: string } | { create: string }

/** A terminal tab that runs something else than a login shell. The docker ids are container ids. */
export type TerminalTarget = ScreenTarget | { dockerLogs: string } | { dockerShell: string }

// ---- Docker on a server ---------------------------------------------------

export interface DockerContainer {
  /** full hexadecimal id */
  id: string
  name: string
  image: string
  state: 'running' | 'paused' | 'restarting' | 'exited' | 'created' | 'dead' | 'removing'
  /** Docker's own wording, e.g. "Up 3 hours" or "Exited (0) 2 days ago" */
  status: string
  /** e.g. "8080 → 80" */
  ports: string[]
  /** Docker Compose project and service, when the container belongs to one */
  project?: string
  service?: string
}

export interface DockerOverview {
  /** missing: no docker on the server · denied: this user may not use it */
  status: 'ok' | 'missing' | 'denied' | 'error'
  version?: string
  message?: string
  containers: DockerContainer[]
}

export interface DockerStats {
  id: string
  cpu: string
  memory: string
  memoryPercent: string
}

export interface DockerImage {
  id: string
  repository: string
  tag: string
  size: string
  created: string
  /** at least one container was made from it */
  inUse: boolean
}

export type DockerRestartPolicy = 'no' | 'on-failure' | 'unless-stopped' | 'always'
export type DockerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'remove'

/** What the "New Container" form collects. */
export interface DockerCreateSpec {
  /** an image that is on the server, e.g. "nginx:latest" */
  image: string
  name?: string
  ports: { host: number; container: number; protocol: 'tcp' | 'udp'; /** reachable from the server itself only */ localOnly: boolean }[]
  /** folders of the server that the container may use */
  mounts: { source: string; target: string; readOnly: boolean }[]
  env: { name: string; value: string }[]
  restart: DockerRestartPolicy
  /** replaces the command of the image; split at spaces */
  command?: string
  /** start it right away */
  start: boolean
}

export interface DockerPullProgress {
  /** the overview this download belongs to */
  id: string
  image: string
  /** layers finished / layers in total, as far as Docker has announced them */
  done: number
  total: number
  /** Docker's latest line */
  status: string
}

export interface DockerDetails {
  id: string
  name: string
  image: string
  command: string
  created: string
  startedAt: string
  restartPolicy: DockerRestartPolicy
  restartCount: number
  mounts: { source: string; target: string; readOnly: boolean }[]
  networks: { name: string; ip: string }[]
  /** folder of the compose file on the server */
  workingDir?: string
}

export interface MovePair {
  from: string
  to: string
}

export interface MoveResult {
  moved: MovePair[]
  failed: { name: string; error: string }[]
}

export interface CopyResult {
  /** paths of the new top-level items */
  created: string[]
}

/** 'ready': can also be pasted in Explorer or Finder · 'internal': only inside the app · 'too-large': too big for the system clipboard */
export type ClipboardCopyResult = 'ready' | 'internal' | 'too-large'

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
  reason?: 'portable' | 'development' | 'unsigned'
}

/** Identifies the state of a remote file when it was opened, to detect changes by others. */
export interface TextFileVersion {
  size: number
  modifiedAt: number
}

/** Character sets the editor can read and write. The names are the ones `TextDecoder` knows. */
export const TEXT_ENCODINGS = [
  { id: 'utf-8', label: 'UTF-8' },
  { id: 'utf-16le', label: 'UTF-16 LE' },
  { id: 'utf-16be', label: 'UTF-16 BE' },
  { id: 'windows-1252', label: 'Western European (Windows-1252, ISO 8859-1)' },
  { id: 'iso-8859-15', label: 'Western European (ISO 8859-15)' },
  { id: 'macintosh', label: 'Western European (Mac Roman)' },
  { id: 'windows-1250', label: 'Central European (Windows-1250)' },
  { id: 'iso-8859-2', label: 'Central European (ISO 8859-2)' },
  { id: 'windows-1251', label: 'Cyrillic (Windows-1251)' },
  { id: 'koi8-r', label: 'Cyrillic (KOI8-R)' },
  { id: 'ibm866', label: 'Cyrillic (DOS 866)' },
  { id: 'windows-1253', label: 'Greek (Windows-1253)' },
  { id: 'windows-1254', label: 'Turkish (Windows-1254)' },
  { id: 'windows-1257', label: 'Baltic (Windows-1257)' }
] as const
export type TextEncoding = (typeof TEXT_ENCODINGS)[number]['id']
export const TEXT_ENCODING_IDS = TEXT_ENCODINGS.map((e) => e.id) as [TextEncoding, ...TextEncoding[]]

export interface TextFile {
  /** always uses 
 line breaks; `eol` remembers what the file had */
  text: string
  eol: 'lf' | 'crlf' | 'mixed'
  bom: boolean
  encoding: TextEncoding
  /** The file is not UTF-8 and names no character set: `encoding` is a guess the user may correct. */
  guessed?: boolean
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

// ------------------------------------------------------------ synchronisation ----

/** How one item differs between the local folder and the folder on the server. */
export type SyncKind = 'onlyLocal' | 'onlyRemote' | 'localNewer' | 'remoteNewer' | 'different'
export type SyncAction = 'upload' | 'download' | 'deleteLocal' | 'deleteRemote' | 'skip'
/** The mirror modes make the target equal to the source: they also replace newer files and delete. */
export type SyncMode = 'upload' | 'download' | 'both' | 'mirrorUpload' | 'mirrorDownload'

export interface SyncSide {
  size: number
  modifiedAt: number
}

export interface SyncItem {
  /** Path below both folders, with forward slashes. */
  rel: string
  type: 'file' | 'dir'
  kind: SyncKind
  local?: SyncSide
  remote?: SyncSide
}

export interface SyncOptions {
  /** `time`: a file differs when size or modification time differ. `size`: only the size counts. */
  compareBy: 'time' | 'size'
  /** Minutes the clock of the server is ahead of real time; `null` finds it out from the files. */
  offsetMinutes: number | null
}

export interface SyncComparison {
  id: string
  localDir: string
  remoteDir: string
  /** Only what differs. */
  items: SyncItem[]
  /** Files that are equal on both sides. */
  same: number
  /** Left alone, with the reason: links, names that cannot exist on this computer and the like. */
  skipped: { rel: string; reason: string }[]
  /** Folders that could not be read. Nothing inside them is touched. */
  unreadable: string[]
  /** The shift of the server clock that was taken into account. */
  offsetMinutes: number
  /** The shift was found out from the files, not given. */
  offsetDetected: boolean
  /** There were more differences than the list can hold. */
  truncated: boolean
  ended: 'done' | 'stopped'
}

export interface SyncProgress {
  token: string
  scanned: number
}

export interface SyncResult {
  uploaded: number
  downloaded: number
  deleted: number
  cancelled: number
  /** Deletions that were not carried out because transfers were cancelled. */
  deletesSkipped: number
  failed: { rel: string; error: string }[]
}

/** A local folder that is watched; what changes in it is uploaded. */
export interface WatchStatus {
  id: string
  sessionId: string
  localDir: string
  remoteDir: string
  state: 'watching' | 'uploading'
  uploaded: number
  failed: number
  /** The file that was uploaded last. */
  lastName?: string
  lastError?: string
  startedAt: number
}

/** A file session lost its connection and is opening it again. */
export interface ReconnectStatus {
  id: string
  attempt: number
  attempts: number
  /** Why the connection is gone, or why the last attempt failed. */
  error: string
}

/** A file of the server that is open in a program on this computer and uploaded on every save. */
export interface ExternalEditStatus {
  id: string
  sessionId: string
  /** Path on the server. */
  remote: string
  name: string
  /** The local copy the program works on. */
  localPath: string
  /** `conflict`: the file changed on the server, nothing is uploaded until the user decides. */
  state: 'open' | 'uploading' | 'conflict' | 'error'
  uploads: number
  lastError?: string
}

// ---- Terminal suggestions --------------------------------------------------

/** What is known about the place a terminal is in when a line is started. */
export interface CompletionContext {
  /** folder of the shell; empty when the server cannot tell */
  cwd: string
  home: string
  /** a program other than a shell has the terminal: nothing is suggested */
  busy: boolean
}

// ---- Workspaces ------------------------------------------------------------

export type PaneKind = 'terminal' | 'files' | 'docker'

/** One connection inside a tab. */
export interface WorkspacePane {
  hostId: string
  kind: PaneKind
  /** a terminal that shows a screen, a container log or a shell in a container */
  target?: { target: TerminalTarget; name: string }
  /** the folder a terminal was in, so that it can start there again */
  cwd?: string
}

/** The arrangement of the panes; the leaves are indexes into `panes`. */
export type WorkspaceLayout = { pane: number } | { dir: 'row' | 'col'; ratio: number; a: WorkspaceLayout; b: WorkspaceLayout }

/** A tab with everything needed to open it again the way it was. */
export interface WorkspaceTab {
  name?: string
  panes: WorkspacePane[]
  layout: WorkspaceLayout
  /** index of the pane that had the keyboard */
  focus: number
  /** focus mode: only the focused pane is shown */
  zoomed: boolean
  /** the saved workspace this tab was opened from */
  workspaceId?: string
}

export interface SavedWorkspace extends WorkspaceTab {
  id: string
  name: string
  updatedAt: number
}

/** The open tabs, written while working and read after the next unlock. */
export interface SessionSnapshot {
  tabs: WorkspaceTab[]
  /** index of the visible tab, -1 for a page of the library */
  active: number
}
