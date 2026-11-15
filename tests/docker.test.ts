import { describe, expect, it } from 'vitest'
import {
  actionCommand,
  createCommand,
  dockerError,
  dockerId,
  imageRef,
  logsCommand,
  parseImages,
  parseInspect,
  parseOverview,
  parseStats,
  pullCommand,
  pullProgress,
  readablePorts,
  removeImageCommand,
  restartPolicyCommand,
  shellCommand,
  type ContainerAction,
  type RestartPolicy
} from '../src/main/core/docker'

const A = '60d15e4698f26d65d9d97f43a3cb8a324a43f4b09b65296dffb4391b5612596e'
const B = '45dcb37c217b3c50f85848409536e9a99914665425381d84cb2899efbdca5b4b'

describe('docker overview', () => {
  it('reads version and containers, with compose project, state and ports', () => {
    const out = [
      'CLAVIUM_DOCKER_VERSION 29.1.5',
      JSON.stringify({ ID: A, Names: 'shop-db-1', Image: 'postgres:17-alpine', State: 'exited', Status: 'Exited (0) 5 weeks ago', Ports: '', Labels: 'com.docker.compose.project=shop,com.docker.compose.service=db,a=b' }),
      JSON.stringify({ ID: B, Names: 'web', Image: 'nginx', State: 'running', Status: 'Up 3 hours', Ports: '0.0.0.0:8080->80/tcp, [::]:8080->80/tcp, 443/tcp', Labels: '' }),
      'not json'
    ].join('\n')
    expect(parseOverview(out)).toEqual({
      status: 'ok',
      version: '29.1.5',
      containers: [
        { id: A, name: 'shop-db-1', image: 'postgres:17-alpine', state: 'exited', status: 'Exited (0) 5 weeks ago', ports: [], project: 'shop', service: 'db' },
        { id: B, name: 'web', image: 'nginx', state: 'running', status: 'Up 3 hours', ports: ['8080 → 80', '443'], project: undefined, service: undefined }
      ]
    })
  })

  it('tells apart: not installed, not allowed, not running', () => {
    expect(parseOverview('CLAVIUM_DOCKER_MISSING\n').status).toBe('missing')
    expect(parseOverview('CLAVIUM_DOCKER_ERROR\npermission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n').status).toBe('denied')
    const down = parseOverview('CLAVIUM_DOCKER_ERROR\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n')
    expect(down.status).toBe('error')
    expect(down.message).toMatch(/Is the docker daemon running/)
    expect(parseOverview('').status).toBe('error')
  })

  it('shows ports the short way', () => {
    expect(readablePorts('127.0.0.1:5432->5432/tcp')).toEqual(['5432 → 5432'])
    expect(readablePorts('0.0.0.0:53->53/udp, 0.0.0.0:8000-8002->8000-8002/tcp')).toEqual(['53 → 53/udp', '8000-8002 → 8000-8002'])
    expect(readablePorts('')).toEqual([])
  })
})

