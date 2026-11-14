/**
 * Small syntax highlighter for the built-in editor.
 *
 * Each language is a list of (token class, regular expression) rules. The rules are joined into
 * one expression and matched left to right over the whole text, so strings and comments that
 * span lines work without any state. Output is HTML made only of escaped text and
 * <span class="t-…"> wrappers; file content can never inject markup.
 *
 * Token classes: c comment · s string · n number · k keyword · f function · t tag/section ·
 * a attribute/key/variable · m markup/meta · d deleted (diff)
 */

type Rule = [cls: string, source: string]

interface Language {
  name: string
  rules: Rule[]
  keywords?: string[]
  /** keywords and rules ignore case */
  insensitive?: boolean
}

const DQ = `"(?:[^"\\\\\\n]|\\\\.)*"?`
const SQ = `'(?:[^'\\\\\\n]|\\\\.)*'?`
const BT = '`(?:[^`\\\\]|\\\\[\\s\\S])*`?'
const NUM = `\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b`
const BLOCK = `\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))`
const SLASH = `\\/\\/.*`
const HASH = `#.*`
const WORD = `[A-Za-z_$][\\w$]*`

function clike(name: string, keywords: string, extra: Rule[] = [], opts: { hash?: boolean; backtick?: boolean } = {}): Language {
  const rules: Rule[] = [['c', BLOCK], ['c', SLASH]]
  if (opts.hash) rules.push(['c', HASH])
  rules.push(...extra, ['s', DQ], ['s', SQ])
  if (opts.backtick) rules.push(['s', BT])
  rules.push(['n', NUM], ['w', WORD])
  return { name, rules, keywords: keywords.split(' ') }
}

const JS_KEYWORDS =
  'abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield'

