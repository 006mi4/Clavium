import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_TRANSFER_SETTINGS, type ExternalEditStatus, type RemoteEntry } from '@shared/types'
import { FileManager, type Desktop } from '../src/main/files'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { holdFile } from './helpers/holdFile'
import { startTestSshServer, type TestSshServer } from './helpers/testServer'

let srv: TestSshServer
const open: FileManager[] = []
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (what: () => unknown, ms = 10_000): Promise<void> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (what()) return
  throw new Error('Timed out')
}

beforeAll(async () => {
  srv = await startTestSshServer()
})
afterAll(async () => {
  await srv.close()
})
afterEach(() => {
  for (const fm of open.splice(0)) fm.closeAll()
})

async function setup() {
  const { vault } = await newUnlockedVault()
  const launched: string[] = []
  const events: ExternalEditStatus[][] = []
  const desktop: Desktop = {
    tempRoot: realpathSync(mkdtempSync(join(tmpdir(), 'clavium-extedit-'))),
    readClipboardFiles: async () => [],
    writeClipboardFiles: async () => undefined,
    clearClipboard: () => undefined,
    openInEditor: async (path) => void launched.push(path)
  }
  const fm = new FileManager(vault, recordingPrompter(), (channel, payload) => channel === 'files:external' && events.push(payload as ExternalEditStatus[]), desktop, () => DEFAULT_TRANSFER_SETTINGS)
  open.push(fm)
  const id = await fm.open(sshHost(srv.port))
  const entry = (path: string): Promise<RemoteEntry> => fm.get(id).stat(path)
  const state = (): ExternalEditStatus => fm.externalList()[0]
  return { fm, id, launched, events, entry, state, tempRoot: desktop.tempRoot }
}

describe('editing in an external editor', () => {
  it('opens a local copy in the editor and uploads it at every save', async () => {
    const t = await setup()
    writeFileSync(join(srv.root, 'notes.txt'), 'first')
    const edit = await t.fm.externalEdit(t.id, await t.entry('/notes.txt'))
    expect(t.launched).toEqual([edit.localPath])
    expect(readFileSync(edit.localPath, 'utf8')).toBe('first')
    expect(edit).toMatchObject({ remote: '/notes.txt', name: 'notes.txt', state: 'open', uploads: 0 })

    writeFileSync(edit.localPath, 'second, saved in the editor')
    await until(() => readFileSync(join(srv.root, 'notes.txt'), 'utf8') === 'second, saved in the editor')
    await until(() => t.state().uploads === 1 && t.state().state === 'open')

    // editors that save by writing a new file and renaming it over the old one
    writeFileSync(edit.localPath + '.tmp', 'third, saved by renaming')
    renameSync(edit.localPath + '.tmp', edit.localPath)
    await until(() => readFileSync(join(srv.root, 'notes.txt'), 'utf8') === 'third, saved by renaming')
    await until(() => t.state().uploads === 2)
    expect(t.events.some((list) => list[0]?.state === 'uploading')).toBe(true)

    // opening the same file again does not make a second copy
    const again = await t.fm.externalEdit(t.id, await t.entry('/notes.txt'))
    expect(again.id).toBe(edit.id)
    expect(t.launched).toEqual([edit.localPath, edit.localPath])
    expect(t.fm.externalList()).toHaveLength(1)
  })

  it('does not replace changes someone else made on the server until the user says so', async () => {
    const t = await setup()
    writeFileSync(join(srv.root, 'shared.conf'), 'a=1')
    const edit = await t.fm.externalEdit(t.id, await t.entry('/shared.conf'))
    writeFileSync(join(srv.root, 'shared.conf'), 'a=1 changed by a colleague')
    writeFileSync(edit.localPath, 'a=2 mine')
    await until(() => t.state().state === 'conflict')
    expect(t.state().lastError).toMatch(/changed on the server/)
    expect(readFileSync(join(srv.root, 'shared.conf'), 'utf8')).toBe('a=1 changed by a colleague')

    await t.fm.externalUpload(edit.id)
    expect(readFileSync(join(srv.root, 'shared.conf'), 'utf8')).toBe('a=2 mine')
    expect(t.state()).toMatchObject({ state: 'open', uploads: 1 })
    // afterwards saving works as usual again
    writeFileSync(edit.localPath, 'a=3')
    await until(() => readFileSync(join(srv.root, 'shared.conf'), 'utf8') === 'a=3')
  })

  it('stops on request and with the session, and removes the local copy', async () => {
    const t = await setup()
    writeFileSync(join(srv.root, 'one.txt'), '1')
    writeFileSync(join(srv.root, 'two.txt'), '2')
    const one = await t.fm.externalEdit(t.id, await t.entry('/one.txt'))
    const two = await t.fm.externalEdit(t.id, await t.entry('/two.txt'))
    t.fm.externalStop(one.id)
    await until(() => !existsSync(dirname(one.localPath)))
    expect(t.fm.externalList().map((e) => e.name)).toEqual(['two.txt'])
    t.fm.close(t.id)
    await until(() => !existsSync(dirname(two.localPath)))
    expect(t.fm.externalList()).toEqual([])
    expect(readFileSync(join(srv.root, 'one.txt'), 'utf8')).toBe('1')
  })

  it('waits while the program keeps the saved file to itself, then uploads it', async () => {
    const t = await setup()
    writeFileSync(join(srv.root, 'letter.txt'), 'draft')
    const edit = await t.fm.externalEdit(t.id, await t.entry('/letter.txt'))
    writeFileSync(edit.localPath, 'final, but the program has not let go yet')
    const release = await holdFile(edit.localPath)
    try {
      // several looks at the file while it is held
      await sleep(1800)
      expect(readFileSync(join(srv.root, 'letter.txt'), 'utf8')).toBe('draft')
      expect(t.state()).toMatchObject({ state: 'open', uploads: 0 })
      expect(t.state().lastError).toBeUndefined()
    } finally {
      await release()
    }
    await until(() => readFileSync(join(srv.root, 'letter.txt'), 'utf8') === 'final, but the program has not let go yet')
    await until(() => t.state().uploads === 1 && t.state().state === 'open')
  })

  it('a file name from the server cannot place the local copy outside its folder', async () => {
    const t = await setup()
    writeFileSync(join(srv.root, 'plain.txt'), 'x')
    const real = await t.entry('/plain.txt')
    const edit = await t.fm.externalEdit(t.id, { ...real, name: '..\\..\\evil.cmd' })
    expect(dirname(dirname(edit.localPath))).toBe(t.tempRoot)
    expect(edit.localPath.endsWith('.._.._evil.cmd')).toBe(true)
  })
})

describe('previewing pictures', () => {
  it('hands a picture to the preview and refuses other files and very large ones', async () => {
    const t = await setup()
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
    writeFileSync(join(srv.root, 'dot.PNG'), png)
    const r = await t.fm.readImage(t.id, '/dot.PNG')
    expect(r.size).toBe(png.length)
    expect(r.dataUrl).toBe('data:image/png;base64,' + png.toString('base64'))
    writeFileSync(join(srv.root, 'script.sh'), '#!/bin/sh')
    await expect(t.fm.readImage(t.id, '/script.sh')).rejects.toThrow(/cannot be shown as a picture/)
    writeFileSync(join(srv.root, 'huge.jpg'), Buffer.alloc(16 * 1024 * 1024 + 1))
    await expect(t.fm.readImage(t.id, '/huge.jpg')).rejects.toThrow(/larger than 16 MB/)
  })
})
