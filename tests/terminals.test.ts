// A terminal that is opened again starts in the folder its shell was in.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerminalManager } from '../src/main/terminals'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer

beforeAll(async () => {
  srv = await startTestSshServer()
  // the folder /srv/www exists on this server, nothing else does
  srv.onExec = (command) => (command.includes('__clavium_dir_ok__') ? (command.includes('/srv/www') ? '__clavium_dir_ok__\n' : '') : undefined)
})
afterAll(async () => {
  await srv.close()
})

/** Opens a terminal and gives back what the server printed until the prompt stands there. */
async function firstScreen(cwd?: string): Promise<string> {
  const { vault } = await newUnlockedVault()
  let text = ''
  let done: () => void = () => undefined
  const prompt = new Promise<void>((resolve) => (done = resolve))
  const terminals = new TerminalManager(vault, recordingPrompter(), (channel, _id, data) => {
    if (channel !== 'term:data') return
    text += Buffer.from(data as Uint8Array).toString('utf8')
    if (text.endsWith('$ ')) done()
  })
  const id = await terminals.open(sshHost(srv.port), 80, 24, undefined, cwd)
  await prompt
  terminals.close(id)
  return text
}

describe('the folder a terminal starts in', () => {
  it('is the folder that was asked for, when the server still has it', async () => {
    expect(await firstScreen('/srv/www')).toContain('(in /srv/www)')
  })

  it('is the home folder when nothing was asked for or the folder is gone', async () => {
    expect(await firstScreen()).not.toContain('(in ')
    expect(await firstScreen('/srv/gone')).not.toContain('(in ')
  })

  it('does not take an answer that merely repeats the command for a yes', async () => {
    const before = srv.onExec
    // a server that echoes whatever it is asked, as a restricted shell might
    srv.onExec = (command) => `not allowed: ${command}\n`
    try {
      expect(await firstScreen('/srv/www')).not.toContain('(in ')
    } finally {
      srv.onExec = before
    }
  })
})
