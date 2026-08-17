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
  expandCandidate,
  contextMetaDirectory,
  endpointFromContextMeta,
  readCurrentContextName,
  resolveDockerEndpoint,
  WINDOWS_PIPE,
} from '../../core/docker/endpoint.js';
import { parseContainers } from '../../core/docker/parse.js';
import { evaluateContainerStop, publishedHostPorts } from '../../core/docker/stop.js';
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

  it('expands a leading tilde and XDG_RUNTIME_DIR, and drops what it cannot expand', () => {
    assert.equal(expandCandidate('~/.docker/run/docker.sock', '/home/dev'), '/home/dev/.docker/run/docker.sock');
    assert.equal(expandCandidate('/var/run/docker.sock', '/home/dev'), '/var/run/docker.sock');
    assert.equal(
      expandCandidate('$XDG_RUNTIME_DIR/docker.sock', '/home/dev', { XDG_RUNTIME_DIR: '/run/user/1000' }),
      '/run/user/1000/docker.sock',
    );
    // A literal `$XDG_RUNTIME_DIR/...` path would be probed pointlessly on every scan.
    assert.equal(expandCandidate('$XDG_RUNTIME_DIR/docker.sock', '/home/dev'), undefined);
    assert.equal(expandCandidate('~/x', undefined), undefined);
  });

  it('rejects a DOCKER_HOST that names no path', () => {
    // Node treats a falsy socketPath as absent and connects to localhost:80 instead,
    // which would be an actual network request.
    for (const value of ['unix://', 'npipe://']) {
      const endpoint = endpointFromDockerHost(value);
      assert.equal(endpoint.kind, 'unavailable', value);
    }
  });

  it('covers the runtimes people actually use on linux', () => {
    const { candidates } = resolveDockerEndpoint(
      'linux',
      { XDG_RUNTIME_DIR: '/run/user/1000' },
      '/home/dev',
    );
    for (const expected of [
      '/var/run/docker.sock',
      '/run/user/1000/docker.sock', // rootless Docker
      '/home/dev/.docker/desktop/docker.sock', // Docker Desktop for Linux
      '/run/user/1000/podman/podman.sock', // rootless Podman
    ]) {
      assert.ok(candidates.includes(expected), expected);
    }
  });

  it('follows the active docker context, which is what the CLI does', () => {
    assert.equal(readCurrentContextName('{"currentContext":"desktop-linux"}'), 'desktop-linux');
    assert.equal(readCurrentContextName('{"currentContext":"default"}'), undefined);
    assert.equal(readCurrentContextName('{}'), undefined);
    assert.equal(readCurrentContextName('not json'), undefined);

    // Recorded from this machine: the directory is the hex sha256 of the context name.
    assert.equal(
      contextMetaDirectory('desktop-linux'),
      'fe9c6bd7a66301f49ca9b6a70b217107cd1284598bfc254700c989b916da791e',
    );

    assert.deepEqual(
      endpointFromContextMeta('{"Name":"desktop-linux","Endpoints":{"docker":{"Host":"unix:///Users/dev/.docker/run/docker.sock"}}}'),
      { kind: 'socket', path: '/Users/dev/.docker/run/docker.sock' },
    );
    assert.equal(endpointFromContextMeta('{"Endpoints":{}}'), undefined);
    assert.equal(
      endpointFromContextMeta('{"Endpoints":{"docker":{"Host":"tcp://build:2375"}}}')?.kind,
      'unavailable',
      'a remote context is refused, not ignored',
    );
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

describe('regressions found in review', () => {
  const FOLDER = '/home/dev/shop';
  const context = { workspaceFolders: [FOLDER], caseInsensitive: false };
  const row = (port: number, process?: { pid: number; name?: string }): PortEntry => ({
    port,
    ...(process ? { process } : {}),
    bindings: [{ address: '*', family: 'ipv4', scope: 'any' }],
    scope: 'any',
  });

  /**
   * Windows reports `{ pid }` with no name for a process owned by another account, and
   * Linux does the same when /proc is unreadable. Reading that as "not Docker" dropped the
   * container, which put Terminate Process back on the row, aimed at the daemon.
   */
  it('does not treat an unnamed process as evidence that Docker is absent', () => {
    assert.equal(buildModel([row(6379, { pid: 4242 })], [], context, containers).all[0].container?.name, 'shop-cache-1');
    assert.equal(buildModel([row(6379)], [], context, containers).all[0].container?.name, 'shop-cache-1');
  });

  it('still refuses to attach a container to a named process that is not Docker', () => {
    assert.equal(buildModel([row(6379, { pid: 4242, name: 'node' })], [], context, containers).all[0].container, undefined);
  });

  /** A paused container keeps its bindings, and a restarting one reclaims them. */
  it('keeps a container that still holds its ports', () => {
    for (const state of ['running', 'paused', 'restarting']) {
      const one = parseContainers([
        { Id: 'a'.repeat(64), Names: ['/x'], State: state, Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 9111, Type: 'tcp' }] },
      ]);
      assert.ok(findContainerForHostPort(indexContainersByHostPort(one), 9111), state);
    }
  });

  it('drops a container that has released them', () => {
    for (const state of ['exited', 'dead', 'created']) {
      const one = parseContainers([
        { Id: 'a'.repeat(64), Names: ['/x'], State: state, Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 9111, Type: 'tcp' }] },
      ]);
      assert.equal(findContainerForHostPort(indexContainersByHostPort(one), 9111), undefined, state);
    }
  });

  /** Two containers can share a port number on different addresses. */
  it('disambiguates two containers on one port by the address the scan saw', () => {
    const two = parseContainers([
      { Id: 'a'.repeat(64), Names: ['/loopback'], State: 'running', Ports: [{ IP: '127.0.0.1', PrivatePort: 80, PublicPort: 9000, Type: 'tcp' }] },
      { Id: 'b'.repeat(64), Names: ['/lan'], State: 'running', Ports: [{ IP: '192.168.1.5', PrivatePort: 80, PublicPort: 9000, Type: 'tcp' }] },
    ]);
    const index = indexContainersByHostPort(two);
    assert.equal(findContainerForHostPort(index, 9000, ['127.0.0.1'])?.name, 'loopback');
    assert.equal(findContainerForHostPort(index, 9000, ['192.168.1.5'])?.name, 'lan');
  });

  it('names neither when the address cannot tell them apart', () => {
    const two = parseContainers([
      { Id: 'a'.repeat(64), Names: ['/one'], State: 'running', Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 9000, Type: 'tcp' }] },
      { Id: 'b'.repeat(64), Names: ['/two'], State: 'running', Ports: [{ IP: '::', PrivatePort: 80, PublicPort: 9000, Type: 'tcp' }] },
    ]);
    // Guessing here would put a confident, wrong name on a row that offers to stop it.
    assert.equal(findContainerForHostPort(indexContainersByHostPort(two), 9000, ['*']), undefined);
  });

  /** The Supabase CLI labels the project and nothing else. */
  it('keeps the project directory when only the project label is present', () => {
    const [only] = parseContainers([
      {
        Id: 'c'.repeat(64),
        Names: ['/supabase_kong_shop'],
        State: 'running',
        Ports: [{ IP: '0.0.0.0', PrivatePort: 8000, PublicPort: 54321, Type: 'tcp' }],
        Labels: {
          'com.docker.compose.project': 'shop',
          'com.docker.compose.project.working_dir': FOLDER,
        },
      },
    ]);
    assert.equal(only.compose?.project, 'shop');
    assert.equal(only.compose?.service, undefined);
    assert.equal(containerBelongsToWorkspace(only, [FOLDER], false), true);
    assert.equal(describeContainer(only), 'supabase_kong_shop', 'no service, so the name is the label');
  });
});

