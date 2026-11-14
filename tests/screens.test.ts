import { describe, expect, it } from 'vitest'
import { AltScreenFilter, historyCommand, parseHistory, parseScreenList, shellQuote } from '../src/main/core/screens'

describe('screen list', () => {
  it('reads the output of screen -ls, with and without dates, with spaces in names', () => {
    const out = 'There are screens on:\r\n\t990.minecraft\t(11/15/26 00:35:18)\t(Detached)\n\t993.my web\t(11/15/26 00:35:18)\t(Attached)\n\t17.old\t(Multi, attached)\n\t5.gone\t(Dead ???)\n2 Sockets in /run/screen/S-tim.\r\n'
    expect(parseScreenList(out)).toEqual({
      installed: true,
      screens: [
        { id: '990.minecraft', name: 'minecraft', attached: false, started: '11/15/26 00:35:18' },
        { id: '993.my web', name: 'my web', attached: true, started: '11/15/26 00:35:18' },
        { id: '17.old', name: 'old', attached: true, started: undefined }
      ]
    })
  })

  it('tells "no screens" from "screen is not installed"', () => {
    expect(parseScreenList('No Sockets found in /run/screen/S-tim.\r\n')).toEqual({ installed: true, screens: [] })
    expect(parseScreenList('CLAVIUM_NO_SCREEN\n')).toEqual({ installed: false, screens: [] })
  })

  it('quotes names so the shell cannot run anything in them', () => {
    expect(shellQuote('1.a b')).toBe(`'1.a b'`)
    expect(shellQuote(`1.x'; rm -rf ~; '`)).toBe(String.raw`'1.x'\''; rm -rf ~; '\'''`)
    expect(historyCommand(`1.x'y`)).toContain(String.raw`-S '1.x'\''y' -X hardcopy`)
  })
})

describe('screen history', () => {
  const lines = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => `[12:00:${String(from + i).padStart(2, '0')}] line ${from + i}`)
  const file = (from: number, to: number): string => `CLAVIUM_SCREEN_HISTORY\n${lines(from, to).join('\n')}\n\n`
  /** what screen sends when it draws these lines on a cleared terminal */
  const drawn = (from: number, to: number): string => `\x1b[?1h\x1b=\x1b[1;5r\x1b[H\x1b[2J\x1b[0m` + lines(from, to).join('\r\n') + '\r\n'

  it('returns exactly what came before the lines screen has drawn itself', () => {
    // screen drew lines 6-10; the file was read a moment later and already ends with line 12
    expect(parseHistory(file(1, 12), drawn(6, 10) + '[12:00:11] line 11\r\n[12:00:12] line 12\r\n', 5)).toBe(lines(1, 5).join('\r\n') + '\r\n')
    // colours in what screen draws don't matter, the file has plain text
    expect(parseHistory(file(1, 10), drawn(6, 10).replace('[12:00:06]', '\x1b[32m[12:00:06]\x1b[0m'), 5)).toBe(lines(1, 5).join('\r\n') + '\r\n')
  })

  it('falls back to the height of the terminal when the drawn lines are not in the file', () => {
    expect(parseHistory(file(1, 10), '\x1b[H\x1b[2Jsomething else\r\n', 4)).toBe(lines(1, 7).join('\r\n') + '\r\n')
    expect(parseHistory(file(1, 10), '', 4)).toBe(lines(1, 7).join('\r\n') + '\r\n')
  })

  it('returns nothing when there is no history yet', () => {
    expect(parseHistory(file(1, 4), drawn(1, 4), 5)).toBe('')
    expect(parseHistory('screen failed', drawn(1, 4), 24)).toBe('')
  })
})

describe('alternate screen filter', () => {
  it('removes the switch to the screen without scrollback, also when it is split across chunks', () => {
    const f = new AltScreenFilter()
    expect(f.push('a\x1b[?1049hb\x1b[1;24r')).toBe('ab\x1b[1;24r')
    expect(f.push('c\x1b[?10') + f.push('49hd') + f.push('\x1b') + f.push('[?1049le')).toBe('cde')
    expect(f.push('\x1b[?25l\x1b[31mred\x1b[?1h')).toBe('\x1b[?25l\x1b[31mred\x1b[?1h') // everything else passes
  })
})
