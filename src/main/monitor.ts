import type { Client } from 'ssh2'
import type { HostRecord, MonitorSample } from '@shared/types'
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
    this.sessions.set(id, { client, prev: null, running: null })
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
