import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  Tray,
  type WebContents
} from 'electron'
import type { EventChannel } from '@shared/ipc'
import { AuditLog } from './core/audit'
import { SettingsStore } from './core/settings'
import { Vault } from './core/vault'
import { FileManager } from './files'
import { ForwardManager } from './forwards'
import { registerIpc } from './ipc'
import { McpController } from './mcpController'
import { UiPrompter } from './prompts'
import { TerminalManager } from './terminals'

/** Real location of the executable (the portable build unpacks itself to a temp dir). */
function exePath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

/**
 * Copy the stdio bridge (clavium-mcp.exe) to %APPDATA%\Clavium\bin so AI client configs
 * keep a stable path across updates and for the portable build. Returns its path.
 */
function installBridge(dataDir: string): string {
  const source = app.isPackaged
    ? join(process.resourcesPath, 'bin', 'clavium-mcp.exe')
    : join(app.getAppPath(), 'resources', 'bin', 'clavium-mcp.exe')
  const binDir = join(dataDir, 'bin')
  const target = join(binDir, 'clavium-mcp.exe')
  try {
    mkdirSync(binDir, { recursive: true })
    if (existsSync(source)) {
      const same = existsSync(target) && readFileSync(source).equals(readFileSync(target))
      if (!same) copyFileSync(source, target)
    }
    // Lets the bridge start Clavium when an AI client needs it and the app is not running.
    if (app.isPackaged) writeFileSync(join(binDir, 'clavium-app-path.txt'), exePath(), 'utf8')
  } catch {
    // The bridge may be in use by a running AI client; the existing copy keeps working.
  }
  return target
}

// --------------------------------------------------------- main app ----

function runApp(): void {
  // Development/E2E only: isolated data directory. Ignored in packaged builds.
  if (!app.isPackaged && process.env.CLAVIUM_DATA_DIR) app.setPath('userData', process.env.CLAVIUM_DATA_DIR)
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const dataDir = app.getPath('userData')
  const bridgePath = installBridge(dataDir)
  const vault = new Vault(join(dataDir, 'vault.json'))
  const settings = new SettingsStore(join(dataDir, 'settings.json'))
  const audit = new AuditLog(join(dataDir, 'audit.log'))

  let mainWindow: BrowserWindow | null = null
  let tray: Tray | null = null
  let quitting = false

  const getWindow = (): BrowserWindow | null => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null)
  const send = (channel: EventChannel, ...args: unknown[]): void => {
    getWindow()?.webContents.send(channel, ...args)
  }

  const prompter = new UiPrompter(getWindow)
  const terminals = new TerminalManager(vault, prompter, send)
  const files = new FileManager(vault, prompter, send)
  const forwards = new ForwardManager(vault, prompter, () => send('fwd:changed'))
  const mcp = new McpController({
    vault,
    settings,
    prompter,
    audit,
    version: app.getVersion(),
    bridgePath,
    onChange: () => send('mcp:changed')
  })

  vault.onStateChange((state) => {
    if (state !== 'unlocked') {
      // Locking disconnects everything; open tabs reconnect after the next unlock.
      prompter.cancelAll()
      terminals.closeAll()
      files.closeAll()
      forwards.stopAll()
      mcp.service.shutdown() // drop AI connections immediately on lock
    } else {
      void mcp.apply() // creates the token on first unlock if MCP is enabled
    }
    send('vault:changed', state)
    updateTrayMenu()
  })
  settings.onChange((s) => {
    const { mcpTokenHash: _h, ...rest } = s
    send('settings:changed', rest)
  })
  audit.onEntry((e) => send('audit:entry', e))

  // ---- hardening -------------------------------------------------------
  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (ev, url) => {
      const dev = process.env.ELECTRON_RENDERER_URL
      if (!(dev && url.startsWith(dev))) ev.preventDefault()
    })
    contents.on('will-attach-webview', (ev) => ev.preventDefault())
  })

  // ---- window ----------------------------------------------------------
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'resources', 'icon.png')

  // Window chrome follows the system appearance (light / dark). Keep in sync with --bg in styles.css.
  const chrome = (): { bg: string; symbols: string } =>
    nativeTheme.shouldUseDarkColors ? { bg: '#1c1c1e', symbols: '#f2f2f4' } : { bg: '#ffffff', symbols: '#1c1c1e' }
  const TITLEBAR_HEIGHT = 48

  nativeTheme.on('updated', () => {
    const w = getWindow()
    if (!w) return
    const c = chrome()
    w.setBackgroundColor(c.bg)
    if (process.platform === 'win32') {
      w.setTitleBarOverlay({ color: c.bg, symbolColor: c.symbols, height: TITLEBAR_HEIGHT })
    }
  })

  function createWindow(): void {
    const c = chrome()
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 940,
      minHeight: 600,
      show: false,
      title: 'Clavium',
      backgroundColor: c.bg,
      icon: existsSync(iconPath) ? iconPath : undefined,
      autoHideMenuBar: true,
      // The app draws its own unified toolbar; Windows keeps its native caption buttons on top of it.
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: c.bg, symbolColor: c.symbols, height: TITLEBAR_HEIGHT },
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        devTools: !app.isPackaged
      }
    })
    mainWindow.once('ready-to-show', () => mainWindow?.show())
    mainWindow.on('close', (e) => {
      if (!quitting && settings.get().closeToTray && tray) {
        e.preventDefault()
        mainWindow?.hide()
      }
    })
    mainWindow.on('closed', () => {
      mainWindow = null
    })
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  function showWindow(): void {
    const w = getWindow()
    if (!w) return createWindow()
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }

  function updateTrayMenu(): void {
    if (!tray) return
    const unlocked = vault.state() === 'unlocked'
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Clavium', click: showWindow },
        { label: unlocked ? 'Lock vault' : 'Locked', enabled: unlocked, click: () => vault.lock() },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            quitting = true
            app.quit()
          }
        }
      ])
    )
    tray.setToolTip(`Clavium${unlocked ? '' : ' (locked)'}`)
  }

  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    session.defaultSession.setPermissionCheckHandler(() => false)

    registerIpc({ window: getWindow, vault, settings, audit, prompter, mcp, terminals, files, forwards })
    createWindow()

    if (existsSync(iconPath)) {
      tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }))
      tray.on('click', showWindow)
      updateTrayMenu()
    }

    await mcp.apply()

    // ---- auto-lock ----
    setInterval(() => {
      const minutes = settings.get().autoLockMinutes
      if (minutes > 0 && vault.state() === 'unlocked' && powerMonitor.getSystemIdleTime() >= minutes * 60) {
        vault.lock()
      }
    }, 20_000)
    const lockIfConfigured = (): void => {
      if (settings.get().lockOnSystemLock && vault.state() === 'unlocked') vault.lock()
    }
    powerMonitor.on('lock-screen', lockIfConfigured)
    powerMonitor.on('suspend', lockIfConfigured)
  })

  app.on('before-quit', () => {
    quitting = true
    prompter.cancelAll()
    terminals.closeAll()
    files.closeAll()
    forwards.stopAll()
    void mcp.shutdown()
    vault.lock()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit()
  })
}

runApp()
