import type { DockerContainer, DockerDetails, DockerImage, DockerOverview, DockerStats } from '@shared/types'

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
/** A shell inside a container: bash where the image has it, sh otherwise. */
export function shellCommand(id: string): string {
  return `docker exec -it ${dockerId(id)} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`
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
