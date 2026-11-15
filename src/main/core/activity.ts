// What runs on a server and which ports are open: one command that only reads, and the functions
// that read its output. As with the load, everything comes from /proc, which is the same on every
// Linux; the tables of ps, top or netstat differ between distributions and are not used.
//
// What a user may see depends on its rights, and the answer says so instead of guessing:
// - /proc can be mounted so that a user only sees its own processes (hidepid).
// - Which program holds a port is only visible for the user's own programs, unless it is root.
//   The owner of a port (a user) is always visible.
// Nothing here uses sudo. Reading with sudo every few seconds would fill the log of the server.
import type { MonitorActivity, MonitorPort, MonitorProcess, MonitorSignal } from '@shared/types'
import { shellQuote } from './screens'

const SCRIPT = [
  'if [ ! -r /proc/stat ] || [ ! -r /proc/self/stat ]; then echo "##unsupported"; uname -s 2>/dev/null; exit 0; fi',
  'echo "##self"; echo "$$ $(id -u 2>/dev/null)"',
  'echo "##cpu"; read -r l < /proc/stat; echo "$l"; grep -c "^cpu[0-9]" /proc/stat',
  'echo "##mem"; read -r l < /proc/meminfo; echo "$l"',
  'echo "##hide"; [ -r /proc/1/stat ] || echo nopid1; grep " /proc proc " /proc/mounts 2>/dev/null | head -n 1',
  'echo "##passwd"; cut -d: -f1,3 /etc/passwd 2>/dev/null',
  // Per process: the user, the memory in kB (independent of the page size) and the line of
  // /proc/<pid>/stat. Only builtins of the shell, so hundreds of processes start no program.
  'echo "##proc"',
  'for d in /proc/[0-9]*; do',
  '  u=; m=0',
  '  while read -r k v r; do case "$k" in Uid:) u=$v;; VmRSS:) m=$v; break;; esac; done < "$d/status"',
  '  read -r l < "$d/stat" && echo "$u $m $l"',
  'done 2>/dev/null',
  // sockets that wait for connections (state 0A) and bound UDP sockets, with owner and inode
  'echo "##tcp"; grep " 0A " /proc/net/tcp 2>/dev/null',
  'echo "##tcp6"; grep " 0A " /proc/net/tcp6 2>/dev/null',
  'echo "##udp"; cat /proc/net/udp 2>/dev/null',
  'echo "##udp6"; cat /proc/net/udp6 2>/dev/null',
  // which process holds which socket: ss knows, otherwise the open files of the processes
  'echo "##ss"; if command -v ss >/dev/null 2>&1; then echo found; ss -tulnpe 2>/dev/null; fi',
  `echo "##fd"; command -v ss >/dev/null 2>&1 || ls -l /proc/[0-9]*/fd 2>/dev/null | grep -e "^/proc" -e "socket:"`,
  // Command lines last: they are text of the programs themselves and may contain anything.
  'echo "##cmd"; head -n 1 /proc/[0-9]*/cmdline 2>/dev/null; echo; echo "##end"'
].join('\n')

export const ACTIVITY_COMMAND = `sh -c ${shellQuote(SCRIPT)}`

/** The counters the next measurement is compared with. */
export interface ActivityRaw {
  /** all ticks of all processors together */
  total: number
  /** per process: its ticks, and when it started (a reused number is a different process) */
  ticks: Map<number, { used: number; start: string }>
}

export type ParsedActivity = { supported: false; os: string } | { supported: true; raw: ActivityRaw; cores: number; activity: Omit<Extract<MonitorActivity, { supported: true }>, 'supported'> }

/** What usually listens on a port. A hint for the reader, never a statement about the program. */
const USUAL: Record<number, string> = {
  21: 'FTP', 22: 'SSH', 25: 'mail (SMTP)', 53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'web (HTTP)', 110: 'mail (POP3)', 111: 'RPC', 123: 'time (NTP)', 143: 'mail (IMAP)',
  323: 'time (chrony)', 443: 'web (HTTPS)', 465: 'mail (SMTP)', 587: 'mail (SMTP)', 631: 'printing', 993: 'mail (IMAP)', 995: 'mail (POP3)', 1433: 'SQL Server', 1883: 'MQTT',
  2049: 'NFS', 2375: 'Docker', 2376: 'Docker', 3000: 'a web app', 3306: 'MySQL or MariaDB', 3389: 'remote desktop', 5353: 'mDNS', 5432: 'PostgreSQL', 5672: 'RabbitMQ', 5900: 'VNC',
  6379: 'Redis', 6443: 'Kubernetes', 8080: 'web (HTTP)', 8443: 'web (HTTPS)', 9090: 'Prometheus', 9100: 'node exporter', 9200: 'Elasticsearch', 11211: 'Memcached', 27017: 'MongoDB', 51820: 'WireGuard'
} // prettier-ignore

