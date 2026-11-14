/** Every IPC channel the renderer may invoke. The preload script rejects anything else. */
export const INVOKE_CHANNELS = [
  'vault:state',
  'vault:create',
  'vault:unlock',
  'vault:lock',
  'vault:changePassword',
  'hosts:list',
  'hosts:save',
  'hosts:delete',
  'hosts:duplicate',
  'keys:list',
  'keys:importFile',
  'keys:importText',
  'keys:generate',
  'keys:delete',
  'knownHosts:list',
  'knownHosts:remove',
  'settings:get',
  'settings:set',
  'mcp:status',
  'mcp:token',
  'mcp:regenerate',
  'mcp:snippets',
  'term:open',
  'term:write',
  'term:resize',
  'term:close',
  'files:open',
  'files:home',
  'files:list',
  'files:mkdir',
  'files:rename',
  'files:readText',
  'files:writeText',
  'files:remove',
  'files:download',
  'files:upload',
  'files:uploadPaths',
  'files:close',
  'fwd:list',
  'fwd:start',
  'fwd:stop',
  'prompt:respond',
  'audit:list',
  'update:state',
  'update:check',
  'update:download',
  'update:install',
  'app:info',
  'app:openExternal',
  'clipboard:read',
  'clipboard:write'
] as const

/** Events the main process pushes to the renderer. */
export const EVENT_CHANNELS = [
  'vault:changed',
  'settings:changed',
  'term:data',
  'term:exit',
  'files:progress',
  'files:closed',
  'prompt:request',
  'prompt:cancel',
  'audit:entry',
  'fwd:changed',
  'mcp:changed',
  'update:changed'
] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type EventChannel = (typeof EVENT_CHANNELS)[number]

export interface McpSnippets {
  url: string
  exePath: string
  claudeCode: string
  claudeDesktop: string
  codex: string
  generic: string
}

export interface AppInfo {
  name: string
  version: string
  platform: string
  electron: string
  repoUrl: string
}
