import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_COMMAND, decodeAddress, parseActivity, parseCommands, parseHolders, signalCommand, signalError, withUsage, type ParsedActivity } from '../src/main/core/activity'

/** The fields of /proc/<pid>/stat after the name: state ppid … with ticks, flags and start time. */
function stat(pid: number, name: string, ppid: number, o: { used?: number; start?: number; kernel?: boolean; state?: string } = {}): string {
  const f = new Array<string | number>(50).fill(0)
  f[0] = ppid
  f[5] = o.kernel ? 0x00200000 | 0x40 : 0x400000
  f[10] = o.used ?? 0
  f[11] = 0
  f[18] = o.start ?? pid * 10
  return `${pid} (${name}) ${o.state ?? 'S'} ${f.join(' ')}`
}

const HEAD = (pid: number, content: string): string => `==> /proc/${pid}/cmdline <==\n${content}`

function output(o: { self?: string; proc?: string[]; hide?: string; tcp?: string[]; tcp6?: string[]; udp?: string[]; ss?: string[]; fd?: string[]; cmd?: string; total?: number } = {}): string {
  const proc = o.proc ?? [
    `0 12000 ${stat(1, 'systemd', 0, { used: 500 })}`,
    `0 0 ${stat(2, 'kthreadd', 0, { kernel: true })}`,
    `0 9000 ${stat(800, 'sshd', 1)}`,
    `1000 7000 ${stat(900, 'sshd', 800)}`,
    `1000 1500 ${stat(901, 'sh', 900)}`,
    `33 250000 ${stat(1200, 'nginx', 1, { used: 4000 })}`,
    `33 90000 ${stat(1201, 'nginx', 1200, { used: 100 })}`,
    `1000 480000 ${stat(1500, 'node (my app)', 1, { used: 2000, state: 'R' })}`,
    `1001 3000 ${stat(1600, 'backup', 1)}`
  ]
  return [
    '##self', o.self ?? '901 1000',
    '##cpu', `cpu  ${o.total ?? 100000} 0 0 0 0 0 0 0 0 0`, '4',
    '##mem', 'MemTotal:       16000000 kB',
    '##hide', o.hide ?? 'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
    '##passwd', 'root:0', 'www-data:33', 'tim:1000',
    '##proc', ...proc,
    '##tcp', ...(o.tcp ?? [
      '   0: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5001 1 0000000000000000 100 0 0 10 0',
      '   1: 0100007F:0CEA 00000000:0000 0A 00000000:00000000 00:00000000 00000000   114        0 5002 1 0000000000000000 100 0 0 10 0',
      '   2: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 100 0 0 10 0',
      '   3: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5004 1 0000000000000000 100 0 0 10 0',
      '   4: 00000000:0801 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 0 1 0000000000000000 100 0 0 10 0'
    ]),
    '##tcp6', ...(o.tcp6 ?? ['   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5005 1 0000000000000000 100 0 0 10 0']),
    '##udp', ...(o.udp ?? ['   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops', '  501: 3500007F:0035 00000000:0000 07 00000000:00000000 00:00000000 00000000   101        0 5006 2 0000000000000000 0']),
    '##udp6',
    '##ss', ...(o.ss ?? ['found', 'Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process', 'tcp   LISTEN 0      511          0.0.0.0:3000      0.0.0.0:*    users:(("node",pid=1500,fd=21)) uid:1000 ino:5003 sk:5 cgroup:/user.slice <->', 'tcp   LISTEN 0      128          0.0.0.0:22        0.0.0.0:*    ino:5001 sk:1 <->']),
    '##fd', ...(o.fd ?? []),
    '##cmd', o.cmd ?? [HEAD(1, '/sbin/init\0splash\0'), HEAD(2, ''), HEAD(800, 'sshd: /usr/sbin/sshd -D [listener]\0'), HEAD(1200, 'nginx: master process /usr/sbin/nginx\0'), HEAD(1500, 'node\0/srv/app/server.js\0--port\x003000\0')].join('\n'),
    '',
    '##end',
    ''
  ].join('\n')
}

const ok = (text: string): Extract<ParsedActivity, { supported: true }> => {
  const p = parseActivity(text)
  if (!p.supported) throw new Error('expected Linux')
  return p
}

