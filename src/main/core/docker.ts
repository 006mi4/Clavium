import type { DockerContainer, DockerCreateSpec, DockerDetails, DockerImage, DockerOverview, DockerStats } from '@shared/types'
import { shellQuote } from './screens'

/**
 * Docker on a server, driven through the `docker` command line over SSH. This file only builds
 * commands and reads their output; nothing here talks to a server.
 *
 * Containers and images are always addressed by the hexadecimal id Docker printed, never by a
 * name, so nothing typed by a user or chosen by a container author ends up in a command line.
 */

const ID = /^[0-9a-f]{12,64}$/
/** The id as Docker printed it, or an error. Images may carry a "sha256:" prefix. */
export function dockerId(value: string): string {
  const id = value.replace(/^sha256:/, '')
  if (!ID.test(id)) throw new Error('Unknown container or image')
  return id
}

export const RESTART_POLICIES = ['no', 'on-failure', 'unless-stopped', 'always'] as const
export type RestartPolicy = (typeof RESTART_POLICIES)[number]
export const CONTAINER_ACTIONS = ['start', 'stop', 'restart', 'pause', 'unpause', 'remove'] as const
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number]

const MARK = 'CLAVIUM_DOCKER'

/** One round trip: is Docker there, may this user use it, which version, and all containers. */
export const OVERVIEW_COMMAND = [
  `command -v docker >/dev/null 2>&1 || { echo ${MARK}_MISSING; exit 0; }`,
  `v=$(docker version --format '{{.Server.Version}}' 2>&1) || { echo ${MARK}_ERROR; echo "$v"; exit 0; }`,
  `echo "${MARK}_VERSION $v"`,
  `docker ps -a --no-trunc --format '{{json .}}'`
].join('; ')

export const STATS_COMMAND = `docker stats --no-stream --format '{{json .}}'`
export const IMAGES_COMMAND = `docker images --no-trunc --format '{{json .}}'`

export function actionCommand(action: ContainerAction, ids: string[]): string {
  if (!CONTAINER_ACTIONS.includes(action)) throw new Error('Unknown action')
  const list = ids.map(dockerId).join(' ')
  if (!list) throw new Error('No container selected')
  // "remove" only takes away stopped containers; Docker refuses for running ones.
  return `docker ${action === 'remove' ? 'rm' : action} ${list}`
}
export function inspectCommand(id: string): string {
  return `docker inspect ${dockerId(id)}`
}
export function restartPolicyCommand(id: string, policy: RestartPolicy): string {
  if (!RESTART_POLICIES.includes(policy)) throw new Error('Unknown restart policy')
  return `docker update --restart ${policy} ${dockerId(id)}`
}
export function removeImageCommand(id: string): string {
  return `docker rmi ${dockerId(id)}`
}
/** Follow the log of a container; for a terminal tab. */
export function logsCommand(id: string): string {
  return `docker logs --tail 1000 -f ${dockerId(id)}`
}
/** The last lines of a container's log, both its output and its error output. */
export function tailLogsCommand(id: string, lines: number): string {
  return `docker logs --tail ${Math.max(1, Math.min(5000, Math.floor(lines)))} ${dockerId(id)} 2>&1`
}
/** A shell inside a container: bash where the image has it, sh otherwise. */
export function shellCommand(id: string): string {
  return `docker exec -it ${dockerId(id)} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`
}

/**
 * The sentence that explains why a docker command failed. Docker often adds hints after it
 * ("Run 'docker run --help' for more information"), so the last line is not the right one.
 */
export function dockerError(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const line = lines.find((l) => /Error response from daemon/i.test(l)) ?? lines.find((l) => /^(docker: |error)/i.test(l)) ?? lines.pop() ?? ''
  return line.replace(/^(docker: )?(Error response from daemon:\s*)?/i, '').slice(0, 400) || 'The Docker command failed'
}

function jsonLines(output: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>)
    } catch {
      /* a line that is not JSON is not a row */
    }
  }
  return rows
}
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** "a=b,com.docker.compose.project=shop" → the value of one label */
function label(labels: string, key: string): string | undefined {
  for (const part of labels.split(',')) {
    const eq = part.indexOf('=')
    if (eq > 0 && part.slice(0, eq) === key) return part.slice(eq + 1)
  }
  return undefined
}

