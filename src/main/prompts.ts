import { BrowserWindow, Notification } from 'electron'
import type { PromptRequest, PromptResponse } from '@shared/types'
import { randomId } from './core/crypto'
import type {
  HostKeyQuestion,
  KeyboardInteractiveQuestion,
  McpConfirmQuestion,
  Prompter
} from './core/prompter'

interface Pending {
  kind: PromptRequest['kind']
  resolve: (r: PromptResponse | null) => void
  timer: NodeJS.Timeout
}

const DEFAULT_TIMEOUT = 5 * 60_000

/** Routes questions from the core to modal dialogs in the renderer. */
export class UiPrompter implements Prompter {
  private pending = new Map<string, Pending>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private ask(req: PromptRequest, timeoutMs: number, attention: boolean): Promise<PromptResponse | null> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return Promise.resolve(null)
    if (attention) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.flashFrame(true)
      if (!win.isFocused() && Notification.isSupported()) {
        new Notification({ title: 'Clavium – approval needed', body: `${'hostName' in req ? req.hostName : ''}: AI wants to act` }).show()
      }
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id)
        win.webContents.send('prompt:cancel', req.id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(req.id, { kind: req.kind, resolve, timer })
      win.webContents.send('prompt:request', req)
    })
  }

  /** Called from IPC when the user answered a dialog. */
  respond(id: string, response: PromptResponse): void {
    const p = this.pending.get(id)
    if (!p || p.kind !== response.kind) return
    clearTimeout(p.timer)
    this.pending.delete(id)
    this.getWindow()?.flashFrame(false)
    p.resolve(response)
  }

  /** Reject everything that is still open (e.g. on lock or quit). */
  cancelAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      this.getWindow()?.webContents.send('prompt:cancel', id)
      p.resolve(null)
    }
    this.pending.clear()
  }

  async hostKey(q: HostKeyQuestion): Promise<boolean> {
    const r = await this.ask({ kind: 'hostKey', id: randomId(), ...q }, DEFAULT_TIMEOUT, true)
    return r?.kind === 'hostKey' && r.accept
  }

  async keyboardInteractive(q: KeyboardInteractiveQuestion): Promise<string[] | null> {
    const r = await this.ask({ kind: 'keyboardInteractive', id: randomId(), ...q }, DEFAULT_TIMEOUT, false)
    return r?.kind === 'keyboardInteractive' ? r.answers : null
  }

  async mcpConfirm(q: McpConfirmQuestion): Promise<boolean> {
    const r = await this.ask({ kind: 'mcpConfirm', id: randomId(), ...q }, q.timeoutMs, true)
    return r?.kind === 'mcpConfirm' && r.allow
  }
}
