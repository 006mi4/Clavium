import { describe, expect, it } from 'vitest'
import {
  backspace,
  buildSearch,
  changeCase,
  deleteLines,
  duplicateLines,
  findMatches,
  indent,
  insertLine,
  moveLines,
  newline,
  offsetOfLine,
  outdent,
  replaceAll,
  replacementFor,
  smartHome,
  toggleComment,
  typeChar,
  type Edit,
  type Sel
} from '../src/renderer/src/editor/commands'

/** "a[b]c" → selection around b; "a|c" → caret. */
function sel(marked: string): Sel {
  if (marked.includes('|')) {
    const i = marked.indexOf('|')
    return { text: marked.replace('|', ''), start: i, end: i }
  }
  const start = marked.indexOf('[')
  const end = marked.indexOf(']') - 1
  return { text: marked.replace('[', '').replace(']', ''), start, end }
}

/** Apply an edit and show the result in the same notation. */
function run(marked: string, cmd: (s: Sel) => Edit | null): string {
  const s = sel(marked)
  const e = cmd(s)
  if (!e) return 'null'
  const text = s.text.slice(0, e.from) + e.insert + s.text.slice(e.to)
  return e.start === e.end ? text.slice(0, e.start) + '|' + text.slice(e.start) : text.slice(0, e.start) + '[' + text.slice(e.start, e.end) + ']' + text.slice(e.end)
}

describe('indentation', () => {
  it('inserts at the caret or indents every selected line', () => {
    expect(run('ab|c', (s) => indent(s, '  '))).toBe('ab  |c')
    expect(run('a\n[b\nc]\nd', (s) => indent(s, '  '))).toBe('a\n[  b\n  c]\nd')
    expect(run('[a\n\nb]', (s) => indent(s, '\t'))).toBe('[\ta\n\n\tb]') // blank lines stay empty
  })

  it('outdents spaces and tabs', () => {
    expect(run('    a|b', (s) => outdent(s, '  '))).toBe('  a|b')
    expect(run('[  a\n\tb\n c]', (s) => outdent(s, '  '))).toBe('[a\nb\nc]')
    expect(run('a|b', (s) => outdent(s, '  '))).toBe('null')
  })
})

describe('line commands', () => {
  it('duplicates, deletes and moves lines', () => {
    expect(run('a\nb|b\nc', duplicateLines)).toBe('a\nbb\nb|b\nc')
    expect(run('a\nb|b\nc', deleteLines)).toBe('a\n|c')
    expect(run('a\nb|', deleteLines)).toBe('a|') // last line
    expect(run('only|', deleteLines)).toBe('|')
    expect(run('a\nb|b\nc', (s) => moveLines(s, -1))).toBe('b|b\na\nc')
    expect(run('a\nb|b\nc', (s) => moveLines(s, 1))).toBe('a\nc\nb|b')
    expect(run('a|\nb', (s) => moveLines(s, -1))).toBe('null')
    expect(run('a\nb|', (s) => moveLines(s, 1))).toBe('null')
    expect(run('x\n[a\nb]\ny', (s) => moveLines(s, 1))).toBe('x\ny\n[a\nb]')
  })

  it('inserts lines above and below with the same indentation', () => {
    expect(run('  a|b\nc', (s) => insertLine(s, 'below'))).toBe('  ab\n  |\nc')
    expect(run('  a|b\nc', (s) => insertLine(s, 'above'))).toBe('  |\n  ab\nc')
  })

  it('toggles comments', () => {
    expect(run('  po|rt: 1', (s) => toggleComment(s, '#'))).toBe('  # po|rt: 1')
    expect(run('  # po|rt: 1', (s) => toggleComment(s, '#'))).toBe('  po|rt: 1')
    expect(run('[  a\n    b\n\n  c]', (s) => toggleComment(s, '//'))).toBe('[  // a\n  //   b\n\n  // c]')
    expect(run('[  // a\n  //   b\n\n  // c]', (s) => toggleComment(s, '//'))).toBe('[  a\n    b\n\n  c]')
    // a mix of commented and uncommented lines gets commented, not half-uncommented
    expect(run('[# a\nb]', (s) => toggleComment(s, '#'))).toBe('[# # a\n# b]')
  })
})

