// What the monitor of a server shows: one command that only reads, and the functions that turn
// its output into numbers. Everything comes from /proc and /sys, which every Linux has in the
// same form, plus "df". No tool has to be installed, and no tool's own table is parsed, because
// those differ between distributions. Only graphics cards have no common place: NVIDIA is asked
// through nvidia-smi, AMD through /sys.
import type { MonitorDisk, MonitorGpu, MonitorSample, MonitorTemp } from '@shared/types'
import { shellQuote } from './screens'

const SCRIPT = [
  'if [ ! -r /proc/stat ] || [ ! -r /proc/meminfo ]; then echo "##unsupported"; uname -s 2>/dev/null; exit 0; fi',
  'echo "##host"; uname -n 2>/dev/null',
  'echo "##kernel"; uname -r 2>/dev/null',
  'echo "##os"; cat /etc/os-release 2>/dev/null',
  'echo "##uptime"; cat /proc/uptime 2>/dev/null',
  'echo "##load"; cat /proc/loadavg 2>/dev/null',
  // the lines after the cpu lines can be very long on machines with many interrupts
  `echo "##stat"; grep '^cpu' /proc/stat 2>/dev/null || cat /proc/stat`,
  'echo "##mem"; cat /proc/meminfo',
  'echo "##net"; cat /proc/net/dev 2>/dev/null',
  'echo "##io"; cat /proc/diskstats 2>/dev/null',
  // -T (the kind of file system) is not in POSIX, but GNU and BusyBox know it
  'echo "##df"; df -kPT 2>/dev/null || df -kP 2>/dev/null',
  'echo "##temp"',
  'for z in /sys/class/thermal/thermal_zone*; do',
  '  [ -r "$z/temp" ] && echo "zone|$(cat "$z/type" 2>/dev/null)||$(cat "$z/temp" 2>/dev/null)"',
  'done',
  'for f in /sys/class/hwmon/hwmon*/temp*_input; do',
  '  [ -r "$f" ] && echo "hwmon|$(cat "${f%/*}/name" 2>/dev/null)|$(cat "${f%_input}_label" 2>/dev/null)|$(cat "$f" 2>/dev/null)"',
  'done',
  'echo "##nvidia"',
  'command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw --format=csv,noheader,nounits 2>/dev/null',
  'echo "##amd"',
  // only the cards themselves: the outputs (card0-HDMI-A-1) point to the same device
  'for d in /sys/class/drm/card[0-9] /sys/class/drm/card[0-9][0-9]; do',
  '  [ -r "$d/device/gpu_busy_percent" ] && echo "$(cat "$d/device/gpu_busy_percent" 2>/dev/null)|$(cat "$d/device/mem_info_vram_used" 2>/dev/null)|$(cat "$d/device/mem_info_vram_total" 2>/dev/null)|$(cat $d/device/hwmon/hwmon*/temp1_input 2>/dev/null | head -n 1)|${d##*/}"',
  'done',
  'echo "##end"'
].join('\n')

/** Runs through "sh -c", so it works the same whatever login shell the user has. */
export const SAMPLE_COMMAND = `sh -c ${shellQuote(SCRIPT)}`

/** The counters of one moment. Rates come from two of these. */
export interface RawSample {
  /** seconds since the server started, the clock the rates are measured with */
  clock: number
  /** per line of /proc/stat ("cpu", "cpu0", …): [busy, total] in ticks */
  cpu: Map<string, [number, number]>
  iowait: number
  /** bytes received and sent, per network interface */
  net: Map<string, [number, number]>
  /** bytes read and written, all whole disks together */
  io: [number, number] | null
}

export type Parsed = { supported: false; os: string } | { supported: true; raw: RawSample; fixed: Omit<Extract<MonitorSample, { supported: true }>, 'cpu' | 'net' | 'io'> & { cores: number } }