/** "0100007F" is 127.0.0.1: each 32 bit word is stored with its bytes reversed. */
export function decodeAddress(hex: string): string | null {
  if (!/^([0-9A-Fa-f]{8}){1,4}$/.test(hex) || (hex.length !== 8 && hex.length !== 32)) return null
  const bytes: number[] = []
  for (let w = 0; w < hex.length; w += 8) for (let b = 6; b >= 0; b -= 2) bytes.push(parseInt(hex.slice(w + b, w + b + 2), 16))
  if (bytes.length === 4) return bytes.join('.')
  // an IPv4 address inside IPv6
  if (bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join('.')
  const groups: string[] = []
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16))
  // the longest run of zero groups becomes "::"
  let best = -1
  let bestLen = 1
  for (let i = 0; i < 8; i++) {
    let j = i
    while (j < 8 && groups[j] === '0') j++
    if (j - i > bestLen) {
      best = i
      bestLen = j - i
    }
  }
  if (best < 0) return groups.join(':')
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`
}

function scopeOf(address: string): MonitorPort['scope'] {
  if (address === '0.0.0.0' || address === '::') return 'all'
  if (address === '::1' || address.startsWith('127.')) return 'local'
  return 'address'
}

function split(text: string): { sections: Map<string, string[]>; commands: string } | null {
  const body = text.replace(/\r\n/g, '\n')
  const cut = body.indexOf('\n##cmd\n')
  // the end mark is the very last line: a command line cannot fake it, it would not be last
  if (cut < 0 || !/\n##end\n?$/.test(body)) return null
  const sections = new Map<string, string[]>()
  let cur: string[] | null = null
  for (const line of body.slice(0, cut).split('\n')) {
    if (line.startsWith('##')) {
      cur = []
      sections.set(line.slice(2).trim(), cur)
    } else if (cur && line.trim() !== '') cur.push(line)
  }
  return { sections, commands: body.slice(cut + '\n##cmd\n'.length).replace(/\n##end\n?$/, '') }
}

/**
 * The command lines, as "head" prints several files: a line "==> /proc/<pid>/cmdline <==", then
 * the first line of the file. The line after a heading is always content, whatever it looks like,
 * so a program cannot pose as another by naming itself like a heading.
 */
export function parseCommands(text: string): Map<number, string> {
  const out = new Map<number, string>()
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^==> \/proc\/(\d+)\/cmdline <==$/.exec(lines[i])
    if (!m) continue
    const content = lines[i + 1] ?? ''
    // an empty file (a thread of the kernel) is followed by the empty line before the next heading
    if (content !== '') {
      // the parts of a command line are separated by NUL
      const shown = content.replace(/\0+$/, '').replace(/\0/g, ' ').replace(/[\u0001-\u001f\u007f]/g, ' ').trim()
      if (shown) out.set(Number(m[1]), shown.slice(0, 2000))
      i++
    }
  }
  return out
}

/** Which processes hold a socket, by the inode of the socket. */
export function parseHolders(ss: string[], fd: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>()
  const add = (inode: string, pid: number): void => {
    const list = out.get(inode) ?? []
    if (!list.includes(pid)) list.push(pid)
    out.set(inode, list)
  }
  for (const line of ss) {
    const inode = /\bino:(\d+)/.exec(line)?.[1]
    if (!inode || inode === '0') continue
    for (const m of line.matchAll(/\bpid=(\d+)/g)) add(inode, Number(m[1]))
  }
  let pid: number | null = null
  for (const line of fd) {
    const dir = /^\/proc\/(\d+)\/fd:$/.exec(line)
    if (dir) pid = Number(dir[1])
    else if (pid !== null) {
      const inode = /-> socket:\[(\d+)\]$/.exec(line)?.[1]
      if (inode) add(inode, pid)
    }
  }
  return out
}

export function parseActivity(text: string): ParsedActivity {
  if (/^##unsupported\b/.test(text)) return { supported: false, os: text.split(/\r?\n/)[1]?.trim() || 'this system' }
  const parts = split(text)
  const procLines = parts?.sections.get('proc')
  if (!parts || !procLines || !parts.sections.has('self')) throw new Error('The server did not answer in the expected form')
  const s = parts.sections

  const [selfPid, selfUidText] = (s.get('self')?.[0] ?? '').trim().split(/\s+/)
  const selfUid = /^\d+$/.test(selfUidText ?? '') ? Number(selfUidText) : null
  const names = new Map<number, string>()
  for (const line of s.get('passwd') ?? []) {
    const m = /^([^:]+):(\d+)$/.exec(line)
    if (m && !names.has(Number(m[2]))) names.set(Number(m[2]), m[1].slice(0, 64))
  }
  const userOf = (uid: number | null): string => (uid === null ? 'unknown' : names.get(uid) ?? `uid ${uid}`)

  const cpu = (s.get('cpu')?.[0] ?? '').trim().split(/\s+/)
  const total = cpu[0] === 'cpu' ? cpu.slice(1, 9).reduce((a, b) => a + (Number(b) || 0), 0) : 0
  const cores = Math.max(1, Number(s.get('cpu')?.[1]) || 1)
  const memTotal = (Number(/^MemTotal:\s+(\d+)/.exec(s.get('mem')?.[0] ?? '')?.[1]) || 0) * 1024

  const commands = parseCommands(parts.commands)
  const ticks = new Map<number, { used: number; start: string }>()
  const processes: MonitorProcess[] = []
  for (const line of procLines) {
    // "<uid> <kB> <pid> (<name>) <state> <ppid> …": the name may contain spaces and brackets
    const m = /^(\d*) (\d+) (\d+) \((.*)\) (\S) (.+)$/.exec(line)
    if (!m) continue
    const rest = m[6].split(' ')
    const pid = Number(m[3])
    const start = rest[18]
    if (!start || !/^\d+$/.test(start)) continue
    const uid = m[1] === '' ? null : Number(m[1])
    // PF_KTHREAD: a thread of the kernel, not a program
    const kernel = (Number(rest[5]) & 0x00200000) !== 0
    const name = m[4].replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 64)
    ticks.set(pid, { used: (Number(rest[10]) || 0) + (Number(rest[11]) || 0), start })
    processes.push({ pid, ppid: Number(rest[0]) || 0, name, command: kernel ? '' : commands.get(pid) ?? '', uid, user: userOf(uid), state: m[5], cpu: null, memory: Number(m[2]) * 1024, start, kernel, own: uid !== null && uid === selfUid, connection: false })
  }
  if (processes.length === 0) throw new Error('The server did not answer in the expected form')

  // the programs this connection itself runs through: ending one of them ends the connection
  const byPid = new Map(processes.map((p) => [p.pid, p]))
  for (let p = byPid.get(Number(selfPid)), n = 0; p && n < 64; p = byPid.get(p.ppid), n++) {
    if (p.pid === 1) break
    p.connection = true
  }

  const holders = parseHolders(s.get('ss') ?? [], s.get('fd') ?? [])
  const root = selfUid === 0
  const merged = new Map<string, MonitorPort>()
  for (const protocol of ['tcp', 'udp'] as const) {
    for (const line of [...(s.get(protocol) ?? []), ...(s.get(`${protocol}6`) ?? [])]) {
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode …
      const f = line.trim().split(/\s+/)
      const local = /^([0-9A-Fa-f]+):([0-9A-Fa-f]{4})$/.exec(f[1] ?? '')
      if (!local || f.length < 10) continue
      if (protocol === 'tcp' && f[3] !== '0A') continue
      const address = decodeAddress(local[1])
      const port = parseInt(local[2], 16)
      if (!address || !port) continue
      const uid = /^\d+$/.test(f[7]) ? Number(f[7]) : null
      const inode = f[9]
      const pids = (holders.get(inode) ?? []).filter((p) => byPid.has(p)).sort((a, b) => a - b)
      // the one that started the others (a server and its workers share one socket)
      const main = pids.find((p) => !pids.includes(byPid.get(p)?.ppid ?? -1)) ?? pids[0] ?? null
      // Why no program is known. A socket of the kernel itself (NFS, WireGuard) has no inode.
      const holder: MonitorPort['holder'] = pids.length ? 'known' : inode === '0' ? 'kernel' : root || (uid !== null && uid === selfUid) ? 'none' : 'hidden'
      const key = `${protocol} ${port} ${uid} ${pids.join(',')} ${holder}`
      const known = merged.get(key)
      if (known) {
        if (!known.addresses.includes(address)) known.addresses.push(address)
        if (scopeOf(address) === 'all') known.scope = 'all'
        else if (known.scope !== 'all' && scopeOf(address) !== known.scope) known.scope = 'address'
      } else merged.set(key, { protocol, port, addresses: [address], scope: scopeOf(address), uid, user: userOf(uid), pids, pid: main, holder, usual: USUAL[port] ?? null })
    }
  }
  const ports = [...merged.values()].sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol)).slice(0, 2000)

  const hide = (s.get('hide') ?? []).join('\n')
  return {
    supported: true,
    raw: { total, ticks },
    cores,
    activity: {
      processes,
      ports,
      self: { uid: selfUid, user: userOf(selfUid), root },
      hidden: /\bnopid1\b/.test(hide) || /hidepid=(1|2|noaccess|invisible)/.test(hide),
      memTotal
    }
  }
}

/** Fill in how much of a processor each process used since the measurement before. 100 is one whole core. */
export function withUsage(cur: Extract<ParsedActivity, { supported: true }>, prev: ActivityRaw | null): MonitorActivity {
  const all = prev ? cur.raw.total - prev.total : 0
  const processes = cur.activity.processes.map((p) => {
    const now = cur.raw.ticks.get(p.pid)
    const before = prev?.ticks.get(p.pid)
    if (!now || all <= 0) return p
    // new since the last measurement: everything it used, it used in this time
    const used = before && before.start === now.start ? now.used - before.used : before ? null : now.used
    if (used === null || used < 0) return p
    return { ...p, cpu: Math.min(cur.cores * 100, Math.round((used / all) * cur.cores * 1000) / 10) }
  })
  return { supported: true, ...cur.activity, processes }
}

/**
 * End a process. The number alone is not enough: numbers are reused, so the start time the list
 * showed is checked first and a process that took over the number is left alone.
 */
export function signalCommand(pid: number, start: string, signal: MonitorSignal, sudo: boolean): string {
  if (!Number.isInteger(pid) || pid < 2 || !/^\d+$/.test(start) || (signal !== 'TERM' && signal !== 'KILL')) throw new Error('Invalid process')
  // after the name in brackets the start time is the 20th field
  const script = [`read -r l < /proc/${pid}/stat 2>/dev/null || exit 113`, 'l=${l##*) }', 'set -- $l', `[ "\${20}" = "${start}" ] || exit 114`, `${sudo ? 'sudo -n ' : ''}kill -${signal} ${pid}`].join('; ')
  return `sh -c ${shellQuote(script)}`
}

/** Why ending a process did not work, in words the user can act on. */
export function signalError(exitCode: number | null, stderr: string, sudo: boolean): string {
  if (exitCode === 113) return 'This process has already ended.'
  if (exitCode === 114) return 'This process has ended, and another one has its number now. Nothing was done.'
  if (sudo) {
    if (/password is required|a terminal is required|no tty present|askpass/i.test(stderr)) return 'This user may only use sudo with a password, which Clavium does not enter. End the process in a terminal with “sudo kill”.'
    if (/not in the sudoers|not allowed to (run|execute)|may not run sudo/i.test(stderr)) return 'This user may not use sudo on this server, so it cannot end processes of other users.'
    if (/sudo: (command )?not found|sudo: not found|sudo: No such file/i.test(stderr)) return 'There is no sudo on this server, so this user cannot end processes of other users.'
  }
  if (/not permitted|permission denied/i.test(stderr)) return 'This user may not end this process.'
  if (/no such process/i.test(stderr)) return 'This process has already ended.'
  return stderr.trim().split('\n').pop()?.slice(0, 300) || 'The process could not be ended.'
}
