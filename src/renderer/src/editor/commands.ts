/**
 * Editing commands of the built-in editor as pure functions.
 * A command looks at the text and selection and returns one replacement (`Edit`) or null when
 * there is nothing to do. The editor applies it as a single undoable step.
 */

export interface Sel {
  text: string
  start: number
  end: number
}

export interface Edit {
  /** replace text[from..to) with `insert` */
  from: number
  to: number
  insert: string
  /** selection afterwards */
  start: number
  end: number
}

/** The whole lines touched by the selection: [from, to) without the final line break. */
export function lineBlock(s: Sel): { from: number; to: number; block: string } {
  const from = s.text.lastIndexOf('\n', s.start - 1) + 1
  // a selection that ends right after a line break does not include the next line
  const endAt = s.end > s.start && s.text[s.end - 1] === '\n' ? s.end - 1 : s.end
  let to = s.text.indexOf('\n', endAt)
  if (to < 0) to = s.text.length
  return { from, to, block: s.text.slice(from, to) }
}

export function indentUnit(text: string): string {
  return /^\t/m.test(text) ? '\t' : '  '
}

export function indent(s: Sel, unit: string): Edit {
  if (!s.text.slice(s.start, s.end).includes('\n')) {
    return { from: s.start, to: s.end, insert: unit, start: s.start + unit.length, end: s.start + unit.length }
  }
  const { from, to, block } = lineBlock(s)
  const lines = block.split('\n')
  const insert = lines.map((l) => (l.length ? unit + l : l)).join('\n')
  return { from, to, insert, start: from, end: from + insert.length }
}

export function outdent(s: Sel, unit: string): Edit | null {
  const { from, to, block } = lineBlock(s)
  const width = unit === '\t' ? 4 : unit.length
  const strip = (l: string): string => (l.startsWith('\t') ? l.slice(1) : l.slice(Math.min(width, /^ */.exec(l)![0].length)))
  const lines = block.split('\n')
  const out = lines.map(strip)
  const insert = out.join('\n')
  if (insert === block) return null
  if (lines.length === 1) {
    const removed = block.length - insert.length
    return { from, to, insert, start: Math.max(from, s.start - removed), end: Math.max(from, s.end - removed) }
  }
  return { from, to, insert, start: from, end: from + insert.length }
}

/** Add or remove a line comment (`#`, `//`, `--`) on every selected line. */
export function toggleComment(s: Sel, prefix: string): Edit {
  const { from, to, block } = lineBlock(s)
  const lines = block.split('\n')
  const filled = lines.filter((l) => l.trim() !== '')
  const allCommented = filled.length > 0 && filled.every((l) => l.trimStart().startsWith(prefix))
  let out: string[]
  if (allCommented) {
    out = lines.map((l) => {
      const i = l.indexOf(prefix)
      if (i < 0) return l
      const after = l.slice(i + prefix.length)
      return l.slice(0, i) + (after.startsWith(' ') ? after.slice(1) : after)
    })
  } else {
    const column = Math.min(...(filled.length ? filled : ['']).map((l) => /^[ \t]*/.exec(l)![0].length))
    out = lines.map((l) => (l.trim() === '' && lines.length > 1 ? l : l.slice(0, column) + prefix + ' ' + l.slice(column)))
  }
  const insert = out.join('\n')
  if (lines.length === 1) {
    const delta = insert.length - block.length
    return { from, to, insert, start: Math.max(from, s.start + delta), end: Math.max(from, s.end + delta) }
  }
  return { from, to, insert, start: from, end: from + insert.length }
}

export function duplicateLines(s: Sel): Edit {
  const { to, block } = lineBlock(s)
  const shift = block.length + 1
  return { from: to, to, insert: '\n' + block, start: s.start + shift, end: s.end + shift }
}

export function deleteLines(s: Sel): Edit {
  const { from, to } = lineBlock(s)
  if (to < s.text.length) return { from, to: to + 1, insert: '', start: from, end: from }
  const start = Math.max(0, from - 1) // last line: remove the line break before it
  return { from: start, to, insert: '', start, end: start }
}

