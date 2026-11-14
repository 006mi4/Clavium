import type { ScreenInfo, ScreenList } from '@shared/types'

/**
 * GNU screen: long-running programs (game servers, bots, builds) that keep going on the server
 * after the connection is closed. This file knows how to list them, how to fetch what a screen
 * has printed so far, and how to make a terminal scroll normally while attached.
 */

/** Quote a value for a POSIX shell. Screen names may contain spaces and other characters. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Names for new screens: plain characters only, so they are easy to type and to recognise. */
export const SCREEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

const NOT_INSTALLED = 'CLAVIUM_NO_SCREEN'

/** Prints the user's screens, or a marker when screen is not installed. Changes nothing. */
export const LIST_COMMAND = `command -v screen >/dev/null 2>&1 || { echo ${NOT_INSTALLED}; exit 0; }; LC_ALL=C screen -ls 2>/dev/null; true`

/**
 * Parse `screen -ls`. Lines look like "\t1234.minecraft\t(11/15/26 00:35:18)\t(Detached)";
 * the date column is missing on older versions.
 */
export function parseScreenList(output: string): ScreenList {
  if (output.includes(NOT_INSTALLED)) return { installed: false, screens: [] }
  const screens: ScreenInfo[] = []
  for (const line of output.split(/\r?\n/)) {
    const cols = line.split('\t').filter((c) => c !== '')
    if (!line.startsWith('\t') || cols.length < 2) continue
    const m = /^(\d+)\.(.+)$/.exec(cols[0])
    const state = /^\((Attached|Detached|Multi[^)]*|Dead[^)]*)\)$/i.exec(cols[cols.length - 1])
    if (!m || !state || /^dead/i.test(state[1])) continue
    screens.push({
      id: cols[0],
      name: m[2],
      attached: !/^detached$/i.test(state[1]),
      started: cols.length >= 3 ? cols[1].replace(/^\(|\)$/g, '') : undefined
    })
  }
  return { installed: true, screens }
}

const MARK = 'CLAVIUM_SCREEN_HISTORY'
const HISTORY_LINES = 5000

/**
 * Fetch what a screen has printed so far. Screen writes it to a file; a private temporary file is
 * used and deleted right away. Also raises the screen's own history for what comes next.
 */
export function historyCommand(id: string): string {
  const s = shellQuote(id)
  return [
    `echo ${MARK}`,
    `f=$(mktemp) || exit 0`,
    `screen -S ${s} -X hardcopy -h "$f" >/dev/null 2>&1`,
    `i=0; while [ ! -s "$f" ] && [ $i -lt 10 ]; do sleep 0.1; i=$((i+1)); done`,
    `tail -n ${HISTORY_LINES} "$f"; rm -f "$f"`,
    `screen -S ${s} -X scrollback ${HISTORY_LINES} >/dev/null 2>&1; true`
  ].join('; ')
}

/** Text of the first lines screen drew after it last cleared the terminal, without escape codes. */
function firstDrawnLines(drawn: string, count: number): string[] {
  const cleared = Math.max(drawn.lastIndexOf('\x1b[2J'), drawn.lastIndexOf('\x1b[J'))
  const text = drawn
    .slice(cleared < 0 ? 0 : cleared)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // colours, cursor movement, modes
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, '')
  const lines = text.split('\r\n')
  lines.pop() // the last piece may be half a line
  return lines.slice(0, count).map((l) => l.trimEnd())
}

/**
 * Turn the output of `historyCommand` into text for the terminal's scrollback.
 *
 * The history is fetched while the screen is already attached, so nothing printed in between can
 * be lost. It therefore overlaps with what screen has drawn itself: the file ends with the lines
 * that are on the terminal already. The first lines screen drew are looked up in the file, and
 * only what comes before them is returned. If they can't be found, the file is cut `rows` lines
 * before its end, which is where the terminal starts when nothing was printed in the meantime.
 *
 * @param drawn what screen has sent to the terminal since it was attached
 * @param rows height of the terminal
 */
export function parseHistory(output: string, drawn: string, rows: number): string {
  const at = output.indexOf(MARK)
  if (at < 0) return ''
  const lines = output
    .slice(at + MARK.length)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
  const first = firstDrawnLines(drawn, 6)
  let cut = Math.max(0, lines.length - rows)
  if (first.some((l) => l !== '')) {
    for (let i = lines.length - first.length; i >= 0; i--) {
      if (first.every((l, j) => lines[i + j] === l)) {
        cut = i
        break
      }
    }
  }
  const past = lines.slice(0, cut)
  while (past.length && past[0] === '') past.shift()
  if (past.length === 0) return ''
  return past.join('\r\n') + '\r\n'
}

/** Clears the terminal the way screen does before it draws; what was there moves into the scrollback. */
export function pushIntoScrollback(rows: number): string {
  return '\r\n'.repeat(rows)
}

/**
 * Screen switches the terminal to its "alternate screen", which has no scrollback: the mouse
 * wheel would do nothing. These switches are removed from the output, so everything screen
 * prints scrolls into the normal history of the terminal.
 */
export class AltScreenFilter {
  private carry = ''

  push(chunk: string): string {
    let data = this.carry + chunk
    this.carry = ''
    // keep an unfinished escape sequence at the end for the next chunk
    const tail = /\x1b(\[(\?\d*)?)?$/.exec(data)
    if (tail) {
      this.carry = tail[0]
      data = data.slice(0, tail.index)
    }
    return data.replace(/\x1b\[\?(1049|1047|47)[hl]/g, '')
  }
}
