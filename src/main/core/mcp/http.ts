import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AppSettings } from '@shared/types'
import { safeEqual, sha256Hex } from '../crypto'
import type { Vault } from '../vault'
import type { McpService } from './service'

const MAX_BODY = 4 * 1024 * 1024
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export interface McpHttpOptions {
  vault: Vault
  service: McpService
  settings: () => AppSettings
}

/**
 * MCP over Streamable HTTP, bound to 127.0.0.1 only.
 *  - Bearer token required (constant-time compare).
 *  - Requests carrying an Origin header are rejected: browsers always send one, MCP clients
 *    don't. Together with the Host-header check this blocks CSRF and DNS rebinding.
 *  - Failed authentications are rate limited.
 */
export class McpHttpServer {
  private server: Server | null = null
  private port = 0
  private failures: number[] = []
  private blockedUntil = 0

  constructor(private readonly opts: McpHttpOptions) {}

  get listeningPort(): number {
    return this.server ? this.port : 0
  }

  async start(port: number): Promise<void> {
    await this.stop()
    const server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) this.reply(res, 500, 'Internal error')
        else res.end()
      })
    })
    server.headersTimeout = 30_000
    server.requestTimeout = 0 // tool calls may wait for the user's confirmation
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = port
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    if (!s) return
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      s.closeAllConnections?.()
    })
  }

  private reply(res: ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
  }

  private tokenValid(token: string): boolean {
    if (this.opts.vault.state() === 'unlocked') {
      const real = this.opts.vault.data.mcpToken
      return !!real && safeEqual(token, real)
    }
    // Locked: only the hash is available. Tools will still refuse to work until unlock.
    const hash = this.opts.settings().mcpTokenHash
    return !!hash && safeEqual(sha256Hex(token), hash)
  }

  private authFailed(): void {
    const now = Date.now()
    this.failures = this.failures.filter((t) => now - t < 60_000)
    this.failures.push(now)
    if (this.failures.length >= 10) this.blockedUntil = now + 60_000
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return this.reply(res, 403, 'Forbidden')

    const host = (req.headers.host ?? '').toLowerCase()
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`]
    if (!allowedHosts.includes(host)) return this.reply(res, 403, 'Invalid Host header')
    if (req.headers.origin !== undefined) return this.reply(res, 403, 'Browser requests are not allowed')

    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/mcp') return this.reply(res, 404, 'Not found')

    if (Date.now() < this.blockedUntil) return this.reply(res, 429, 'Too many failed authentication attempts')
    const auth = req.headers.authorization ?? ''
    const m = /^Bearer\s+(\S+)$/i.exec(auth)
    if (!m || !this.tokenValid(m[1])) {
      this.authFailed()
      res.setHeader('WWW-Authenticate', 'Bearer realm="clavium"')
      return this.reply(res, 401, 'Unauthorized: missing or wrong Clavium MCP token')
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST')
      return this.reply(res, 405, 'Method not allowed (stateless server: POST only)')
    }
    const ct = (req.headers['content-type'] ?? '').toLowerCase()
    if (!ct.startsWith('application/json')) return this.reply(res, 415, 'Content-Type must be application/json')

    let body: unknown
    try {
      body = JSON.parse(await readBody(req, MAX_BODY))
    } catch (e) {
      return this.reply(res, (e as Error).message === 'too large' ? 413 : 400, 'Invalid request body')
    }

    const server = this.opts.service.createServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
