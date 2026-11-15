import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  nativeTheme,
  powerMonitor,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'
import type { EventChannel } from '@shared/ipc'
import { AuditLog } from './core/audit'
import { SettingsStore } from './core/settings'
import { Vault } from './core/vault'
import { WindowEditorBridge } from './editorBridge'
import { DockerManager } from './docker'
import { MonitorManager } from './monitor'
import { FileManager } from './files'
import { ForwardManager } from './forwards'
import { registerIpc } from './ipc'
import { McpController } from './mcpController'
import { UiPrompter } from './prompts'
import { TerminalManager } from './terminals'
import { Updater } from './updater'
import { readClipboardFiles, writeClipboardFiles } from './fileclipboard'

/** Real location of the executable (the portable build unpacks itself to a temp dir). */

/**
 * Open a local file in an editor. The file is always handed to an editor program as an argument
 * and never started itself: its name and content come from a server.
 */
function openInEditor(file: string, program: string): Promise<void> {
  // The end-to-end tests have no editor to open.
  if (process.env.CLAVIUM_NO_EXTERNAL_EDITOR && !app.isPackaged) return Promise.resolve()
  const mac = process.platform === 'darwin'
  // Elsewhere "open with the default program" may start the file itself. Not with files from a server.
  if (!program && !mac && process.platform !== 'win32') return Promise.reject(new Error('Choose an editor in Settings first'))
  const [command, args] = program
    ? mac && program.replace(/\/+$/, '').endsWith('.app')
      ? ['open', ['-a', program, file]]
      : [program, [file]]
    : mac
      ? ['open', ['-t', file]]
      : ['notepad.exe', [file]]
  return new Promise((resolve, reject) => {
    const child = spawn(command as string, args as string[], { detached: true, stdio: 'ignore' })
    child.once('error', (e) => reject(new Error(`The editor could not be started (${e.message})`)))
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

function exePath(): string {
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
}

const isMac = process.platform === 'darwin'
const BRIDGE_NAME = process.platform === 'win32' ? 'clavium-mcp.exe' : 'clavium-mcp'

/** What the bridge starts when Clavium is not running: the exe on Windows, the app bundle on macOS. */
function launchTarget(): string {
  // <bundle>.app/Contents/MacOS/Clavium
  return isMac ? resolve(process.execPath, '..', '..', '..') : exePath()
}

/**
 * Copy the stdio bridge (clavium-mcp) to the bin folder of the data directory (%APPDATA%\Clavium
 * on Windows, ~/Library/Application Support/Clavium on macOS) so AI client configs keep a stable
 * path across updates and for the portable build. Returns its path.
 */
function installBridge(dataDir: string): string {
  const source = app.isPackaged
    ? join(process.resourcesPath, 'bin', BRIDGE_NAME)
    : join(app.getAppPath(), 'resources', 'bin', BRIDGE_NAME)
  const binDir = join(dataDir, 'bin')
  const target = join(binDir, BRIDGE_NAME)
  try {
    mkdirSync(binDir, { recursive: true })
    if (existsSync(source)) {
      const same = existsSync(target) && readFileSync(source).equals(readFileSync(target))
      if (!same) {
        if (isMac) {
          // macOS remembers the signature of a program file. Writing new code into the same file
          // gets the program killed at its next start, so the new copy replaces the file as a whole.
          const fresh = `${target}.new`
          copyFileSync(source, fresh)
          chmodSync(fresh, 0o755)
          renameSync(fresh, target)
        } else {
          copyFileSync(source, target)
        }
      }
    }
    // Lets the bridge start Clavium when an AI client needs it and the app is not running.
    if (app.isPackaged) writeFileSync(join(binDir, 'clavium-app-path.txt'), launchTarget(), 'utf8')
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
  const resource = (name: string): string =>
    app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'resources', name)
  const iconPath = resource('icon.png')

  // Windows shows notifications under the name and icon of the app this ID belongs to. The
  // installer registers the ID below with the Start menu shortcut. Without an installed shortcut
  // (portable build, development) Windows shows the ID text itself, so the plain name is used.
  if (process.platform === 'win32') {
    const installed = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE
    app.setAppUserModelId(installed ? 'io.github.clavium.desktop' : 'Clavium')
  }
  const prompter = new UiPrompter(getWindow, iconPath, !process.env.CLAVIUM_NO_NOTIFICATIONS || app.isPackaged)
  const send = (channel: EventChannel, ...args: unknown[]): void => {
    getWindow()?.webContents.send(channel, ...args)
  }

  const terminals = new TerminalManager(vault, prompter, send)
  // Private folder for files that are only passing through (copies between servers, files put on
  // the system clipboard). Emptied at every start and when the app quits.
  const transferDir = join(dataDir, 'transfer-tmp')
  const emptyTransferDir = (): void => {
    try {
      rmSync(transferDir, { recursive: true, force: true })
    } catch {
      /* a file may still be in use; the next start removes it */
    }
  }
  emptyTransferDir()
  mkdirSync(transferDir, { recursive: true })
  const files = new FileManager(vault, prompter, send, {
    tempRoot: transferDir,
    readClipboardFiles,
    writeClipboardFiles,
    clearClipboard: () => clipboard.clear(),
    trash: (path) => shell.trashItem(path),
    openInEditor: (path) => openInEditor(path, settings.get().externalEditor)
  }, () => settings.get())
  const docker = new DockerManager(vault, prompter, send)
  const monitor = new MonitorManager(vault, prompter, send)
  const forwards = new ForwardManager(vault, prompter, () => send('fwd:changed'))
  const editor = new WindowEditorBridge(getWindow)
  const mcp = new McpController({
    editor,
    vault,
    settings,
    prompter,
    audit,
    version: app.getVersion(),
    bridgePath,
    onChange: () => send('mcp:changed')
  })

  const updater = new Updater(
    settings,
    (s) => send('update:changed', s),
    () => {
      quitting = true
    }
  )

  vault.onStateChange((state) => {
    if (state !== 'unlocked') {
      // Locking disconnects everything; open tabs reconnect after the next unlock.
      prompter.cancelAll()
      terminals.closeAll()
      files.closeAll()
      docker.closeAll()
      monitor.closeAll()
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
      // The app draws its own unified toolbar. Windows keeps its native caption buttons on top of
      // it (right), macOS its close, minimise and zoom buttons (left, centred in the toolbar).
      titleBarStyle: 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 16, y: Math.round((TITLEBAR_HEIGHT - 14) / 2) } }
        : { titleBarOverlay: { color: c.bg, symbolColor: c.symbols, height: TITLEBAR_HEIGHT } }),
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
  // macOS: a click on the Dock icon brings the window back after it was closed or hidden.
  app.on('activate', showWindow)

  /**
   * macOS always shows a menu bar, and its entries are what make Cmd+C, Cmd+V, Cmd+Q and the
   * like work at all. Only standard entries: everything else lives in the window.
   */
  function macMenu(): Menu {
    const template: MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' }
        ]
      },
      {
        label: 'Window',
        submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'front' }]
      }
    ]
    return Menu.buildFromTemplate(template)
  }

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(isMac ? macMenu() : null)
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    session.defaultSession.setPermissionCheckHandler(() => false)

    const dragIcon = nativeImage.createFromPath(iconPath).resize({ width: 40, height: 40 })
    registerIpc({ window: getWindow, vault, settings, audit, prompter, mcp, terminals, files, docker, monitor, forwards, updater, editor, dragIcon: () => dragIcon })
    createWindow()

    // macOS: a black-and-transparent "template" image that the menu bar colours itself.
    const trayIcon = isMac ? resource('trayTemplate.png') : iconPath
    if (existsSync(trayIcon)) {
      tray = new Tray(isMac ? nativeImage.createFromPath(trayIcon) : nativeImage.createFromPath(trayIcon).resize({ width: 16, height: 16 }))
      // On macOS a click opens the menu, like every other menu bar icon.
      if (!isMac) tray.on('click', showWindow)
      updateTrayMenu()
    }

    await mcp.apply()
    updater.start()

    // ---- auto-lock ----
    // Automated tests switch it off: they run for minutes on a computer nobody is touching.
    const autoLock = app.isPackaged || !process.env.CLAVIUM_NO_AUTOLOCK
    setInterval(() => {
      const minutes = settings.get().autoLockMinutes
      if (autoLock && minutes > 0 && vault.state() === 'unlocked' && powerMonitor.getSystemIdleTime() >= minutes * 60) {
        vault.lock()
      }
    }, 20_000)
    const lockIfConfigured = (): void => {
      if (autoLock && settings.get().lockOnSystemLock && vault.state() === 'unlocked') vault.lock()
    }
    powerMonitor.on('lock-screen', lockIfConfigured)
    powerMonitor.on('suspend', lockIfConfigured)
  })

  app.on('before-quit', () => {
    quitting = true
    prompter.cancelAll()
    terminals.closeAll()
    files.closeAll()
    docker.closeAll()
    monitor.closeAll()
    emptyTransferDir()
    forwards.stopAll()
    void mcp.shutdown()
    vault.lock()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && !tray) app.quit()
  })
}

runApp()
