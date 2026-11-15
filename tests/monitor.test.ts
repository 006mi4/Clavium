import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SAMPLE_COMMAND, parseDisks, parseGpus, parseSample, parseTemps, toSample, type Parsed } from '../src/main/core/monitor'

const GB = 1024 * 1024 * 1024

/** What the command prints on a server, put together from parts so a test can change one of them. */
function output(parts: Partial<Record<'os' | 'uptime' | 'load' | 'stat' | 'mem' | 'net' | 'io' | 'df' | 'temp' | 'nvidia' | 'amd', string>> = {}): string {
  const d = {
    os: 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"',
    uptime: '1000.00 3900.12',
    load: '0.52 0.48 0.40 2/613 12345',
    // user nice system idle iowait irq softirq steal guest guest_nice
    stat: 'cpu  1000 0 500 8000 500 0 0 0 0 0\ncpu0 600 0 300 3800 300 0 0 0 0 0\ncpu1 400 0 200 4200 200 0 0 0 0 0',
    mem: 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:   10000000 kB\nBuffers:          500000 kB\nCached:          8000000 kB\nSReclaimable:     500000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB',
    net: [
      'Inter-|   Receive                                                |  Transmit',
      ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
      '    lo: 9999999   100    0    0    0     0          0         0  9999999   100    0    0    0     0       0          0',
      '  eth0: 1000000   900    0    0    0     0          0         0   500000   800    0    0    0     0       0          0',
      'docker0: 7777777  10    0    0    0     0          0         0  7777777    10    0    0    0     0       0          0',
      'veth1a2b: 555555  10    0    0    0     0          0         0   555555    10    0    0    0     0       0          0'
    ].join('\n'),
    io: [
      '   7       0 loop0 100 0 2000 10 0 0 0 0 0 10 10',
      '   8       0 sda 5000 10 200000 900 3000 20 100000 800 0 1000 1700',
      '   8       1 sda1 4000 10 190000 800 2900 20 90000 700 0 900 1500',
      ' 259       0 nvme0n1 100 0 20000 10 50 0 40000 10 0 20 20',
      ' 259       1 nvme0n1p1 90 0 19000 10 40 0 39000 10 0 20 20',
      ' 253       0 dm-0 4000 0 190000 800 2900 0 90000 700 0 900 1500'
    ].join('\n'),
    df: [
      'Filesystem     Type     1024-blocks      Used Available Capacity Mounted on',
      'tmpfs          tmpfs        1600000      2000   1598000       1% /run',
      '/dev/sda1      ext4       100000000  60000000  35000000      64% /',
      '/dev/sda1      ext4       100000000  60000000  35000000      64% /var/lib/docker/bind',
      'overlay        overlay    100000000  60000000  35000000      64% /var/lib/docker/overlay2/abc/merged',
      '/dev/loop3     squashfs       60000     60000         0     100% /snap/core/1',
      'nas:/export    nfs4      2000000000 1900000000 100000000      95% /mnt/my backup'
    ].join('\n'),
    temp: '',
    nvidia: '',
    amd: '',
    ...parts
  }
  return ['##host', 'web-1', '##kernel', '6.8.0-45-generic', '##os', d.os, '##uptime', d.uptime, '##load', d.load, '##stat', d.stat, '##mem', d.mem, '##net', d.net, '##io', d.io, '##df', d.df, '##temp', d.temp, '##nvidia', d.nvidia, '##amd', d.amd, '##end', ''].join('\n')
}

const supported = (text: string): Extract<Parsed, { supported: true }> => {
  const p = parseSample(text)
  if (!p.supported) throw new Error('expected a Linux sample')
  return p
}

