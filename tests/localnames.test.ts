import { describe, expect, it } from 'vitest'
import { safeLocalName } from '../src/main/core/queue'

describe('local names for files of a server', () => {
  it('never end in a dot or a space, also after a long name was shortened', () => {
    // Windows drops such endings in most programs, so a file named like that could not be opened there
    expect(safeLocalName('notes. ')).toBe('notes')
    expect(safeLocalName('a'.repeat(199) + '. tail')).toBe('a'.repeat(199))
    expect(safeLocalName('b'.repeat(198) + '  .x')).toBe('b'.repeat(198))
    expect(safeLocalName('c'.repeat(300))).toBe('c'.repeat(200))
    expect(safeLocalName('...')).toBe('_')
  })

  it('keeps reserved and unsafe names out', () => {
    expect(safeLocalName('CON')).toBe('_CON')
    expect(safeLocalName('nul.txt')).toBe('_nul.txt')
    expect(safeLocalName('con.')).toBe('_con')
    expect(safeLocalName('..\\..\\evil.cmd')).toBe('.._.._evil.cmd')
    expect(safeLocalName('a:b?.txt')).toBe('a_b_.txt')
    expect(safeLocalName('Größe und Maße.txt')).toBe('Größe und Maße.txt')
  })
})
