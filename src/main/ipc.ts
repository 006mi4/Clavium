import { readFile } from 'node:fs/promises'
import { app, clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import type { AppInfo, InvokeChannel } from '@shared/ipc'
import type { HostRecord, HostSummary, PromptResponse, RemoteEntry } from '@shared/types'
import type { AuditLog } from './core/audit'
import { randomId } from './core/crypto'
import { buildKeyRecord, generateKey, summarizeKey } from './core/keys'
import { settingsSchema, type SettingsStore } from './core/settings'
import { MAX_TEXT_BYTES, readTextFile, writeTextFile } from './core/textfile'
import type { Vault } from './core/vault'
import type { FileManager } from './files'
import type { ForwardManager } from './forwards'
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
  forwards: ForwardManager
  updater: Updater
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
  forwards: z.array(forwardSchema).max(50)
})

const entrySchema = z.object({
  name: z.string().max(1024),
  path: remotePath,
  type: z.enum(['file', 'dir', 'link', 'other']),
  size: z.number(),
  modifiedAt: z.number(),
  permissions: z.string().max(20).optional()
})

const promptResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('hostKey'), accept: z.boolean() }),
  z.object({ kind: z.literal('keyboardInteractive'), answers: z.array(z.string().max(4096)).max(20).nullable() }),
  z.object({ kind: z.literal('mcpConfirm'), allow: z.boolean() })
])

// ------------------------------------------------------------- helpers ----

export function summarizeHost(h: HostRecord): HostSummary {
  const { password, ...rest } = h
  return { ...rest, hasPassword: !!password }
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
      const { password, id: _ignored, ...fields } = input
      const record: HostRecord = {
        ...fields,
        id: existing?.id ?? randomId(),
        password: password === undefined ? existing?.password : password === null ? undefined : password,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      d.hosts = existing ? d.hosts.map((h) => (h.id === record.id ? record : h)) : [...d.hosts, record]
      return summarizeHost(record)
    })
  })
  handle('hosts:delete', z.tuple([id]), (hostId) =>
    ctx.vault.update((d) => {
      d.hosts = d.hosts.filter((h) => h.id !== hostId)
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
  handle('term:open', z.tuple([id, cols, rows]), (hostId, c, r) => ctx.terminals.open(host(hostId), c, r))
  handle('term:write', z.tuple([id, z.string().max(1024 * 1024)]), (sid, data) => ctx.terminals.write(sid, data))
  handle('term:resize', z.tuple([id, cols, rows]), (sid, c, r) => ctx.terminals.resize(sid, c, r))
  handle('term:close', z.tuple([id]), (sid) => ctx.terminals.close(sid))

  // files
  handle('files:open', z.tuple([id]), (hostId) => ctx.files.open(host(hostId)))
  handle('files:home', z.tuple([id]), (fid) => ctx.files.get(fid).home())
  handle('files:list', z.tuple([id, remotePath]), (fid, p) => ctx.files.get(fid).list(p))
  handle('files:mkdir', z.tuple([id, remotePath]), (fid, p) => ctx.files.get(fid).mkdir(p))
  handle('files:rename', z.tuple([id, remotePath, remotePath]), (fid, a, b) => ctx.files.get(fid).rename(a, b))
  handle('files:readText', z.tuple([id, remotePath]), (fid, p) => readTextFile(ctx.files.get(fid), p))
  handle(
    'files:writeText',
    z.tuple([
      id,
      remotePath,
      z.object({ text: z.string().max(MAX_TEXT_BYTES + 1024), eol: z.enum(['lf', 'crlf', 'mixed']), bom: z.boolean() }),
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
  handle('files:upload', z.tuple([id, remotePath, z.enum(['files', 'folder'])]), async (fid, dir, kind) => {
    const win = ctx.window()
    if (!win) return false
    const r = await dialog.showOpenDialog(win, {
      title: kind === 'folder' ? 'Upload folder' : 'Upload files',
      properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
    })
    if (r.canceled || r.filePaths.length === 0) return false
    void ctx.files.upload(fid, r.filePaths, dir)
    return true
  })
  handle('files:uploadPaths', z.tuple([id, remotePath, z.array(z.string().min(1).max(4096)).min(1).max(1000)]), (fid, dir, paths) => {
    void ctx.files.upload(fid, paths, dir)
    return true
  })
  handle('files:close', z.tuple([id]), (fid) => ctx.files.close(fid))

  // port forwards
  handle('fwd:list', z.tuple([]), () => ctx.forwards.list())
  handle('fwd:start', z.tuple([id, id]), (hostId, fwdId) => ctx.forwards.start(host(hostId), fwdId))
  handle('fwd:stop', z.tuple([id, id]), (hostId, fwdId) => ctx.forwards.stop(hostId, fwdId))

  // prompts
  handle('prompt:respond', z.tuple([id, promptResponseSchema]), (pid, resp) =>
    ctx.prompter.respond(pid, resp as PromptResponse)
  )

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