describe('reading one measurement', () => {
  it('reads system, memory, load and disks', () => {
    const { fixed } = supported(output())
    expect(fixed.hostname).toBe('web-1')
    expect(fixed.os).toBe('Ubuntu 24.04.1 LTS')
    expect(fixed.kernel).toBe('6.8.0-45-generic')
    expect(fixed.uptime).toBe(1000)
    expect(fixed.load).toEqual([0.52, 0.48, 0.4])
    expect(fixed.cores).toBe(2)
    // used is what programs hold: total minus what is available, not total minus free
    expect(fixed.mem).toEqual({ total: 16000000 * 1024, used: 6000000 * 1024, cache: 9000000 * 1024, swapTotal: 2000000 * 1024, swapUsed: 500000 * 1024 })
  })

  it('has no rates in the first measurement and computes them from the second', () => {
    const first = supported(output())
    const a = toSample(first, null)
    expect(a.cpu).toEqual({ count: 2, usage: null, cores: [], iowait: null })
    expect(a.net.rx).toBeNull()
    expect(a.io).toEqual({ read: null, write: null })

    // two seconds later: 200 ticks passed, 100 of them idle, 20 waiting for disks
    const second = supported(
      output({
        uptime: '1002.00 3990.00',
        stat: 'cpu  1060 0 520 8100 520 0 0 0 0 0\ncpu0 660 0 320 3800 320 0 0 0 0 0\ncpu1 400 0 200 4300 200 0 0 0 0 0',
        net: '  eth0: 1200000 900 0 0 0 0 0 0 600000 800 0 0 0 0 0 0\n    lo: 99999999 1 0 0 0 0 0 0 99999999 1 0 0 0 0 0 0',
        io: '   8       0 sda 5000 10 204096 900 3000 20 100000 800 0 1000 1700\n 259       0 nvme0n1 100 0 20000 10 50 0 42048 10 0 20 20'
      })
    )
    const b = toSample(second, first.raw)
    // busy is everything that is neither idle nor waiting for a disk: 80 of 200 ticks
    expect(b.cpu.usage).toBe(40)
    expect(b.cpu.cores).toEqual([80, 0])
    expect(b.cpu.iowait).toBe(10)
    expect(b.net.rx).toBe(100000)
    expect(b.net.tx).toBe(50000)
    expect(b.net.interfaces).toEqual([{ name: 'eth0', rx: 100000, tx: 50000 }])
    // sectors of 512 bytes: 4096 read on sda, 2048 written on nvme0n1, over two seconds
    expect(b.io).toEqual({ read: (4096 * 512) / 2, write: (2048 * 512) / 2 })
  })

  it('counts neither the loopback nor the bridges of containers, and only whole disks', () => {
    const { raw } = supported(output())
    expect([...raw.net.keys()]).toEqual(['eth0'])
    // sda and nvme0n1, without their partitions, the loop device and the device mapper
    expect(raw.io).toEqual([(200000 + 20000) * 512, (100000 + 40000) * 512])
  })

  it('shows no rates after a restart of the server, when the counters start again', () => {
    const before = supported(output())
    const after = supported(output({ uptime: '12.00 20.00', stat: 'cpu  10 0 5 80 5 0 0 0 0 0\ncpu0 6 0 3 38 3 0 0 0 0 0\ncpu1 4 0 2 42 2 0 0 0 0 0' }))
    const s = toSample(after, before.raw)
    expect(s.cpu.usage).toBeNull()
    expect(s.net.rx).toBeNull()
  })

  it('works on a kernel without MemAvailable and on a server without swap', () => {
    const { fixed } = supported(output({ mem: 'MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 250 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB' }))
    expect(fixed.mem).toEqual({ total: 1000 * 1024, used: 600 * 1024, cache: 300 * 1024, swapTotal: 0, swapUsed: 0 })
  })

  it('says so when the system is not Linux', () => {
    expect(parseSample('##unsupported\nDarwin\n')).toEqual({ supported: false, os: 'Darwin' })
    expect(parseSample('##unsupported\n')).toEqual({ supported: false, os: 'this system' })
  })

  it('refuses an answer that was cut off or is something else', () => {
    expect(() => parseSample('Welcome to the server\n')).toThrow(/expected form/)
    expect(() => parseSample(output().replace('##end', ''))).toThrow(/expected form/)
  })
})