function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let cur: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('##')) {
      cur = []
      out.set(line.slice(2).trim(), cur)
    } else if (cur && line.trim() !== '') cur.push(line)
  }
  return out
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s.trim() === '') return null
  const n = Number(s.trim())
  return Number.isFinite(n) ? n : null
}

/** Network interfaces that only pass on what a real one carries; counting them would count twice. */
const VIRTUAL_NET = /^(lo|veth|docker|br-|virbr|tun|tap|wg|tailscale|cni|flannel|cali|lxc|lxd|vnet|dummy|ifb|sit|ip6tnl|gre|kube)/

/** Whole disks. Partitions, device mapper and RAID sit on top of them and would count twice. */
const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/

/** File systems that hold no files of the user. */
const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'efivarfs', 'ramfs', 'iso9660', 'proc', 'sysfs', 'cgroup', 'cgroup2', 'devpts', 'autofs', 'tracefs', 'debugfs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'binfmt_misc', 'nsfs', 'fuse.lxcfs', 'fuse.snapfuse'])
const PSEUDO_DEVICE = /^(tmpfs|devtmpfs|udev|none|shm|run|efivarfs|cgroup|proc|sysfs|dev|\/dev\/loop\d+)$/

export function parseDisks(lines: string[]): MonitorDisk[] {
  if (lines.length === 0) return []
  const typed = /\bType\b/.test(lines[0])
  const byDevice = new Map<string, MonitorDisk>()
  for (const line of lines.slice(1)) {
    // the mount point is last and may contain spaces
    const m = typed ? /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/.exec(line) : /^(\S+)()\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+(.+)$/.exec(line)
    if (!m) continue
    const [, device, type, total, used, free, mount] = m
    if (Number(total) === 0) continue
    if (PSEUDO_FS.has(type) || PSEUDO_DEVICE.test(device)) continue
    // "overlay" is the root of a container; the layers of other containers on a host are noise
    if ((type === 'overlay' || device === 'overlay') && mount !== '/') continue
    const disk: MonitorDisk = { device, type, mount, total: Number(total) * 1024, used: Number(used) * 1024, free: Number(free) * 1024 }
    // one device mounted several times (subvolumes, bind mounts) is one line: the shortest path
    const known = byDevice.get(device)
    if (!known || mount.length < known.mount.length) byDevice.set(device, disk)
  }
  return [...byDevice.values()].sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, 40)
}

const TEMP_NAMES: Record<string, string> = {
  coretemp: 'CPU',
  k10temp: 'CPU',
  zenpower: 'CPU',
  cpu_thermal: 'CPU',
  'x86_pkg_temp': 'CPU',
  'cpu-thermal': 'CPU',
  nvme: 'NVMe',
  amdgpu: 'GPU',
  radeon: 'GPU',
  nouveau: 'GPU',
  acpitz: 'Mainboard',
  drivetemp: 'Drive'
}

export function parseTemps(lines: string[]): MonitorTemp[] {
  const all: (MonitorTemp & { hwmon: boolean })[] = []
  for (const line of lines) {
    const [source, name = '', label = '', value] = line.split('|')
    const milli = num(value)
    // sensors that are not connected report 0 or nonsense
    if (milli === null || milli <= 0 || milli > 150_000) continue
    const nice = TEMP_NAMES[name] ?? name
    all.push({ label: (label && label !== nice ? `${nice || 'Sensor'} ${label}` : nice || 'Sensor').slice(0, 60), celsius: Math.round(milli / 100) / 10, hwmon: source === 'hwmon' })
  }
  // hwmon is the more exact source; thermal zones often repeat the same sensors
  const chosen = all.some((t) => t.hwmon) ? all.filter((t) => t.hwmon) : all
  // per label only the hottest: a CPU with 32 cores has 32 sensors
  const hottest = new Map<string, number>()
  for (const t of chosen) {
    const key = /^CPU\b/.test(t.label) ? 'CPU' : t.label
    hottest.set(key, Math.max(hottest.get(key) ?? -Infinity, t.celsius))
  }
  return [...hottest].map(([label, celsius]) => ({ label, celsius })).slice(0, 12)
}

