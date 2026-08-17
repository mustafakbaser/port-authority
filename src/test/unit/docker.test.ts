import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  containerBelongsToWorkspace,
  describeContainer,
  findContainerForHostPort,
  indexContainersByHostPort,
  isDockerProcess,
} from '../../core/docker/match.js';
import {
  endpointFromDockerHost,
  expandHome,
  resolveDockerEndpoint,
  WINDOWS_PIPE,
} from '../../core/docker/endpoint.js';
import { parseContainers } from '../../core/docker/parse.js';
import type { ContainerInfo } from '../../core/docker/types.js';
import { buildModel } from '../../core/model.js';
import type { PortEntry } from '../../core/ports/scanner.js';

/**
 * Recorded from a real daemon rather than written from the reference docs, then edited to
 * remove machine specific paths. Every shape in it was observed: the IPv4/IPv6 pair Docker
 * emits for one published port, a bind limited to 127.0.0.1, a container started without
 * Compose, a port that is exposed but not published, and one that has exited.
 */
const FIXTURE = JSON.parse(
  readFileSync(path.join(__dirname, '../../../src/test/fixtures/docker/containers.json'), 'utf8'),
) as unknown;

const containers = parseContainers(FIXTURE);
const byName = (name: string): ContainerInfo => {
  const found = containers.find((container) => container.name === name);
  assert.ok(found, `fixture is missing ${name}`);
  return found;
};

describe('parsing the container list', () => {
  it('reads every container in the recorded response', () => {
    assert.equal(containers.length, 6);
  });

  it('keeps both address families of a single published port', () => {
    // `-p 6379:6379` arrives as two objects, one per family. Neither is a duplicate of
    // the other, and collapsing them here would lose the bind address.
    const cache = byName('shop-cache-1');
    assert.deepEqual(cache.bindings, [
      { hostIp: '0.0.0.0', hostPort: 6379, containerPort: 6379 },
      { hostIp: '::', hostPort: 6379, containerPort: 6379 },
    ]);
  });

  it('keeps a loopback only publication', () => {
    assert.deepEqual(byName('shop-edge-1').bindings, [
      { hostIp: '127.0.0.1', hostPort: 8097, containerPort: 80 },
    ]);
  });

  it('records a host port that differs from the container port', () => {
    const queue = byName('shop-queue-1');
    assert.equal(queue.bindings[0].hostPort, 6380);
    assert.equal(queue.bindings[0].containerPort, 6379);
  });

  it('ignores a port that is exposed but never published', () => {
    // No PublicPort means nothing is listening on this machine for it.
    assert.deepEqual(byName('shop-php-1').bindings, []);
  });

  it('extracts the compose project, service and working directory', () => {
    assert.deepEqual(byName('shop-cache-1').compose, {
      project: 'shop',
      service: 'cache',
      workingDir: '/home/dev/shop',
      configFile: '/home/dev/shop/compose.yml',
    });
  });

  it('leaves compose metadata off a container started with docker run', () => {
    assert.equal(byName('standalone-proxy').compose, undefined);
  });

  it('carries the daemon state and status through untouched', () => {
    const stopped = byName('shop-old-cache-1');
    assert.equal(stopped.state, 'exited');
    assert.equal(stopped.status, 'Exited (0) 3 hours ago');
  });

  it('shortens the id the way docker ps does', () => {
    assert.equal(byName('shop-cache-1').shortId.length, 12);
  });
});

describe('parsing defensively', () => {
  it('returns nothing for a payload that is not a list', () => {
    assert.deepEqual(parseContainers(null), []);
    assert.deepEqual(parseContainers({ message: 'permission denied' }), []);
    assert.deepEqual(parseContainers('[]'), []);
  });

  it('skips malformed entries instead of throwing', () => {
    const parsed = parseContainers([null, {}, { Id: 'abc123def456789' }, 42]);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].name, 'abc123def456');
  });

  it('ignores non-TCP and out of range bindings', () => {
    const parsed = parseContainers([
      {
        Id: 'abc123def456789',
        Names: ['/x'],
        Ports: [
          { IP: '0.0.0.0', PrivatePort: 53, PublicPort: 53, Type: 'udp' },
          { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 0, Type: 'tcp' },
          { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 70000, Type: 'tcp' },
          { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
        ],
      },
    ]);
    assert.deepEqual(parsed[0].bindings, [{ hostIp: '0.0.0.0', hostPort: 8080, containerPort: 80 }]);
  });
});

