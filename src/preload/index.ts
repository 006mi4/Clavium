import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, type EventChannel, type InvokeChannel } from '@shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

// Narrow, allow-listed bridge. The renderer never gets ipcRenderer or Node APIs.
contextBridge.exposeInMainWorld('clavium', {
  invoke(channel: InvokeChannel, ...args: unknown[]): Promise<unknown> {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  },
  on(channel: EventChannel, listener: (...args: unknown[]) => void): () => void {
    if (!eventAllowed.has(channel)) throw new Error(`Blocked channel ${channel}`)
    const wrapped = (_e: Electron.IpcRendererEvent, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  }
})
