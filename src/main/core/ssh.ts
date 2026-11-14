import { existsSync } from 'node:fs'
import { Client, type Algorithms, type ConnectConfig } from 'ssh2'
import type { HostRecord } from '@shared/types'
import { verifyPresentedKey } from './hostkeys'
import { fingerprintOf, keyTypeOf } from './keys'
import type { Prompter } from './prompter'
import type { Vault } from './vault'

/** Modern algorithms only. Legacy ones (SHA-1, ssh-rsa) must be enabled per host. */
const STRICT_ALGORITHMS: Algorithms = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha256'
  ],
  cipher: [
    'chacha20-poly1305@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-gcm@openssh.com',
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr'
  ],
  hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512'],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256'
  ],
  compress: ['none']
}

const LEGACY_EXTRAS = {
  kex: ['diffie-hellman-group14-sha1', 'diffie-hellman-group-exchange-sha1'],
  hmac: ['hmac-sha1-etm@openssh.com', 'hmac-sha1'],
  serverHostKey: ['ssh-rsa']
}

/**
 * What the current runtime can actually do. Electron's BoringSSL lacks some algorithms
 * that plain Node.js has (e.g. chacha20-poly1305), and ssh2 rejects unknown names.
 */
const RUNTIME_SUPPORTED = ((): Record<'kex' | 'cipher' | 'hmac' | 'serverHostKey', Set<string>> => {
  // Not part of ssh2's typed public API, but stable since ssh2 1.0.
  const c = require('ssh2/lib/protocol/constants.js') as Record<string, string[]>
  return {
    kex: new Set(c.SUPPORTED_KEX),
    cipher: new Set(c.SUPPORTED_CIPHER),
    hmac: new Set(c.SUPPORTED_MAC),
    serverHostKey: new Set(c.SUPPORTED_SERVER_HOST_KEY)
  }
})()

export function algorithmsFor(host: Pick<HostRecord, 'allowLegacyAlgorithms'>): Algorithms {
  const pick = (k: keyof typeof RUNTIME_SUPPORTED, extra: string[] = []): string[] =>
    [...(STRICT_ALGORITHMS[k] as string[]), ...(host.allowLegacyAlgorithms ? extra : [])].filter((a) =>
      RUNTIME_SUPPORTED[k].has(a)
    )
  return {
    kex: pick('kex', LEGACY_EXTRAS.kex),
    cipher: pick('cipher'),
    hmac: pick('hmac', LEGACY_EXTRAS.hmac),
    serverHostKey: pick('serverHostKey', LEGACY_EXTRAS.serverHostKey),
    compress: ['none']
  } as Algorithms
}

function agentPath(): string | undefined {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') {
    const openssh = '\\\\.\\pipe\\openssh-ssh-agent'
    return existsSync(openssh) ? openssh : 'pageant'
  }
  return undefined
}

export interface SshConnectContext {
  vault: Vault
  prompter: Prompter
  /** true for user-initiated sessions; false for AI/MCP sessions (never prompts for secrets). */
  interactive: boolean
  readyTimeoutMs?: number
}

export class SshConnectError extends Error {}