describe('choosing an endpoint', () => {
  it('refuses a remote DOCKER_HOST', () => {
    for (const value of ['tcp://10.0.0.5:2375', 'ssh://build@ci.example.com', 'https://docker.example.com']) {
      const endpoint = endpointFromDockerHost(value);
      assert.equal(endpoint.kind, 'unavailable');
      assert.equal(endpoint.kind === 'unavailable' && endpoint.reason, 'remoteRefused');
    }
  });

  it('accepts the local transports', () => {
    assert.deepEqual(endpointFromDockerHost('unix:///var/run/docker.sock'), {
      kind: 'socket',
      path: '/var/run/docker.sock',
    });
    assert.deepEqual(endpointFromDockerHost('npipe:////./pipe/docker_engine'), {
      kind: 'pipe',
      path: '\\\\.\\pipe\\docker_engine',
    });
    assert.deepEqual(endpointFromDockerHost('/var/run/docker.sock'), {
      kind: 'socket',
      path: '/var/run/docker.sock',
    });
  });

  it('goes straight to the named pipe on Windows', () => {
    const { endpoint, candidates } = resolveDockerEndpoint('win32');
    assert.deepEqual(endpoint, { kind: 'pipe', path: WINDOWS_PIPE });
    assert.deepEqual(candidates, []);
  });

  it('offers per user sockets before the shared one on macOS', () => {
    const { candidates } = resolveDockerEndpoint('darwin', {}, '/Users/dev');
    assert.equal(candidates[0], '/Users/dev/.docker/run/docker.sock');
    assert.ok(candidates.includes('/var/run/docker.sock'));
    assert.ok(candidates.some((c) => c.includes('colima')), 'colima is common enough to try');
  });

  it('prefers DOCKER_HOST over the candidate list', () => {
    const { endpoint, candidates } = resolveDockerEndpoint('linux', { DOCKER_HOST: 'unix:///tmp/d.sock' }, '/home/dev');
    assert.deepEqual(endpoint, { kind: 'socket', path: '/tmp/d.sock' });
    assert.deepEqual(candidates, []);
  });

  it('expands only a leading tilde', () => {
    assert.equal(expandHome('~/.docker/run/docker.sock', '/home/dev'), '/home/dev/.docker/run/docker.sock');
    assert.equal(expandHome('/var/run/docker.sock', '/home/dev'), '/var/run/docker.sock');
    assert.equal(expandHome('~/x', undefined), '~/x');
  });
});

describe('matching a host port to a container', () => {
  const index = indexContainersByHostPort(containers);

  it('finds the container publishing the port', () => {
    assert.equal(findContainerForHostPort(index, 6379)?.name, 'shop-cache-1');
    assert.equal(findContainerForHostPort(index, 6380)?.name, 'shop-queue-1');
    assert.equal(findContainerForHostPort(index, 8097)?.name, 'shop-edge-1');
  });

  it('returns nothing for a port no container publishes', () => {
    assert.equal(findContainerForHostPort(index, 3000), undefined);
    assert.equal(findContainerForHostPort(index, 9000), undefined, 'exposed but not published');
  });

  it('ignores a container that is not running', () => {
    const stale = parseContainers([
      {
        Id: 'aaaabbbbcccc1111',
        Names: ['/gone'],
        State: 'exited',
        Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8100, Type: 'tcp' }],
      },
    ]);
    assert.equal(findContainerForHostPort(indexContainersByHostPort(stale), 8100), undefined);
  });
});

describe('container ownership', () => {
  const cache = byName('shop-cache-1');
  const standalone = byName('standalone-proxy');

  it('claims a compose project inside an open folder', () => {
    assert.equal(containerBelongsToWorkspace(cache, ['/home/dev/shop'], false), true);
    assert.equal(containerBelongsToWorkspace(cache, ['/home/dev'], false), true);
  });

  it('applies the same containment rule as process ownership', () => {
    // `/home/dev/shop-backup` is a different project, exactly as it is for a process cwd.
    assert.equal(containerBelongsToWorkspace(cache, ['/home/dev/shop-backup'], false), false);
    assert.equal(containerBelongsToWorkspace(cache, ['/home/dev/other'], false), false);
  });

  it('never claims a container started without compose', () => {
    assert.equal(containerBelongsToWorkspace(standalone, ['/home/dev/shop'], false), false);
  });
});

