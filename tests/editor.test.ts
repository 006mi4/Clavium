import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detectLanguage, highlight } from '../src/renderer/src/editor/highlight'
import { decodeText, encodeText, readTextFile, writeTextFile } from '../src/main/core/textfile'
import { openRemoteFs } from '../src/main/core/remotefs'
import { newUnlockedVault, recordingPrompter, sshHost } from './helpers/fixtures'
import { startTestSshServer } from './helpers/testServer'

/** Strip the highlighter's own spans; what remains must be the escaped original text. */
const plain = (html: string): string =>
  html
    .replace(/<span class="t-[a-z]">|<\/span>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

describe('syntax highlighter', () => {
  it('detects languages from names, extensions and shebangs', () => {
    expect(detectLanguage('docker-compose.yml')).toBe('yaml')
    expect(detectLanguage('Dockerfile.prod')).toBe('dockerfile')
    expect(detectLanguage('.env.production')).toBe('ini')
    expect(detectLanguage('nginx.conf')).toBe('conf')
    expect(detectLanguage('deploy', '#!/usr/bin/env bash')).toBe('shell')
    expect(detectLanguage('tool', '#!/usr/bin/python3')).toBe('python')
    expect(detectLanguage('README')).toBe('plain')
    expect(detectLanguage('app.TSX')).toBe('typescript')
  })

  it('marks keys, strings, comments and keywords', () => {
    expect(highlight('image: "nginx" # web', 'yaml')).toBe(
      '<span class="t-a">image</span>: <span class="t-s">"nginx"</span> <span class="t-c"># web</span>'
    )
    expect(highlight('{"port": 8080, "on": true}', 'json')).toContain('<span class="t-a">"port"</span>: <span class="t-n">8080</span>')
    const js = highlight('const x = fetch("/a") // go', 'javascript')
    expect(js).toContain('<span class="t-k">const</span>')
    expect(js).toContain('<span class="t-f">fetch</span>')
    expect(js).toContain('<span class="t-c">// go</span>')
    expect(highlight('select * FROM users', 'sql')).toContain('<span class="t-k">FROM</span>')
    expect(highlight('[server]\nport = 22', 'ini')).toContain('<span class="t-t">[server]</span>')
    // a # inside a string is not a comment
    expect(highlight('x = "a # b"', 'python')).toBe('x = <span class="t-s">"a # b"</span>')
    // unterminated block comment runs to the end instead of hanging
    expect(highlight('/* open\nstill', 'css')).toBe('<span class="t-c">/* open\nstill</span>')
  })

  it('never lets file content become markup', () => {
    const evil = '<img src=x onerror=alert(1)> & "</span><script>alert(1)</script>'
    for (const lang of ['plain', 'html', 'javascript', 'yaml', 'markdown', 'json', 'shell', 'log']) {
      const html = highlight(evil, lang)
      expect(html).not.toMatch(/<(?!\/?span)/) // the only tags are our own spans
      expect(html).not.toMatch(/<span(?! class="t-[a-z]">)/)
      expect(plain(html)).toBe(evil)
    }
  })

  it('reproduces the input exactly for every language', () => {
    const sample = '#!/bin/sh\n# c\nkey: "v" \'x\'\n<a href="1">t</a>\n\t$VAR ${X} 0x1F 12.5\n/* b */ // l\n```\ncode\n```\n+ add\n- del\n'
    for (const lang of ['plain', 'json', 'yaml', 'ini', 'conf', 'shell', 'dockerfile', 'markdown', 'html', 'css', 'javascript', 'typescript', 'python', 'php', 'go', 'rust', 'c', 'java', 'lua', 'ruby', 'sql', 'diff', 'log', 'unknown-language']) {
      expect(plain(highlight(sample, lang))).toBe(sample)
    }
  })

  it('stays fast on a large file', () => {
    const big = 'server {\n  listen 80; # port\n  name "example";\n}\n'.repeat(8000) // ~400 KB
    const t = Date.now()
    highlight(big, 'conf')
    expect(Date.now() - t).toBeLessThan(1500)
  })
})

describe('text encoding', () => {
  it('round-trips line endings and the byte order mark exactly', () => {
    for (const raw of ['a\nb\n', 'a\r\nb\r\n', '﻿a\r\nb', 'ä€😀\n', '']) {
      const buf = Buffer.from(raw, 'utf8')
      const d = decodeText(buf)
      expect(d.text).not.toContain('\r')
      expect(encodeText(d.text, d.eol, d.bom).equals(buf)).toBe(true)
    }
    expect(decodeText(Buffer.from('a\r\nb\nc')).eol).toBe('mixed')
  })

  it('refuses binary files, and reads a file that is not UTF-8 as a guess the user can correct', () => {
    expect(() => decodeText(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toThrow(/binary/)
    const latin = Buffer.from([0x48, 0xe4, 0x6c, 0x6c, 0x6f, 0x20, 0x80]) // "Hällo €" in Windows-1252
    expect(decodeText(latin)).toMatchObject({ text: 'Hällo €', encoding: 'windows-1252', guessed: true, bom: false })
    expect(decodeText(Buffer.from('plain'))).toEqual({ text: 'plain', eol: 'lf', bom: false, encoding: 'utf-8' })
    // the same bytes mean other letters in another character set
    expect(decodeText(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]), 'windows-1251').text).toBe('Привет')
    expect(decodeText(Buffer.from([0xa4]), 'iso-8859-15').text).toBe('€')
    // asked to read as UTF-8, bytes that are not UTF-8 are refused instead of being lost on saving
    expect(() => decodeText(latin, 'utf-8')).toThrow(/not valid UTF-8/)
  })

  it('writes every character set back byte for byte, with its line endings', () => {
    for (const encoding of ['windows-1252', 'iso-8859-15', 'macintosh', 'windows-1250', 'iso-8859-2', 'windows-1251', 'koi8-r', 'ibm866', 'windows-1253', 'windows-1254', 'windows-1257'] as const) {
      const known = (b: number): boolean => new TextDecoder(encoding).decode(Uint8Array.of(b)) !== '\ufffd'
      const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i).filter((b) => b !== 0 && b !== 13 && known(b)))
      expect(bytes.length, encoding).toBeGreaterThan(230)
      const d = decodeText(bytes, encoding)
      expect(encodeText(d.text, d.eol, d.bom, encoding).equals(bytes), encoding).toBe(true)
    }
    // a byte that means nothing in a character set is refused, not replaced by a question mark
    expect(() => decodeText(Buffer.from([0x41, 0xaa]), 'windows-1253')).toThrow(/bytes that mean nothing/)
    const crlf = decodeText(Buffer.from([0x67, 0x72, 0xfc, 0xdf, 0x0d, 0x0a, 0x65, 0x0d, 0x0a]), 'iso-8859-15')
    expect(crlf).toMatchObject({ text: 'grüß\ne\n', eol: 'crlf' })
    expect(encodeText('grün\n', 'crlf', false, 'iso-8859-15').equals(Buffer.from([0x67, 0x72, 0xfc, 0x6e, 0x0d, 0x0a]))).toBe(true)
  })

  it('reads and writes UTF-16 in both byte orders, recognised by the mark at the start', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße 😀\r\nzwei', 'utf16le')])
    const d = decodeText(le)
    expect(d).toEqual({ text: 'Grüße 😀\nzwei', eol: 'crlf', bom: true, encoding: 'utf-16le' })
    expect(encodeText(d.text, d.eol, d.bom, d.encoding).equals(le)).toBe(true)
    const be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('añ', 'utf16le').swap16()])
    const b = decodeText(be)
    expect(b).toMatchObject({ text: 'añ', bom: true, encoding: 'utf-16be' })
    expect(encodeText(b.text, b.eol, b.bom, b.encoding).equals(be)).toBe(true)
  })

  it('refuses to save characters the character set cannot hold, and says which and where', () => {
    expect(() => encodeText('ok\nGrün 😀\n', 'lf', false, 'koi8-r')).toThrow(/cannot hold “ü”, “😀” \(first in line 2\)/)
    expect(encodeText('5 €', 'lf', false, 'windows-1252').equals(Buffer.from([0x35, 0x20, 0x80]))).toBe(true)
  })
})

