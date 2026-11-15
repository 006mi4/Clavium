// Suggestions for the command line of a terminal. Pure: it works on the text in front of the
// cursor and on lists that were loaded from the server before. Nothing here talks to a server.
import { BUILTINS, DYNAMIC_KINDS, PREFIX_COMMANDS, PREFIX_VALUE_OPTIONS, SPECS, type ArgSource, type CommandSpec, type DynamicKind } from './completeSpecs'

export type SuggestKind = 'history' | 'command' | 'subcommand' | 'option' | 'file' | 'dir' | 'value'

export interface Suggestion {
  kind: SuggestKind
  label: string
  detail?: string
  /** how many characters in front of the cursor are replaced */
  replace: number
  /** what is typed instead */
  insert: string
}

export interface LineContext {
  /** everything in front of the cursor */
  input: string
  /** the word the cursor is in, as typed (with quotes and backslashes); empty after a space */
  token: string
  /** the same word without quoting */
  value: string
  /** an opening quote of the word that is not closed yet */
  quote: '' | "'" | '"'
  /** the program of the command the cursor is in; undefined while the program itself is typed */
  command?: string
  /** the finished words after the program */
  args: string[]
  /** the word is the target of a redirection (> file) */
  redirect: boolean
}

/** What has to be known from the server to complete a line. */
export type CompletionNeed = { kind: 'commands' } | { kind: 'dir'; path: string } | { kind: DynamicKind; cwd: string }

export interface CompletionData {
  /** programs in PATH; undefined until loaded */
  commands?: string[]
  /** newest first */
  history: string[]
  /** entries of a folder, folders end with a slash; undefined until loaded */
  dir(path: string): string[] | undefined
  dynamic(kind: DynamicKind, cwd: string): string[] | undefined
}

export const MAX_SUGGESTIONS = 40
const count = (s: string): number => [...s].length

/** Split the text in front of the cursor the way a shell reads it. */
export function parseLine(input: string): LineContext {
  let words: string[] = []
  let raw = ''
  let value = ''
  let quote: '' | "'" | '"' = ''
  let inWord = false
  let pendingRedirect = false
  let wordIsRedirect = false
  const endWord = (): void => {
    if (inWord && !wordIsRedirect) words.push(value)
    raw = ''
    value = ''
    inWord = false
    wordIsRedirect = false
  }
  const startWord = (): void => {
    if (!inWord) {
      inWord = true
      wordIsRedirect = pendingRedirect
      pendingRedirect = false
    }
  }
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote === "'") {
      raw += ch
      if (ch === "'") quote = ''
      else value += ch
    } else if (quote === '"') {
      raw += ch
      if (ch === '"') quote = ''
      else if (ch === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
        raw += input[++i]
        value += input[i]
      } else value += ch
    } else if (ch === '\\') {
      startWord()
      raw += ch
      if (i + 1 < input.length) {
        raw += input[++i]
        value += input[i]
      }
    } else if (ch === "'" || ch === '"') {
      startWord()
      raw += ch
      quote = ch
    } else if (ch === ' ' || ch === '\t') {
      endWord()
    } else if (ch === '|' || ch === ';' || ch === '&' || ch === '(' || ch === '`' || ch === '\n') {
      // a new command starts; "2>&1" is a redirection, not a new command
      if (ch === '&' && (raw.endsWith('>') || pendingRedirect)) {
        raw += ch
        value += ch
        continue
      }
      endWord()
      words = []
      pendingRedirect = false
    } else if (ch === '>' || ch === '<') {
      // "2>" belongs to the redirection, not to the words
      if (inWord && /^\d*$/.test(value)) {
        raw = ''
        value = ''
        inWord = false
      } else endWord()
      pendingRedirect = true
    } else {
      startWord()
      raw += ch
      value += ch
    }
  }
  const current = inWord || quote !== ''
  // Leave out what stands in front of the program: VAR=value and commands like sudo with their options.
  let start = 0
  for (;;) {
    while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start])) start++
    if (start < words.length && PREFIX_COMMANDS.has(words[start])) {
      const takesValue = PREFIX_VALUE_OPTIONS[words[start]] ?? ''
      start++
      while (start < words.length && words[start].startsWith('-')) {
        // "sudo -u www-data": the word after such an option is its value, not the program
        const opt = words[start]
        start += opt.length === 2 && takesValue.includes(opt[1]) ? 2 : 1
      }
      start = Math.min(start, words.length)
      continue
    }
    break
  }
  const rest = words.slice(start)
  return {
    input,
    token: current ? raw : '',
    value: current ? value : '',
    quote,
    command: rest[0],
    args: rest.slice(1),
    redirect: current ? wordIsRedirect : pendingRedirect
  }
}

/** The spec the cursor is in, after walking down the subcommands that were typed. */
export function resolveSpec(command: string, args: string[]): { spec: CommandSpec | undefined; root: CommandSpec | undefined; positional: number } {
  const root = SPECS[command]
  let spec = root
  let positional = 0
  for (const arg of args) {
    if (arg.startsWith('-')) continue
    const next: CommandSpec | undefined = spec?.sub?.[arg]
    if (next) {
      spec = next
      positional = 0
    } else positional++
  }
  return { spec, root, positional }
}