export function moveLines(s: Sel, dir: -1 | 1): Edit | null {
  const { from, to, block } = lineBlock(s)
  if (dir === -1) {
    if (from === 0) return null
    const prevFrom = s.text.lastIndexOf('\n', from - 2) + 1
    const prev = s.text.slice(prevFrom, from - 1)
    const shift = -(prev.length + 1)
    return { from: prevFrom, to, insert: block + '\n' + prev, start: s.start + shift, end: s.end + shift }
  }
  if (to >= s.text.length) return null
  let nextTo = s.text.indexOf('\n', to + 1)
  if (nextTo < 0) nextTo = s.text.length
  const next = s.text.slice(to + 1, nextTo)
  const shift = next.length + 1
  return { from, to: nextTo, insert: next + '\n' + block, start: s.start + shift, end: s.end + shift }
}

function indentOfLine(text: string, pos: number): string {
  const from = text.lastIndexOf('\n', pos - 1) + 1
  return /^[ \t]*/.exec(text.slice(from))![0]
}

export function insertLine(s: Sel, where: 'above' | 'below'): Edit {
  const { from, to } = lineBlock({ ...s, end: s.start })
  const ind = indentOfLine(s.text, s.start)
  if (where === 'below') return { from: to, to, insert: '\n' + ind, start: to + 1 + ind.length, end: to + 1 + ind.length }
  return { from, to: from, insert: ind + '\n', start: from + ind.length, end: from + ind.length }
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
const CLOSERS = new Set(Object.values(OPENERS))
const WRAPPERS: Record<string, string> = { ...OPENERS, '"': '"', "'": "'", '`': '`' }

/** Enter: keep the indentation, indent one more after an opening bracket. */
export function newline(s: Sel, unit: string): Edit {
  const lineFrom = s.text.lastIndexOf('\n', s.start - 1) + 1
  const ind = /^[ \t]*/.exec(s.text.slice(lineFrom, s.start))![0]
  const before = s.text[s.start - 1]
  const after = s.text[s.end]
  if (before && OPENERS[before]) {
    const inner = '\n' + ind + unit
    const pos = s.start + inner.length
    // caret between a pair like {|}: put the closing bracket on its own line
    return { from: s.start, to: s.end, insert: OPENERS[before] === after ? inner + '\n' + ind : inner, start: pos, end: pos }
  }
  const insert = '\n' + ind
  return { from: s.start, to: s.end, insert, start: s.start + insert.length, end: s.start + insert.length }
}

/** Typing a bracket or quote: wrap the selection, close brackets, or step over a closing bracket. */
export function typeChar(s: Sel, ch: string): Edit | null {
  if (s.start !== s.end && WRAPPERS[ch]) {
    const inner = s.text.slice(s.start, s.end)
    return { from: s.start, to: s.end, insert: ch + inner + WRAPPERS[ch], start: s.start + 1, end: s.end + 1 }
  }
  if (s.start !== s.end) return null
  const next = s.text[s.start]
  if (CLOSERS.has(ch) && next === ch) return { from: s.start, to: s.start, insert: '', start: s.start + 1, end: s.start + 1 }
  if (OPENERS[ch] && (next === undefined || /[\s)\]},;]/.test(next))) {
    return { from: s.start, to: s.start, insert: ch + OPENERS[ch], start: s.start + 1, end: s.start + 1 }
  }
  return null
}

/** Backspace inside an empty pair like (|) removes both characters. */
export function backspace(s: Sel): Edit | null {
  if (s.start !== s.end || s.start === 0) return null
  const before = s.text[s.start - 1]
  if (OPENERS[before] && s.text[s.start] === OPENERS[before]) {
    return { from: s.start - 1, to: s.start + 1, insert: '', start: s.start - 1, end: s.start - 1 }
  }
  return null
}

export function changeCase(s: Sel, upper: boolean): Edit | null {
  if (s.start === s.end) return null
  const sel = s.text.slice(s.start, s.end)
  const insert = upper ? sel.toUpperCase() : sel.toLowerCase()
  return insert === sel ? null : { from: s.start, to: s.end, insert, start: s.start, end: s.start + insert.length }
}

/** Home: jump to the first non-blank character, or to column 1 if already there. */
export function smartHome(text: string, pos: number): number {
  const from = text.lastIndexOf('\n', pos - 1) + 1
  const first = from + /^[ \t]*/.exec(text.slice(from))![0].length
  return pos === first ? from : first
}

