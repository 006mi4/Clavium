import type { TextEncoding, TextFile, TextFileVersion, TextWriteResult } from '@shared/types'
import type { RemoteFs } from './remotefs'

/** Files larger than this are not opened in the editor (download them instead). */
export const MAX_TEXT_BYTES = 32 * 1024 * 1024
const TOO_LARGE = 'This file is larger than 32 MB. Download it to edit it.'

const BOMS: { encoding: TextEncoding; bytes: Buffer }[] = [
  { encoding: 'utf-8', bytes: Buffer.from([0xef, 0xbb, 0xbf]) },
  { encoding: 'utf-16le', bytes: Buffer.from([0xff, 0xfe]) },
  { encoding: 'utf-16be', bytes: Buffer.from([0xfe, 0xff]) }
]
const bomOf = (encoding: TextEncoding): Buffer | undefined => BOMS.find((b) => b.encoding === encoding)?.bytes
const startsWith = (buf: Buffer, bytes: Buffer): boolean => buf.length >= bytes.length && buf.subarray(0, bytes.length).equals(bytes)

/** For character sets with one byte per character: which byte stands for which character. */
const tables = new Map<TextEncoding, Map<number, number>>()
function tableFor(encoding: TextEncoding): Map<number, number> {
  let table = tables.get(encoding)
  if (!table) {
    table = new Map()
    const decoder = new TextDecoder(encoding)
    for (let byte = 0; byte < 256; byte++) {
      const ch = decoder.decode(Uint8Array.of(byte)).charCodeAt(0)
      // U+FFFD marks a byte that has no meaning in this character set.
      if (ch !== 0xfffd && !table.has(ch)) table.set(ch, byte)
    }
    tables.set(encoding, table)
  }
  return table
}

type Decoded = Pick<TextFile, 'text' | 'eol' | 'bom' | 'encoding' | 'guessed'>

/**
 * Decode a file for editing. Without `encoding` the character set is found out: by the mark at
 * the start of the file, else UTF-8 when the bytes are clean UTF-8, else Windows-1252 as a guess
 * the user can correct. Binary files are refused, because editing them would damage them.
 */
export function decodeText(buf: Buffer, encoding?: TextEncoding): Decoded {
  const mark = BOMS.find((b) => startsWith(buf, b.bytes) && (!encoding || encoding === b.encoding))
  let guessed = false
  let used = encoding ?? mark?.encoding
  const body = mark ? buf.subarray(mark.bytes.length) : buf
  if (!used?.startsWith('utf-16') && body.includes(0)) throw new Error('This is a binary file and can’t be edited as text.')
  let raw: string | undefined
  if (!used) {
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(body)
      used = 'utf-8'
    } catch {
      used = 'windows-1252'
      guessed = true
    }
  }
  if (raw === undefined) {
    try {
      // Bytes that mean nothing in this character set would be lost on saving: refuse instead.
      raw = new TextDecoder(used, { fatal: true, ignoreBOM: true }).decode(body)
    } catch {
      throw new Error(`This file is not valid ${used.toUpperCase()} text: it has bytes that mean nothing there. Choose another character set.`)
    }
  }
  const crlf = (raw.match(/\r\n/g) ?? []).length
  const loneLf = (raw.match(/(?<!\r)\n/g) ?? []).length
  const eol: TextFile['eol'] = crlf > 0 && loneLf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : 'lf'
  return { text: raw.replace(/\r\n/g, '\n'), eol, bom: !!mark, encoding: used, ...(guessed ? { guessed } : {}) }
}

/**
 * Inverse of decodeText: restores line endings, the mark at the start and the character set.
 * Mixed endings become LF. Throws when the text has characters the character set cannot hold.
 */
export function encodeText(text: string, eol: TextFile['eol'], bom: boolean, encoding: TextEncoding = 'utf-8'): Buffer {
  const normalized = text.replace(/\r\n/g, '\n')
  const out = eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized
  let body: Buffer
  if (encoding === 'utf-8') body = Buffer.from(out, 'utf8')
  else if (encoding === 'utf-16le') body = Buffer.from(out, 'utf16le')
  else if (encoding === 'utf-16be') body = Buffer.from(out, 'utf16le').swap16()
  else {
    const table = tableFor(encoding)
    body = Buffer.allocUnsafe(out.length)
    const missing = new Set<string>()
    let firstLine = 0
    let line = 1
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i)
      if (code === 10) line++
      const byte = table.get(code)
      if (byte === undefined) {
        // A character outside the 65,536 most common ones takes two places in the string.
        const pair = code >= 0xd800 && code <= 0xdbff && i + 1 < out.length
        if (missing.size < 5) missing.add(pair ? out.slice(i, i + 2) : out[i])
        if (!firstLine) firstLine = line
        if (pair) i++
        continue
      }
      body[i] = byte
    }
    if (firstLine) {
      throw new Error(`This character set cannot hold ${[...missing].map((c) => `“${c}”`).join(', ')} (first in line ${firstLine}). Choose UTF-8 as the character set, or remove these characters.`)
    }
  }
  const mark = bom ? bomOf(encoding) : undefined
  return mark ? Buffer.concat([mark, body]) : body
}

export async function readTextFile(fs: RemoteFs, path: string, encoding?: TextEncoding): Promise<TextFile> {
  const st = await fs.stat(path)
  if (st.type === 'dir') throw new Error('This is a folder.')
  if (st.size > MAX_TEXT_BYTES) throw new Error(TOO_LARGE)
  const r = await fs.readFile(path, MAX_TEXT_BYTES + 1)
  if (r.truncated || r.data.length > MAX_TEXT_BYTES) throw new Error(TOO_LARGE)
  return { ...decodeText(r.data, encoding), version: { size: st.size, modifiedAt: st.modifiedAt } }
}

/**
 * Save an edited file. If the file on the server no longer looks like the version that was
 * opened (someone else changed it), nothing is written unless `force` is set.
 */
export async function writeTextFile(
  fs: RemoteFs,
  path: string,
  file: Pick<TextFile, 'text' | 'eol' | 'bom'> & { encoding?: TextEncoding },
  expected: TextFileVersion,
  force: boolean
): Promise<TextWriteResult> {
  const data = encodeText(file.text, file.eol, file.bom, file.encoding)
  if (data.length > MAX_TEXT_BYTES) throw new Error('The text is larger than 32 MB and can’t be saved from the editor.')
  if (!force) {
    const now = await fs.stat(path).catch(() => null)
    if (!now) return { saved: false, conflict: 'deleted' }
    if (now.size !== expected.size || now.modifiedAt !== expected.modifiedAt) return { saved: false, conflict: 'changed' }
  }
  await fs.writeFile(path, data, true)
  const after = await fs.stat(path)
  return { saved: true, version: { size: after.size, modifiedAt: after.modifiedAt } }
}
