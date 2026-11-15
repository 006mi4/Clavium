import type { Client } from 'ssh2'
import type { DockerCreateSpec, DockerDetails, DockerImage, DockerOverview, DockerPullProgress, DockerStats, HostRecord } from '@shared/types'
import { randomId } from './core/crypto'
import {
  IMAGES_COMMAND,
  OVERVIEW_COMMAND,
  STATS_COMMAND,
  actionCommand,
  createCommand,
  dockerError,
  inspectCommand,
  parseImages,
  parseInspect,
  parseOverview,
  parseStats,
  pullCommand,
  pullProgress,
  removeImageCommand,
  restartPolicyCommand,
  type ContainerAction,
  type RestartPolicy
} from './core/docker'
import type { Prompter } from './core/prompter'
import { connectSsh, execCommand } from './core/ssh'
import type { Vault } from './core/vault'

type Send = (channel: 'docker:closed' | 'docker:pullProgress', payload: string | DockerPullProgress) => void

/** Docker overviews: one SSH connection per open overview, commands run on it one after another. */
export class DockerManager {
  private sessions = new Map<string, Client>()

  constructor(
    private readonly vault: Vault,
    private readonly prompter: Prompter,
    private readonly send: Send
  ) {}

  async open(host: HostRecord): Promise<string> {
    if (host.protocol !== 'ssh') throw new Error('Docker needs an SSH connection')
    const client = await connectSsh(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const id = randomId()
    this.sessions.set(id, client)
    client.on('close', () => {
      if (this.sessions.delete(id)) this.send('docker:closed', id)
    })
    return id
  }

  private client(id: string): Client {
    const c = this.sessions.get(id)
    if (!c) throw new Error('The connection is closed — reconnect')
    return c
  }

  /** Run a docker command; a failure becomes an error with Docker's own explanation. */
  private async run(id: string, command: string, timeoutMs = 30_000): Promise<string> {
    const r = await execCommand(this.client(id), command, { timeoutMs, maxBytes: 16 * 1024 * 1024 })
    if (r.timedOut) throw new Error('Docker did not answer in time')
    if (r.exitCode !== 0) {
      throw new Error(dockerError(r.stderr))
    }
    return r.stdout
  }

  async overview(id: string): Promise<DockerOverview> {
    return parseOverview(await this.run(id, OVERVIEW_COMMAND))
  }
  async stats(id: string): Promise<DockerStats[]> {
    return parseStats(await this.run(id, STATS_COMMAND))
  }
  async images(id: string): Promise<DockerImage[]> {
    return parseImages(await this.run(id, IMAGES_COMMAND))
  }
  async inspect(id: string, container: string): Promise<DockerDetails> {
    return parseInspect(await this.run(id, inspectCommand(container)))
  }
  /** Stopping waits for the program to shut down (10 s each by default), hence the long limit. */
  async action(id: string, action: ContainerAction, containers: string[]): Promise<void> {
    await this.run(id, actionCommand(action, containers), 30_000 + containers.length * 15_000)
  }
  async setRestartPolicy(id: string, container: string, policy: RestartPolicy): Promise<void> {
    await this.run(id, restartPolicyCommand(container, policy))
  }
  async removeImage(id: string, image: string): Promise<void> {
    await this.run(id, removeImageCommand(image))
  }

  /**
   * Run a command and hand its output on line by line while it runs; `stdin` is sent to it first.
   * Resolves with everything it printed, or rejects with Docker's explanation.
   */
  private stream(id: string, command: string, opts: { stdin?: string; onLine?: (line: string) => void; timeoutMs: number }): Promise<string> {
    const client = this.client(id)
    return new Promise((resolve, reject) => {
      client.exec(command, (err, channel) => {
        if (err) return reject(err)
        let out = ''
        let errOut = ''
        let pending = ''
        const timer = setTimeout(() => {
          channel.close()
          reject(new Error('Docker did not finish in time'))
        }, opts.timeoutMs)
        channel.on('data', (chunk: Buffer) => {
          if (out.length < 4 * 1024 * 1024) out += chunk.toString('utf8')
          pending += chunk.toString('utf8')
          const lines = pending.split(/\r?\n|\r/)
          pending = lines.pop() ?? ''
          for (const line of lines) opts.onLine?.(line)
        })
        channel.stderr.on('data', (chunk: Buffer) => {
          if (errOut.length < 64 * 1024) errOut += chunk.toString('utf8')
        })
        channel.on('close', (code: number | null) => {
          clearTimeout(timer)
          if (code === 0) return resolve(out)
          reject(new Error(dockerError(errOut)))
        })
        channel.end(opts.stdin ?? '')
      })
    })
  }

  /** Download an image. Progress goes to the window as `docker:pullProgress`. */
  async pull(id: string, image: string): Promise<void> {
    const lines: string[] = []
    let last = 0
    await this.stream(id, pullCommand(image), {
      timeoutMs: 30 * 60_000,
      onLine: (line) => {
        lines.push(line)
        if (Date.now() - last < 200) return
        last = Date.now()
        this.send('docker:pullProgress', { id, image, ...pullProgress(lines) })
      }
    })
  }

  /** Create a container (and start it, if asked). Returns its id. */
  async create(id: string, spec: DockerCreateSpec): Promise<string> {
    // Only images that are on the server: nothing is downloaded as a side effect of this.
    // "nginx" means "nginx:latest"; a colon before the last slash belongs to the address of a registry
    const tagged = (spec.image.split('/').pop() ?? '').includes(':')
    const wanted = tagged ? spec.image : `${spec.image}:latest`
    const local = await this.images(id)
    if (!local.some((i) => `${i.repository}:${i.tag}` === wanted)) throw new Error(`The image “${spec.image}” is not on this server yet. Download it first.`)
    const { command, stdin } = createCommand(spec)
    const out = await this.stream(id, command, { stdin, timeoutMs: 120_000 })
    return out.trim().split(/\r?\n/).pop() ?? ''
  }

  close(id: string): void {
    const c = this.sessions.get(id)
    this.sessions.delete(id)
    c?.end()
  }

  /** Vault locked or app quitting. */
  closeAll(): void {
    for (const id of [...this.sessions.keys()]) {
      this.close(id)
      this.send('docker:closed', id)
    }
  }
}