describe('processes', () => {
  it('reads name, command line, user, memory and state', () => {
    const { activity } = ok(output())
    const node = activity.processes.find((p) => p.pid === 1500)
    // a name with spaces and brackets, as a program may give itself
    expect(node).toMatchObject({ name: 'node (my app)', command: 'node /srv/app/server.js --port 3000', user: 'tim', uid: 1000, state: 'R', memory: 480000 * 1024, own: true, kernel: false, ppid: 1, cpu: null })
    expect(activity.processes.find((p) => p.pid === 2)).toMatchObject({ kernel: true, command: '', name: 'kthreadd' })
    // a user the server has no name for
    expect(activity.processes.find((p) => p.pid === 1600)).toMatchObject({ user: 'uid 1001', own: false })
    expect(activity.self).toEqual({ uid: 1000, user: 'tim', root: false })
    expect(activity.memTotal).toBe(16000000 * 1024)
    expect(activity.hidden).toBe(false)
  })

  it('marks the processes this connection runs through, but not the first process of the server', () => {
    const { activity } = ok(output())
    expect(activity.processes.filter((p) => p.connection).map((p) => p.pid)).toEqual([800, 900, 901])
  })

  it('computes the share of a processor from two measurements, and tells a reused number apart', () => {
    const first = ok(output())
    const alone = withUsage(first, null)
    expect(alone.supported && alone.processes.every((p) => p.cpu === null)).toBe(true)
    // 1200 ticks of all four cores passed: 300 are one core for the whole time
    const second = ok(
      output({
        total: 101200,
        proc: [
          `0 12000 ${stat(1, 'systemd', 0, { used: 500 })}`,
          `33 250000 ${stat(1200, 'nginx', 1, { used: 4150 })}`,
          `1000 480000 ${stat(1500, 'node', 1, { used: 2600 })}`,
          `1001 3000 ${stat(1600, 'other', 1, { used: 5, start: 99999 })}`,
          `1000 100 ${stat(1700, 'new', 1, { used: 30 })}`
        ]
      })
    )
    const a = withUsage(second, first.raw)
    if (!a.supported) throw new Error('expected Linux')
    const cpu = (pid: number): number | null => a.processes.find((p) => p.pid === pid)?.cpu ?? null
    expect(cpu(1)).toBe(0)
    expect(cpu(1200)).toBe(50)
    // two whole cores
    expect(cpu(1500)).toBe(200)
    // the number 1600 belongs to another process now: nothing to compare with
    expect(cpu(1600)).toBeNull()
    expect(cpu(1700)).toBe(10)
  })

  it('says when the server hides the processes of other users', () => {
    expect(ok(output({ hide: 'proc /proc proc rw,relatime,hidepid=2 0 0' })).activity.hidden).toBe(true)
    expect(ok(output({ hide: 'proc /proc proc rw,relatime,hidepid=invisible 0 0' })).activity.hidden).toBe(true)
    expect(ok(output({ hide: 'nopid1' })).activity.hidden).toBe(true)
  })

  it('does not let a program pose as another through its command line', () => {
    const cmds = parseCommands([HEAD(10, '==> /proc/1/cmdline <=='), HEAD(11, ''), HEAD(12, 'real\0'), HEAD(13, 'a\x1b[31mb\0')].join('\n') + '\n')
    expect(cmds.get(10)).toBe('==> /proc/1/cmdline <==')
    expect(cmds.has(1)).toBe(false)
    expect(cmds.has(11)).toBe(false)
    expect(cmds.get(12)).toBe('real')
    // no control characters reach the page
    expect(cmds.get(13)).toBe('a [31mb')
    // a command line that looks like the end of the answer does not end it
    const { activity } = ok(output({ cmd: [HEAD(1500, '##end'), HEAD(1200, '##proc')].join('\n') }))
    expect(activity.processes.find((p) => p.pid === 1500)?.command).toBe('##end')
    expect(activity.processes).toHaveLength(9)
  })

  it('refuses an answer that was cut off, and says so on another system', () => {
    expect(() => parseActivity(output().replace(/##end\n$/, ''))).toThrow(/expected form/)
    expect(() => parseActivity('hello')).toThrow(/expected form/)
    expect(parseActivity('##unsupported\nFreeBSD\n')).toEqual({ supported: false, os: 'FreeBSD' })
  })
})

describe('open ports', () => {
  it('decodes addresses the way the kernel stores them', () => {
    expect(decodeAddress('0100007F')).toBe('127.0.0.1')
    expect(decodeAddress('0A01A8C0')).toBe('192.168.1.10')
    expect(decodeAddress('00000000000000000000000000000000')).toBe('::')
    expect(decodeAddress('00000000000000000000000001000000')).toBe('::1')
    expect(decodeAddress('0000000000000000FFFF00000100007F')).toBe('127.0.0.1')
    expect(decodeAddress('000080FE00000000FF005450FEB6A2FE')).toBe('fe80::5054:ff:fea2:b6fe')
    expect(decodeAddress('B80D0120000000000000000001000000')).toBe('2001:db8::1')
    expect(decodeAddress('xyz')).toBeNull()
  })

  it('lists listening ports with owner, reach and the program where this user may see it', () => {
    const { activity } = ok(output())
    const port = (n: number, protocol = 'tcp') => activity.ports.find((p) => p.port === n && p.protocol === protocol)
    // sshd belongs to root: this user sees that, but not which program it is. IPv4 and IPv6 are one line.
    expect(port(22)).toEqual({ protocol: 'tcp', port: 22, addresses: ['0.0.0.0', '::'], scope: 'all', uid: 0, user: 'root', pids: [], pid: null, holder: 'hidden', usual: 'SSH' })
    // the user's own program
    expect(port(3000)).toMatchObject({ scope: 'all', user: 'tim', pids: [1500], pid: 1500, holder: 'known' })
    // only reachable on the server itself, owner without a name
    expect(port(3306)).toMatchObject({ addresses: ['127.0.0.1'], scope: 'local', user: 'uid 114', holder: 'hidden', usual: 'MySQL or MariaDB' })
    // a socket of the kernel itself
    expect(port(2049)).toMatchObject({ holder: 'kernel', pids: [] })
    expect(port(53, 'udp')).toMatchObject({ addresses: ['127.0.0.53'], scope: 'local', user: 'uid 101' })
    expect(activity.ports.map((p) => p.port)).toEqual([22, 53, 80, 2049, 3000, 3306])
  })

  it('as root knows every program, and names the one the workers were started by', () => {
    const { activity } = ok(
      output({
        self: '901 0',
        ss: ['found', 'tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1201,fd=6),("nginx",pid=1200,fd=6)) ino:5004 sk:9 <->', 'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=800,fd=3)) ino:5001', 'tcp LISTEN 0 128 [::]:22 [::]:* users:(("sshd",pid=800,fd=4)) ino:5005']
      })
    )
    expect(activity.self.root).toBe(true)
    expect(activity.ports.find((p) => p.port === 80)).toMatchObject({ pids: [1200, 1201], pid: 1200, holder: 'known' })
    expect(activity.ports.find((p) => p.port === 22)).toMatchObject({ pids: [800], addresses: ['0.0.0.0', '::'], holder: 'known' })
    // root sees everything: a port without a program really has none
    expect(activity.ports.find((p) => p.port === 3306)).toMatchObject({ holder: 'none' })
  })

  it('finds the programs through their open files where there is no ss', () => {
    const holders = parseHolders([], ['/proc/1500/fd:', 'lrwx------ 1 tim tim 64 Nov 15 10:00 0 -> /dev/null', 'lrwx------ 1 tim tim 64 Nov 15 10:00 21 -> socket:[5003]', 'lrwx------ 1 tim tim 64 Nov 15 10:00 22 -> socket:[7000]', '/proc/1700/fd:', 'lrwx------    1 tim      tim             64 Nov 15 10:00 3 -> socket:[5003]'])
    expect(holders.get('5003')).toEqual([1500, 1700])
    expect(holders.get('7000')).toEqual([1500])
    const { activity } = ok(output({ ss: [], fd: ['/proc/1500/fd:', 'lrwx------ 1 tim tim 64 Nov 15 10:00 21 -> socket:[5003]'] }))
    expect(activity.ports.find((p) => p.port === 3000)).toMatchObject({ pids: [1500], holder: 'known' })
  })

  it('ignores a holder that is not in the list of processes', () => {
    const { activity } = ok(output({ ss: ['found', 'tcp LISTEN 0 5 0.0.0.0:3000 0.0.0.0:* users:(("x",pid=424242,fd=3)) ino:5003'] }))
    expect(activity.ports.find((p) => p.port === 3000)).toMatchObject({ pids: [], holder: 'none' })
  })
})

describe('ending a process', () => {
  it('refuses numbers and signals that make no sense', () => {
    expect(() => signalCommand(1, '5', 'TERM', false)).toThrow()
    expect(() => signalCommand(12.5, '5', 'TERM', false)).toThrow()
    expect(() => signalCommand(50, '5; rm -rf /', 'TERM', false)).toThrow()
    expect(() => signalCommand(50, '5', 'STOP' as never, false)).toThrow()
    expect(signalCommand(50, '777', 'KILL', true)).toContain('sudo -n kill -KILL 50')
    expect(signalCommand(50, '777', 'TERM', false)).not.toContain('sudo')
  })

  it('explains failures in words', () => {
    expect(signalError(113, '', false)).toMatch(/already ended/)
    expect(signalError(114, '', true)).toMatch(/another one has its number/)
    expect(signalError(1, 'sh: 1: kill: Operation not permitted', false)).toMatch(/may not end this process/)
    expect(signalError(1, 'sudo: a password is required', true)).toMatch(/only use sudo with a password/)
    expect(signalError(1, 'sudo: a terminal is required to read the password; either use the -S option', true)).toMatch(/only use sudo with a password/)
    expect(signalError(1, 'tim is not in the sudoers file.  This incident will be reported.', true)).toMatch(/may not use sudo/)
    expect(signalError(1, 'Sorry, user tim is not allowed to execute \'/usr/bin/kill -TERM 5\' as root on web.', true)).toMatch(/may not use sudo/)
    expect(signalError(127, 'sh: 1: sudo: not found', true)).toMatch(/no sudo on this server/)
    expect(signalError(127, 'sh: sudo: command not found', true)).toMatch(/no sudo on this server/)
    expect(signalError(1, 'kill: (5): No such process', false)).toMatch(/already ended/)
  })

  /** The command with /proc pointing into a folder, run by a real sh. */
  const runMoved = (command: string, root: string): { status: number | null; stderr: string } => {
    const script = /^sh -c '([\s\S]*)'$/.exec(command)?.[1].replace(/'\\''/g, "'")
    if (!script) throw new Error('unexpected form')
    const r = spawnSync('/bin/sh', ['-c', script.replace(/\/proc\//g, `${root}/proc/`)], { encoding: 'utf8' })
    return { status: r.status, stderr: r.stderr }
  }

  it.skipIf(process.platform === 'win32')('really ends the process, but only the one the list showed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-act-'))
    const child = spawn('/bin/sleep', ['60'], { stdio: 'ignore' })
    try {
      const pid = child.pid as number
      const gone = new Promise<string | null>((res) => child.on('exit', (_c, sig) => res(sig)))
      mkdirSync(join(root, 'proc', String(pid)), { recursive: true })
      writeFileSync(join(root, 'proc', String(pid), 'stat'), stat(pid, 'sleep (x) y', 1, { start: 424242 }) + '\n')

      // the number was taken over by another process: nothing happens
      expect(runMoved(signalCommand(pid, '111', 'TERM', false), root).status).toBe(114)
      expect(child.exitCode).toBeNull()
      expect(child.signalCode).toBeNull()
      // a process that no longer exists
      expect(runMoved(signalCommand(pid + 1, '424242', 'TERM', false), root).status).toBe(113)

      expect(runMoved(signalCommand(pid, '424242', 'TERM', false), root).status).toBe(0)
      expect(await gone).toBe('SIGTERM')
    } finally {
      child.kill('SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('the command itself, run by a real sh', () => {
  it.skipIf(process.platform === 'win32')('collects processes, ports and command lines from a Linux file tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-act-'))
    try {
      const put = (path: string, content: string | Buffer): void => {
        mkdirSync(join(root, path, '..'), { recursive: true })
        writeFileSync(join(root, path), content)
      }
      const proc = (pid: number, name: string, ppid: number, uid: number, kb: number, cmdline: string): void => {
        put(`proc/${pid}/stat`, stat(pid, name, ppid, { kernel: kb === 0 }) + '\n')
        put(`proc/${pid}/status`, `Name:\t${name}\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t0\t0\t0\t0\n${kb ? `VmPeak:\t  9999 kB\nVmRSS:\t  ${kb} kB\nRssAnon:\t 1 kB\n` : 'Threads:\t1\n'}`)
        put(`proc/${pid}/cmdline`, Buffer.from(cmdline))
      }
      proc(1, 'init', 0, 0, 1200, '/sbin/init\0')
      proc(2, 'kthreadd', 0, 0, 0, '')
      proc(77, 'my server', 1, 1000, 52000, 'python3\0-m\0http.server\x008000\0')
      put('proc/self/stat', 'x')
      put('proc/stat', 'cpu  10 0 10 80 0 0 0 0 0 0\ncpu0 5 0 5 40 0 0 0 0 0 0\ncpu1 5 0 5 40 0 0 0 0 0 0\nintr 1 2 3\n')
      put('proc/meminfo', 'MemTotal:        2000000 kB\nMemFree: 1 kB\n')
      put('proc/mounts', 'sysfs /sys sysfs rw 0 0\nproc /proc proc rw,relatime,hidepid=2 0 0\n')
      put('etc/passwd', 'root:x:0:0:root:/root:/bin/sh\ntim:x:1000:1000:Tim:/home/tim:/bin/sh\n')
      put('proc/net/tcp', '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 9001 1 0 100 0 0 10 0\n   1: 0100007F:1F40 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 9002 1 0 100 0 0 10 0\n')
      // no ss on this server: the open files of the processes tell who holds the socket
      const bin = join(root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'ls'), `#!/bin/sh\necho "${root}/proc/77/fd:"\necho "lrwx------ 1 tim tim 64 Nov 15 10:00 3 -> socket:[9001]"\necho "lrwx------ 1 tim tim 64 Nov 15 10:00 4 -> /dev/null"\n`)
      writeFileSync(join(bin, 'id'), '#!/bin/sh\necho 1000\n')
      chmodSync(join(bin, 'ls'), 0o755)
      chmodSync(join(bin, 'id'), 0o755)

      const script = /^sh -c '([\s\S]*)'$/.exec(ACTIVITY_COMMAND)?.[1].replace(/'\\''/g, "'")
      if (!script) throw new Error('unexpected form')
      const moved = script.replace(/\/(proc|etc)\//g, `${root}/$1/`).replace('"^/proc"', `"^${root}/proc"`)
      // only the tools every Linux has, and deliberately no ss
      for (const tool of ['grep', 'cut', 'head', 'cat', 'uname']) writeFileSync(join(bin, tool), `#!/bin/sh\nexec ${execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim()} "$@"\n`, { mode: 0o755 })
      const text = execFileSync('/bin/sh', ['-c', moved], { encoding: 'utf8', env: { PATH: bin } }).split(root).join('')

      const { activity, cores } = ok(text)
      expect(cores).toBe(2)
      expect(text).not.toContain('intr')
      expect(activity.memTotal).toBe(2000000 * 1024)
      expect(activity.hidden).toBe(true)
      expect(activity.self).toEqual({ uid: 1000, user: 'tim', root: false })
      expect(activity.processes.map((p) => [p.pid, p.name, p.user, p.memory, p.command, p.kernel])).toEqual([
        [1, 'init', 'root', 1200 * 1024, '/sbin/init', false],
        [2, 'kthreadd', 'root', 0, '', true],
        [77, 'my server', 'tim', 52000 * 1024, 'python3 -m http.server 8000', false]
      ])
      // only the listening socket, not the connection on the same port
      expect(activity.ports).toEqual([{ protocol: 'tcp', port: 8000, addresses: ['0.0.0.0'], scope: 'all', uid: 1000, user: 'tim', pids: [77], pid: 77, holder: 'known', usual: null }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
