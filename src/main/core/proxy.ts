import { connect, isIP, type Socket } from 'node:net'
import type { ProxyConfig } from '@shared/types'

export type ProxyAccess = ProxyConfig & { password?: string }

/** Reads exact numbers of bytes from a socket without taking more than asked for. */
function reader(socket: Socket) {
  let fail: ((e: Error) => void) | null = null
  let wake: (() => void) | null = null
  const onReadable = (): void => wake?.()
  const onError = (e: Error): void => fail?.(e)
  const onClose = (): void => fail?.(new Error('The proxy closed the connection'))
  socket.on('readable', onReadable)
  socket.on('error', onError)
  socket.on('close', onClose)
  const next = (): Promise<void> =>
    new Promise((resolve, reject) => {
      wake = resolve
      fail = reject
    })
  return {
    async bytes(n: number): Promise<Buffer> {
      for (;;) {
        const chunk = socket.read(n) as Buffer | null
        if (chunk && chunk.length === n) return chunk
        if (chunk) socket.unshift(chunk)
        await next()
      }
    },
    /** Read up to and including the first empty line (the end of an HTTP header). */
    async header(limit: number): Promise<string> {
      let seen = Buffer.alloc(0)
      for (;;) {
        const chunk = socket.read() as Buffer | null
        if (!chunk) {
          await next()
          continue
        }
        seen = Buffer.concat([seen, chunk])
        if (seen.length >= 5 && seen.subarray(0, 5).toString('latin1') !== 'HTTP/') throw new Error('This is not an HTTP proxy')
        const end = seen.indexOf('\r\n\r\n')
        if (end >= 0) {
          // What follows belongs to the connection behind the proxy.
          if (seen.length > end + 4) socket.unshift(seen.subarray(end + 4))
          return seen.subarray(0, end).toString('latin1')
        }
        if (seen.length > limit) throw new Error('The proxy sent an answer that is too long')
      }
    },
    /** Hand the socket over: from here on its data belongs to whoever uses the tunnel. */
    release(): void {
      socket.removeListener('readable', onReadable)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
  }
}

const SOCKS_ERRORS: Record<number, string> = {
  1: 'general failure',
  2: 'connection not allowed',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'time to live expired',
  7: 'command not supported',
  8: 'address type not supported'
}

async function socks5(socket: Socket, read: ReturnType<typeof reader>, proxy: ProxyAccess, host: string, port: number): Promise<void> {
  const withLogin = !!proxy.username
  socket.write(Buffer.from(withLogin ? [5, 2, 0, 2] : [5, 1, 0]))
  const [version, method] = await read.bytes(2)
  if (version !== 5) throw new Error('This is not a SOCKS5 proxy')
  if (method === 2) {
    const user = Buffer.from(proxy.username ?? '')
    const pass = Buffer.from(proxy.password ?? '')
    if (user.length > 255 || pass.length > 255) throw new Error('User name or password of the proxy is too long')
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
    const [, status] = await read.bytes(2)
    if (status !== 0) throw new Error('The proxy did not accept the user name or password')
  } else if (method !== 0) {
    throw new Error(withLogin ? 'The proxy offers no way to log in that Clavium knows' : 'The proxy asks for a user name and password')
  }
  // The name goes to the proxy as it is: the proxy looks it up, not this computer.
  const kind = isIP(host)
  let address: Buffer
  if (kind === 4) address = Buffer.from([1, ...host.split('.').map(Number)])
  else if (kind === 6) address = Buffer.concat([Buffer.from([4]), ipv6Bytes(host)])
  else {
    const name = Buffer.from(host)
    if (name.length > 255) throw new Error('Host name too long')
    address = Buffer.concat([Buffer.from([3, name.length]), name])
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]))
  const [, reply, , bound] = await read.bytes(4)
  if (reply !== 0) throw new Error(`The proxy could not connect to ${host}:${port} (${SOCKS_ERRORS[reply] ?? `error ${reply}`})`)
  const rest = bound === 1 ? 4 : bound === 4 ? 16 : bound === 3 ? (await read.bytes(1))[0] : -1
  if (rest < 0) throw new Error('The proxy sent an answer Clavium does not understand')
  await read.bytes(rest + 2)
}

function ipv6Bytes(host: string): Buffer {
  const [head, tail = ''] = host.split('::')
  const groups = (s: string): number[] => (s ? s.split(':').map((g) => parseInt(g, 16)) : [])
  const a = groups(head)
  const b = host.includes('::') ? groups(tail) : []
  const all = [...a, ...new Array<number>(Math.max(0, 8 - a.length - b.length)).fill(0), ...b]
  const out = Buffer.alloc(16)
  all.slice(0, 8).forEach((g, i) => out.writeUInt16BE(g & 0xffff, i * 2))
  return out
}

async function httpConnect(socket: Socket, read: ReturnType<typeof reader>, proxy: ProxyAccess, host: string, port: number): Promise<void> {
  const target = `${host.includes(':') ? `[${host}]` : host}:${port}`
  const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`]
  if (proxy.username) lines.push('Proxy-Authorization: Basic ' + Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64'))
  socket.write(lines.join('\r\n') + '\r\n\r\n')
  const header = await read.header(16 * 1024)
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(header)
  if (!status) throw new Error('This is not an HTTP proxy')
  if (status[1] === '407') throw new Error(proxy.username ? 'The proxy did not accept the user name or password' : 'The proxy asks for a user name and password')
  if (status[1][0] !== '2') throw new Error(`The proxy could not connect to ${host}:${port} (HTTP ${status[1]})`)
}

/**
 * Open a connection to `host:port` through a proxy. Resolves with a socket that behaves as if it
 * were connected to the target directly. The password is never part of an error message.
 */
export function openTunnel(proxy: ProxyAccess, host: string, port: number, timeoutMs = 20000): Promise<Socket> {
  if (/[\r\n\0\s]/.test(host)) return Promise.reject(new Error('Invalid host name'))
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port })
    const read = reader(socket)
    const timer = setTimeout(() => socket.destroy(new Error(`The proxy ${proxy.host}:${proxy.port} did not answer in time`)), timeoutMs)
    const failed = (e: Error): void => {
      clearTimeout(timer)
      read.release()
      socket.on('error', () => undefined)
      socket.destroy()
      reject(/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT/.test(e.message) ? new Error(`Cannot reach the proxy ${proxy.host}:${proxy.port} (${e.message})`) : e)
    }
    socket.once('error', failed)
    socket.once('connect', () => {
      socket.removeListener('error', failed)
      ;(proxy.type === 'socks5' ? socks5 : httpConnect)(socket, read, proxy, host, port).then(() => {
        clearTimeout(timer)
        read.release()
        resolve(socket)
      }, failed)
    })
  })
}