describe('file systems', () => {
  it('keeps real disks and network shares, once per device, and drops what holds no files', () => {
    const disks = supported(output()).fixed.disks
    expect(disks.map((d) => d.mount)).toEqual(['/', '/mnt/my backup'])
    expect(disks[0]).toEqual({ device: '/dev/sda1', type: 'ext4', mount: '/', total: 100000000 * 1024, used: 60000000 * 1024, free: 35000000 * 1024 })
    expect(disks[1].type).toBe('nfs4')
  })

  it('reads a df that cannot tell the kind of file system', () => {
    const disks = parseDisks(['Filesystem 1024-blocks Used Available Capacity Mounted on', '/dev/vda2 20000 5000 15000 25% /', 'tmpfs 500 0 500 0% /dev/shm', 'none 500 0 500 0% /tmp'])
    expect(disks).toEqual([{ device: '/dev/vda2', type: '', mount: '/', total: 20000 * 1024, used: 5000 * 1024, free: 15000 * 1024 }])
  })

  it('shows the root of a container, which is an overlay', () => {
    const disks = parseDisks(['Filesystem Type 1024-blocks Used Available Capacity Mounted on', 'overlay overlay 61000000 9000000 49000000 16% /', 'shm tmpfs 65536 0 65536 0% /dev/shm'])
    expect(disks.map((d) => d.mount)).toEqual(['/'])
  })
})

describe('temperatures', () => {
  it('prefers hwmon, names the sensors and keeps the hottest per kind', () => {
    const temps = parseTemps(['zone|x86_pkg_temp||61000', 'hwmon|coretemp|Package id 0|62000', 'hwmon|coretemp|Core 0|58000', 'hwmon|coretemp|Core 1|64500', 'hwmon|nvme|Composite|41850', 'hwmon|acpitz||0'])
    expect(temps).toEqual([
      { label: 'CPU', celsius: 64.5 },
      { label: 'NVMe Composite', celsius: 41.9 }
    ])
  })

  it('falls back to thermal zones, as on a Raspberry Pi', () => {
    expect(parseTemps(['zone|cpu-thermal||48312'])).toEqual([{ label: 'CPU', celsius: 48.3 }])
  })

  it('is empty in a virtual machine without sensors', () => {
    expect(supported(output()).fixed.temps).toEqual([])
  })
})