describe('deciding whether a container may be stopped', () => {
  const container = byName('shop-cache-1');
  const snapshot = { containers };
  const request = { port: 6379, containerId: container.id };

  it('allows a running container that still publishes the port', () => {
    const verdict = evaluateContainerStop(snapshot, request);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.container.name, 'shop-cache-1');
  });

  /** All three can change while a confirmation dialog sits on screen. */
  it('refuses when the container is gone', () => {
    const verdict = evaluateContainerStop({ containers: [] }, request);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : '', /no longer known/);
  });

  it('refuses when it no longer holds its ports', () => {
    const stopped = { containers: [{ ...container, state: 'exited' }] };
    const verdict = evaluateContainerStop(stopped, request);
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : '', /already exited/);
  });

  it('refuses when the port changed hands', () => {
    const verdict = evaluateContainerStop(snapshot, { ...request, port: 9999 });
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok === false ? verdict.reason : '', /no longer publishes port 9999/);
  });

  it('refuses when the daemon itself became unreachable', () => {
    const verdict = evaluateContainerStop(
      { containers, unavailable: { reason: 'unreachable', message: 'Docker went away.' } },
      request,
    );
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.reason, 'Docker went away.');
  });

  /** A range publication frees more ports than the one the user clicked on. */
  it('lists every host port the container publishes', () => {
    const ranged = parseContainers([
      {
        Id: 'd'.repeat(64),
        Names: ['/range'],
        State: 'running',
        Ports: [8000, 8001, 8002].flatMap((port) => [
          { IP: '0.0.0.0', PrivatePort: port, PublicPort: port, Type: 'tcp' },
          { IP: '::', PrivatePort: port, PublicPort: port, Type: 'tcp' },
        ]),
      },
    ]);
    assert.deepEqual(publishedHostPorts(ranged[0]), [8000, 8001, 8002]);
  });
});