const LANGUAGES: Record<string, Language> = {
  plain: { name: 'Plain Text', rules: [] },

  json: {
    name: 'JSON',
    rules: [['c', BLOCK], ['c', SLASH], ['a', `"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)`], ['s', DQ], ['n', `-?${NUM}`], ['k', `\\b(?:true|false|null)\\b`]]
  },

  yaml: {
    name: 'YAML',
    rules: [
      ['c', `(?<=^|\\s)#.*`],
      ['m', `^(?:---|\\.\\.\\.)\\s*$`],
      ['a', `^[ \\t]*(?:- +)*[^\\s#:'"\\[\\]{},&*!|>][^:#\\n]*?(?=:(?:\\s|$))`],
      ['s', DQ],
      ['s', SQ],
      ['m', `[&*][\\w-]+`],
      ['n', NUM],
      ['k', `\\b(?:true|false|null|yes|no|on|off)\\b`]
    ],
    insensitive: true
  },

  ini: {
    name: 'Config',
    rules: [
      ['c', `^\\s*[#;].*`],
      ['t', `^\\s*\\[\\[?[^\\]\\n]*\\]?\\]?`],
      ['a', `^\\s*[\\w.\\-]+(?=\\s*[=:])`],
      ['s', DQ],
      ['s', SQ],
      ['n', NUM],
      ['k', `\\b(?:true|false|yes|no|on|off|null|none)\\b`]
    ],
    insensitive: true
  },

  conf: {
    name: 'Config',
    rules: [['c', HASH], ['s', DQ], ['s', SQ], ['a', `\\$\\{?\\w+\\}?`], ['k', `^[ \\t]*[A-Za-z_][\\w.\\-]*`], ['n', NUM]]
  },

  shell: {
    name: 'Shell',
    rules: [['c', `(?<=^|\\s)#.*`], ['s', DQ], ['s', `'[^']*'?`], ['a', `\\$(?:\\{[^}\\n]*\\}?|[\\w@#?*!$]+)`], ['n', NUM], ['w', `[A-Za-z_][\\w-]*`]],
    keywords:
      'if then else elif fi for while until do done case esac in function select time return exit break continue local export readonly declare unset shift source alias echo printf read cd set trap eval exec test true false sudo'.split(
        ' '
      )
  },

  dockerfile: {
    name: 'Dockerfile',
    rules: [
      ['c', `^\\s*#.*`],
      ['k', `^\\s*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b`],
      ['k', `\\bAS\\b`],
      ['s', DQ],
      ['s', SQ],
      ['a', `\\$\\{?\\w+\\}?`],
      ['n', NUM]
    ],
    insensitive: true
  },

  markdown: {
    name: 'Markdown',
    rules: [
      ['s', '^```[\\s\\S]*?(?:^```|(?![\\s\\S]))'],
      ['m', `^#{1,6} .*`],
      ['c', `^>.*`],
      ['s', '`[^`\\n]+`'],
      ['k', `\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__`],
      ['a', `!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)`],
      ['m', `^\\s*(?:[-*+]|\\d+\\.)(?= )`],
      ['c', `<!--[\\s\\S]*?-->`]
    ]
  },

  html: {
    name: 'HTML',
    rules: [
      ['c', `<!--[\\s\\S]*?(?:-->|(?![\\s\\S]))`],
      ['m', `<![^>\\n]*>|<\\?[\\s\\S]*?\\?>`],
      ['t', `<\\/?[A-Za-z][\\w:.-]*|\\/?>`],
      ['a', `[A-Za-z_:@][\\w:.-]*(?=\\s*=)`],
      ['s', DQ],
      ['s', SQ],
      ['n', `&#?\\w+;`]
    ]
  },

  css: {
    name: 'CSS',
    rules: [
      ['c', BLOCK],
      ['c', `\\/\\/.*`],
      ['s', DQ],
      ['s', SQ],
      ['k', `@[\\w-]+|!important`],
      ['n', `#[\\da-fA-F]{3,8}\\b`],
      ['a', `[\\w-]+(?=\\s*:[^:])|--[\\w-]+`],
      ['n', `-?(?:\\d+\\.?\\d*|\\.\\d+)(?:%|[a-zA-Z]+)?`],
      ['t', `[.#][A-Za-z_][\\w-]*`]
    ]
  },

  javascript: clike('JavaScript', JS_KEYWORDS, [], { backtick: true }),
  typescript: clike('TypeScript', JS_KEYWORDS + ' any boolean number string symbol unknown never keyof infer is namespace module satisfies', [], { backtick: true }),

  python: {
    name: 'Python',
    rules: [
      ['c', HASH],
      ['s', `(?:[rbfuRBFU]{0,2})(?:"""[\\s\\S]*?(?:"""|(?![\\s\\S]))|'''[\\s\\S]*?(?:'''|(?![\\s\\S])))`],
      ['s', `(?:[rbfuRBFU]{0,2})${DQ}`],
      ['s', `(?:[rbfuRBFU]{0,2})${SQ}`],
      ['m', `^\\s*@[\\w.]+`],
      ['n', NUM],
      ['w', `[A-Za-z_]\\w*`]
    ],
    keywords:
      'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case'.split(
        ' '
      )
  },

  php: clike(
    'PHP',
    'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends false final finally fn for foreach function global if implements include include_once instanceof interface isset list match namespace new null or print private protected public readonly require require_once return static switch throw trait true try unset use var while xor yield',
    [['a', `\\$\\w+`], ['m', `<\\?(?:php|=)?|\\?>`]],
    { hash: true }
  ),

  go: clike('Go', 'break case chan const continue default defer else fallthrough false for func go goto if import interface iota map nil package range return select struct switch true type var', [], { backtick: true }),
  rust: clike('Rust', 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
  c: clike(
    'C / C++',
    'auto bool break case catch char class const constexpr continue default delete do double else enum explicit extern false float for friend goto if inline int long namespace new nullptr operator private protected public return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while',
    [['m', `^\\s*#\\s*\\w+`]]
  ),
  java: clike(
    'Java / C#',
    'abstract as async await base bool boolean break byte case catch char class const continue default do double else enum extends false final finally float for foreach get if implements import in instanceof int interface internal is long namespace new null object out override package params private protected public readonly record ref return sealed set short static string super switch this throw throws true try using var virtual void volatile while',
    [['m', `@\\w+`]]
  ),
  lua: { name: 'Lua', rules: [['c', `--\\[\\[[\\s\\S]*?(?:\\]\\]|(?![\\s\\S]))`], ['c', `--.*`], ['s', DQ], ['s', SQ], ['n', NUM], ['w', WORD]], keywords: 'and break do else elseif end false for function goto if in local nil not or repeat return then true until while'.split(' ') },
  ruby: { name: 'Ruby', rules: [['c', HASH], ['s', DQ], ['s', SQ], ['a', `:[A-Za-z_]\\w*|@{1,2}\\w+`], ['n', NUM], ['w', `[A-Za-z_]\\w*[?!]?`]], keywords: 'alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo require rescue retry return self super then true undef unless until when while yield'.split(' ') },

  sql: {
    name: 'SQL',
    rules: [['c', `--.*`], ['c', BLOCK], ['s', `'(?:[^']|'')*'?`], ['s', DQ], ['n', NUM], ['w', `[A-Za-z_]\\w*`]],
    keywords:
      'add all alter and as asc begin between by case check column commit constraint create cross database default delete desc distinct drop else end exists foreign from full grant group having if in index inner insert into is join key left like limit not null offset on or order outer primary references revoke right rollback select set table then transaction union unique update values view when where with'.split(
        ' '
      ),
    insensitive: true
  },

  diff: { name: 'Diff', rules: [['m', `^(?:@@.*|diff .*|index .*|---.*|\\+\\+\\+.*)`], ['s', `^\\+.*`], ['d', `^-.*`]] },

  log: {
    name: 'Log',
    rules: [
      ['c', `\\b\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}:\\d{2}(?:[.,]\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?`],
      ['d', `\\b(?:ERROR|FATAL|CRITICAL|FAIL(?:ED)?|PANIC)\\b`],
      ['m', `\\b(?:WARN(?:ING)?)\\b`],
      ['k', `\\b(?:INFO|NOTICE|DEBUG|TRACE)\\b`],
      ['s', DQ],
      ['n', `\\b\\d{1,3}(?:\\.\\d{1,3}){3}(?::\\d+)?\\b`]
    ],
    insensitive: true
  }
}

const BY_EXTENSION: Record<string, string> = {
  json: 'json', jsonc: 'json', webmanifest: 'json', map: 'json',
  yml: 'yaml', yaml: 'yaml',
  ini: 'ini', toml: 'ini', env: 'ini', properties: 'ini', cfg: 'ini', cnf: 'ini', service: 'ini', timer: 'ini', socket: 'ini', desktop: 'ini', editorconfig: 'ini', gitconfig: 'ini',
  conf: 'conf', config: 'conf', htaccess: 'conf', nginx: 'conf',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', profile: 'shell', bashrc: 'shell', zshrc: 'shell', bash_profile: 'shell', bash_aliases: 'shell',
  md: 'markdown', markdown: 'markdown',
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', xhtml: 'html', plist: 'html',
  css: 'css', scss: 'css', less: 'css',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', pyw: 'python',
  php: 'php', phtml: 'php',
  go: 'go', rs: 'rust',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', hpp: 'c', cxx: 'c',
  java: 'java', cs: 'java', kt: 'java', swift: 'java', dart: 'java',
  lua: 'lua', rb: 'ruby',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
  log: 'log'
}

const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'conf', gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby',
  'nginx.conf': 'conf', 'httpd.conf': 'conf', 'apache2.conf': 'conf', sshd_config: 'conf', ssh_config: 'conf', hosts: 'conf', fstab: 'conf', crontab: 'conf',
  authorized_keys: 'plain', known_hosts: 'plain'
}

