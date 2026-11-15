// Builds the MCP stdio bridge into resources/bin/.
//  - Windows: bridge/ClaviumMcpBridge.cs -> clavium-mcp.exe, using the C# compiler that ships
//    with .NET Framework 4.x on every Windows 10/11 machine.
//  - macOS:   bridge/ClaviumMcpBridge.swift -> clavium-mcp (universal: Apple silicon and Intel),
//    using the swiftc of the Xcode command line tools.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const outDir = join('resources', 'bin')

function buildWindows() {
  const windir = process.env.WINDIR || 'C:\\Windows'
  const csc = [
    join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
  ].find(existsSync)
  if (!csc) {
    console.error('[build-bridge] csc.exe (.NET Framework 4.x) not found')
    process.exit(1)
  }
  const args = ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', '/out:' + join(outDir, 'clavium-mcp.exe'), '/r:System.dll']
  if (existsSync(join('build', 'icon.ico'))) args.push('/win32icon:' + join('build', 'icon.ico'))
  args.push(join('bridge', 'ClaviumMcpBridge.cs'))
  execFileSync(csc, args, { stdio: 'inherit' })
  console.log('[build-bridge] resources/bin/clavium-mcp.exe')
}

function buildMac() {
  const source = join('bridge', 'ClaviumMcpBridge.swift')
  const out = join(outDir, 'clavium-mcp')
  const slices = ['arm64', 'x86_64'].map((arch) => {
    const slice = `${out}-${arch}`
    execFileSync('xcrun', ['swiftc', '-O', '-target', `${arch}-apple-macos11.0`, '-o', slice, source], { stdio: 'inherit' })
    return slice
  })
  execFileSync('xcrun', ['lipo', '-create', '-output', out, ...slices], { stdio: 'inherit' })
  for (const slice of slices) rmSync(slice)
  // Apple silicon only runs signed code. An ad-hoc signature is enough for a local helper;
  // electron-builder signs it again together with the app when a certificate is available.
  execFileSync('codesign', ['--force', '--sign', '-', out], { stdio: 'inherit' })
  console.log('[build-bridge] resources/bin/clavium-mcp')
}

mkdirSync(outDir, { recursive: true })
if (process.platform === 'win32') buildWindows()
else if (process.platform === 'darwin') buildMac()
else console.warn('[build-bridge] skipped: the MCP stdio bridge is built on Windows and macOS only')
