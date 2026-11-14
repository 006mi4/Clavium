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
 * In-place updates for the installed (NSIS) build.
 *
 * electron-updater handles the mechanics (finding the latest release, downloading, running the
 * installer). Trust comes from our own check: nothing is installed unless the downloaded file
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

  constructor(
    private readonly settings: SettingsStore,
    private readonly onChange: (s: UpdateState) => void
  ) {
    const portable = !!process.env.PORTABLE_EXECUTABLE_FILE
    const supported = app.isPackaged && process.platform === 'win32' && !portable
    this.state = {
      status: supported ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      reason: supported ? undefined : portable ? 'portable' : 'development'
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
      if (this.state.status === 'checking' || this.state.status === 'downloading') this.fail(e)
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
    const noRelease = /404|latest\.yml|No published versions/i.test(raw)
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

  /** Quit, run the verified installer silently and start the new version. */
  async install(): Promise<void> {
    if (this.state.status !== 'ready' || !this.manifest || !this.verifiedFile) return
    try {
      // The file sat on disk since verification: check it once more right before running it.
      if ((await sha512File(this.verifiedFile)) !== this.manifest.sha512) throw new Error('The downloaded update changed on disk. It was not installed.')
    } catch (e) {
      return this.fail(e)
    }
    autoUpdater.quitAndInstall(true, true)
  }
}
