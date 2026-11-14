import type { TextFile, TextFileVersion, TextWriteResult } from '@shared/types'
import type { RemoteFs } from './remotefs'

/** Files larger than this are not opened in the editor (download them instead). */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

const BOM = Buffer.from([0xef, 0xbb, 0xbf])

/**
 * Decode a file for editing. Refuses anything that is not clean UTF-8 text, because
 * editing and re-saving such a file would silently corrupt it.
 */
export function decodeText(buf: Buffer): Pick<TextFile, 'text' | 'eol' | 'bom'> {
  const bom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM)
  const body = bom ? buf.subarray(3) : buf
  if (body.includes(0)) throw new Error('This is a binary file and can’t be edited as text.')
  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    throw new Error('This file is not UTF-8 text and can’t be edited without damaging it.')
  }
  const crlf = (raw.match(/\r\n/g) ?? []).length
  const loneLf = (raw.match(/(?<!\r)\n/g) ?? []).length
  const eol: TextFile['eol'] = crlf > 0 && loneLf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : 'lf'
  return { text: raw.replace(/\r\n/g, '\n'), eol, bom }
}

/** Inverse of decodeText: restores the original line endings and BOM. Mixed endings become LF. */
export function encodeText(text: string, eol: TextFile['eol'], bom: boolean): Buffer {
  const normalized = text.replace(/\r\n/g, '\n')
  const body = Buffer.from(eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized, 'utf8')
  return bom ? Buffer.concat([BOM, body]) : body
}

export async function readTextFile(fs: RemoteFs, path: string): Promise<TextFile> {
  const st = await fs.stat(path)
  if (st.type === 'dir') throw new Error('This is a folder.')
  if (st.size > MAX_TEXT_BYTES) throw new Error('This file is larger than 2 MB. Download it to edit it.')
  const r = await fs.readFile(path, MAX_TEXT_BYTES + 1)
  if (r.truncated || r.data.length > MAX_TEXT_BYTES) throw new Error('This file is larger than 2 MB. Download it to edit it.')
  return { ...decodeText(r.data), version: { size: st.size, modifiedAt: st.modifiedAt } }
}

/**
 * Save an edited file. If the file on the server no longer looks like the version that was
 * opened (someone else changed it), nothing is written unless `force` is set.
 */
export async function writeTextFile(
  fs: RemoteFs,
  path: string,
  file: Pick<TextFile, 'text' | 'eol' | 'bom'>,
  expected: TextFileVersion,
  force: boolean
): Promise<TextWriteResult> {
  const data = encodeText(file.text, file.eol, file.bom)
  if (data.length > MAX_TEXT_BYTES) throw new Error('The text is larger than 2 MB and can’t be saved from the editor.')
  if (!force) {
    const now = await fs.stat(path).catch(() => null)
    if (!now) return { saved: false, conflict: 'deleted' }
    if (now.size !== expected.size || now.modifiedAt !== expected.modifiedAt) return { saved: false, conflict: 'changed' }
  }
  await fs.writeFile(path, data, true)
  const after = await fs.stat(path)
  return { saved: true, version: { size: after.size, modifiedAt: after.modifiedAt } }
}
