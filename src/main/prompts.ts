import { type BrowserWindow, Notification, nativeImage } from 'electron'
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
  /** the desktop notification of this question, removed once it is answered */
  note: Notification | null
}

const DEFAULT_TIMEOUT = 5 * 60_000

/** Routes questions from the core to modal dialogs in the renderer. */
export class UiPrompter implements Prompter {
  private pending = new Map<string, Pending>()

  /**
   * @param iconPath app icon shown inside desktop notifications
   * @param notifications false in automated tests, so they don't pop up on the developer's desktop
   */
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly iconPath?: string,
    private readonly notifications = true
  ) {}

  /** Desktop notification while the window is in the background; a click brings the window up. */
  private notify(win: BrowserWindow, title: string, body: string): Notification | null {
    if (!this.notifications || win.isFocused() || !Notification.isSupported()) return null
    const icon = this.iconPath ? nativeImage.createFromPath(this.iconPath) : undefined
    const n = new Notification({ title, body, icon: icon && !icon.isEmpty() ? icon : undefined })
    n.on('click', () => {
      if (win.isDestroyed()) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
    n.show()
    return n
  }

  private ask(req: PromptRequest, timeoutMs: number, attention: { title: string; body: string } | null): Promise<PromptResponse | null> {
    const win = this.getWindow()
    if (!win || win.isDestroyed()) return Promise.resolve(null)
    if (attention) {
      if (!win.isVisible()) win.show()
      if (win.isMinimized()) win.restore()
      win.flashFrame(true)
    }
    const note = attention ? this.notify(win, attention.title, attention.body) : null
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        note?.close()
        this.pending.delete(req.id)
        win.webContents.send('prompt:cancel', req.id)
        resolve(null)
      }, timeoutMs)
      this.pending.set(req.id, { kind: req.kind, resolve, timer, note })
      win.webContents.send('prompt:request', req)
    })
  }

  /** Called from IPC when the user answered a dialog. */
  respond(id: string, response: PromptResponse): void {
    const p = this.pending.get(id)
    if (!p || p.kind !== response.kind) return
    clearTimeout(p.timer)
    p.note?.close()
    this.pending.delete(id)
    this.getWindow()?.flashFrame(false)
    p.resolve(response)
  }

  /** Reject everything that is still open (e.g. on lock or quit). */
  cancelAll(): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.note?.close()
      this.getWindow()?.webContents.send('prompt:cancel', id)
      p.resolve(null)
    }
    this.pending.clear()
  }

  async hostKey(q: HostKeyQuestion): Promise<boolean> {
    const r = await this.ask({ kind: 'hostKey', id: randomId(), ...q }, DEFAULT_TIMEOUT, {
      title: q.previousFingerprint ? 'Host key has changed' : 'Verify host key',
      body: `${q.host}: Clavium needs you to check the server's fingerprint.`
    })
    return r?.kind === 'hostKey' && r.accept
  }

  async keyboardInteractive(q: KeyboardInteractiveQuestion): Promise<string[] | null> {
    const r = await this.ask({ kind: 'keyboardInteractive', id: randomId(), ...q }, DEFAULT_TIMEOUT, null)
    return r?.kind === 'keyboardInteractive' ? r.answers : null
  }

  async mcpConfirm(q: McpConfirmQuestion): Promise<boolean> {
    const r = await this.ask({ kind: 'mcpConfirm', id: randomId(), ...q }, q.timeoutMs, {
      title: 'An AI assistant is waiting for your approval',
      body: `${q.summary}. Click to review it in Clavium.`
    })
    return r?.kind === 'mcpConfirm' && r.allow
  }
}
