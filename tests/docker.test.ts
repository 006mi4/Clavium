import { describe, expect, it } from 'vitest'
import {
  actionCommand,
  dockerId,
  logsCommand,
  parseImages,
  parseInspect,
  parseOverview,
  parseStats,
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
