import { readFile } from 'node:fs/promises'
import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AppInfo, InvokeChannel } from '@shared/ipc'
import { FTP_ENCODINGS, PROXY_TYPES, TEXT_ENCODING_IDS, type HostRecord, type HostSummary, type PromptResponse, type RemoteEntry, type SavedWorkspace, type WorkspaceLayout } from '@shared/types'
import { DYNAMIC_KINDS } from '@shared/completeSpecs'
import { MAX_PANES, panes as layoutPanes } from '@shared/layout'
import type { AuditLog } from './core/audit'
import { randomId } from './core/crypto'
import { buildKeyRecord, generateKey, summarizeKey } from './core/keys'
import { settingsSchema, type SettingsStore } from './core/settings'
import { MAX_TEXT_BYTES, readTextFile, writeTextFile } from './core/textfile'
import type { Vault } from './core/vault'
import { CONTAINER_ACTIONS, RESTART_POLICIES } from './core/docker'
import type { DockerManager } from './docker'
import type { MonitorManager } from './monitor'
import type { FileManager } from './files'
import type { ForwardManager } from './forwards'
import type { WindowEditorBridge } from './editorBridge'
import type { McpController } from './mcpController'
import type { UiPrompter } from './prompts'
import type { TerminalManager } from './terminals'
import type { Updater } from './updater'

export const REPO_URL = 'https://github.com/006mi4/Clavium'

export interface IpcContext {
  window: () => BrowserWindow | null
  vault: Vault
  settings: SettingsStore
  audit: AuditLog
  prompter: UiPrompter
  mcp: McpController
  terminals: TerminalManager
  files: FileManager
  docker: DockerManager
  monitor: MonitorManager
  /** picture shown next to the pointer while files are dragged out of the window */
  dragIcon: () => Electron.NativeImage
  forwards: ForwardManager
  updater: Updater
  editor: WindowEditorBridge
}

// ------------------------------------------------------------ schemas ----

const id = z.string().min(1).max(64)
const remotePath = z.string().min(1).max(4096)

const forwardSchema = z.object({
  id: id,
  localPort: z.number().int().min(1).max(65535),
  remoteHost: z.string().trim().min(1).max(255),
  remotePort: z.number().int().min(1).max(65535)
})

const hostInputSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(100),
  group: z.string().trim().max(100),
  protocol: z.enum(['ssh', 'ftps', 'ftps-implicit', 'ftp']),
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[^\s/@\\]+$/, 'Invalid host name'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().max(255),
  authMethod: z.enum(['password', 'key', 'agent', 'keyboard-interactive']),
  password: z.string().max(4096).nullable().optional(),
  keyId: id.optional(),
  allowLegacyAlgorithms: z.boolean(),
  aiAccess: z.enum(['none', 'read', 'full']),
  aiConfirm: z.enum(['all', 'changes', 'none']),
  notes: z.string().max(10_000),
  forwards: z.array(forwardSchema).max(50),
  ftpEncoding: z.enum(FTP_ENCODINGS).optional(),
  jumpHostId: id.optional(),
  proxy: z
    .object({
      type: z.enum(PROXY_TYPES),
      host: z.string().trim().min(1).max(255).regex(/^[^\s/@\\]+$/, 'Invalid proxy host name'),
      port: z.number().int().min(1).max(65535),
      username: z.string().max(255).optional()
    })
    .strict()
    .optional(),
  proxyPassword: z.string().max(255).nullable().optional()
})

const entrySchema = z.object({
  name: z.string().max(1024),
  path: remotePath,
  type: z.enum(['file', 'dir', 'link', 'other']),
  size: z.number(),
  modifiedAt: z.number(),
  timePrecision: z.enum(['minute', 'day']).optional(),
  permissions: z.string().max(20).optional(),
  uid: z.number().int().min(0).optional(),
  gid: z.number().int().min(0).optional(),
  owner: z.string().max(64).optional(),
  group: z.string().max(64).optional()
})

const promptResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hostKey'), accept: z.boolean() }),
  z.object({ kind: z.literal('keyboardInteractive'), answers: z.array(z.string().max(4096)).max(20).nullable() }),
  z.object({ kind: z.literal('mcpConfirm'), allow: z.boolean() })
])

// ------------------------------------------------------------- helpers ----

export function summarizeHost(h: HostRecord): HostSummary {
  const { password, proxyPassword, ...rest } = h
  return { ...rest, hasPassword: !!password, hasProxyPassword: !!proxyPassword }
}

export function registerIpc(ctx: IpcContext): void {
  const handle = <S extends z.ZodTuple>(
    channel: InvokeChannel,
    schema: S,
    fn: (...args: z.infer<S>) => unknown
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
      const win = ctx.window()
      // Only our own window may talk to the main process.
      if (!win || event.sender.id !== win.webContents.id) throw new Error('Unauthorized IPC sender')
      const parsed = schema.safeParse(raw)
      if (!parsed.success) throw new Error(`Invalid arguments for ${channel}`)
      return fn(...(parsed.data as z.infer<S>))
    })
  }
  const host = (hostId: string): HostRecord => {
    const h = ctx.vault.data.hosts.find((x) => x.id === hostId)
    if (!h) throw new Error('Host not found')
    return h
  }

  // vault
  handle('vault:state', z.tuple([]), () => ctx.vault.state())
  handle('vault:create', z.tuple([z.string().max(1024)]), (pw) => ctx.vault.create(pw))
  handle('vault:unlock', z.tuple([z.string().max(1024)]), (pw) => ctx.vault.unlock(pw))
  handle('vault:lock', z.tuple([]), () => ctx.vault.lock())
  handle('vault:export', z.tuple([]), async () => {
    const win = ctx.window()
    if (!win) return false
    const r = await dialog.showSaveDialog(win, {
      title: 'Back up vault',
      defaultPath: `Clavium-backup-${new Date().toISOString().slice(0, 10)}.clavium-vault`,
      filters: [{ name: 'Clavium vault backup', extensions: ['clavium-vault'] }]
    })
    if (r.canceled || !r.filePath) return false
    await ctx.vault.exportTo(r.filePath)
    return true
  })
  handle('vault:import', z.tuple([]), async () => {
    const win = ctx.window()
    if (!win) return false
    const r = await dialog.showOpenDialog(win, {
      title: 'Restore vault from backup',
      properties: ['openFile'],
      filters: [
        { name: 'Clavium vault backup', extensions: ['clavium-vault', 'json'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (r.canceled || !r.filePaths[0]) return false
    await ctx.vault.importFrom(r.filePaths[0])
    return true
  })
  handle('vault:changePassword', z.tuple([z.string().max(1024), z.string().max(1024)]), (o, n) =>
    ctx.vault.changePassword(o, n)
  )

  // hosts
  handle('hosts:list', z.tuple([]), () => ctx.vault.data.hosts.map(summarizeHost))
  handle('hosts:save', z.tuple([hostInputSchema]), async (input) => {
    const now = Date.now()
    return ctx.vault.update((d) => {
      const existing = input.id ? d.hosts.find((h) => h.id === input.id) : undefined
      if (input.authMethod === 'key' && input.keyId && !d.keys.some((k) => k.id === input.keyId)) {
        throw new Error('Selected key does not exist')
      }
      const { password, proxyPassword, id: _ignored, ...fields } = input
      if (fields.jumpHostId) {
        const jump = d.hosts.find((h) => h.id === fields.jumpHostId)
        if (!jump || jump.protocol !== 'ssh') throw new Error('The jump host must be an SSH host of this vault')
        if (fields.protocol !== 'ssh') throw new Error('Only SSH hosts can be reached through a jump host')
        if (jump.id === existing?.id) throw new Error('A host cannot be its own jump host')
        fields.proxy = undefined
      }
      const record: HostRecord = {
        ...fields,
        id: existing?.id ?? randomId(),
        password: password === undefined ? existing?.password : password === null ? undefined : password,
        proxyPassword: !fields.proxy ? undefined : proxyPassword === undefined ? existing?.proxyPassword : proxyPassword === null ? undefined : proxyPassword,
        bookmarks: existing?.bookmarks,
        lastPath: existing?.lastPath,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      d.hosts = existing ? d.hosts.map((h) => (h.id === record.id ? record : h)) : [...d.hosts, record]
      return summarizeHost(record)
    })
  })
  // What the file manager remembers per host. Kept in the vault: folder names can tell a lot.
  const storedPath = remotePath.regex(/^[^\r\n\0]+$/)
  handle('hosts:setBookmarks', z.tuple([id, z.array(storedPath).max(200)]), (hostId, paths) =>
    ctx.vault.update((d) => {
      const h = d.hosts.find((x) => x.id === hostId)
      if (h) h.bookmarks = [...new Set(paths)]
    })
  )
  handle('hosts:rememberPath', z.tuple([id, storedPath]), async (hostId, path) => {
    const h = ctx.vault.data.hosts.find((x) => x.id === hostId)
    if (h && h.lastPath !== path) await ctx.vault.update(() => void (h.lastPath = path))
  })
  handle('hosts:delete', z.tuple([id]), (hostId) =>
    ctx.vault.update((d) => {
      // Hosts that went through the deleted one connect directly again, and say so by failing or not.
      d.hosts = d.hosts.filter((h) => h.id !== hostId).map((h) => (h.jumpHostId === hostId ? { ...h, jumpHostId: undefined } : h))
    })
  )
  handle('hosts:duplicate', z.tuple([id]), (hostId) =>
    ctx.vault.update((d) => {
      const src = d.hosts.find((h) => h.id === hostId)
      if (!src) throw new Error('Host not found')
      const now = Date.now()
      const copy: HostRecord = {
        ...structuredClone(src),
        id: randomId(),
        name: `${src.name} (copy)`,
        createdAt: now,
        updatedAt: now
      }
      d.hosts.push(copy)
      return summarizeHost(copy)
    })
  )

  // keys
  handle('keys:list', z.tuple([]), () => ctx.vault.data.keys.map(summarizeKey))
  handle('keys:importFile', z.tuple([z.string().max(100), z.string().max(1024)]), async (name, passphrase) => {
    const win = ctx.window()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, {
      title: 'Import private key',
      properties: ['openFile', 'showHiddenFiles'],
      defaultPath: app.getPath('home') + '/.ssh'
    })
    if (r.canceled || !r.filePaths[0]) return null
    const text = await readFile(r.filePaths[0], 'utf8')
    if (text.length > 64 * 1024) throw new Error('File is too large to be a private key')
    const rec = buildKeyRecord(name || r.filePaths[0].split(/[\\/]/).pop() || 'key', text, passphrase)
    await ctx.vault.update((d) => d.keys.push(rec))
    return summarizeKey(rec)
  })
  handle('keys:importText', z.tuple([z.string().max(100), z.string().max(64 * 1024), z.string().max(1024)]), async (name, text, pass) => {
    const rec = buildKeyRecord(name, text, pass)
    await ctx.vault.update((d) => d.keys.push(rec))
    return summarizeKey(rec)
  })
  handle('keys:generate', z.tuple([z.string().max(100), z.enum(['ed25519', 'ecdsa', 'rsa']), z.string().max(1024)]), async (name, type, pass) => {
    const rec = generateKey(name, type, pass)
    await ctx.vault.update((d) => d.keys.push(rec))
    return summarizeKey(rec)
  })
  handle('keys:delete', z.tuple([id]), (keyId) =>
    ctx.vault.update((d) => {
      if (d.hosts.some((h) => h.authMethod === 'key' && h.keyId === keyId)) {
        throw new Error('This key is still used by at least one host')
      }
      d.keys = d.keys.filter((k) => k.id !== keyId)
    })
  )

  // known hosts
  handle('knownHosts:list', z.tuple([]), () => ctx.vault.data.knownHosts)
  handle('knownHosts:remove', z.tuple([z.string().max(300)]), (khId) =>
    ctx.vault.update((d) => {
      d.knownHosts = d.knownHosts.filter((k) => k.id !== khId)
    })
  )

  // settings (the token hash is managed by the main process only)
  handle('settings:get', z.tuple([]), () => {
    const { mcpTokenHash: _h, ...rest } = ctx.settings.get()
    return rest
  })
  handle('settings:pickProgram', z.tuple([]), async () => {
    const win = ctx.window()
    if (!win) return null
    const r = await dialog.showOpenDialog(win, { title: 'Choose the editor', properties: ['openFile'], ...(process.platform === 'darwin' ? { defaultPath: '/Applications' } : {}) })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  handle('settings:set', z.tuple([settingsSchema.omit({ mcpTokenHash: true }).partial()]), async (patch) => {
    await ctx.settings.set(patch)
    await ctx.mcp.apply()
    const { mcpTokenHash: _h, ...rest } = ctx.settings.get()
    return rest
  })

  // mcp
  handle('mcp:status', z.tuple([]), () => ctx.mcp.status())
  handle('mcp:token', z.tuple([]), () => ctx.mcp.token())
  handle('mcp:regenerate', z.tuple([]), () => ctx.mcp.regenerate())
  handle('mcp:snippets', z.tuple([]), () => ctx.mcp.snippets())

  // terminals
  const cols = z.number().int().min(2).max(1000)
  const rows = z.number().int().min(2).max(500)
  const screenId = z.string().min(3).max(200).regex(/^\d+\.[^\r\n\0\t]+$/)
  const containerId = z.string().regex(/^(sha256:)?[0-9a-f]{12,64}$/)
  const screenTarget = z.union([
    z.object({ attach: screenId }).strict(),
    z.object({ create: z.string().min(1).max(40) }).strict(),
    z.object({ dockerLogs: containerId }).strict(),
    z.object({ dockerShell: containerId }).strict()
  ])
  // a folder on a server, as the server itself reported it
  const remoteDir = z.string().min(1).max(4096).regex(/^\/[^\0\r\n]*$/)
  handle('term:open', z.tuple([id, cols, rows, screenTarget.optional(), remoteDir.optional()]), (hostId, c, r, screen, cwd) => ctx.terminals.open(host(hostId), c, r, screen, cwd))
  handle('term:screens', z.tuple([id]), (sid) => ctx.terminals.screens(sid))
  handle('term:endScreen', z.tuple([id, screenId]), (sid, screen) => ctx.terminals.endScreen(sid, screen))
  handle('term:hasDocker', z.tuple([id]), (sid) => ctx.terminals.hasDocker(sid))

  // suggestions while typing in a terminal: read-only lists from the server
  const plainPath = z.string().min(1).max(4096).regex(/^[^\0\r\n]+$/)
  const completionNeed = z.union([
    z.object({ kind: z.literal('commands') }).strict(),
    z.object({ kind: z.literal('dir'), path: plainPath }).strict(),
    z.object({ kind: z.enum(DYNAMIC_KINDS), cwd: z.union([z.literal(''), plainPath]) }).strict()
  ])
  handle('term:completeContext', z.tuple([id]), (sid) => ctx.terminals.completeContext(sid))
  handle('term:completeList', z.tuple([id, completionNeed]), (sid, need) => ctx.terminals.completeList(sid, need))
  handle('term:completeHistory', z.tuple([id]), (sid) => ctx.terminals.completeHistory(sid))

  // workspaces: tabs with several connections, saved by name, and the tabs of the last session
  const layoutSchema: z.ZodType<WorkspaceLayout> = z.lazy(() =>
    z.union([
      z.object({ pane: z.number().int().min(0).max(MAX_PANES - 1) }).strict(),
      z.object({ dir: z.enum(['row', 'col']), ratio: z.number().min(0).max(1), a: layoutSchema, b: layoutSchema }).strict()
    ])
  )
  const tabSchema = z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      panes: z
        .array(
          z
            .object({
              hostId: id,
              kind: z.enum(['terminal', 'files', 'docker', 'monitor']),
              target: z.object({ target: screenTarget, name: z.string().max(200) }).strict().optional(),
              cwd: remoteDir.optional()
            })
            .strict()
        )
        .min(1)
        .max(MAX_PANES),
      layout: layoutSchema,
      focus: z.number().int().min(0).max(MAX_PANES - 1),
      zoomed: z.boolean(),
      workspaceId: id.optional()
    })
    .strict()
    .refine((t) => {
      // every pane appears in the layout exactly once
      const used = layoutPanes(t.layout).slice().sort((x, y) => x - y)
      return used.length === t.panes.length && used.every((n, i) => n === i) && t.focus < t.panes.length
    }, 'The layout does not match the panes')
  handle('workspace:list', z.tuple([]), () => [...(ctx.vault.data.workspaces ?? [])].sort((x, y) => x.name.localeCompare(y.name)))
  handle('workspace:save', z.tuple([z.string().trim().min(1).max(80), tabSchema, id.nullable()]), (name, tab, existing) =>
    ctx.vault.update((d) => {
      const list = (d.workspaces ??= [])
      const at = existing ? list.findIndex((w) => w.id === existing) : -1
      if (at < 0 && list.length >= 200) throw new Error('There are too many saved workspaces')
      const saved: SavedWorkspace = { ...tab, workspaceId: undefined, id: at >= 0 ? list[at].id : randomId(), name, updatedAt: Date.now() }
      if (at >= 0) list[at] = saved
      else list.push(saved)
      return saved
    })
  )
  handle('workspace:delete', z.tuple([id]), (wid) =>
    ctx.vault.update((d) => {
      d.workspaces = (d.workspaces ?? []).filter((w) => w.id !== wid)
    })
  )
  handle('session:get', z.tuple([]), () => ctx.vault.data.lastSession ?? null)
  handle('session:set', z.tuple([z.object({ tabs: z.array(tabSchema).max(50), active: z.number().int().min(-1).max(49) }).strict()]), (snapshot) =>
    ctx.vault.update((d) => {
      d.lastSession = snapshot
    })
  )

  // docker
  handle('docker:open', z.tuple([id]), (hostId) => ctx.docker.open(host(hostId)))
  handle('docker:overview', z.tuple([id]), (did) => ctx.docker.overview(did))
  handle('docker:stats', z.tuple([id]), (did) => ctx.docker.stats(did))
  handle('docker:images', z.tuple([id]), (did) => ctx.docker.images(did))
  handle('docker:inspect', z.tuple([id, containerId]), (did, c) => ctx.docker.inspect(did, c))
  handle('docker:action', z.tuple([id, z.enum(CONTAINER_ACTIONS), z.array(containerId).min(1).max(200)]), (did, action, ids) => ctx.docker.action(did, action, ids))
  handle('docker:restartPolicy', z.tuple([id, containerId, z.enum(RESTART_POLICIES)]), (did, c, policy) => ctx.docker.setRestartPolicy(did, c, policy))
  handle('docker:removeImage', z.tuple([id, containerId]), (did, image) => ctx.docker.removeImage(did, image))
  const dockerPort = z.number().int().min(1).max(65535)
  const createSpec = z
    .object({
      image: z.string().min(1).max(255),
      name: z.string().max(63).optional(),
      ports: z.array(z.object({ host: dockerPort, container: dockerPort, protocol: z.enum(['tcp', 'udp']), localOnly: z.boolean() }).strict()).max(50),
      mounts: z.array(z.object({ source: z.string().min(1).max(1024), target: z.string().min(1).max(1024), readOnly: z.boolean() }).strict()).max(50),
      env: z.array(z.object({ name: z.string().min(1).max(128), value: z.string().max(32 * 1024) }).strict()).max(200),
      restart: z.enum(RESTART_POLICIES),
      command: z.string().max(4096).optional(),
      start: z.boolean()
    })
    .strict()
  handle('docker:pull', z.tuple([id, z.string().min(1).max(255)]), (did, image) => ctx.docker.pull(did, image))
  handle('docker:create', z.tuple([id, createSpec]), (did, spec) => ctx.docker.create(did, spec))
  handle('docker:close', z.tuple([id]), (did) => ctx.docker.close(did))

  // monitor
  handle('monitor:open', z.tuple([id]), (hostId) => ctx.monitor.open(host(hostId)))
  handle('monitor:sample', z.tuple([id]), (mid) => ctx.monitor.sample(mid))
  handle('monitor:activity', z.tuple([id]), (mid) => ctx.monitor.activity(mid))
  handle(
    'monitor:signal',
    z.tuple([id, z.number().int().min(2).max(4194304), z.string().regex(/^\d{1,20}$/), z.enum(['TERM', 'KILL']), z.boolean()]),
    (mid, pid, start, signal, sudo) => ctx.monitor.signal(mid, pid, start, signal, sudo)
  )
  handle('monitor:close', z.tuple([id]), (mid) => ctx.monitor.close(mid))
  handle('term:write', z.tuple([id, z.string().max(1024 * 1024)]), (sid, data) => ctx.terminals.write(sid, data))
  handle('term:resize', z.tuple([id, cols, rows]), (sid, c, r) => ctx.terminals.resize(sid, c, r))
  handle('term:close', z.tuple([id]), (sid) => ctx.terminals.close(sid))

  // files
  handle('files:open', z.tuple([id]), (hostId) => ctx.files.open(host(hostId)))
  handle('files:home', z.tuple([id]), (fid) => ctx.files.get(fid).home())
  handle('files:list', z.tuple([id, remotePath]), (fid, p) => ctx.files.get(fid).list(p))
  handle('files:mkdir', z.tuple([id, remotePath]), (fid, p) => ctx.files.get(fid).mkdir(p))
  handle('files:rename', z.tuple([id, remotePath, remotePath]), (fid, a, b) => ctx.files.get(fid).rename(a, b))
  handle('files:stat', z.tuple([id, remotePath]), (fid, p) => ctx.files.get(fid).stat(p))
  handle('files:createFile', z.tuple([id, remotePath]), (fid, p) => ctx.files.get(fid).writeFile(p, Buffer.alloc(0), false))
  handle('files:readText', z.tuple([id, remotePath, z.enum(TEXT_ENCODING_IDS).nullable()]), (fid, p, encoding) => readTextFile(ctx.files.get(fid), p, encoding ?? undefined))
  handle(
    'files:writeText',
    z.tuple([
      id,
      remotePath,
      z.object({ text: z.string().max(MAX_TEXT_BYTES + 1024), eol: z.enum(['lf', 'crlf', 'mixed']), bom: z.boolean(), encoding: z.enum(TEXT_ENCODING_IDS).optional() }),
      z.object({ size: z.number(), modifiedAt: z.number() }),
      z.boolean()
    ]),
    (fid, p, file, expected, force) => writeTextFile(ctx.files.get(fid), p, file, expected, force)
  )
  handle('files:remove', z.tuple([id, remotePath, z.boolean()]), (fid, p, rec) => ctx.files.get(fid).remove(p, rec))
  handle('files:download', z.tuple([id, z.array(entrySchema).min(1).max(1000)]), async (fid, entries) => {
    const win = ctx.window()
    if (!win) return false
    const single = entries.length === 1 && entries[0].type !== 'dir'
    if (single) {
      const r = await dialog.showSaveDialog(win, { title: 'Save file', defaultPath: entries[0].name })
      if (r.canceled || !r.filePath) return false
      void ctx.files.download(fid, entries as RemoteEntry[], { localFile: r.filePath })
    } else {
      const r = await dialog.showOpenDialog(win, { title: 'Download into folder', properties: ['openDirectory', 'createDirectory'] })
      if (r.canceled || !r.filePaths[0]) return false
      void ctx.files.download(fid, entries as RemoteEntry[], { localDir: r.filePaths[0] })
    }
    return true
  })
  const localPaths = z.array(z.string().min(1).max(4096)).min(1).max(1000)
  const entryList = z.array(entrySchema).min(1).max(1000)
  handle('files:pickLocal', z.tuple([z.enum(['files', 'folder', 'sync'])]), async (kind) => {
    const win = ctx.window()
    if (!win) return []
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'sync' ? 'Choose local folder' : kind === 'folder' ? 'Upload folder' : 'Upload files',
      properties: kind === 'sync' ? ['openDirectory', 'createDirectory'] : kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    return r.canceled ? [] : r.filePaths
  })
  handle('files:uploadPaths', z.tuple([id, remotePath, localPaths]), (fid, dir, paths) => {
    void ctx.files.upload(fid, paths, dir)
    return true
  })
  handle(
    'files:move',
    z.tuple([id, z.array(z.object({ from: remotePath, to: remotePath })).min(1).max(1000)]),
    (fid, pairs) => ctx.files.move(fid, pairs)
  )
  handle('files:copy', z.tuple([id, entryList, id, remotePath]), (src, entries, dst, dir) =>
    ctx.files.copy(src, entries as RemoteEntry[], dst, dir)
  )
  handle('files:clipboardCopy', z.tuple([id, entryList, z.boolean()]), (fid, entries, forWindows) =>
    ctx.files.copyToClipboard(fid, entries as RemoteEntry[], forWindows)
  )
  handle('files:clipboardFiles', z.tuple([]), () => ctx.files.clipboardFiles())
  handle('files:dragOut', z.tuple([id, entryList]), (fid, entries) => {
    const win = ctx.window()
    if (!win) return null
    return ctx.files.dragOut(fid, entries as RemoteEntry[], (file) => win.webContents.startDrag({ file, icon: ctx.dragIcon() }))
  })
  handle('files:dragCancel', z.tuple([]), () => ctx.files.cancelDrag())
  const chmodOptions = z.object({
    mode: z.number().int().min(0).max(0o777),
    recursive: z.boolean(),
    target: z.enum(['all', 'files', 'folders']),
    foldersOpen: z.boolean()
  })
  const ownerSchema = z.object({ uid: z.number().int().min(0).max(0xffffffff).optional(), gid: z.number().int().min(0).max(0xffffffff).optional() })
  handle('files:chmodTree', z.tuple([id, entryList, chmodOptions, id]), (fid, entries, options, token) =>
    ctx.files.chmodTree(fid, entries as RemoteEntry[], options, token)
  )
  handle('files:chownTree', z.tuple([id, entryList, ownerSchema, z.boolean(), id]), (fid, entries, owner, recursive, token) =>
    ctx.files.chownTree(fid, entries as RemoteEntry[], owner, recursive, token)
  )
  handle('files:folderSize', z.tuple([id, entryList, id]), (fid, entries, token) => ctx.files.folderSize(fid, entries as RemoteEntry[], token))
  handle('files:search', z.tuple([id, remotePath, z.string().trim().min(1).max(200), id]), (fid, root, query, token) =>
    ctx.files.search(fid, root, query, token)
  )
  handle('files:cancelWork', z.tuple([id]), (token) => ctx.files.cancelWork(token))
  const localDir = z.string().min(1).max(4096)
  const syncOptions = z.object({ compareBy: z.enum(['time', 'size']), offsetMinutes: z.number().int().min(-840).max(840).nullable() }).strict()
  const syncChoice = z.object({ rel: z.string().min(1).max(4096), action: z.enum(['upload', 'download', 'deleteLocal', 'deleteRemote', 'skip']) }).strict()
  handle('files:syncCompare', z.tuple([id, remotePath, localDir, syncOptions, id]), (fid, remote, local, options, token) =>
    ctx.files.syncCompare(fid, remote, local, options, token)
  )
  handle('files:syncApply', z.tuple([id, z.array(syncChoice).max(50_000), z.number().int().min(0)]), (planId, chosen, deletes) =>
    ctx.files.syncApply(planId, chosen, deletes)
  )
  handle('files:watchStart', z.tuple([id, remotePath, localDir]), (fid, remote, local) => ctx.files.watchStart(fid, remote, local))
  handle('files:watchStop', z.tuple([id]), (watchId) => ctx.files.watchStop(watchId))
  handle('files:watchList', z.tuple([]), () => ctx.files.watchList())
  handle('files:readImage', z.tuple([id, remotePath]), (fid, p) => ctx.files.readImage(fid, p))
  handle('files:externalEdit', z.tuple([id, entrySchema]), (fid, entry) => ctx.files.externalEdit(fid, entry as RemoteEntry))
  handle('files:externalUpload', z.tuple([id]), (editId) => ctx.files.externalUpload(editId))
  handle('files:externalStop', z.tuple([id]), (editId) => ctx.files.externalStop(editId))
  handle('files:externalList', z.tuple([]), () => ctx.files.externalList())
  handle('files:queueGet', z.tuple([]), () => ctx.files.transfers())
  handle(
    'files:queueAction',
    z.tuple([z.enum(['pause', 'resume', 'retry', 'cancel', 'top', 'up', 'down', 'bottom']), id.nullable()]),
    (action, tid) => ctx.files.queueAction(action, tid ?? undefined)
  )
  handle('files:queueAnswer', z.tuple([id, z.enum(['overwrite', 'skip', 'rename', 'newer', 'resume']), z.boolean()]), (tid, rule, all) =>
    ctx.files.answerConflict(tid, rule, all)
  )
  handle('files:queueClear', z.tuple([]), () => ctx.files.clearFinishedTransfers())
  handle('files:close', z.tuple([id]), (fid) => ctx.files.close(fid))

  // port forwards
  handle('fwd:list', z.tuple([]), () => ctx.forwards.list())
  handle('fwd:start', z.tuple([id, id]), (hostId, fwdId) => ctx.forwards.start(host(hostId), fwdId))
  handle('fwd:stop', z.tuple([id, id]), (hostId, fwdId) => ctx.forwards.stop(hostId, fwdId))

  // prompts
  handle('prompt:respond', z.tuple([id, promptResponseSchema]), (pid, resp) =>
    ctx.prompter.respond(pid, resp as PromptResponse)
  )

  // answers of the editor to requests from the MCP server
  handle('editor:respond', z.tuple([id, z.boolean(), z.unknown()]), (rid, ok, payload) => ctx.editor.respond(rid, ok, payload))

  // updates
  handle('update:state', z.tuple([]), () => ctx.updater.getState())
  handle('update:check', z.tuple([]), () => ctx.updater.check())
  handle('update:download', z.tuple([]), () => ctx.updater.download())
  handle('update:install', z.tuple([]), () => ctx.updater.install())

  // misc
  handle('audit:list', z.tuple([z.number().int().min(1).max(2000)]), (limit) => ctx.audit.recent(limit))
  handle('app:info', z.tuple([]), (): AppInfo => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
    repoUrl: REPO_URL
  }))
  handle('app:openExternal', z.tuple([z.string().url().max(2048)]), (url) => {
    const u = new URL(url)
    // Only https links to the project page / docs.
    if (u.protocol !== 'https:' || !['github.com', 'modelcontextprotocol.io'].includes(u.hostname)) {
      throw new Error('Link not allowed')
    }
    return shell.openExternal(u.toString())
  })
  handle('clipboard:read', z.tuple([]), () => clipboard.readText())
  handle('clipboard:write', z.tuple([z.string().max(10 * 1024 * 1024)]), (t) => clipboard.writeText(t))
}