/** "0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 5432/tcp" → ["8080 → 80", "5432"] without repeats */
export function readablePorts(ports: string): string[] {
  const seen = new Set<string>()
  for (const part of ports.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(?:.*:)?(\d+(?:-\d+)?)->(\d+(?:-\d+)?)\/(\w+)$/.exec(part)
    const inner = /^(\d+(?:-\d+)?)\/(\w+)$/.exec(part)
    if (m) seen.add(`${m[1]} → ${m[2]}${m[3] === 'tcp' ? '' : '/' + m[3]}`)
    else if (inner) seen.add(`${inner[1]}${inner[2] === 'tcp' ? '' : '/' + inner[2]}`)
    else seen.add(part)
  }
  return [...seen]
}

export function parseOverview(output: string): DockerOverview {
  if (output.includes(`${MARK}_MISSING`)) return { status: 'missing', containers: [] }
  if (output.includes(`${MARK}_ERROR`)) {
    const message = output.slice(output.indexOf(`${MARK}_ERROR`) + `${MARK}_ERROR`.length).trim()
    const denied = /permission denied/i.test(message)
    return { status: denied ? 'denied' : 'error', message: message.split(/\r?\n/).pop()?.slice(0, 300), containers: [] }
  }
  const version = new RegExp(`${MARK}_VERSION (\\S+)`).exec(output)
  if (!version) return { status: 'error', message: 'Docker did not answer', containers: [] }
  const containers: DockerContainer[] = jsonLines(output).map((r) => {
    const labels = text(r.Labels)
    const state = text(r.State)
    return {
      id: text(r.ID),
      name: text(r.Names).split(',')[0],
      image: text(r.Image),
      state: (['running', 'paused', 'restarting', 'exited', 'created', 'dead', 'removing'].includes(state) ? state : 'exited') as DockerContainer['state'],
      status: text(r.Status),
      ports: readablePorts(text(r.Ports)),
      project: label(labels, 'com.docker.compose.project'),
      service: label(labels, 'com.docker.compose.service')
    }
  })
  return { status: 'ok', version: version[1], containers: containers.filter((c) => ID.test(c.id)) }
}

export function parseStats(output: string): DockerStats[] {
  return jsonLines(output).map((r) => ({
    id: text(r.Container) || text(r.ID),
    cpu: text(r.CPUPerc),
    memory: text(r.MemUsage).split('/')[0].trim(),
    memoryPercent: text(r.MemPerc)
  }))
}

export function parseImages(output: string): DockerImage[] {
  return jsonLines(output)
    .map((r) => ({
      id: text(r.ID).replace(/^sha256:/, ''),
      repository: text(r.Repository),
      tag: text(r.Tag),
      size: text(r.Size),
      created: text(r.CreatedSince),
      inUse: Number(text(r.Containers)) > 0
    }))
    .filter((i) => ID.test(i.id))
}

