import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { completionNeeds, escapePath, keystrokes, parseHistory, parseLine, parseNames, suggest, type CompletionData } from '../src/shared/complete'
import { CONTEXT_COMMAND, HISTORY_COMMAND, listCommand, parseContext, parseList } from '../src/main/core/completion'

const data = (over: Partial<CompletionData> = {}): CompletionData => ({ history: [], dir: () => undefined, dynamic: () => undefined, ...over })
const labels = (input: string, d: CompletionData = data(), cwd = '/srv'): string[] => suggest(parseLine(input), d, cwd).map((s) => s.label)

describe('reading the command line', () => {
  it('knows whether a program or an argument is typed', () => {
    expect(parseLine('gi')).toMatchObject({ command: undefined, token: 'gi', args: [] })
    expect(parseLine('git ')).toMatchObject({ command: 'git', token: '', args: [] })
    expect(parseLine('git commit -m "a b" fi')).toMatchObject({ command: 'git', args: ['commit', '-m', 'a b'], token: 'fi' })
  })

  it('starts again after a pipe, a semicolon and inside $( )', () => {
    expect(parseLine('cat x | gr')).toMatchObject({ command: undefined, token: 'gr' })
    expect(parseLine('cd /tmp && ls -')).toMatchObject({ command: 'ls', token: '-' })
    expect(parseLine('echo $(git ch')).toMatchObject({ command: 'git', token: 'ch' })
  })

  it('looks through sudo, its options and variables in front of a command', () => {
    expect(parseLine('sudo -u www-data git st')).toMatchObject({ command: 'git', token: 'st' })
    expect(parseLine('FOO=1 BAR=2 doc')).toMatchObject({ command: undefined, token: 'doc' })
    expect(parseLine('sudo ')).toMatchObject({ command: undefined, token: '' })
    // the value of an option is still being typed: nothing to suggest as a program yet
    expect(parseLine('sudo -u ww')).toMatchObject({ command: undefined, token: 'ww' })
    expect(parseLine('watch -n 2 df -')).toMatchObject({ command: 'df', token: '-' })
  })

  it('keeps quoting apart from the value', () => {
    expect(parseLine('cat my\\ fi')).toMatchObject({ token: 'my\\ fi', value: 'my fi', quote: '' })
    expect(parseLine('cat "my fi')).toMatchObject({ token: '"my fi', value: 'my fi', quote: '"' })
    expect(parseLine("cat 'it")).toMatchObject({ value: 'it', quote: "'" })
  })

  it('sees the target of a redirection', () => {
    expect(parseLine('echo hi > ou')).toMatchObject({ redirect: true, token: 'ou', args: ['hi'] })
    expect(parseLine('ls 2>&1 | le')).toMatchObject({ command: undefined, token: 'le' })
    expect(parseLine('cmd 2> ')).toMatchObject({ redirect: true, token: '' })
  })
})

