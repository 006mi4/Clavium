import type { EventChannel, InvokeChannel } from '../shared/ipc'

export interface ClaviumBridge {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown>
  on(channel: EventChannel, listener: (...args: unknown[]) => void): () => void
  pathForFile(file: File): string
}

declare global {
  interface Window {
    clavium: ClaviumBridge
  }
}
