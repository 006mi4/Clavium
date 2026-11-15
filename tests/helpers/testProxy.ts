import net, { type AddressInfo } from 'node:net'

export interface TestProxy {
  port: number
  /** every target a client asked for, as "host:port" */
  targets: string[]
  close(): Promise<void>
}

type Login = { username: string; password: string }

function listen(server: net.Server, targets: string[]): Promise<TestProxy> {
  const sockets = new Set<net.Socket>()
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
    s.on('error', () => undefined)
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        targets,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          })
      })
    )
  )
}

function pipeTo(client: net.Socket, host: string, port: number, ok: () => void, fail: () => void): void {
  const out = net.connect(port, host)
  out.once('error', fail)
  out.once('connect', () => {
    out.removeListener('error', fail)
    ok()
    client.pipe(out).pipe(client)
    out.on('error', () => client.destroy())
    client.on('close', () => out.destroy())
    out.on('close', () => client.destroy())
  })
}

/** A small SOCKS5 proxy (RFC 1928, with user name and password as in RFC 1929 when `login` is given). */
export function startSocksProxy(login?: Login): Promise<TestProxy> {
  const targets: string[] = []
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0)
    let step: 'hello' | 'auth' | 'request' | 'open' = 'hello'
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d])
      for (;;) {
        if (step === 'hello') {
          if (buf.length < 2 || buf.length < 2 + buf[1]) return
          const methods = [...buf.subarray(2, 2 + buf[1])]
          buf = buf.subarray(2 + buf[1])
          const want = login ? 2 : 0
          if (!methods.includes(want)) return void client.end(Buffer.from([5, 0xff]))
          client.write(Buffer.from([5, want]))
          step = login ? 'auth' : 'request'
        } else if (step === 'auth') {
          if (buf.length < 2 || buf.length < 2 + buf[1] + 1 || buf.length < 3 + buf[1] + buf[2 + buf[1]]) return
          const user = buf.subarray(2, 2 + buf[1]).toString()
          const plen = buf[2 + buf[1]]
          const pass = buf.subarray(3 + buf[1], 3 + buf[1] + plen).toString()
          buf = buf.subarray(3 + buf[1] + plen)
          if (user !== login?.username || pass !== login?.password) return void client.end(Buffer.from([1, 1]))
          client.write(Buffer.from([1, 0]))
          step = 'request'
        } else if (step === 'request') {
          if (buf.length < 5) return
          const kind = buf[3]
          const alen = kind === 1 ? 4 : kind === 4 ? 16 : 1 + buf[4]
          if (buf.length < 4 + alen + 2) return
          const host = kind === 1 ? [...buf.subarray(4, 8)].join('.') : kind === 3 ? buf.subarray(5, 5 + buf[4]).toString() : '::1'
          const port = buf.readUInt16BE(4 + alen)
          const rest = buf.subarray(4 + alen + 2)
          step = 'open'
          client.removeListener('data', onData)
          client.pause()
          targets.push(`${host}:${port}`)
          pipeTo(
            client,
            host,
            port,
            () => {
              client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
              if (rest.length) client.unshift(rest)
            },
            () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
          )
          return
        } else return
      }
    }
    client.on('data', onData)
  })
  return listen(server, targets)
}

/** A small HTTP proxy that knows CONNECT only (with Basic authentication when `login` is given). */
export function startHttpProxy(login?: Login): Promise<TestProxy> {
  const targets: string[] = []
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0)
    const onData = (d: Buffer): void => {
      buf = Buffer.concat([buf, d])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      client.removeListener('data', onData)
      client.pause()
      const head = buf.subarray(0, end).toString('latin1')
      const rest = buf.subarray(end + 4)
      const m = /^CONNECT (\S+):(\d+) HTTP\/1\.1\r\n/.exec(head + '\r\n')
      if (!m) return void client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      if (login) {
        const given = /^Proxy-Authorization: Basic (\S+)$/im.exec(head)?.[1]
        if (given !== Buffer.from(`${login.username}:${login.password}`).toString('base64')) {
          return void client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n')
        }
      }
      targets.push(`${m[1]}:${m[2]}`)
      pipeTo(
        client,
        m[1],
        Number(m[2]),
        () => {
          client.write('HTTP/1.1 200 Connection established\r\n\r\n')
          if (rest.length) client.unshift(rest)
        },
        () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      )
    }
    client.on('data', onData)
  })
  return listen(server, targets)
}
