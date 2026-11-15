import { spawn } from 'node:child_process'
import { chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Make a file unreadable for other programs, the way an editor or an office program does while it
 * has the file open. On Windows a second process opens the file without sharing it. Elsewhere no
 * program can lock a file like that, so the permission to read it is taken away instead; to the
 * code under test both look the same: the file is there and cannot be opened.
 * Resolves once the file is held, with a function that lets it go again.
 */
export function holdFile(path: string): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777
    chmodSync(path, 0)
    return Promise.resolve(async () => chmodSync(path, mode))
  }
  return new Promise((resolve, reject) => {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    // The path travels in the environment, and the process lets go when its input is closed.
    const script = "$f = [IO.File]::Open($env:CLAVIUM_HOLD, 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $f.Close()"
    const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CLAVIUM_HOLD: path }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const exited = new Promise<void>((done) => child.once('exit', () => done()))
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString()
      if (out.includes('held')) {
        resolve(async () => {
          child.stdin.end()
          await exited
        })
      }
    })
    child.once('error', reject)
    void exited.then(() => reject(new Error('The file could not be held')))
  })
}