const SPECIAL = /[\s!"#$&'()*;<>?[\\\]`{|}]/g

/** A path the way it is typed at a prompt: special characters get a backslash. */
export function escapePath(path: string): string {
  const tilde = path === '~' || path.startsWith('~/') ? '~' : ''
  return tilde + path.slice(tilde.length).replace(SPECIAL, '\\$&')
}

function joinPath(cwd: string, dir: string): string {
  if (dir.startsWith('/') || dir === '~' || dir.startsWith('~/')) return dir
  if (!cwd) return ''
  return (cwd.endsWith('/') ? cwd : cwd + '/') + dir
}

/** The folder whose entries complete the word, and the part of the name that is typed. */
function pathParts(value: string, cwd: string): { typedDir: string; base: string; dir: string } {
  const cut = value.lastIndexOf('/')
  const typedDir = cut >= 0 ? value.slice(0, cut + 1) : ''
  const base = cut >= 0 ? value.slice(cut + 1) : value
  return { typedDir, base, dir: value === '~' ? '' : joinPath(cwd, typedDir || './') }
}

function sourcesFor(ctx: LineContext): { spec: CommandSpec | undefined; root: CommandSpec | undefined; sources: readonly ArgSource[] } {
  if (ctx.redirect) return { spec: undefined, root: undefined, sources: ['path'] }
  const { spec, root, positional } = resolveSpec(ctx.command as string, ctx.args)
  const args = spec?.args
  if (!args) return { spec, root, sources: spec?.sub && positional === 0 ? [] : ['path'] }
  if (args.length === 0) return { spec, root, sources: [] }
  // The last kind repeats: "chown user file file ..."
  return { spec, root, sources: [args[Math.min(positional, args.length - 1)]] }
}

const isDynamic = (s: ArgSource): s is DynamicKind => typeof s === 'string' && (DYNAMIC_KINDS as readonly string[]).includes(s)

/** What `suggest` would like to know. The caller loads it and asks again. */
export function completionNeeds(ctx: LineContext, cwd: string): CompletionNeed[] {
  if (ctx.value.startsWith('$')) return []
  if (!ctx.command && !ctx.redirect) {
    // "./script" and "/usr/bin/x" are paths even where a program is expected
    if (ctx.value.includes('/')) {
      const { dir } = pathParts(ctx.value, cwd)
      return dir ? [{ kind: 'dir', path: dir }] : []
    }
    return [{ kind: 'commands' }]
  }
  if (ctx.value.startsWith('-') && !ctx.redirect) return []
  const needs: CompletionNeed[] = []
  for (const source of sourcesFor(ctx).sources) {
    if (source === 'path' || source === 'dir') {
      const { dir } = pathParts(ctx.value, cwd)
      if (dir) needs.push({ kind: 'dir', path: dir })
    } else if (source === 'command') needs.push({ kind: 'commands' })
    else if (isDynamic(source)) needs.push({ kind: source, cwd })
  }
  return needs
}

/** Names that start with what is typed come first, then those that contain it. */
function match<T>(items: readonly T[], typed: string, name: (item: T) => string, loose = false): T[] {
  if (!typed) return [...items]
  const lower = typed.toLowerCase()
  const exact: T[] = []
  const anyCase: T[] = []
  const inside: T[] = []
  for (const item of items) {
    const n = name(item)
    if (n.startsWith(typed)) exact.push(item)
    else if (n.toLowerCase().startsWith(lower)) anyCase.push(item)
    else if (loose && typed.length >= 2 && n.toLowerCase().includes(lower)) inside.push(item)
  }
  return [...exact, ...anyCase, ...inside]
}

function pathSuggestions(ctx: LineContext, data: CompletionData, cwd: string, dirsOnly: boolean): Suggestion[] {
  const { typedDir, base, dir } = pathParts(ctx.value, cwd)
  if (!dir) return []
  const entries = data.dir(dir)
  if (!entries) return []
  const visible = entries.filter((e) => (base.startsWith('.') || !e.startsWith('.')) && (!dirsOnly || e.endsWith('/')))
  return match(visible, base, (e) => e).map((entry): Suggestion => {
    const isDir = entry.endsWith('/')
    const full = typedDir + entry
    // Inside an open quote nothing needs a backslash; the quote is closed after a file name.
    const insert = ctx.quote ? ctx.quote + full + (isDir ? '' : ctx.quote + ' ') : escapePath(full) + (isDir ? '' : ' ')
    return { kind: isDir ? 'dir' : 'file', label: entry, replace: count(ctx.token), insert }
  })
}

function word(kind: SuggestKind, ctx: LineContext, label: string, detail?: string): Suggestion {
  // Names from the server (branches, programs) are escaped like paths: they are typed into a shell.
  return { kind, label, detail, replace: count(ctx.token), insert: escapePath(label) + ' ' }
}

function commandSuggestions(ctx: LineContext, data: CompletionData): Suggestion[] {
  const names = new Set<string>()
  const known = Object.keys(SPECS).filter((n) => !data.commands || data.commands.includes(n) || BUILTINS.includes(n))
  const all = [...known, ...BUILTINS, ...(data.commands ?? [])].filter((n) => !names.has(n) && names.add(n))
  return match(all, ctx.value, (n) => n, true).map((n) => word('command', ctx, n, SPECS[n]?.d))
}

function historySuggestions(ctx: LineContext, data: CompletionData, limit: number, evenEmpty = false): Suggestion[] {
  const typed = ctx.input.trimStart()
  if (!typed && !evenEmpty) return []
  const seen = new Set<string>()
  const out: Suggestion[] = []
  for (const line of data.history) {
    if (out.length >= limit) break
    if (line === typed || !line.startsWith(typed) || seen.has(line)) continue
    seen.add(line)
    out.push({ kind: 'history', label: line, replace: count(typed), insert: line })
  }
  return out
}

/**
 * The suggestions for a line, best first. Lists that are not loaded yet are simply missing.
 * `asked`: the user opened the list with the shortcut. Then there is something to show even where
 * nothing is typed yet: the last commands on an empty line, the programs after "sudo " or a pipe.
 */
export function suggest(ctx: LineContext, data: CompletionData, cwd: string, asked = false): Suggestion[] {
  if (ctx.value.startsWith('$')) return []
  const out: Suggestion[] = []
  if (!ctx.command && !ctx.redirect) {
    out.push(...historySuggestions(ctx, data, asked && !ctx.input.trim() ? 10 : 5, asked))
    if (ctx.value.includes('/')) out.push(...pathSuggestions(ctx, data, cwd, false))
    // On a line that is still empty the last commands say more than a list of every program.
    else if (ctx.value || (asked && (ctx.input.trim() || out.length === 0))) out.push(...commandSuggestions(ctx, data))
  } else {
    const { spec, root, sources } = sourcesFor(ctx)
    if (ctx.value.startsWith('-') && !ctx.redirect) {
      const opts = { ...(spec !== root ? root?.opts : undefined), ...spec?.opts }
      out.push(...match(Object.entries(opts), ctx.value, ([name]) => name).map(([name, detail]) => word('option', ctx, name, detail)))
    } else {
      if (spec?.sub && !ctx.redirect) {
        out.push(...match(Object.entries(spec.sub), ctx.value, ([name]) => name).map(([name, sub]) => word('subcommand', ctx, name, sub.d)))
      }
      for (const source of sources) {
        if (source === 'path' || source === 'dir') out.push(...pathSuggestions(ctx, data, cwd, source === 'dir'))
        else if (source === 'command') out.push(...commandSuggestions(ctx, data))
        else if (isDynamic(source)) out.push(...match(data.dynamic(source, cwd) ?? [], ctx.value, (n) => n, true).map((n) => word('value', ctx, n)))
        else out.push(...match(source as readonly string[], ctx.value, (n) => n).map((n) => word('value', ctx, n)))
      }
      // Options that are not flags ("ps aux", "chmod 755") are offered once something is typed.
      if (ctx.value && spec?.opts) {
        out.push(...match(Object.entries(spec.opts).filter(([n]) => !n.startsWith('-') && !n.startsWith('+')), ctx.value, ([n]) => n).map(([n, d]) => word('option', ctx, n, d)))
      }
    }
    out.push(...historySuggestions(ctx, data, 3))
  }
  // Nothing to do when the only suggestion is what already stands there.
  const useful = out.filter((s) => s.insert.trimEnd() !== (s.kind === 'history' ? ctx.input.trimStart() : ctx.token))
  return useful.slice(0, MAX_SUGGESTIONS)
}

/** The keystrokes that turn the line into the suggestion: backspaces, then the new text. */
export function keystrokes(s: Suggestion, ctx: LineContext): string {
  const old = s.kind === 'history' ? ctx.input.trimStart() : ctx.token
  if (s.insert.startsWith(old)) return s.insert.slice(old.length)
  return '\x7f'.repeat(s.replace) + s.insert
}

// ---- reading lists the server sent ---------------------------------------

/** Lines of bash, zsh and fish history files, newest first, without duplicates. */
export function parseHistory(text: string, limit = 500): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let line = lines[i].replace(/\r$/, '')
    if (/^#\d+$/.test(line)) continue // bash timestamps
    line = line.replace(/^: \d+:\d+;/, '') // zsh extended history
    const fish = /^- cmd: (.*)$/.exec(line)
    if (fish) line = fish[1]
    else if (/^\s+(when|paths):|^\s+- /.test(line)) continue
    line = line.trim()
    // Control characters would be typed into the shell as they are; such lines are left out.
    if (!line || line.length > 500 || /[\x00-\x1f\x7f]/.test(line) || seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/** One name per line. Names with control characters are left out: they could not be typed safely. */
export function parseNames(text: string, limit: number): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split('\n')) {
    const name = raw.replace(/\r$/, '')
    if (!name || name.length > 255 || /[\x00-\x1f\x7f]/.test(name) || seen.has(name)) continue
    seen.add(name)
    out.push(name)
    if (out.length >= limit) break
  }
  return out
}
