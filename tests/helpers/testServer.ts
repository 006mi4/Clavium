// A small but real SSH + SFTP server for integration tests (backed by a temp directory).
import * as fs from 'node:fs'
import { posix, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { Server, utils, type Connection } from 'ssh2'

const { STATUS_CODE, flagsToString } = utils.sftp

export interface TestSshServer {
  port: number
  root: string
  hostKey: string
  /** permission changes the server was asked to make */
  setstat: { path: string; mode: number | undefined }[]
  chown: { path: string; uid: number; gid: number }[]
  close(): Promise<void>
}

export const TEST_USER = 'tester'
export const TEST_PASSWORD = 'correct horse battery'

function toAttrs(st: fs.Stats) {
  return {
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  }
}

export async function startTestSshServer(hostKey?: string): Promise<TestSshServer> {
  const root = mkdtempSync(join(tmpdir(), 'clavium-sftp-'))
  const key = hostKey ?? utils.generateKeyPairSync('ed25519').private
  const setstat: TestSshServer['setstat'] = []
  const chown: TestSshServer['chown'] = []
  const real = (vpath: string): string => {
    const norm = posix.normalize(posix.isAbsolute(vpath) ? vpath : posix.join('/', vpath))
    if (norm.includes('..')) throw new Error('escape')
    return join(root, ...norm.split('/').filter(Boolean))
  }

  const server = new Server({ hostKeys: [key] }, (client: Connection) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === TEST_USER && ctx.password === TEST_PASSWORD) return ctx.accept()
      ctx.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept) => accept?.())
        session.on('shell', (accept) => {
          // Minimal line-echo shell: answers "echo:<line>" for every line typed.
          const stream = accept()
          stream.write('Welcome to the Clavium test server\r\n$ ')
          let line = ''
          stream.on('data', (d: Buffer) => {
            for (const ch of d.toString('utf8')) {
              if (ch === '\r' || ch === '\n') {
                stream.write(`\r\necho:${line}\r\n$ `)
                if (line === 'exit') {
                  stream.exit(0)
                  stream.end()
                }
                line = ''
              } else {
                line += ch
                stream.write(ch)
              }
            }
          })
        })
        session.on('exec', (accept, _reject, info) => {
          const stream = accept()
          if (info.command === 'sleep') {
            stream.on('close', () => undefined)
            return // never finishes -> client timeout
          }
          stream.write(`ran: ${info.command}\n`)
          stream.stderr.write('warn\n')
          stream.exit(3)
          stream.end()
        })
        session.on('sftp', (accept) => {
          const sftp = accept()
          const handles = new Map<number, { fd?: number; dir?: string; done?: boolean }>()
          let next = 1
          const newHandle = (v: { fd?: number; dir?: string }): Buffer => {
            const id = next++
            handles.set(id, v)
            const b = Buffer.alloc(4)
            b.writeUInt32BE(id)
            return b
          }
          const getHandle = (b: Buffer) => handles.get(b.readUInt32BE(0))
          const fail = (reqid: number, e: unknown): void => {
            const code = (e as NodeJS.ErrnoException).code
            sftp.status(reqid, code === 'ENOENT' ? STATUS_CODE.NO_SUCH_FILE : code === 'EEXIST' ? STATUS_CODE.FAILURE : STATUS_CODE.FAILURE)
          }
          sftp.on('REALPATH', (reqid, path) => {
            const v = posix.normalize(path === '.' || path === '' ? '/' : posix.isAbsolute(path) ? path : '/' + path)
            sftp.name(reqid, [{ filename: v, longname: v, attrs: {} as never }])
          })
          for (const ev of ['STAT', 'LSTAT'] as const) {
            sftp.on(ev, (reqid: number, path: string) => {
              try {
                const st = ev === 'STAT' ? fs.statSync(real(path)) : fs.lstatSync(real(path))
                sftp.attrs(reqid, toAttrs(st))
              } catch (e) {
                fail(reqid, e)
              }
            })
          }
          sftp.on('FSTAT', (reqid, handle) => {
            const h = getHandle(handle)
            if (h?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            sftp.attrs(reqid, toAttrs(fs.fstatSync(h.fd)))
          })
          sftp.on('OPENDIR', (reqid, path) => {
            try {
              if (!fs.statSync(real(path)).isDirectory()) return sftp.status(reqid, STATUS_CODE.FAILURE)
              sftp.handle(reqid, newHandle({ dir: path }))
            } catch (e) {
              fail(reqid, e)
            }
          })
          sftp.on('READDIR', (reqid, handle) => {
            const h = getHandle(handle)
            if (!h?.dir) return sftp.status(reqid, STATUS_CODE.FAILURE)
            if (h.done) return sftp.status(reqid, STATUS_CODE.EOF)
            h.done = true
            const names = fs.readdirSync(real(h.dir)).map((name) => {
              const st = fs.lstatSync(join(real(h.dir as string), name))
              return { filename: name, longname: name, attrs: toAttrs(st) }
            })
            sftp.name(reqid, names)
          })
          sftp.on('OPEN', (reqid, filename, flags) => {
            try {
              const fd = fs.openSync(real(filename), flagsToString(flags) ?? 'r')
              sftp.handle(reqid, newHandle({ fd }))
            } catch (e) {
              fail(reqid, e)
            }
          })
          sftp.on('READ', (reqid, handle, offset, length) => {
            const h = getHandle(handle)
            if (h?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            const buf = Buffer.alloc(length)
            const n = fs.readSync(h.fd, buf, 0, length, offset)
            if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF)
            sftp.data(reqid, buf.subarray(0, n))
          })
          sftp.on('WRITE', (reqid, handle, offset, data) => {
            const h = getHandle(handle)
            if (h?.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
            fs.writeSync(h.fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          })
          sftp.on('CLOSE', (reqid, handle) => {
            const h = getHandle(handle)
            if (h?.fd !== undefined) fs.closeSync(h.fd)
            handles.delete(handle.readUInt32BE(0))
            sftp.status(reqid, STATUS_CODE.OK)
          })
          const simple = (ev: string, fn: (...a: string[]) => void) =>
            sftp.on(ev as 'MKDIR', ((reqid: number, ...args: string[]) => {
              try {
                fn(...args)
                sftp.status(reqid, STATUS_CODE.OK)
              } catch (e) {
                fail(reqid, e)
              }
            }) as never)
          simple('MKDIR', (p) => fs.mkdirSync(real(p)))
          simple('RMDIR', (p) => fs.rmdirSync(real(p)))
          simple('REMOVE', (p) => fs.unlinkSync(real(p)))
          simple('RENAME', (a, b) => fs.renameSync(real(a), real(b)))
          sftp.on('SETSTAT', (reqid, path, attrs) => {
            try {
              if (attrs.mode !== undefined) {
                setstat.push({ path, mode: attrs.mode })
                fs.chmodSync(real(path), attrs.mode & 0o777)
              }
              // Changing the owner needs root, so it is only written down.
              if (attrs.uid !== undefined) chown.push({ path, uid: attrs.uid, gid: attrs.gid })
              if (attrs.mtime !== undefined) fs.utimesSync(real(path), attrs.atime ?? attrs.mtime, attrs.mtime)
              sftp.status(reqid, STATUS_CODE.OK)
            } catch (e) {
              fail(reqid, e)
            }
          })
          sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
        })
      })
    })
    client.on('error', () => undefined)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    root,
    hostKey: key,
    setstat,
    chown,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        fs.rmSync(root, { recursive: true, force: true })
      })
  }
}
