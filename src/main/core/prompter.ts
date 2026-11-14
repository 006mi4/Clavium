import type { PromptRequest } from '@shared/types'

type Without<T, K extends keyof T> = Omit<T, K>

export type HostKeyQuestion = Without<Extract<PromptRequest, { kind: 'hostKey' }>, 'id' | 'kind'>
export type KeyboardInteractiveQuestion = Without<
  Extract<PromptRequest, { kind: 'keyboardInteractive' }>,
  'id' | 'kind'
>
export type McpConfirmQuestion = Without<Extract<PromptRequest, { kind: 'mcpConfirm' }>, 'id' | 'kind'>

/** Questions the core asks the human. Implemented by the Electron UI (or a stub in tests). */
export interface Prompter {
  hostKey(q: HostKeyQuestion): Promise<boolean>
  keyboardInteractive(q: KeyboardInteractiveQuestion): Promise<string[] | null>
  mcpConfirm(q: McpConfirmQuestion): Promise<boolean>
}
