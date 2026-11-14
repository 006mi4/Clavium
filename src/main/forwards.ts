import { createServer, type Server } from 'node:net'
import type { Client } from 'ssh2'
import type { ActiveForward, HostRecord } from '@shared/types'
import type { Prompter } from './core/prompter'
import { connectSsh } from './core/ssh'
import type { Vault } from './core/vault'

interface Running extends ActiveForward {
  server: Server
  client: Client
}

/** Local port forwarding (ssh -L), always bound to 127.0.0.1. */
export class ForwardManager {
  private running = new Map<string, Running>()

  constructor(
    private readonly vault: Vault,
    private readonly prompter: Prompter,
    private readonly changed: () => void
  ) {}

  list(): ActiveForward[] {
    return [...this.running.values()].map(({ hostId, forwardId, localPort, remoteHost, remotePort }) => ({
      hostId,
      forwardId,
      localPort,
      remoteHost,
      remotePort
    }))
  }

  async start(host: HostRecord, forwardId: string): Promise<void> {
    const fwd = host.forwards.find((f) => f.id === forwardId)
    if (!fwd) throw new Error('Port forward not found')
    const key = `${host.id}:${forwardId}`
    if (this.running.has(key)) return
    const client = await connectSsh(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const server = createServer((sock) => {
      client.forwardOut('127.0.0.1', sock.remotePort ?? 0, fwd.remoteHost, fwd.remotePort, (err, stream) => {
        if (err) {
          sock.destroy()
          return
        }
        sock.pipe(stream).pipe(sock)
        sock.on('error', () => stream.close())
        stream.on('error', () => sock.destroy())
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', (e) => {
        client.end()
        reject(new Error(`Cannot listen on 127.0.0.1:${fwd.localPort}: ${e.message}`))
      })
      server.listen(fwd.localPort, '127.0.0.1', () => resolve())
    })
    const entry: Running = {
      hostId: host.id,
      forwardId,
      localPort: fwd.localPort,
      remoteHost: fwd.remoteHost,
      remotePort: fwd.remotePort,
      server,
      client
    }
    this.running.set(key, entry)
    client.on('close', () => this.stop(host.id, forwardId))
    this.changed()
  }

  stop(hostId: string, forwardId: string): void {
    const key = `${hostId}:${forwardId}`
    const r = this.running.get(key)
    if (!r) return
    this.running.delete(key)
    r.server.close()
    r.client.end()
    this.changed()
  }

  stopAll(): void {
    for (const r of [...this.running.values()]) this.stop(r.hostId, r.forwardId)
  }
}