describe('suggestions', () => {
  it('offers programs of the server, described where they are known', () => {
    const d = data({ commands: ['git', 'gzip', 'grep', 'mygit'] })
    const out = suggest(parseLine('gi'), d, '/srv')
    expect(out.map((s) => s.label)).toEqual(['git', 'mygit'])
    expect(out[0]).toMatchObject({ kind: 'command', detail: 'Version control', insert: 'git ', replace: 2 })
    // a known program that the server does not have is not offered
    expect(labels('kube', data({ commands: ['ls'] }))).toEqual([])
    // before the list is loaded, the known ones are
    expect(labels('kube')).toEqual(['kubectl'])
  })

  it('offers subcommands, then options, then what the subcommand takes', () => {
    expect(labels('git ch')).toEqual(['checkout', 'cherry-pick'])
    expect(labels('git commit --a')).toEqual(['--amend'])
    expect(labels('systemctl restart ng', data({ dynamic: (kind) => (kind === 'systemd-unit' ? ['nginx.service', 'ssh.service'] : undefined) }))).toEqual(['nginx.service'])
    expect(labels('docker compose u')).toEqual(['up'])
    expect(labels('docker logs -')).toEqual(['-f', '--tail', '-t', '--since'])
  })

  it('knows the long spellings of options, after the short ones', () => {
    expect(labels('ls --al')).toEqual(['--all', '--almost-all'])
    expect(labels('ls -').slice(0, 2)).toEqual(['-l', '-a'])
    expect(labels('grep --ign')).toEqual(['--ignore-case'])
    expect(labels('rm --he')).toEqual(['--help'])
    // an option that was already known keeps its place and its text
    const color = suggest(parseLine('grep --col'), data(), '/srv')
    expect(color.map((s) => [s.label, s.detail])).toEqual([['--color', 'Highlight the hits']])
  })

  it('completes paths against the folder of the shell', () => {
    const d = data({ dir: (path) => (path === '/srv/./' ? ['www/', 'readme.txt', '.env', 'my file.txt'] : path === '/srv/www/' ? ['index.html'] : undefined) })
    expect(completionNeeds(parseLine('cat re'), '/srv')).toEqual([{ kind: 'dir', path: '/srv/./' }])
    expect(completionNeeds(parseLine('cat www/in'), '/srv')).toEqual([{ kind: 'dir', path: '/srv/www/' }])
    expect(completionNeeds(parseLine('cat ~/x'), '/srv')).toEqual([{ kind: 'dir', path: '~/' }])
    expect(completionNeeds(parseLine('cat /etc/ho'), '')).toEqual([{ kind: 'dir', path: '/etc/' }])
    // without a known folder a relative path cannot be completed
    expect(completionNeeds(parseLine('cat re'), '')).toEqual([])
    expect(labels('cat ', d)).toEqual(['www/', 'readme.txt', 'my file.txt'])
    expect(labels('cat .', d)).toEqual(['.env'])
    expect(labels('cd ', d)).toEqual(['www/'])
    expect(labels('cat www/', d)).toEqual(['index.html'])
    const file = suggest(parseLine('cat my'), d, '/srv')[0]
    expect(file).toMatchObject({ kind: 'file', insert: 'my\\ file.txt ', replace: 2 })
    expect(suggest(parseLine('cat "my'), d, '/srv')[0].insert).toBe('"my file.txt" ')
    expect(suggest(parseLine('cd w'), d, '/srv')[0].insert).toBe('www/')
  })

  it('offers lines of the history that start with what is typed', () => {
    const d = data({ history: ['git push origin main', 'git pull', 'ls', 'git push origin main'] })
    const out = suggest(parseLine('git pu'), d, '/srv')
    expect(out.filter((s) => s.kind === 'history').map((s) => s.label)).toEqual(['git push origin main', 'git pull'])
    expect(keystrokes(out.find((s) => s.kind === 'history')!, parseLine('git pu'))).toBe('sh origin main')
    expect(labels('', d)).toEqual([])
  })

  it('has something to show where nothing is typed yet, once the list is asked for with the shortcut', () => {
    const d = data({ history: ['git pull', 'ls -la', 'git pull'], commands: ['git', 'ls'] })
    const asked = (input: string, with_: CompletionData = d): string[] => suggest(parseLine(input), with_, '/srv', true).map((s) => s.label)
    // an empty line: the last commands, and only those
    expect(asked('')).toEqual(['git pull', 'ls -la'])
    expect(keystrokes(suggest(parseLine(''), d, '/srv', true)[0], parseLine(''))).toBe('git pull')
    // without a history the programs are better than nothing
    expect(asked('', data({ commands: ['git', 'ls'] }))).toContain('git')
    // where a program is expected after something else
    expect(asked('sudo ')).toContain('git')
    expect(asked('cat x | ')).toContain('ls')
    // subcommands need no shortcut
    expect(labels('git ')).toContain('checkout')
    expect(labels('sudo ', d)).toEqual([])
  })

  it('types a suggestion with as few keys as possible', () => {
    const ctx = parseLine('git Ch')
    const s = suggest(ctx, data(), '/srv')[0]
    expect(s.label).toBe('checkout')
    // the typed part differs in case: it is deleted and typed again
    expect(keystrokes(s, ctx)).toBe('\x7f\x7fcheckout ')
    const same = parseLine('git ch')
    expect(keystrokes(suggest(same, data(), '/srv')[0], same)).toBe('eckout ')
  })

  it('never types a name from the server unescaped', () => {
    const d = data({ dynamic: () => ['feat/$(reboot)', 'main'] })
    const out = suggest(parseLine('git checkout fe'), d, '/srv')
    expect(out[0].insert).toBe('feat/\\$\\(reboot\\) ')
    expect(escapePath('~/a b')).toBe('~/a\\ b')
    expect(escapePath('a;b|c&d')).toBe('a\\;b\\|c\\&d')
  })
})

describe('lists from the server', () => {
  it('reads bash, zsh and fish history, newest first, without lines that would run by themselves', () => {
    const text = ['#1700000000', 'ls -la', ': 1700000001:0;git status', '- cmd: docker ps', '  when: 1700000002', 'ls -la', 'evil\x1b[A', 'x'.repeat(600)].join('\n')
    expect(parseHistory(text)).toEqual(['ls -la', 'docker ps', 'git status'])
  })

  it('drops names with control characters', () => {
    expect(parseNames('a\nb\r\n\nbad\x07name\na\n', 10)).toEqual(['a', 'b'])
    expect(parseList({ kind: 'git-branch', cwd: '' }, 'main\nfeature/x\nwith space\n$(x)\n')).toEqual(['main', 'feature/x'])
    expect(parseList({ kind: 'user', cwd: '' }, 'root\nwww-data\nbad;name\n')).toEqual(['root', 'www-data'])
  })

  it('understands what the server says about the terminal', () => {
    expect(parseContext('motd\n__clavium_ctx__\n-bash\n/srv/www\n/home/tim\n')).toEqual({ cwd: '/srv/www', home: '/home/tim', busy: false })
    expect(parseContext('__clavium_ctx__\n/usr/bin/vim\n/srv\n/root\n')).toMatchObject({ busy: true })
    expect(parseContext('__clavium_ctx__\nzsh\n\n/home/tim\n')).toEqual({ cwd: '', home: '/home/tim', busy: false })
    // a server without ps: nothing is known, and nothing is held back
    expect(parseContext('__clavium_ctx__\n\n\n/home/tim\n')).toEqual({ cwd: '', home: '/home/tim', busy: false })
    expect(parseContext('garbage')).toEqual({ cwd: '', home: '', busy: false })
  })
})