/** The parts of `docker inspect` that help to understand a container. Environment variables are left out: they often hold passwords. */
export function parseInspect(output: string): DockerDetails {
  const data = (JSON.parse(output) as Record<string, any>[])[0] // eslint-disable-line @typescript-eslint/no-explicit-any
  const policy = text(data?.HostConfig?.RestartPolicy?.Name) || 'no'
  const mounts = Array.isArray(data?.Mounts) ? data.Mounts : []
  const networks = data?.NetworkSettings?.Networks ?? {}
  return {
    id: text(data?.Id),
    name: text(data?.Name).replace(/^\//, ''),
    image: text(data?.Config?.Image),
    command: [...(data?.Config?.Entrypoint ?? []), ...(data?.Config?.Cmd ?? [])].join(' '),
    created: text(data?.Created),
    startedAt: text(data?.State?.StartedAt),
    restartPolicy: (RESTART_POLICIES as readonly string[]).includes(policy) ? (policy as RestartPolicy) : 'no',
    restartCount: Number(data?.RestartCount) || 0,
    mounts: mounts.map((m: Record<string, unknown>) => ({
      source: text(m.Type) === 'volume' ? `volume ${text(m.Name)}` : text(m.Source),
      target: text(m.Destination),
      readOnly: m.RW === false
    })),
    networks: Object.entries(networks).map(([name, n]) => ({ name, ip: text((n as Record<string, unknown>).IPAddress) })),
    workingDir: text(data?.Config?.Labels?.['com.docker.compose.project.working_dir']) || undefined
  }
}

// ---- downloading images and creating containers --------------------------
// Here values typed by the user do become part of a command line. Each one is checked against a
// narrow pattern first and quoted for the shell on top of that.

/** "nginx", "nginx:1.27", "ghcr.io/owner/app:v2", "registry.example.com:5000/app@sha256:…" */
const IMAGE_REF = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)*(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(@sha256:[0-9a-f]{64})?$/
export function imageRef(value: string): string {
  const ref = value.trim()
  if (ref.length > 255 || !IMAGE_REF.test(ref)) throw new Error('This is not a valid image name. Examples: nginx, nginx:1.27, ghcr.io/owner/app:v2')
  return ref
}

export function pullCommand(image: string): string {
  return `docker pull ${shellQuote(imageRef(image))}`
}

/**
 * Progress of `docker pull` from the lines it has printed so far, e.g.
 * "a1b2c3d4e5f6: Pulling fs layer", "a1b2c3d4e5f6: Pull complete", "Status: Downloaded newer image".
 */
export function pullProgress(lines: string[]): { done: number; total: number; status: string } {
  const layers = new Map<string, boolean>()
  let status = ''
  for (const line of lines) {
    const m = /^([0-9a-f]{12}): (.+)$/.exec(line.trim())
    if (m) layers.set(m[1], /^(Pull complete|Already exists)/.test(m[2]) || layers.get(m[1]) === true)
    if (line.trim()) status = line.trim()
  }
  return { done: [...layers.values()].filter(Boolean).length, total: layers.size, status: status.slice(0, 200) }
}

const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

function port(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Ports are numbers from 1 to 65535')
  return value
}
/** A path for --mount: absolute, and free of the characters that separate the fields of the option. */
function mountPath(value: string, what: string): string {
  const path = value.trim()
  if (!path.startsWith('/') || path.length > 1024 || /[,\0\r\n"]/.test(path)) throw new Error(`${what} must be a full path like /srv/data, without commas or quotes`)
  return path
}

/**
 * The command that creates a container, plus what has to be sent to its standard input.
 * Environment variables go through standard input (`--env-file /dev/stdin`) and not through the
 * command line, where every user of the server could read them in the process list.
 */
export function createCommand(spec: DockerCreateSpec): { command: string; stdin: string } {
  const args: string[] = ['docker', spec.start ? 'run -d' : 'create']
  if (spec.name?.trim()) {
    if (!CONTAINER_NAME.test(spec.name.trim())) throw new Error('Use letters, digits, dots, dashes and underscores for the name')
    args.push('--name', shellQuote(spec.name.trim()))
  }
  for (const p of spec.ports) {
    if (p.protocol !== 'tcp' && p.protocol !== 'udp') throw new Error('Unknown protocol')
    args.push('-p', `${p.localOnly ? '127.0.0.1:' : ''}${port(p.host)}:${port(p.container)}/${p.protocol}`)
  }
  for (const m of spec.mounts) {
    const option = `type=bind,source=${mountPath(m.source, 'The folder on the server')},target=${mountPath(m.target, 'The path in the container')}${m.readOnly ? ',readonly' : ''}`
    args.push('--mount', shellQuote(option))
  }
  if (!RESTART_POLICIES.includes(spec.restart)) throw new Error('Unknown restart policy')
  if (spec.restart !== 'no') args.push('--restart', spec.restart)
  const env: string[] = []
  for (const e of spec.env) {
    if (!ENV_NAME.test(e.name)) throw new Error(`“${e.name}” is not a valid name for a variable. Use letters, digits and underscores.`)
    if (/[\r\n\0]/.test(e.value)) throw new Error(`The value of ${e.name} must be a single line`)
    env.push(`${e.name}=${e.value}`)
  }
  if (env.length) args.push('--env-file', '/dev/stdin')
  args.push(shellQuote(imageRef(spec.image)))
  for (const word of (spec.command ?? '').split(/\s+/).filter(Boolean)) args.push(shellQuote(word))
  return { command: args.join(' '), stdin: env.length ? env.join('\n') + '\n' : '' }
}