describe('editing remote files', () => {
  it('reads, saves, keeps CRLF and detects changes made by someone else', async () => {
    const srv = await startTestSshServer()
    try {
      const { vault } = await newUnlockedVault()
      const fs = await openRemoteFs(sshHost(srv.port), { vault, prompter: recordingPrompter(), interactive: true })
      await fs.writeFile('/app.conf', Buffer.from('port=1\r\nhost=a\r\n'), false)

      const file = await readTextFile(fs, '/app.conf')
      expect(file).toMatchObject({ text: 'port=1\nhost=a\n', eol: 'crlf', bom: false })

      const saved = await writeTextFile(fs, '/app.conf', { ...file, text: 'port=2\nhost=a\n' }, file.version, false)
      expect(saved.saved).toBe(true)
      expect((await fs.readFile('/app.conf', 100)).data.toString()).toBe('port=2\r\nhost=a\r\n')

      // someone else edits the file: our stale version must not overwrite it silently
      await fs.writeFile('/app.conf', Buffer.from('changed elsewhere, longer\r\n'), true)
      const stale = await writeTextFile(fs, '/app.conf', { ...file, text: 'mine\n' }, file.version, false)
      expect(stale).toEqual({ saved: false, conflict: 'changed' })
      expect((await fs.readFile('/app.conf', 100)).data.toString()).toBe('changed elsewhere, longer\r\n')

      const forced = await writeTextFile(fs, '/app.conf', { ...file, text: 'mine\n' }, file.version, true)
      expect(forced.saved).toBe(true)
      expect((await fs.readFile('/app.conf', 100)).data.toString()).toBe('mine\r\n')

      await fs.remove('/app.conf', false)
      expect(await writeTextFile(fs, '/app.conf', { ...file, text: 'x' }, file.version, false)).toEqual({ saved: false, conflict: 'deleted' })

      await fs.writeFile('/blob.bin', Buffer.from([1, 0, 2, 0]), false)
      await expect(readTextFile(fs, '/blob.bin')).rejects.toThrow(/binary/)
      // files of several megabytes open: read with many requests at once, and still in the right order
      const big = Buffer.from(Array.from({ length: 5 * 1024 * 1024 + 123 }, (_, i) => 97 + ((i * 7 + (i >> 9)) % 26)))
      writeFileSync(join(srv.root, 'big.txt'), big)
      const opened = await readTextFile(fs, '/big.txt')
      expect(Buffer.from(opened.text).equals(big)).toBe(true)
      writeFileSync(join(srv.root, 'huge.txt'), Buffer.alloc(32 * 1024 * 1024 + 1, 97))
      await expect(readTextFile(fs, '/huge.txt')).rejects.toThrow(/larger than 32 MB/)

      // a file in another character set: read as a guess, read again as told, saved in that character set
      writeFileSync(join(srv.root, 'old.txt'), Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0a]))
      expect(await readTextFile(fs, '/old.txt')).toMatchObject({ encoding: 'windows-1252', guessed: true })
      const cyr = await readTextFile(fs, '/old.txt', 'windows-1251')
      expect(cyr).toMatchObject({ text: 'Привет\n', encoding: 'windows-1251' })
      expect((await writeTextFile(fs, '/old.txt', { ...cyr, text: 'Привет, мир\n' }, cyr.version, false)).saved).toBe(true)
      expect(readFileSync(join(srv.root, 'old.txt')).equals(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x2c, 0x20, 0xec, 0xe8, 0xf0, 0x0a]))).toBe(true)
      await expect(writeTextFile(fs, '/old.txt', { ...cyr, text: 'Grüße\n' }, cyr.version, true)).rejects.toThrow(/cannot hold/)
      // converting: the same text written as UTF-8
      await writeTextFile(fs, '/old.txt', { ...cyr, encoding: 'utf-8' }, cyr.version, true)
      expect(readFileSync(join(srv.root, 'old.txt'), 'utf8')).toBe('Привет\n')
      fs.close()
    } finally {
      await srv.close()
    }
  })
})
