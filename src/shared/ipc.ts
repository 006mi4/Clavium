/** Every IPC channel the renderer may invoke. The preload script rejects anything else. */
export const INVOKE_CHANNELS = [
  'vault:state',
  'vault:create',
  'vault:unlock',
  'vault:lock',
  'vault:changePassword',
  'vault:export',
  'vault:import',
  'hosts:list',
  'hosts:save',
  'hosts:setBookmarks',
  'hosts:rememberPath',
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
  'term:screens',
  'term:endScreen',
  'term:hasDocker',
  'docker:open',
  'docker:overview',
  'docker:stats',
  'docker:images',
  'docker:inspect',
  'docker:action',
  'docker:restartPolicy',
  'docker:removeImage',
  'docker:pull',
  'docker:create',
  'docker:close',
  'files:open',
  'files:home',
  'files:list',
  'files:mkdir',
  'files:rename',
  'files:stat',
  'files:createFile',
  'files:readText',
  'files:writeText',
  'files:remove',
  'files:download',
  'files:pickLocal',
  'files:uploadPaths',
  'files:move',
  'files:copy',
  'files:clipboardCopy',
  'files:clipboardFiles',
  'files:dragOut',
  'files:dragCancel',
  'files:chmodTree',
  'files:chownTree',
  'files:folderSize',
  'files:search',
  'files:cancelWork',
  'files:syncCompare',
  'files:syncApply',
  'files:watchStart',
  'files:watchStop',
  'files:watchList',
  'files:queueGet',
  'files:queueAction',
  'files:queueAnswer',
  'files:queueClear',
  'files:close',
  'fwd:list',
  'fwd:start',
  'fwd:stop',
  'prompt:respond',
  'audit:list',
  'editor:respond',
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
  'files:queue',
  'files:changed',
  'files:searchHits',
  'files:syncProgress',
  'files:watch',
  'files:closed',
  'docker:closed',
  'docker:pullProgress',
  'prompt:request',
  'prompt:cancel',
  'audit:entry',
  'fwd:changed',
  'mcp:changed',
  'editor:request',
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