// The commands themselves, run by a real shell. Windows has no sh; the servers do.
describe.skipIf(process.platform === 'win32')('commands that fetch the lists', () => {
  const run = (command: string, env: NodeJS.ProcessEnv = {}): string => execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, ...env } })

  it('lists a folder whose name tries to break out of the quoting', () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-complete-'))
    try {
      const nasty = join(root, `it's $(touch ${root}/pwned); "x"`)
      mkdirSync(join(nasty, 'sub'), { recursive: true })
      writeFileSync(join(nasty, 'file.txt'), '')
      writeFileSync(join(nasty, '.hidden'), '')
      const need = { kind: 'dir' as const, path: nasty + '/' }
      expect(parseList(need, run(listCommand(need))).sort()).toEqual(['.hidden', 'file.txt', 'sub/'])
      expect(parseList({ kind: 'dir', path: root }, run(listCommand({ kind: 'dir', path: root })))).toHaveLength(1)
      // "~" means the home folder, and only at the start
      mkdirSync(join(root, 'home', 'docs'), { recursive: true })
      expect(parseList({ kind: 'dir', path: '~/' }, run(listCommand({ kind: 'dir', path: '~/' }), { HOME: join(root, 'home') }))).toEqual(['docs/'])
      // a folder that does not exist gives nothing, and no error
      expect(run(listCommand({ kind: 'dir', path: join(root, 'missing') }) + '; true')).toBe('')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists programs, branches and the history', () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-complete-'))
    try {
      mkdirSync(join(root, 'bin'))
      writeFileSync(join(root, 'bin', 'mytool'), '')
      expect(parseList({ kind: 'commands' }, run(listCommand({ kind: 'commands' }), { PATH: `${join(root, 'bin')}:/bin:/usr/bin` }))).toEqual(expect.arrayContaining(['mytool', 'ls']))
      writeFileSync(join(root, '.bash_history'), 'ls\ngit status\n')
      expect(parseHistory(run(HISTORY_COMMAND, { HOME: root, HISTFILE: '' }))).toEqual(['git status', 'ls'])
      const git = (...args: string[]): string => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' })
      git('init', '-q', '-b', 'main')
      git('commit', '-q', '--allow-empty', '-m', 'x')
      git('branch', 'feature/login')
      const need = { kind: 'git-branch' as const, cwd: root }
      expect(parseList(need, run(listCommand(need))).sort()).toEqual(['feature/login', 'main'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // The same search that runs on a server, with Python standing in for sshd: it gives its child a
  // terminal just like sshd does.
  it.skipIf(process.platform !== 'darwin')('finds the shell of the terminal and its folder below the process that owns the terminal', () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-complete-'))
    try {
      const probe = CONTEXT_COMMAND.replace('sshd*|*/sshd*', '[Pp]ython*|*/[Pp]ython*')
      expect(probe).not.toBe(CONTEXT_COMMAND)
      writeFileSync(join(root, 'probe.sh'), `cd ${JSON.stringify(root)} && ${probe}\n`)
      const withTerminal = [
        'import os, pty, sys',
        'pid, fd = pty.fork()',
        'if pid == 0:',
        '    os.execv("/bin/sh", ["/bin/sh", sys.argv[1]])',
        'out = b""',
        'while True:',
        '    try:',
        '        data = os.read(fd, 4096)',
        '    except OSError:',
        '        break',
        '    if not data:',
        '        break',
        '    out += data',
        'os.waitpid(pid, 0)',
        'sys.stdout.buffer.write(out)'
      ].join('\n')
      const out = execFileSync('python3', ['-c', withTerminal, join(root, 'probe.sh')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).replace(/\r/g, '')
      const context = parseContext(out)
      expect(context.busy).toBe(false)
      // macOS reaches the temporary folder through /private
      expect(context.cwd.replace(/^\/private/, '')).toBe(root.replace(/^\/private/, ''))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('asks for the place of the shell without failing where there is no sshd above it', () => {
    const out = parseContext(run(CONTEXT_COMMAND))
    expect(out.busy).toBe(false)
    expect(out.home).toBe(process.env.HOME)
  })
})
