import type { Client } from 'ssh2'
import type { DockerDetails, DockerImage, DockerOverview, DockerStats, HostRecord } from '@shared/types'
import { randomId } from './core/crypto'
import {
  IMAGES_COMMAND,
  OVERVIEW_COMMAND,
  STATS_COMMAND,
  actionCommand,
  inspectCommand,
  parseImages,
  parseInspect,
  parseOverview,
  parseStats,
  removeImageCommand,
  restartPolicyCommand,
  type ContainerAction,
  type RestartPolicy
} from './core/docker'
import type { Prompter } from './core/prompter'
import { connectSsh, execCommand } from './core/ssh'
import type { Vault } from './core/vault'

type Send = (channel: 'docker:closed', id: string) => void

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
      const line = r.stderr.trim().split(/\r?\n/).pop() ?? ''
      throw new Error(line.replace(/^Error response from daemon:\s*/i, '').slice(0, 400) || 'The Docker command failed')
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
