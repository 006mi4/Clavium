import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FtpSrv } from 'ftp-srv'
import { FtpFs } from '../src/main/core/remotefs'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'

let root: string
let server: FtpSrv
const port = 30000 + Math.floor(Math.random() * 5000)

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'clavium-ftp-'))
  writeFileSync(join(root, 'hello.txt'), 'hello ftp')
  server = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, pasv_url: '127.0.0.1', pasv_min: port + 1, pasv_max: port + 50, anonymous: false, greeting: 'test' })
  server.on('login', ({ username, password }, resolve, reject) => {
    if (username === 'ftpuser' && password === 'ftppass') resolve({ root })
    else reject(new Error('bad login'))
  })
  await server.listen()
})

afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('FTP (plain)', () => {
  const host = (pw: string) => sshHost(port, { protocol: 'ftp', username: 'ftpuser', password: pw })

  it('lists, reads, writes, renames and deletes', async () => {
    const { vault } = await newUnlockedVault()
    const fs = await FtpFs.connect(host('ftppass'), { vault, prompter: recordingPrompter(), interactive: false })
    const home = await fs.home()
    expect((await fs.list(home)).map((e) => e.name)).toContain('hello.txt')
    expect((await fs.readFile(join(home, 'hello.txt').replace(/\\/g, '/'), 1024)).data.toString()).toBe('hello ftp')

    await fs.mkdir('/sub')
    await fs.writeFile('/sub/new.txt', Buffer.from('written via ftp'), false)
    await expect(fs.writeFile('/sub/new.txt', Buffer.from('x'), false)).rejects.toThrow(/exists/)
    await fs.rename('/sub/new.txt', '/sub/renamed.txt')
    expect((await fs.stat('/sub/renamed.txt')).size).toBe(15)
    const partial = await fs.readFile('/sub/renamed.txt', 7)
    expect(partial.data.toString()).toBe('written')
    expect(partial.truncated).toBe(true)
    await fs.remove('/sub', true)
    expect((await fs.list('/')).map((e) => e.name)).not.toContain('sub')
    await expect(fs.mkdir('/evil\r\nDELE hello.txt')).rejects.toThrow(/control characters/)
    fs.close()
  })

  it('rejects wrong credentials', async () => {
    const { vault } = await newUnlockedVault()
    await expect(FtpFs.connect(host('nope'), { vault, prompter: recordingPrompter(), interactive: false })).rejects.toThrow()
  })
})
