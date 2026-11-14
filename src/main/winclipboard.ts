import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * File lists on the Windows clipboard ("Copy" in Explorer). Electron has no API for them, so the
 * PowerShell that ships with Windows is used. It is started by its full path, and file names are
 * handed over in an environment variable, never as part of the command text.
 */
function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(new Error('The Windows clipboard could not be used')) : resolve(stdout))
    )
  })
}

/** Paths of the files and folders currently on the clipboard; empty if it holds something else. */
export async function readClipboardFiles(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const out = await powershell(
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
      '$f = @(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }); ' +
      'if ($f.Count -gt 0) { ConvertTo-Json -InputObject $f -Compress }'
  )
  const text = out.trim()
  if (!text) return []
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
}

/** Put files and folders on the clipboard, so they can be pasted in Explorer. */
export async function writeClipboardFiles(paths: string[]): Promise<void> {
  if (process.platform !== 'win32' || paths.length === 0) return
  await powershell('Set-Clipboard -LiteralPath @((ConvertFrom-Json $env:CLAVIUM_CLIP_PATHS) | ForEach-Object { $_ })', {
    CLAVIUM_CLIP_PATHS: JSON.stringify(paths)
  })
}
