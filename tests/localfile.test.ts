import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inUse, readableNow, renameWhenFree } from '../src/main/core/localfile'
import { holdFile } from './helpers/holdFile'

const coded = (code: string): Error => Object.assign(new Error(`${code}: something`), { code })

describe('local files that another program holds', () => {
  it('tells a held file from one that can be read, and from one that is gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clavium-held-'))
    const file = join(dir, 'report.txt')
    writeFileSync(file, 'text')
    expect(await readableNow(file)).toBe(true)
    const release = await holdFile(file)
    try {
      expect(await readableNow(file)).toBe(false)
    } finally {
      await release()
    }
    expect(await readableNow(file)).toBe(true)
    // a missing file is not "in use": whoever asks finds that out when opening it
    expect(await readableNow(join(dir, 'nothing.txt'))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('knows the answers of the system that mean "in use"', () => {
    expect(['EBUSY', 'EPERM', 'EACCES'].every((code) => inUse(coded(code)))).toBe(true)
    expect(inUse(coded('ENOENT'))).toBe(false)
    expect(inUse(new Error('plain'))).toBe(false)
    expect(inUse(null)).toBe(false)
  })

  it('waits for a target that is held for a moment, then replaces it', async () => {
    const calls: string[] = []
    let refusals = 3
    await renameWhenFree('a.part', 'a.txt', {
      delays: [1, 1, 1, 1],
      rename: async (from, to) => {
        calls.push(`${from}>${to}`)
        if (refusals-- > 0) throw coded(refusals % 2 ? 'EPERM' : 'EBUSY')
      }
    })
    expect(calls).toEqual(Array(4).fill('a.part>a.txt'))
  })

  it('gives up with a message that names the file and the reason', async () => {
    let attempts = 0
    const failing = renameWhenFree(join('some', 'folder', 'plan.docx.clavium-part'), join('some', 'folder', 'plan.docx'), {
      delays: [1, 1],
      rename: async () => {
        attempts++
        throw coded('EPERM')
      }
    })
    await expect(failing).rejects.toThrow(/"plan\.docx" cannot be replaced: it is open in another program/)
    await expect(failing).rejects.toMatchObject({ code: 'EPERM' })
    expect(attempts).toBe(3)
  })

  it('does not wait when the reason is another one', async () => {
    let attempts = 0
    await expect(
      renameWhenFree('a.part', 'a.txt', {
        rename: async () => {
          attempts++
          throw coded('ENOSPC')
        }
      })
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(attempts).toBe(1)
  })

  it('renames a real file over an existing one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clavium-rename-'))
    writeFileSync(join(dir, 'new.part'), 'new')
    writeFileSync(join(dir, 'file.txt'), 'old')
    await renameWhenFree(join(dir, 'new.part'), join(dir, 'file.txt'))
    expect(readFileSync(join(dir, 'file.txt'), 'utf8')).toBe('new')
    rmSync(dir, { recursive: true, force: true })
  })
})
