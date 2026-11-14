import type { BrowserWindow } from 'electron'
import type { EditorEdit, EditorFileInfo, EditorRequest } from '@shared/types'
import { randomId } from './core/crypto'
import type { EditorBridge } from './core/mcp/service'

const TIMEOUT_MS = 60_000 // opening a file may have to connect first

/**
 * Lets the MCP server ask the editor in the window about its open files. The editor state lives
 * in the renderer, so every call is a request/response round trip over IPC.
 */
export class WindowEditorBridge implements EditorBridge {
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private ask<T>(request: EditorRequest): Promise<T> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return Promise.reject(new Error('The Clavium window is not open.'))
    const id = randomId()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('The editor did not answer in time.'))
      }, TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      win.webContents.send('editor:request', id, request)
    })
  }

  /** Called from IPC with the renderer's answer. */
  respond(id: string, ok: boolean, payload: unknown): void {
    const p = this.pending.get(id)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    if (ok) p.resolve(payload)
    else p.reject(new Error(typeof payload === 'string' ? payload.slice(0, 500) : 'The editor reported an error.'))
  }

  list(): Promise<EditorFileInfo[]> {
    return this.ask({ op: 'list' })
  }
  open(hostId: string, path: string): Promise<void> {
    return this.ask({ op: 'open', hostId, path })
  }
  read(hostId: string, path: string): Promise<{ text: string; unsaved: boolean }> {
    return this.ask({ op: 'read', hostId, path })
  }
  edit(hostId: string, path: string, edit: EditorEdit): Promise<number> {
    return this.ask({ op: 'edit', hostId, path, edit })
  }
}