describe('graphics cards', () => {
  it('reads NVIDIA cards, also with values a card does not report', () => {
    const gpus = parseGpus(['NVIDIA GeForce RTX 4090, 37, 8123, 24564, 61, 215.40', 'Tesla T4, [N/A], 0, 15360, 34, [N/A]'], [])
    expect(gpus[0]).toEqual({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090', usage: 37, memUsed: 8123 * 1024 * 1024, memTotal: 24564 * 1024 * 1024, temp: 61, power: 215.4 })
    expect(gpus[1]).toMatchObject({ name: 'Tesla T4', usage: null, power: null, temp: 34 })
  })

  it('reads AMD cards from /sys, in bytes and thousandths of a degree', () => {
    expect(parseGpus([], ['12|1073741824|8589934592|47000|card0', '3||||card1'])).toEqual([
      { vendor: 'amd', name: 'AMD GPU (card0)', usage: 12, memUsed: GB, memTotal: 8 * GB, temp: 47, power: null },
      { vendor: 'amd', name: 'AMD GPU (card1)', usage: 3, memUsed: null, memTotal: null, temp: null, power: null }
    ])
  })
})

describe('the command itself, run by a real sh', () => {
  /** The script with /proc, /sys and /etc pointing into a folder, and df and nvidia-smi replaced. */
  function runAgainst(root: string, bin: string): string {
    const script = /^sh -c '([\s\S]*)'$/.exec(SAMPLE_COMMAND)?.[1].replace(/'\\''/g, "'")
    if (!script) throw new Error('unexpected form of the command')
    const moved = script.replace(/\/(proc|sys|etc)\//g, `${root}/$1/`)
    return execFileSync('/bin/sh', ['-c', moved], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` } })
  }
  const put = (root: string, path: string, content: string): void => {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  it.skipIf(process.platform === 'win32')('collects everything from a Linux file tree, including sensors and both kinds of graphics card', () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-mon-'))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      writeFileSync(join(bin, 'df'), '#!/bin/sh\n[ "$1" = "-kPT" ] || exit 1\necho "Filesystem Type 1024-blocks Used Available Capacity Mounted on"\necho "/dev/sda1 ext4 1000 400 600 40% /"\n')
      writeFileSync(join(bin, 'nvidia-smi'), '#!/bin/sh\necho "RTX 3060, 5, 100, 12288, 40, 20.00"\n')
      chmodSync(join(bin, 'df'), 0o755)
      chmodSync(join(bin, 'nvidia-smi'), 0o755)
      put(root, 'etc/os-release', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n')
      put(root, 'proc/uptime', '500.25 900.00\n')
      put(root, 'proc/loadavg', '1.00 0.50 0.25 1/100 999\n')
      put(root, 'proc/stat', 'cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 100 0 50 800 50 0 0 0 0 0\nintr 123 456\nctxt 99\n')
      put(root, 'proc/meminfo', 'MemTotal: 2000 kB\nMemAvailable: 1500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')
      put(root, 'proc/net/dev', 'head\nhead\n  eth0: 10 1 0 0 0 0 0 0 20 1 0 0 0 0 0 0\n')
      put(root, 'proc/diskstats', '   8 0 sda 1 0 8 0 1 0 16 0 0 0 0\n')
      put(root, 'sys/class/thermal/thermal_zone0/type', 'acpitz\n')
      put(root, 'sys/class/thermal/thermal_zone0/temp', '30000\n')
      put(root, 'sys/class/hwmon/hwmon0/name', 'k10temp\n')
      put(root, 'sys/class/hwmon/hwmon0/temp1_input', '55125\n')
      put(root, 'sys/class/hwmon/hwmon0/temp1_label', 'Tctl\n')
      put(root, 'sys/class/drm/card0/device/gpu_busy_percent', '9\n')
      put(root, 'sys/class/drm/card0/device/mem_info_vram_used', '1024\n')
      put(root, 'sys/class/drm/card0/device/mem_info_vram_total', '4096\n')
      put(root, 'sys/class/drm/card0/device/hwmon/hwmon3/temp1_input', '51000\n')
      // an output of the card: must not count as a second card
      put(root, 'sys/class/drm/card0-HDMI-A-1/device/gpu_busy_percent', '9\n')

      const text = runAgainst(root, bin)
      const { fixed, raw } = supported(text)
      expect(fixed.os).toBe('Debian GNU/Linux 12 (bookworm)')
      expect(fixed.cores).toBe(1)
      expect(text).not.toContain('intr')
      expect(raw.clock).toBe(500.25)
      expect(fixed.mem.used).toBe(500 * 1024)
      expect(raw.net.get('eth0')).toEqual([10, 20])
      expect(raw.io).toEqual([8 * 512, 16 * 512])
      expect(fixed.disks).toEqual([{ device: '/dev/sda1', type: 'ext4', mount: '/', total: 1000 * 1024, used: 400 * 1024, free: 600 * 1024 }])
      expect(fixed.temps).toEqual([{ label: 'CPU', celsius: 55.1 }])
      expect(fixed.gpus).toEqual([
        { vendor: 'nvidia', name: 'RTX 3060', usage: 5, memUsed: 100 * 1024 * 1024, memTotal: 12288 * 1024 * 1024, temp: 40, power: 20 },
        { vendor: 'amd', name: 'AMD GPU (card0)', usage: 9, memUsed: 1024, memTotal: 4096, temp: 51, power: null }
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('answers "unsupported" where there is no /proc, and falls back to a plain df', () => {
    const root = mkdtempSync(join(tmpdir(), 'clavium-mon-'))
    try {
      const bin = join(root, 'bin')
      mkdirSync(bin)
      expect(parseSample(runAgainst(root, bin)).supported).toBe(false)

      // a df that does not know -T, and no sensors or graphics cards at all
      writeFileSync(join(bin, 'df'), '#!/bin/sh\n[ "$1" = "-kP" ] || exit 1\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/vda1 1000 400 600 40% /"\n')
      chmodSync(join(bin, 'df'), 0o755)
      put(root, 'proc/stat', 'cpu  1 0 1 8 0 0 0 0 0 0\ncpu0 1 0 1 8 0 0 0 0 0 0\n')
      put(root, 'proc/meminfo', 'MemTotal: 2000 kB\nMemFree: 1000 kB\n')
      const { fixed, raw } = supported(runAgainst(root, bin))
      expect(fixed.disks.map((d) => [d.mount, d.type])).toEqual([['/', '']])
      expect(fixed.temps).toEqual([])
      expect(fixed.gpus).toEqual([])
      expect(fixed.os).toBe('Linux')
      expect(raw.io).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
