import { execFile } from 'node:child_process'
import { join } from 'node:path'

/**
 * File lists on the system clipboard ("Copy" in Explorer or Finder). Electron has no API for them,
 * so a scripting host that ships with the system is used: PowerShell on Windows, osascript on
 * macOS. It is started by its full path, and file names are handed over in an environment
 * variable, never as part of the command text.
 */
function run(exe: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(new Error('The system clipboard could not be used')) : resolve(stdout))
    )
  })
}

function powershell(script: string, env: Record<string, string> = {}): Promise<string> {
  const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return run(exe, ['-NoProfile', '-NonInteractive', '-Command', script], env)
}

/** JavaScript for Automation: reaches the pasteboard of macOS without a native module. */
function osascript(script: string, env: Record<string, string> = {}): Promise<string> {
  return run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], env)
}

const MAC_READ = `
ObjC.import('AppKit');
var items = $.NSPasteboard.generalPasteboard.pasteboardItems;
var out = [];
for (var i = 0; items && i < items.count; i++) {
  var s = items.objectAtIndex(i).stringForType('public.file-url');
  if (!s || s.isNil()) continue;
  var u = $.NSURL.URLWithString(s);
  if (u && !u.isNil() && u.isFileURL) out.push(ObjC.unwrap(u.path));
}
JSON.stringify(out)`

// The pasteboard hands the items to the system in the background. A script that ends right after
// writing can lose some of them, so it stays alive for a moment.
const MAC_WRITE = `
ObjC.import('AppKit');
var paths = JSON.parse(ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('CLAVIUM_CLIP_PATHS')));
var pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
var items = $.NSMutableArray.alloc.init;
paths.forEach(function (p) {
  var item = $.NSPasteboardItem.alloc.init;
  item.setStringForType($.NSURL.fileURLWithPath(p).absoluteString, 'public.file-url');
  items.addObject(item);
});
var ok = pb.writeObjects(items);
delay(0.25);
ok ? 'ok' : 'failed'`

function parsePaths(out: string): string[] {
  const text = out.trim()
  if (!text) return []
  const parsed: unknown = JSON.parse(text)
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
}

/** Paths of the files and folders currently on the clipboard; empty if it holds something else. */
export async function readClipboardFiles(): Promise<string[]> {
  if (process.platform === 'win32') {
    return parsePaths(
      await powershell(
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
          '$f = @(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }); ' +
          'if ($f.Count -gt 0) { ConvertTo-Json -InputObject $f -Compress }'
      )
    )
  }
  // macOS hands out decomposed names (u + combining dots for ü). Composed ones open the same file
  // and are what servers expect when the files are uploaded.
  if (process.platform === 'darwin') return parsePaths(await osascript(MAC_READ)).map((p) => p.normalize('NFC'))
  return []
}

/** Put files and folders on the clipboard, so they can be pasted in Explorer or Finder. */
export async function writeClipboardFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  if (process.platform === 'win32') {
    await powershell('Set-Clipboard -LiteralPath @((ConvertFrom-Json $env:CLAVIUM_CLIP_PATHS) | ForEach-Object { $_ })', {
      CLAVIUM_CLIP_PATHS: JSON.stringify(paths)
    })
  } else if (process.platform === 'darwin') {
    const out = await osascript(MAC_WRITE, { CLAVIUM_CLIP_PATHS: JSON.stringify(paths) })
    // Only report success when every file really arrived on the clipboard.
    if (out.trim() !== 'ok' || (await readClipboardFiles()).length !== paths.length) {
      throw new Error('The system clipboard could not be used')
    }
  }
}
