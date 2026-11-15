import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'
import type { SettingsStore } from './core/settings'
import {
  fetchSignedManifest,
  isNewer,
  sha512File,
  verifyInstallerFile,
  type UpdateManifest
} from './core/update'

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000

/**
 * macOS replaces the app in place only when the new copy is signed by the same Apple Developer ID
 * as the running one. A build without one (ad-hoc signature, e.g. built from source) could download
 * an update but never install it, so it does not offer updates at all.
 */
function hasDeveloperId(): boolean {
  // <bundle>.app/Contents/MacOS/Clavium
  const bundle = resolve(process.execPath, '..', '..', '..')
  // codesign writes its report to stderr. An ad-hoc signature has "TeamIdentifier=not set".
  const report = spawnSync('/usr/bin/codesign', ['-dv', bundle], { encoding: 'utf8', timeout: 5000 })
  return /^TeamIdentifier=[A-Z0-9]{10}$/m.test(report.stderr ?? '')
}

/**
 * In-place updates for the installed build: the NSIS installer on Windows, the app in the
 * Applications folder on macOS.
 *
 * electron-updater handles the mechanics (finding the latest release, downloading, running the
 * installer or handing the new app to the updater of macOS). Trust comes from our own check: nothing is installed unless the downloaded file
 * matches a manifest signed with the Clavium release key (see core/update.ts).
 *  - never downloads without the user clicking "Download"
 *  - never installs on its own; only `install()` does, after re-verifying the file
 *  - no downgrades, no pre-releases
 */
export class Updater {
  private state: UpdateState
  private manifest: UpdateManifest | null = null
  private verifiedFile: string | null = null
  private timer: NodeJS.Timeout | null = null
  /** true once the user asked to install: macOS may still refuse, e.g. when the app runs from the disk image */
  private installing = false

  constructor(
    private readonly settings: SettingsStore,
    private readonly onChange: (s: UpdateState) => void,
    /** Called right before the app is closed to install an update. */
    private readonly onInstall: () => void = () => undefined
  ) {
    const portable = !!process.env.PORTABLE_EXECUTABLE_FILE
    const unsigned = app.isPackaged && process.platform === 'darwin' && !hasDeveloperId()
    const platform = process.platform === 'win32' || process.platform === 'darwin'
    const supported = app.isPackaged && platform && !portable && !unsigned
    this.state = {
      status: supported ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      reason: supported ? undefined : portable ? 'portable' : unsigned ? 'unsigned' : 'development'
    }
    if (!supported) return

    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowDowngrade = false
    autoUpdater.allowPrerelease = false
    autoUpdater.disableWebInstaller = true
    autoUpdater.logger = null
    autoUpdater.on('update-available', (info) => {
      try {
        if (!isNewer(info.version, app.getVersion())) return this.set({ status: 'up-to-date', checkedAt: Date.now() })
        this.set({ status: 'available', version: info.version, checkedAt: Date.now() })
      } catch {
        this.set({ status: 'up-to-date', checkedAt: Date.now() }) // pre-release or odd version: ignore
      }
    })
    autoUpdater.on('update-not-available', () => this.set({ status: 'up-to-date', checkedAt: Date.now() }))
    autoUpdater.on('download-progress', (p) => {
      if (this.state.status === 'downloading') this.set({ status: 'downloading', version: this.state.version, progress: Math.round(p.percent) })
    })
    autoUpdater.on('update-downloaded', (e) => void this.verifyDownloaded(e.downloadedFile))
    autoUpdater.on('error', (e) => {
      if (this.state.status === 'checking' || this.state.status === 'downloading' || this.installing) {
        this.installing = false
        this.fail(e)
      }
    })
  }

  getState(): UpdateState {
    return this.state
  }

  private set(patch: Omit<UpdateState, 'currentVersion'>): void {
    this.state = { currentVersion: this.state.currentVersion, checkedAt: this.state.checkedAt, ...patch }
    this.onChange(this.state)
  }

  private fail(e: unknown): void {
    const raw = (e as Error).message ?? String(e)
    const offline = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|ERR_NAME|net::/i.test(raw)
    const noRelease = /404|latest(-mac)?\.yml|No published versions/i.test(raw)
    this.manifest = null
    this.verifiedFile = null
    this.set({
      status: 'error',
      version: this.state.version,
      error: offline ? 'Couldn’t reach GitHub. Check your internet connection.' : noRelease ? 'No published release was found.' : raw.split('\n')[0].slice(0, 300)
    })
  }

  /** Start the periodic check (if enabled in settings). */
  start(): void {
    if (this.state.status === 'unsupported') return
    setTimeout(() => {
      if (this.settings.get().autoCheckUpdates) void this.check()
    }, 15_000).unref()
    this.timer = setInterval(() => {
      const busy = ['downloading', 'verifying', 'ready'].includes(this.state.status)
      if (this.settings.get().autoCheckUpdates && !busy) void this.check()
    }, CHECK_INTERVAL_MS)
    this.timer.unref()
  }

  async check(): Promise<UpdateState> {
    if (['unsupported', 'checking', 'downloading', 'verifying', 'ready'].includes(this.state.status)) return this.state
    this.set({ status: 'checking' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (e) {
      this.fail(e)
    }
    return this.state
  }

  /** Download the offered version. The signed manifest is fetched and verified first. */
  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available' || !this.state.version) return this.state
    const version = this.state.version
    this.set({ status: 'downloading', version, progress: 0 })
    try {
      this.manifest = await fetchSignedManifest(version, app.getVersion())
      await autoUpdater.downloadUpdate()
    } catch (e) {
      this.fail(e)
    }
    return this.state
  }

  private async verifyDownloaded(file: string): Promise<void> {
    const version = this.state.version
    this.set({ status: 'verifying', version })
    try {
      if (!this.manifest) throw new Error('No verified update manifest')
      await verifyInstallerFile(file, this.manifest)
      this.verifiedFile = file
      this.set({ status: 'ready', version })
    } catch (e) {
      this.fail(e)
    }
  }

  /** Quit, install the verified update silently and start the new version. */
  async install(): Promise<void> {
    if (this.state.status !== 'ready' || !this.manifest || !this.verifiedFile) return
    try {
      // The file sat on disk since verification: check it once more right before running it.
      if ((await sha512File(this.verifiedFile)) !== this.manifest.sha512) throw new Error('The downloaded update changed on disk. It was not installed.')
    } catch (e) {
      return this.fail(e)
    }
    // macOS closes the windows before it quits the app. Tell the app first, so that
    // "close to tray" does not keep the window open and the update waiting.
    this.onInstall()
    this.installing = true
    autoUpdater.quitAndInstall(true, true)
  }
}