export function parseGpus(nvidia: string[], amd: string[]): MonitorGpu[] {
  const out: MonitorGpu[] = []
  const mib = (s: string | undefined): number | null => {
    const n = num(s)
    return n === null ? null : n * 1024 * 1024
  }
  for (const line of nvidia) {
    const f = line.split(',').map((x) => x.trim())
    if (f.length < 6) continue
    // a value the card does not report reads "[N/A]" or "[Not Supported]", which is no number
    out.push({ vendor: 'nvidia', name: f[0] || 'NVIDIA GPU', usage: num(f[1]), memUsed: mib(f[2]), memTotal: mib(f[3]), temp: num(f[4]), power: num(f[5]) })
  }
  for (const line of amd) {
    const [busy, used, total, temp, card] = line.split('|')
    const t = num(temp)
    out.push({ vendor: 'amd', name: `AMD GPU (${card || 'card'})`, usage: num(busy), memUsed: num(used), memTotal: num(total), temp: t === null ? null : Math.round(t / 100) / 10, power: null })
  }
  return out.slice(0, 16)
}

export function parseSample(text: string): Parsed {
  const s = sections(text)
  if (s.has('unsupported')) return { supported: false, os: (s.get('unsupported')?.[0] ?? '').trim() || 'this system' }
  const stat = s.get('stat')
  const memLines = s.get('mem')
  if (!stat || !memLines || !s.has('end')) throw new Error('The server did not answer in the expected form')

  const cpu = new Map<string, [number, number]>()
  let iowait = 0
  for (const line of stat) {
    const f = line.trim().split(/\s+/)
    if (!/^cpu\d*$/.test(f[0])) continue
    // user nice system idle iowait irq softirq steal; guest time is already inside user
    const v = f.slice(1, 9).map((x) => Number(x) || 0)
    const total = v.reduce((a, b) => a + b, 0)
    const idle = (v[3] ?? 0) + (v[4] ?? 0)
    cpu.set(f[0], [total - idle, total])
    if (f[0] === 'cpu') iowait = v[4] ?? 0
  }
  if (!cpu.has('cpu')) throw new Error('The server did not answer in the expected form')

  const mem = new Map<string, number>()
  for (const line of memLines) {
    const m = /^(\w+(?:\(\w+\))?):\s+(\d+)/.exec(line)
    if (m) mem.set(m[1], Number(m[2]) * 1024)
  }
  const total = mem.get('MemTotal') ?? 0
  const cache = (mem.get('Buffers') ?? 0) + (mem.get('Cached') ?? 0) + (mem.get('SReclaimable') ?? 0)
  // kernels before 3.14 have no MemAvailable
  const available = Math.min(total, mem.get('MemAvailable') ?? (mem.get('MemFree') ?? 0) + cache)
  const swapTotal = mem.get('SwapTotal') ?? 0

  const net = new Map<string, [number, number]>()
  for (const line of s.get('net') ?? []) {
    const m = /^\s*([^:\s]+):\s*(.+)$/.exec(line)
    if (!m || VIRTUAL_NET.test(m[1])) continue
    const f = m[2].trim().split(/\s+/).map(Number)
    if (f.length >= 9 && Number.isFinite(f[0]) && Number.isFinite(f[8])) net.set(m[1], [f[0], f[8]])
  }

  let io: [number, number] | null = null
  for (const line of s.get('io') ?? []) {
    const f = line.trim().split(/\s+/)
    if (f.length < 10 || !WHOLE_DISK.test(f[2])) continue
    // sectors in this file are always 512 bytes, whatever the disk says
    io = [(io?.[0] ?? 0) + Number(f[5]) * 512, (io?.[1] ?? 0) + Number(f[9]) * 512]
  }

  const os = /^PRETTY_NAME=(.*)$/m.exec((s.get('os') ?? []).join('\n'))?.[1]?.replace(/^["']|["']$/g, '') ?? 'Linux'
  const upFields = (s.get('uptime')?.[0] ?? '').trim().split(/\s+/)
  const uptime = Number(upFields[0]) || 0
  const loadFields = (s.get('load')?.[0] ?? '').trim().split(/\s+/)
  const load = [0, 1, 2].map((i) => Number(loadFields[i]) || 0) as [number, number, number]

  return {
    supported: true,
    raw: { clock: uptime, cpu, iowait, net, io },
    fixed: {
      supported: true,
      hostname: (s.get('host')?.[0] ?? '').trim().slice(0, 255),
      os: os.slice(0, 120),
      kernel: (s.get('kernel')?.[0] ?? '').trim().slice(0, 120),
      uptime,
      load,
      cores: [...cpu.keys()].filter((k) => k !== 'cpu').length || 1,
      mem: { total, used: Math.max(0, total - available), cache, swapTotal, swapUsed: Math.max(0, swapTotal - (mem.get('SwapFree') ?? 0)) },
      disks: parseDisks(s.get('df') ?? []),
      temps: parseTemps(s.get('temp') ?? []),
      gpus: parseGpus(s.get('nvidia') ?? [], s.get('amd') ?? [])
    }
  }
}

const percent = (busy: number, total: number): number | null => (total > 0 && busy >= 0 ? Math.min(100, Math.max(0, Math.round((busy / total) * 1000) / 10)) : null)

/** The sample to show: the fixed values of `cur`, and rates from the change since `prev`. */
export function toSample(cur: Extract<Parsed, { supported: true }>, prev: RawSample | null): Extract<MonitorSample, { supported: true }> {
  const { cores, ...fixed } = cur.fixed
  const raw = cur.raw
  const seconds = prev ? raw.clock - prev.clock : 0
  // no earlier sample, or the server was restarted in between: no rates yet
  const usable = prev !== null && seconds > 0.2
  const delta = (key: string): number | null => {
    const a = prev?.cpu.get(key)
    const b = raw.cpu.get(key)
    if (!usable || !a || !b) return null
    return percent(b[0] - a[0], b[1] - a[1])
  }
  const perCore: number[] = []
  for (let i = 0; i < cores; i++) {
    const v = delta(`cpu${i}`)
    if (v === null) break
    perCore.push(v)
  }
  const totalTicks = usable ? (raw.cpu.get('cpu')?.[1] ?? 0) - (prev?.cpu.get('cpu')?.[1] ?? 0) : 0
  const rate = (now: number, before: number | undefined): number | null => (usable && before !== undefined && now >= before ? (now - before) / seconds : null)

  const interfaces = [...raw.net].map(([name, [rx, tx]]) => ({ name, rx: rate(rx, prev?.net.get(name)?.[0]), tx: rate(tx, prev?.net.get(name)?.[1]) }))
  const sum = (key: 'rx' | 'tx'): number | null => {
    const known = interfaces.map((i) => i[key]).filter((v): v is number => v !== null)
    return known.length ? known.reduce((a, b) => a + b, 0) : null
  }
  return {
    ...fixed,
    cpu: { count: cores, usage: delta('cpu'), cores: perCore.length === cores ? perCore : [], iowait: usable && prev ? percent(raw.iowait - prev.iowait, totalTicks) : null },
    net: { rx: sum('rx'), tx: sum('tx'), interfaces: interfaces.sort((a, b) => (b.rx ?? 0) + (b.tx ?? 0) - ((a.rx ?? 0) + (a.tx ?? 0))).slice(0, 8) },
    io: raw.io ? { read: rate(raw.io[0], prev?.io?.[0]), write: rate(raw.io[1], prev?.io?.[1]) } : null
  }
}
