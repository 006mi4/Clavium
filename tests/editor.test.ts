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

  it('refuses binary and non-UTF-8 files', () => {
    expect(() => decodeText(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))).toThrow(/binary/)
    expect(() => decodeText(Buffer.from([0x48, 0xe4, 0x6c, 0x6c, 0x6f]))).toThrow(/UTF-8/) // latin-1 "Hällo"
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
      await fs.writeFile('/big.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 97), false)
      await expect(readTextFile(fs, '/big.txt')).rejects.toThrow(/larger than 2 MB/)
      fs.close()
    } finally {
      await srv.close()
    }
  })
})