export function offsetOfLine(text: string, line: number): number {
  let pos = 0
  for (let i = 1; i < line; i++) {
    const next = text.indexOf('\n', pos)
    if (next < 0) return pos
    pos = next + 1
  }
  return pos
}

// ---------------------------------------------------------------- search --

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/** Build the search expression; returns an error message for an invalid regular expression. */
export function buildSearch(query: string, o: SearchOptions): { re: RegExp | null; error?: string } {
  if (!query) return { re: null }
  let source = o.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (o.wholeWord) source = `\\b(?:${source})\\b`
  try {
    return { re: new RegExp(source, o.caseSensitive ? 'gm' : 'gim') }
  } catch (e) {
    return { re: null, error: (e as Error).message.replace(/^Invalid regular expression: /, '') }
  }
}

export const MAX_MATCHES = 10_000

/** All matches as [from, to) pairs, capped at MAX_MATCHES. Empty matches are skipped. */
export function findMatches(text: string, re: RegExp | null): [number, number][] {
  if (!re) return []
  const out: [number, number][] = []
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && out.length < MAX_MATCHES) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    out.push([m.index, m.index + m[0].length])
  }
  return out
}

/** Replacement text for one match (supports $1 … in regex mode, literal text otherwise). */
export function replacementFor(matchText: string, re: RegExp, replacement: string, regexMode: boolean): string {
  if (!regexMode) return replacement
  const single = new RegExp(re.source, re.flags.replace('g', ''))
  return matchText.replace(single, replacement)
}

export function replaceAll(text: string, re: RegExp, replacement: string, regexMode: boolean): { text: string; count: number } {
  let count = 0
  re.lastIndex = 0
  const out = text.replace(re, (...args) => {
    const match = args[0] as string
    if (match.length === 0) return match
    count++
    return replacementFor(match, re, replacement, regexMode)
  })
  return { text: out, count }
}

// ------------------------------------------------------------ decoration --

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' }
const SCAN_LIMIT = 50_000

/** Positions of the bracket next to the caret and its partner, or null. */
export function matchBracket(text: string, pos: number): [number, number] | null {
  for (const at of [pos - 1, pos]) {
    const ch = text[at]
    if (!ch || !PAIRS[ch]) continue
    const forward = ch in OPENERS
    const partner = PAIRS[ch]
    let depth = 0
    const stop = forward ? Math.min(text.length, at + SCAN_LIMIT) : Math.max(-1, at - SCAN_LIMIT)
    for (let i = at; i !== stop; i += forward ? 1 : -1) {
      if (text[i] === ch) depth++
      else if (text[i] === partner && --depth === 0) return forward ? [at, i] : [i, at]
    }
  }
  return null
}

/** Other places where the selected word occurs (only for a selection that is one whole word). */
export function wordOccurrences(text: string, start: number, end: number, max = 2000): [number, number][] {
  const word = text.slice(start, end)
  if (word.length < 2 || word.length > 100 || !/^[\w$-]+$/.test(word)) return []
  if (/[\w$]/.test(text[start - 1] ?? '') || /[\w$]/.test(text[end] ?? '')) return []
  // `word` only contains letters, digits, _ $ and - (checked above); $ needs escaping
  const re = new RegExp('(?<![\\w$])' + word.split('$').join('\\$') + '(?![\\w$])', 'g')
  const out: [number, number][] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null && out.length < max) out.push([m.index, m.index + word.length])
  return out.length > 1 ? out : []
}

export interface Mark {
  from: number
  to: number
  cls: string
}

/** HTML for the decoration layer: transparent text with <mark> boxes. Overlapping marks are dropped. */
export function renderMarks(text: string, marks: Mark[], escape: (s: string) => string): string {
  const sorted = [...marks].sort((a, b) => a.from - b.from)
  let out = ''
  let last = 0
  for (const m of sorted) {
    if (m.from < last || m.to <= m.from) continue
    out += escape(text.slice(last, m.from)) + `<mark class="${m.cls}">` + escape(text.slice(m.from, m.to)) + '</mark>'
    last = m.to
  }
  return out + escape(text.slice(last))
}