describe('docker stats, images and details', () => {
  it('reads usage figures', () => {
    const out = JSON.stringify({ Container: B, ID: B.slice(0, 12), CPUPerc: '0.01%', MemUsage: '37.98MiB / 15.46GiB', MemPerc: '0.24%' })
    expect(parseStats(out)).toEqual([{ id: B, cpu: '0.01%', memory: '37.98MiB', memoryPercent: '0.24%' }])
  })

  it('reads images and whether a container uses them', () => {
    const out = [
      JSON.stringify({ ID: 'sha256:' + A, Repository: 'postgres', Tag: '17', Size: '646MB', CreatedSince: '8 weeks ago', Containers: '0' }),
      JSON.stringify({ ID: B.slice(0, 12), Repository: 'postgres', Tag: '17-alpine', Size: '424MB', CreatedSince: '8 weeks ago', Containers: '1' })
    ].join('\n')
    expect(parseImages(out)).toEqual([
      { id: A, repository: 'postgres', tag: '17', size: '646MB', created: '8 weeks ago', inUse: false },
      { id: B.slice(0, 12), repository: 'postgres', tag: '17-alpine', size: '424MB', created: '8 weeks ago', inUse: true }
    ])
  })

  it('reads the details of a container and leaves the environment out', () => {
    const inspect = [
      {
        Id: A,
        Name: '/shop-db-1',
        Created: '2026-09-30T13:12:34Z',
        RestartCount: 2,
        State: { StartedAt: '2026-10-01T08:00:00Z' },
        Config: { Image: 'postgres:17-alpine', Entrypoint: ['docker-entrypoint.sh'], Cmd: ['postgres'], Env: ['POSTGRES_PASSWORD=secret'], Labels: { 'com.docker.compose.project.working_dir': '/srv/shop' } },
        HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
        Mounts: [
          { Type: 'volume', Name: 'shop_data', Destination: '/var/lib/postgresql/data', RW: true },
          { Type: 'bind', Source: '/srv/shop/init', Destination: '/docker-entrypoint-initdb.d', RW: false }
        ],
        NetworkSettings: { Networks: { shop_default: { IPAddress: '172.18.0.2' } } }
      }
    ]
    const d = parseInspect(JSON.stringify(inspect))
    expect(d).toMatchObject({
      id: A,
      name: 'shop-db-1',
      image: 'postgres:17-alpine',
      command: 'docker-entrypoint.sh postgres',
      restartPolicy: 'unless-stopped',
      restartCount: 2,
      mounts: [
        { source: 'volume shop_data', target: '/var/lib/postgresql/data', readOnly: false },
        { source: '/srv/shop/init', target: '/docker-entrypoint-initdb.d', readOnly: true }
      ],
      networks: [{ name: 'shop_default', ip: '172.18.0.2' }],
      workingDir: '/srv/shop'
    })
    expect(JSON.stringify(d)).not.toContain('secret')
  })
})

describe('docker commands', () => {
  it('only ever contain ids that Docker itself could have printed', () => {
    expect(actionCommand('stop', [A, B])).toBe(`docker stop ${A} ${B}`)
    expect(actionCommand('remove', [A])).toBe(`docker rm ${A}`) // no -f: running containers are refused
    expect(restartPolicyCommand(A, 'always')).toBe(`docker update --restart always ${A}`)
    expect(removeImageCommand('sha256:' + A)).toBe(`docker rmi ${A}`)
    expect(logsCommand(A)).toBe(`docker logs --tail 1000 -f ${A}`)
    expect(shellCommand(A)).toContain(`docker exec -it ${A} sh -c`)

    for (const bad of ['web', 'web; rm -rf /', `${A} --force`, '$(reboot)', '', '-f', A.toUpperCase()]) {
      expect(() => dockerId(bad)).toThrow(/Unknown container or image/)
      expect(() => actionCommand('start', [A, bad])).toThrow()
      expect(() => logsCommand(bad)).toThrow()
      expect(() => shellCommand(bad)).toThrow()
    }
    expect(() => actionCommand('start', [])).toThrow(/No container/)
    expect(() => restartPolicyCommand(A, 'always; reboot' as RestartPolicy)).toThrow(/Unknown restart policy/)
    expect(() => actionCommand('exec' as ContainerAction, [A])).toThrow(/Unknown action/)
  })
})