describe('typing helpers', () => {
  it('keeps indentation on Enter and indents after an opening bracket', () => {
    expect(run('  a|', (s) => newline(s, '  '))).toBe('  a\n  |')
    expect(run('  f(|', (s) => newline(s, '  '))).toBe('  f(\n    |')
    expect(run('x {|}', (s) => newline(s, '\t'))).toBe('x {\n\t|\n}')
  })

  it('closes brackets, steps over closers, wraps selections and deletes empty pairs', () => {
    expect(run('f|', (s) => typeChar(s, '('))).toBe('f(|)')
    expect(run('f|x', (s) => typeChar(s, '('))).toBe('null') // not in front of a word
    expect(run('f(|)', (s) => typeChar(s, ')'))).toBe('f()|')
    expect(run('a [b] c', (s) => typeChar(s, '"'))).toBe('a "[b]" c')
    expect(run("it|", (s) => typeChar(s, "'"))).toBe('null') // quotes are never auto-closed
    expect(run('f(|)', backspace)).toBe('f|')
    expect(run('f(a|)', backspace)).toBe('null')
  })

  it('changes case and jumps home smartly', () => {
    expect(run('a [bC] d', (s) => changeCase(s, true))).toBe('a [BC] d')
    expect(run('a [bC] d', (s) => changeCase(s, false))).toBe('a [bc] d')
    expect(smartHome('x\n    abc', 9)).toBe(6)
    expect(smartHome('x\n    abc', 6)).toBe(2)
    expect(offsetOfLine('a\nbb\nccc', 3)).toBe(5)
    expect(offsetOfLine('a\nbb', 99)).toBe(2)
  })
})

describe('search and replace', () => {
  const opts = { caseSensitive: false, wholeWord: false, regex: false }

  it('finds plain text, respecting case and whole words', () => {
    const text = 'Port port export PORT'
    expect(findMatches(text, buildSearch('port', opts).re)).toHaveLength(4)
    expect(findMatches(text, buildSearch('port', { ...opts, caseSensitive: true }).re)).toEqual([
      [5, 9],
      [12, 16]
    ])
    expect(findMatches(text, buildSearch('port', { ...opts, wholeWord: true }).re)).toHaveLength(3)
    // special characters are literal unless regex mode is on
    expect(findMatches('a.b axb', buildSearch('a.b', opts).re)).toEqual([[0, 3]])
    expect(findMatches('a.b axb', buildSearch('a.b', { ...opts, regex: true }).re)).toHaveLength(2)
  })

  it('reports invalid expressions and survives empty matches', () => {
    expect(buildSearch('(', { ...opts, regex: true }).error).toBeTruthy()
    expect(buildSearch('', opts).re).toBeNull()
    expect(findMatches('abc', buildSearch('x*', { ...opts, regex: true }).re)).toEqual([])
    expect(findMatches('a\nb\n', buildSearch('^', { ...opts, regex: true }).re)).toEqual([])
  })

  it('replaces one or all, with groups in regex mode and literal text otherwise', () => {
    const re = buildSearch('(\\w+)=(\\d+)', { ...opts, regex: true }).re as RegExp
    expect(replaceAll('a=1 b=2', re, '$2=$1', true)).toEqual({ text: '1=a 2=b', count: 2 })
    expect(replacementFor('a=1', re, '$1', true)).toBe('a')
    const lit = buildSearch('a', opts).re as RegExp
    expect(replaceAll('a A b', lit, '$1', false)).toEqual({ text: '$1 $1 b', count: 2 })
    expect(replaceAll('abc', buildSearch('zzz', opts).re as RegExp, 'x', false)).toEqual({ text: 'abc', count: 0 })
  })
})
