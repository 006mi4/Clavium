import type { Client, ClientChannel } from 'ssh2'
import type { HostRecord } from '@shared/types'
import { randomId } from './core/crypto'
import type { Prompter } from './core/prompter'
import { connectSsh } from './core/ssh'
import type { Vault } from './core/vault'

interface TermSession {
  client: Client
  stream: ClientChannel
  hostId: string
  buffer: Buffer[]
  flushScheduled: boolean
}

type Send = (channel: 'term:data' | 'term:exit', ...args: unknown[]) => void

/** Interactive SSH shells (one connection per tab). */
export class TerminalManager {
  private sessions = new Map<string, TermSession>()

  constructor(
    private readonly vault: Vault,
    private readonly prompter: Prompter,
    private readonly send: Send
  ) {}

  async open(host: HostRecord, cols: number, rows: number): Promise<string> {
    const client = await connectSsh(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const stream = await new Promise<ClientChannel>((resolve, reject) =>
      client.shell({ term: 'xterm-256color', cols, rows }, (err, s) => (err ? reject(err) : resolve(s)))
    ).catch((e) => {
      client.end()
      throw e
    })
    const id = randomId()
    const session: TermSession = { client, stream, hostId: host.id, buffer: [], flushScheduled: false }
    this.sessions.set(id, session)

    // Batch small chunks to keep IPC traffic reasonable during heavy output.
    const flush = (): void => {
      session.flushScheduled = false
      if (session.buffer.length === 0) return
      const data = Buffer.concat(session.buffer)
      session.buffer = []
      this.send('term:data', id, new Uint8Array(data))
    }
    const onData = (chunk: Buffer): void => {
      session.buffer.push(chunk)
      if (!session.flushScheduled) {
        session.flushScheduled = true
        setTimeout(flush, 8)
      }
    }
    stream.on('data', onData)
    stream.stderr.on('data', onData)
    let exited = false
    const exit = (reason: string): void => {
      if (exited) return
      exited = true
      flush()
      this.sessions.delete(id)
      this.send('term:exit', id, reason)
      client.end()
    }
    stream.on('close', () => exit('Session closed'))
    client.on('close', () => exit('Connection closed'))
    client.on('error', (e: Error) => exit(`Connection error: ${e.message}`))
    return id
  }

  write(id: string, data: string): void {
    this.sessions.get(id)?.stream.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.sessions.get(id)?.stream.setWindow(rows, cols, 0, 0)
  }

  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.stream.close()
    s.client.end()
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id)
  }
}