describe('describing a container', () => {
  it('prefers the compose project and service', () => {
    assert.equal(describeContainer(byName('shop-cache-1')), 'shop/cache');
  });

  it('falls back to the container name', () => {
    assert.equal(describeContainer(byName('standalone-proxy')), 'standalone-proxy');
  });
});

describe('deciding when a container may be attached to a row', () => {
  it('recognises the daemon on each platform', () => {
    for (const name of ['com.docker.backend', 'dockerd', 'docker-proxy', 'Docker Desktop Backend', 'dockerd.exe']) {
      assert.equal(isDockerProcess(name), true, name);
    }
  });

  /**
   * The daemon's port list and a socket scan are taken moments apart. When they disagree,
   * the scan wins: it names the process that owns the socket right now. Labelling someone
   * else's server with a container name would be a confident, wrong answer on the row a
   * user is most likely to act on.
   */
  it('does not treat an ordinary process as Docker', () => {
    for (const name of ['node', 'postgres', 'nginx', 'docker-compose', 'my-docker-helper', undefined]) {
      assert.equal(isDockerProcess(name), false, String(name));
    }
  });
});

describe('joining containers into the port model', () => {
  const FOLDER = '/home/dev/shop';
  const context = { workspaceFolders: [FOLDER], caseInsensitive: false };

  const dockerHeld = (port: number): PortEntry => ({
    port,
    process: { pid: 43435, name: 'com.docker.backend', cwd: '/Users/x/Library/Containers/com.docker.docker/Data' },
    bindings: [{ address: '*', family: 'ipv4', scope: 'any' }],
    scope: 'any',
  });

  it('names the container instead of the daemon, and owns it through compose', () => {
    const model = buildModel([dockerHeld(6379)], [], context, containers);
    const row = model.all[0];
    assert.equal(row.container?.name, 'shop-cache-1');
    assert.equal(row.ownership, 'workspace');
    assert.equal(row.basis, 'container');
  });

  /**
   * Without a container the daemon's own working directory decides, and it sits under
   * ~/Library/Containers, so every published port used to read FOREIGN on evidence that
   * says nothing about the container.
   */
  it('replaces the verdict the daemon working directory would have produced', () => {
    const withoutDocker = buildModel([dockerHeld(6379)], [], context, []);
    assert.equal(withoutDocker.all[0].ownership, 'foreign');
    assert.equal(withoutDocker.all[0].container, undefined);
  });

  it('marks a container from another project as foreign', () => {
    const model = buildModel([dockerHeld(6379)], [], { ...context, workspaceFolders: ['/home/dev/other'] }, containers);
    assert.equal(model.all[0].ownership, 'foreign');
    assert.equal(model.all[0].basis, 'container');
  });

  it('leaves a docker run container unowned rather than calling it foreign', () => {
    const model = buildModel([dockerHeld(8099)], [], context, containers);
    assert.equal(model.all[0].container?.name, 'standalone-proxy');
    assert.equal(model.all[0].ownership, 'unknown');
  });

  it('trusts the socket scan when an ordinary process holds a port docker also claims', () => {
    const heldByNode: PortEntry = {
      port: 6379,
      process: { pid: 900, name: 'node', cwd: FOLDER },
      bindings: [{ address: '127.0.0.1', family: 'ipv4', scope: 'loopback' }],
      scope: 'loopback',
    };
    const model = buildModel([heldByNode], [], context, containers);
    assert.equal(model.all[0].container, undefined, 'the container must not be attached');
    assert.equal(model.all[0].basis, 'cwd');
  });

  it('attaches a container to an expected port too', () => {
    const expectation = {
      port: 6379,
      label: 'REDIS_PORT',
      source: { file: '.env', hint: 'REDIS_PORT' },
      folder: FOLDER,
    };
    const model = buildModel([dockerHeld(6379)], [expectation], context, containers);
    assert.equal(model.expectations[0].container?.name, 'shop-cache-1');
    assert.equal(model.expectations[0].status, 'held-by-workspace');
  });
});
