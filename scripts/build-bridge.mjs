// Compiles bridge/ClaviumMcpBridge.cs into resources/bin/clavium-mcp.exe using the
// C# compiler that ships with .NET Framework 4.x on every Windows 10/11 machine.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

if (process.platform !== 'win32') {
  console.warn('[build-bridge] skipped: the MCP stdio bridge is built on Windows only')
  process.exit(0)
}

const windir = process.env.WINDIR || 'C:\\Windows'
const csc = [
  join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
].find(existsSync)
if (!csc) {
  console.error('[build-bridge] csc.exe (.NET Framework 4.x) not found')
  process.exit(1)
}

mkdirSync(join('resources', 'bin'), { recursive: true })
const args = [
  '/nologo',
  '/optimize+',
  '/target:exe',
  '/platform:anycpu',
  '/out:' + join('resources', 'bin', 'clavium-mcp.exe'),
  '/r:System.dll'
]
if (existsSync(join('build', 'icon.ico'))) args.push('/win32icon:' + join('build', 'icon.ico'))
args.push(join('bridge', 'ClaviumMcpBridge.cs'))
execFileSync(csc, args, { stdio: 'inherit' })
console.log('[build-bridge] resources/bin/clavium-mcp.exe')
