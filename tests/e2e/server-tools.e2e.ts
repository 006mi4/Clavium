// The MCP tools for screens and Docker against a real server. It needs such a server, so it only
// runs when asked for:
//   CLAVIUM_TOOLS_TEST=user@host:port  CLAVIUM_TOOLS_KEY=path/to/private-key  CLAVIUM_TOOLS_IMAGE=alpine
// The user must be allowed to log in with that key and to use Docker; `screen` must be on the PATH
// and the image (with `sh`) on the server. Creates a screen and a container named clavium-mcp-*
// and removes them again.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AuditLog } from '../../src/main/core/audit'
import { buildKeyRecord } from '../../src/main/core/keys'
import { McpService } from '../../src/main/core/mcp/service'
import { connectSsh, execCommand } from '../../src/main/core/ssh'
import { newUnlockedVault, recordingPrompter, sshHost, type RecordingPrompter } from '../helpers/fixtures'

const target = /^(.+)@(.+):(\d+)$/.exec(process.env.CLAVIUM_TOOLS_TEST ?? '')
const IMAGE = process.env.CLAVIUM_TOOLS_IMAGE ?? 'alpine'
const SCREEN = 'clavium-mcp-console'
const BOX = 'clavium-mcp-box'

let service: McpService
let prompter: RecordingPrompter
let client: Client
let remote: (command: string) => Promise<string>
const call = async (name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
  const r = (await client.callTool({ name, arguments: { host: 'real-box', ...args } })) as { content: { text: string }[]; isError?: boolean }
  return { text: r.content[0]?.text ?? '', isError: !!r.isError }
}
const until = async (what: () => Promise<boolean>, message: string): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    if (await what()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(message)
}

describe.runIf(!!target)('MCP tools for screens and Docker on a real server', () => {
  beforeAll(async () => {
    const [, username, hostname, port] = target as RegExpExecArray
    const { vault, dir } = await newUnlockedVault()
    prompter = recordingPrompter()
    const key = buildKeyRecord('test', readFileSync(process.env.CLAVIUM_TOOLS_KEY as string, 'utf8'))
    const host = sshHost(Number(port), { name: 'real-box', hostname, username, authMethod: 'key', keyId: key.id, password: undefined, aiAccess: 'full', aiConfirm: 'changes' })
    await vault.update((d) => {
      d.keys.push(key)
      d.hosts.push(host)
    })
    // The user has connected once and trusted the host key; AI sessions never do that themselves.
    const ssh = await connectSsh(host, { vault, prompter, interactive: true })
    remote = async (command) => (await execCommand(ssh, command, { timeoutMs: 60_000, maxBytes: 1024 * 1024 })).stdout.trim()
    // a "game console": prints a log, then repeats every line typed into it, exactly as received
    await remote(`screen -S ${SCREEN} -X quit; docker rm -f -v ${BOX} 2>/dev/null; sleep 0.3; screen -dmS ${SCREEN} sh -c 'for i in 1 2 3; do echo "[Server] line $i"; done; while IFS= read -r l; do printf "got: %s\\n" "$l"; done'`)
    await remote(`docker run -d --name ${BOX} --entrypoint sh ${IMAGE} -c 'trap "exit 0" TERM; echo "box started"; while true; do sleep 1 & wait $!; done'`)

    service = new McpService({ vault, prompter, audit: new AuditLog(join(dir, 'audit.log')), version: 'test' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await service.createServer().connect(a)
    client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(b)
  })

  afterAll(async () => {
    await remote?.(`screen -S ${SCREEN} -X quit; docker rm -f -v ${BOX}`).catch(() => undefined)
    await client?.close()
    service?.shutdown()
  })

  it('lists screens and reads what a screen has printed', async () => {
    const list = JSON.parse((await call('screen_list', {})).text) as { name: string; attached: boolean }[]
    expect(list.find((s) => s.name === SCREEN)).toMatchObject({ attached: false })
    expect((await call('screen_read', { screen: SCREEN })).text).toBe('[Server] line 1\n[Server] line 2\n[Server] line 3\n')
    expect((await call('screen_read', { screen: SCREEN, lines: 1 })).text).toBe('[Server] line 3\n')
    expect(await call('screen_read', { screen: 'no-such-screen' })).toMatchObject({ isError: true, text: expect.stringMatching(/There is no screen/) })
    expect(prompter.confirmCalls).toHaveLength(0) // looking needs no approval with "ask before changes"
  })

  it('types into a screen exactly what it was given, after the user approved', async () => {
    const tricky = String.raw`say it's $HOME ^C \n "done"; rm -rf ~`
    expect((await call('screen_send', { screen: SCREEN, text: tricky })).text).toMatch(/Sent/)
    expect(prompter.confirmCalls.at(-1)).toMatchObject({ tool: 'screen_send', detail: tricky })
    await until(async () => (await call('screen_read', { screen: SCREEN })).text.includes('got: '), 'the program did not get the line')
    // the program received the line unchanged: nothing was expanded, run or cut off
    expect((await call('screen_read', { screen: SCREEN, lines: 1 })).text).toBe(`got: ${tricky}\n`)

    prompter.allow = false
    expect((await call('screen_send', { screen: SCREEN, text: 'stop' })).text).toMatch(/denied/)
    prompter.allow = true
    expect((await call('screen_read', { screen: SCREEN, lines: 1 })).text).not.toContain('stop')
  })

  it('lists containers, reads a log, and stops and starts a container after approval', async () => {
    const list = JSON.parse((await call('docker_list', {})).text) as { name: string; state: string }[]
    expect(list.find((c) => c.name === BOX)).toMatchObject({ state: 'running' })
    expect((await call('docker_logs', { container: BOX })).text).toBe('box started\n')
    expect(await call('docker_logs', { container: 'no-such-container' })).toMatchObject({ isError: true, text: expect.stringMatching(/There is no container/) })

    const before = prompter.confirmCalls.length
    expect((await call('docker_container_action', { container: BOX, action: 'stop' })).text).toMatch(/is now: Exited/)
    expect(await remote(`docker inspect -f '{{.State.Running}}' ${BOX}`)).toBe('false')
    expect((await call('docker_container_action', { container: BOX, action: 'start' })).text).toMatch(/is now: Up/)
    expect(await remote(`docker inspect -f '{{.State.Running}}' ${BOX}`)).toBe('true')
    expect(prompter.confirmCalls.slice(before).map((c) => c.detail)).toEqual([`docker stop ${BOX}`, `docker start ${BOX}`])

    prompter.allow = false
    expect((await call('docker_container_action', { container: BOX, action: 'stop' })).text).toMatch(/denied/)
    prompter.allow = true
    expect(await remote(`docker inspect -f '{{.State.Running}}' ${BOX}`)).toBe('true')
  })
})