describe('downloading images and creating containers', () => {
  it('accepts image names and nothing else', () => {
    for (const ok of ['nginx', 'nginx:1.27', 'library/postgres:17-alpine', 'ghcr.io/owner/app:v2', 'registry.example.com:5000/team/app', 'app@sha256:' + A]) expect(imageRef(ok)).toBe(ok)
    expect(pullCommand(' nginx:1.27 ')).toBe(`docker pull 'nginx:1.27'`)
    for (const bad of ['', 'Nginx', 'nginx; reboot', 'nginx $(reboot)', '-v /:/host alpine', 'a b', `x'y`, '../x', 'nginx:', ':latest']) expect(() => imageRef(bad), bad).toThrow(/not a valid image name/)
  })

  it('reads the progress of a download from what Docker prints', () => {
    const lines = ['17-alpine: Pulling from library/postgres', 'aaaaaaaaaaaa: Already exists', 'bbbbbbbbbbbb: Pulling fs layer', 'cccccccccccc: Pulling fs layer', 'bbbbbbbbbbbb: Download complete', 'bbbbbbbbbbbb: Pull complete']
    expect(pullProgress(lines)).toEqual({ done: 2, total: 3, status: 'bbbbbbbbbbbb: Pull complete' })
    expect(pullProgress([])).toEqual({ done: 0, total: 0, status: '' })
  })

  const spec = { image: 'nginx:1.27', ports: [], mounts: [], env: [], restart: 'no' as const, start: true }

  it('builds the command from checked and quoted values; variables go through standard input', () => {
    const r = createCommand({
      image: 'nginx:1.27',
      name: 'website',
      ports: [
        { host: 8080, container: 80, protocol: 'tcp', localOnly: false },
        { host: 5353, container: 53, protocol: 'udp', localOnly: true }
      ],
      mounts: [{ source: `/srv/my site's files`, target: '/usr/share/nginx/html', readOnly: true }],
      env: [
        { name: 'PASSWORD', value: `s3cret $HOME 'x' "y"` },
        { name: 'EMPTY', value: '' }
      ],
      restart: 'unless-stopped',
      command: 'nginx  -g  daemon off;',
      start: true
    })
    expect(r.command).toBe(
      String.raw`docker run -d --name 'website' -p 8080:80/tcp -p 127.0.0.1:5353:53/udp --mount 'type=bind,source=/srv/my site'\''s files,target=/usr/share/nginx/html,readonly' --restart unless-stopped --env-file /dev/stdin 'nginx:1.27' 'nginx' '-g' 'daemon' 'off;'`
    )
    expect(r.stdin).toBe(`PASSWORD=s3cret $HOME 'x' "y"\nEMPTY=\n`)
    expect(r.command).not.toContain('s3cret') // not readable in the process list of the server

    expect(createCommand({ ...spec, start: false })).toEqual({ command: `docker create 'nginx:1.27'`, stdin: '' })
  })

  it('refuses values that could change the meaning of the command', () => {
    const bad: [string, object][] = [
      ['name', { name: 'a; reboot' }],
      ['name', { name: '-rm' }],
      ['port', { ports: [{ host: 0, container: 80, protocol: 'tcp', localOnly: false }] }],
      ['port', { ports: [{ host: 80.5, container: 80, protocol: 'tcp', localOnly: false }] }],
      ['protocol', { ports: [{ host: 80, container: 80, protocol: 'tcp --privileged', localOnly: false }] }],
      ['relative folder', { mounts: [{ source: 'data', target: '/data', readOnly: false }] }],
      ['extra mount option', { mounts: [{ source: '/srv,bind-propagation=shared', target: '/data', readOnly: false }] }],
      ['target with comma', { mounts: [{ source: '/srv', target: '/data,readonly', readOnly: false }] }],
      ['variable name', { env: [{ name: 'A B', value: 'x' }] }],
      ['second variable smuggled in', { env: [{ name: 'A', value: 'x\nB=y' }] }],
      ['restart policy', { restart: 'always --privileged' }],
      ['image', { image: 'nginx --privileged' }]
    ]
    for (const [what, patch] of bad) expect(() => createCommand({ ...spec, ...patch } as never), what).toThrow()
    // words of the command are quoted one by one: no word can become an option of docker or a second command
    expect(createCommand({ ...spec, command: 'echo $(reboot); ls' }).command).toBe(String.raw`docker run -d 'nginx:1.27' 'echo' '$(reboot);' 'ls'`)
  })

  it('finds the sentence that explains an error', () => {
    const conflict = `docker: Error response from daemon: Conflict. The container name "/web" is already in use by container "abc". You have to remove (or rename) that container to be able to reuse that name.\n\nRun 'docker run --help' for more information\n`
    expect(dockerError(conflict)).toMatch(/^Conflict\. The container name "\/web" is already in use/)
    expect(dockerError('Error response from daemon: No such container: x\n')).toBe('No such container: x')
    expect(dockerError('something else went wrong\n')).toBe('something else went wrong')
    expect(dockerError('')).toBe('The Docker command failed')
  })
})
