import type { Client, ClientChannel } from 'ssh2'
import type { HostRecord, ScreenList, TerminalTarget } from '@shared/types'
import { logsCommand, shellCommand } from './core/docker'
import { randomId } from './core/crypto'
import type { Prompter } from './core/prompter'
import { AltScreenFilter, LIST_COMMAND, SCREEN_NAME, historyCommand, parseHistory, parseScreenList, pushIntoScrollback, shellQuote } from './core/screens'
import { connectSsh, execCommand } from './core/ssh'
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

  /**
   * Open a shell, or a screen when `screen` is given.
   *
   * A screen is attached directly, without a shell in between. Closing the tab then only ends the
   * connection, and screen reacts to that by detaching: the program inside keeps running, just as
   * after Ctrl+A, D. Nothing here ever asks a screen to quit; that is `endScreen`.
   */
  async open(host: HostRecord, cols: number, rows: number, target?: TerminalTarget): Promise<string> {
    if (target && host.protocol !== 'ssh') throw new Error('This needs an SSH connection')
    // The log of a container, or a shell inside one. Ending the tab ends only that command.
    const docker = target && 'dockerLogs' in target ? logsCommand(target.dockerLogs) : target && 'dockerShell' in target ? shellCommand(target.dockerShell) : null
    const screen = target && !docker ? (target as Exclude<TerminalTarget, { dockerLogs: string } | { dockerShell: string }>) : undefined
    const client = await connectSsh(host, { vault: this.vault, prompter: this.prompter, interactive: true })
    const pty = { term: 'xterm-256color', cols, rows }
    /** id of the screen whose earlier output is fetched once it is attached */
    let attached: string | null = null
    const start = async (): Promise<ClientChannel> => {
      if (docker) return new Promise((resolve, reject) => client.exec(docker, { pty }, (err, s) => (err ? reject(err) : resolve(s))))
      if (!screen) return new Promise((resolve, reject) => client.shell(pty, (err, s) => (err ? reject(err) : resolve(s))))
      let command: string
      const list = await this.listOn(client)
      if (!list.installed) throw new Error('The program “screen” is not installed on this server')
      // A new screen whose name is taken (also after "Reconnect") joins the existing one.
      const wanted = screen
      const existing = 'create' in wanted ? list.screens.find((s) => s.name === wanted.create)?.id : wanted.attach
      if ('create' in screen && !existing) {
        if (!SCREEN_NAME.test(screen.create)) throw new Error('Use letters, digits, dots, dashes and underscores for the name')
        command = `screen -S ${shellQuote(screen.create)}`
      } else {
        // Only screens the server itself lists are attached; the id never comes unchecked from outside.
        if (!existing || !list.screens.some((s) => s.id === existing)) throw new Error('This screen no longer exists on the server')
        attached = existing
        // -x: join the screen without pushing out anyone who is attached from elsewhere
        command = `screen -x ${shellQuote(existing)}`
      }
      return new Promise((resolve, reject) => client.exec(command, { pty }, (err, s) => (err ? reject(err) : resolve(s))))
    }
    const stream = await start().catch((e) => {
      client.end()
      throw e
    })
    const id = randomId()
    const session: TermSession = { client, stream, hostId: host.id, buffer: [], flushScheduled: false }
    this.sessions.set(id, session)
    const filter = screen ? new AltScreenFilter() : null
    // While the earlier output of a screen is being fetched, what screen draws is kept back, so
    // that the history can be put in front of it.
    let holding = attached !== null

    // Batch small chunks to keep IPC traffic reasonable during heavy output.
    const flush = (): void => {
      session.flushScheduled = false
      if (session.buffer.length === 0) return
      const data = Buffer.concat(session.buffer)
      session.buffer = []
      this.send('term:data', id, new Uint8Array(data))
    }
    const onData = (raw: Buffer): void => {
      // latin1 keeps every byte as it is while the escape sequences are looked at
      const chunk = filter ? Buffer.from(filter.push(raw.toString('latin1')), 'latin1') : raw
      if (chunk.length === 0) return
      session.buffer.push(chunk)
      if (!holding && !session.flushScheduled) {
        session.flushScheduled = true
        setTimeout(flush, 8)
      }
    }
    stream.on('data', onData)
    stream.stderr.on('data', onData)
    if (attached) {
      void execCommand(client, historyCommand(attached), { timeoutMs: 8000, maxBytes: 4 * 1024 * 1024 })
        .then((r) => parseHistory(r.stdout, Buffer.concat(session.buffer).toString('utf8'), rows))
        .catch(() => '')
        .then((history) => {
          if (history) session.buffer.unshift(Buffer.from(history + pushIntoScrollback(rows), 'utf8'))
          holding = false
          flush()
        })
    }
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

  private async listOn(client: Client): Promise<ScreenList> {
    const r = await execCommand(client, LIST_COMMAND, { timeoutMs: 8000, maxBytes: 256 * 1024 })
    return parseScreenList(r.stdout)
  }

  /** The screens of the user this terminal is logged in as. */
  screens(id: string): Promise<ScreenList> {
    const s = this.sessions.get(id)
    if (!s) throw new Error('This terminal is no longer connected')
    return this.listOn(s.client)
  }

  /** Whether the docker command exists for the user of this terminal. Changes nothing. */
  async hasDocker(id: string): Promise<boolean> {
    const s = this.sessions.get(id)
    if (!s) return false
    const r = await execCommand(s.client, 'command -v docker >/dev/null 2>&1 && echo yes', { timeoutMs: 8000, maxBytes: 1024 })
    return r.stdout.includes('yes')
  }

  /** End a screen and the program running in it. Only on an explicit request of the user. */
  async endScreen(id: string, screenId: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) throw new Error('This terminal is no longer connected')
    const list = await this.listOn(s.client)
    if (!list.screens.some((x) => x.id === screenId)) throw new Error('This screen no longer exists on the server')
    await execCommand(s.client, `screen -S ${shellQuote(screenId)} -X quit`, { timeoutMs: 8000, maxBytes: 64 * 1024 })
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