export function connectSsh(host: HostRecord, ctx: SshConnectContext): Promise<Client> {
  if (host.protocol !== 'ssh') return Promise.reject(new SshConnectError('Host is not an SSH host'))
  const client = new Client()
  const hostKeyId = `ssh:${host.hostname}:${host.port}`
  let hostKeyRejected = false

  const config: ConnectConfig = {
    host: host.hostname,
    port: host.port,
    username: host.username,
    readyTimeout: ctx.readyTimeoutMs ?? 20000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    algorithms: algorithmsFor(host),
    agentForward: false,
    tryKeyboard: true,
    hostVerifier: (key: Buffer, verify: (ok: boolean) => void) => {
      verifyPresentedKey(
        ctx.vault,
        ctx.prompter,
        {
          id: hostKeyId,
          displayHost: `${host.hostname}:${host.port}`,
          keyType: keyTypeOf(key),
          fingerprint: fingerprintOf(key)
        },
        ctx.interactive
      )
        .then((ok) => {
          hostKeyRejected = !ok
          verify(ok)
        })
        .catch(() => {
          hostKeyRejected = true
          verify(false)
        })
    }
  } as ConnectConfig

  switch (host.authMethod) {
    case 'password':
      if (host.password) config.password = host.password
      break
    case 'key': {
      const key = ctx.vault.data.keys.find((k) => k.id === host.keyId)
      if (!key) return Promise.reject(new SshConnectError('The SSH key of this host no longer exists'))
      config.privateKey = key.privateKey
      if (key.passphrase) config.passphrase = key.passphrase
      break
    }
    case 'agent': {
      const agent = agentPath()
      if (!agent) return Promise.reject(new SshConnectError('No SSH agent found (SSH_AUTH_SOCK not set)'))
      config.agent = agent
      break
    }
    case 'keyboard-interactive':
      break
  }

  client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
    // Answer password prompts automatically with the stored password.
    if (host.password && prompts.length > 0 && prompts.every((p) => /password/i.test(p.prompt))) {
      finish(prompts.map(() => host.password as string))
      return
    }
    if (!ctx.interactive) {
      finish([])
      return
    }
    ctx.prompter
      .keyboardInteractive({
        host: `${host.username}@${host.hostname}`,
        name,
        instructions,
        prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo }))
      })
      .then((answers) => finish(answers ?? []))
      .catch(() => finish([]))
  })

  return new Promise<Client>((resolve, reject) => {
    const onError = (err: Error & { level?: string }): void => {
      client.removeListener('ready', onReady)
      if (hostKeyRejected) {
        reject(new SshConnectError('Host key was not accepted — connection aborted'))
      } else if (err.level === 'client-authentication') {
        reject(new SshConnectError('Authentication failed (wrong user, password or key)'))
      } else if (err.level === 'client-timeout') {
        reject(new SshConnectError('Connection timed out'))
      } else {
        reject(new SshConnectError(err.message))
      }
    }
    const onReady = (): void => {
      client.removeListener('error', onError)
      // Swallow late errors so they never crash the process; owners attach their own handlers.
      client.on('error', () => undefined)
      resolve(client)
    }
    client.once('ready', onReady)
    client.once('error', onError)
    try {
      client.connect(config)
    } catch (e) {
      onError(e as Error)
    }
  })
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  truncated: boolean
}

/** Run a single command (no PTY) with a hard timeout and output cap. */
export function execCommand(
  client: Client,
  command: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      const out: Buffer[] = []
      const errOut: Buffer[] = []
      let outBytes = 0
      let errBytes = 0
      let truncated = false
      let timedOut = false
      let exitCode: number | null = null
      let signal: string | null = null
      const collect = (target: Buffer[], chunk: Buffer, isErr: boolean): void => {
        const used = isErr ? errBytes : outBytes
        const room = opts.maxBytes - used
        if (room <= 0) {
          truncated = true
          return
        }
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk
        if (part.length < chunk.length) truncated = true
        target.push(part)
        if (isErr) errBytes += part.length
        else outBytes += part.length
      }
      const timer = setTimeout(() => {
        timedOut = true
        try {
          stream.signal('KILL')
        } catch {
          /* not supported by every server */
        }
        stream.close()
      }, opts.timeoutMs)
      stream.on('data', (c: Buffer) => collect(out, c, false))
      stream.stderr.on('data', (c: Buffer) => collect(errOut, c, true))
      stream.on('exit', (code: number | null, sig?: string) => {
        exitCode = code ?? null
        signal = sig ?? null
      })
      stream.on('close', () => {
        clearTimeout(timer)
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errOut).toString('utf8'),
          exitCode,
          signal,
          timedOut,
          truncated
        })
      })
    })
  })
}