/** Pick a language id from the file name, falling back to a #! line. */
export function detectLanguage(fileName: string, firstLine = ''): string {
  const name = fileName.toLowerCase()
  if (BY_NAME[name]) return BY_NAME[name]
  if (name.startsWith('dockerfile')) return 'dockerfile'
  if (name.startsWith('.env')) return 'ini'
  const ext = name.includes('.') ? (name.split('.').pop() as string) : ''
  if (BY_EXTENSION[ext]) return BY_EXTENSION[ext]
  const m = /^#!.*?\b(bash|sh|zsh|python\d?|node|ruby|php|lua)\b/.exec(firstLine)
  if (m) return m[1].startsWith('python') ? 'python' : m[1] === 'node' ? 'javascript' : ['bash', 'sh', 'zsh'].includes(m[1]) ? 'shell' : m[1]
  if (/\.(conf|cfg|rc)(\.|$)/.test(name) || name.endsWith('rc')) return 'conf'
  return 'plain'
}

export function languageName(id: string): string {
  return (LANGUAGES[id] ?? LANGUAGES.plain).name
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const compiled = new Map<string, { re: RegExp; classes: string[]; keywords: Set<string> | null; insensitive: boolean }>()

function compile(id: string) {
  let c = compiled.get(id)
  if (!c) {
    const lang = LANGUAGES[id] ?? LANGUAGES.plain
    c = {
      re: new RegExp(lang.rules.map(([, src]) => `(${src})`).join('|') || '(?!)', lang.insensitive ? 'gmi' : 'gm'),
      classes: lang.rules.map(([cls]) => cls),
      keywords: lang.keywords ? new Set(lang.insensitive ? lang.keywords.map((k) => k.toLowerCase()) : lang.keywords) : null,
      insensitive: !!lang.insensitive
    }
    compiled.set(id, c)
  }
  return c
}

/** Returns HTML for `text` highlighted as language `id`. All file content is escaped. */
export function highlight(text: string, id: string): string {
  const c = compile(id)
  if (c.classes.length === 0) return escapeHtml(text)
  const re = c.re
  re.lastIndex = 0
  let out = ''
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const token = m[0]
    if (token.length === 0) {
      re.lastIndex++
      continue
    }
    let cls = ''
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) {
        cls = c.classes[i - 1]
        break
      }
    }
    if (cls === 'w') {
      // identifier: keyword, function call or plain text
      const word = c.insensitive ? token.toLowerCase() : token
      cls = c.keywords?.has(word) ? 'k' : text[re.lastIndex] === '(' ? 'f' : ''
    }
    if (m.index > last) out += escapeHtml(text.slice(last, m.index))
    out += cls ? `<span class="t-${cls}">${escapeHtml(token)}</span>` : escapeHtml(token)
    last = re.lastIndex
  }
  if (last < text.length) out += escapeHtml(text.slice(last))
  return out
}

const LINE_COMMENT: Record<string, string> = {
  yaml: '#', ini: '#', conf: '#', shell: '#', dockerfile: '#', python: '#', ruby: '#',
  json: '//', javascript: '//', typescript: '//', php: '//', go: '//', rust: '//', c: '//', java: '//',
  sql: '--', lua: '--'
}

/** The line-comment marker of a language, or null if it has none (HTML, CSS, Markdown, …). */
export function lineCommentOf(id: string): string | null {
  return LINE_COMMENT[id] ?? null
}

/** Languages for the manual picker, by display name. */
export const LANGUAGE_LIST: { id: string; name: string }[] = Object.entries(LANGUAGES)
  .map(([id, l]) => ({ id, name: id === 'conf' ? 'Config (nginx, Apache, …)' : id === 'ini' ? 'Config (INI, TOML, .env)' : l.name }))
  .sort((a, b) => (a.id === 'plain' ? -1 : b.id === 'plain' ? 1 : a.name.localeCompare(b.name)))

/** Adds a line-number marker in front of every line (used when long lines are wrapped). */
export function withLineMarkers(html: string): string {
  let n = 1
  return '<b data-n="1"></b>' + html.replace(/\n/g, () => `\n<b data-n="${++n}"></b>`)
}
