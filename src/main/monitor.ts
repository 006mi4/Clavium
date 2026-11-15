import type { Client } from 'ssh2'
import type { HostRecord, MonitorActivity, MonitorSample, MonitorSignal } from '@shared/types'
import { ACTIVITY_COMMAND, parseActivity, signalCommand, signalError, withUsage, type ActivityRaw } from './core/activity'
import { randomId } from './core/crypto'
import { SAMPLE_COMMAND, parseSample, toSample, type RawSample } from './core/monitor'
import type { Prompter } from './core/prompter'
import { connectSsh, execCommand } from './core/ssh'
import type { Vault } from './core/vault'

type Send = (channel: 'monitor:closed', payload: string) => void

interface MonitorSession {
  client: Client
  /** the counters of the last measurement, which the next one is compared with */
  prev: RawSample | null
  /** one measurement at a time: a slow server is not asked again while it still answers */
  running: Promise<MonitorSample> | null
  prevActivity: ActivityRaw | null
  runningActivity: Promise<MonitorActivity> | null
}

/** The monitors of servers: one SSH connection per open monitor, asked again every few seconds. */
export class MonitorManager {
  private sessions = new Map<string, MonitorSession>()

  constructor(
    private readonly vault: Vault,
    private readonly prompter: Prompter,
    private readonly send: Send
  ) {}

  async open(host: HostRecord): Promise<string> {
    if (host.protocol !== 'ssh') throw new Error('The monitor needs an SSH connection')
    const client = await connectSsh(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const id = randomId()
    this.sessions.set(id, { client, prev: null, running: null, prevActivity: null, runningActivity: null })
    client.on('close', () => {
      if (this.sessions.delete(id)) this.send('monitor:closed', id)
    })
    return id
  }

  sample(id: string): Promise<MonitorSample> {
    const s = this.sessions.get(id)
    if (!s) return Promise.reject(new Error('The connection is closed — reconnect'))
    s.running ??= this.measure(s).finally(() => {
      s.running = null
    })
    return s.running
  }

  private async measure(s: MonitorSession): Promise<MonitorSample> {
    const r = await execCommand(s.client, SAMPLE_COMMAND, { timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 })
    if (r.timedOut) throw new Error('The server did not answer in time')
    const parsed = parseSample(r.stdout)
    if (!parsed.supported) return parsed
    const sample = toSample(parsed, s.prev)
    s.prev = parsed.raw
    return sample
  }

  /** Processes and open ports. */
  activity(id: string): Promise<MonitorActivity> {
    const s = this.sessions.get(id)
    if (!s) return Promise.reject(new Error('The connection is closed — reconnect'))
    s.runningActivity ??= this.look(s).finally(() => {
      s.runningActivity = null
    })
    return s.runningActivity
  }

  private async look(s: MonitorSession): Promise<MonitorActivity> {
    const r = await execCommand(s.client, ACTIVITY_COMMAND, { timeoutMs: 15_000, maxBytes: 24 * 1024 * 1024 })
    if (r.timedOut) throw new Error('The server did not answer in time')
    if (r.truncated) throw new Error('The server runs more processes than the monitor can list')
    const parsed = parseActivity(r.stdout)
    if (!parsed.supported) return parsed
    const activity = withUsage(parsed, s.prevActivity)
    s.prevActivity = parsed.raw
    return activity
  }

  /** Ask a process to end (TERM) or end it at once (KILL). With `sudo` for a process of another user. */
  async signal(id: string, pid: number, start: string, signal: MonitorSignal, sudo: boolean): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) throw new Error('The connection is closed — reconnect')
    const r = await execCommand(s.client, signalCommand(pid, start, signal, sudo), { timeoutMs: 10_000, maxBytes: 64 * 1024 })
    if (r.timedOut) throw new Error('The server did not answer in time')
    if (r.exitCode !== 0) throw new Error(signalError(r.exitCode, r.stderr, sudo))
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    s.client.end()
  }

  /** Vault locked or app quitting. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
      this.send('monitor:closed', id)
    }
  }
}
