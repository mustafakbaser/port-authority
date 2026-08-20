import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import { DockerClient } from '../../node/docker.js';

/**
 * These run against a real Unix socket rather than a mocked transport.
 *
 * Every defect the review found in this file was in the part a mock would have replaced:
 * which candidate gets chosen, what happens when a socket file exists but nothing answers,
 * and whether a cached failure ever clears. A fake daemon on a real socket is about twenty
 * lines and exercises all of it.
 */
const WINDOWS = process.platform === 'win32';
const temporary: string[] = [];
const servers: net.Server[] = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of temporary) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryHome(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'pa-docker-'));
  temporary.push(directory);
  return directory;
}

/** A daemon that answers `/_ping` and returns the given containers. */
async function fakeDaemon(socketPath: string, containers: unknown[]): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const body = chunk.toString().startsWith('GET /_ping') ? 'OK' : JSON.stringify(containers);
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

/** A socket file that exists and accepts, but never answers. This is what a stale socket looks like. */
async function deadSocket(socketPath: string): Promise<net.Server> {
  const server = net.createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

const CONTAINER = {
  Id: 'a'.repeat(64),
  Names: ['/api'],
  Image: 'node:22',
  State: 'running',
  Status: 'Up 3 minutes',
  Ports: [{ IP: '0.0.0.0', PrivatePort: 3000, PublicPort: 3000, Type: 'tcp' }],
  Labels: {},
};

describe('DockerClient against a real socket', { skip: WINDOWS ? 'Unix sockets are not available on Windows' : false }, () => {
  it('lists containers from a live daemon', async () => {
    const home = temporaryHome();
    const socket = path.join(home, 'live.sock');
    await fakeDaemon(socket, [CONTAINER]);

    const client = new DockerClient({ env: { DOCKER_HOST: `unix://${socket}` }, home });
    const snapshot = await client.listContainers({ timeoutMs: 2000 });
    assert.equal(snapshot.unavailable, undefined);
    assert.equal(snapshot.containers[0].name, 'api');
  });

  /**
   * The blocker this file was rewritten for. A socket file left behind by a stopped daemon
   * satisfies every cheap test, and choosing it used to be permanent.
   */
  it('skips a socket that exists but does not answer, and finds the live one', async () => {
    const home = temporaryHome();
    const dead = path.join(home, 'dead.sock');
    const live = path.join(home, 'live.sock');
    await deadSocket(dead);
    await fakeDaemon(live, [CONTAINER]);
    assert.ok(statSync(dead).isSocket(), 'the dead path really is a socket file');

    const client = new DockerClient({
      home,
      discover: async () => [
        { kind: 'socket', path: dead },
        { kind: 'socket', path: live },
      ],
    });
    const snapshot = await client.listContainers({ timeoutMs: 2000 });
    assert.equal(snapshot.containers.length, 1, 'fell through to the live daemon');
    assert.equal(snapshot.unavailable, undefined);
  });

  it('reports a dead socket rather than claiming none exists', async () => {
    const home = temporaryHome();
    const dead = path.join(home, 'dead.sock');
    await deadSocket(dead);

    const client = new DockerClient({ env: { DOCKER_HOST: `unix://${dead}` }, home });
    const snapshot = await client.listContainers({ timeoutMs: 1000 });
    assert.equal(snapshot.unavailable?.reason, 'unreachable');
    assert.ok(!/no docker socket/i.test(snapshot.unavailable?.message ?? ''), 'must not say the socket is missing');
  });

  it('refuses a remote DOCKER_HOST without opening anything', async () => {
    const client = new DockerClient({ env: { DOCKER_HOST: 'tcp://10.0.0.5:2375' }, home: temporaryHome() });
    const snapshot = await client.listContainers({ timeoutMs: 500 });
    assert.equal(snapshot.unavailable?.reason, 'remoteRefused');
  });

  it('refuses a DOCKER_HOST with no path instead of falling back to a TCP connection', async () => {
    // Node treats a falsy socketPath as absent and dials localhost:80.
    const client = new DockerClient({ env: { DOCKER_HOST: 'unix://' }, home: temporaryHome() });
    const snapshot = await client.listContainers({ timeoutMs: 500 });
    assert.equal(snapshot.unavailable?.reason, 'notFound');
    assert.match(snapshot.unavailable?.message ?? '', /no socket path/i);
  });

  it('stops probing for a while after a failure, and probes again after reset', async () => {
    const home = temporaryHome();
    const live = path.join(home, 'late.sock');
    let daemonStarted = false;

    const client = new DockerClient({
      home,
      backoffMs: 60_000,
      // The socket only appears after the first probe, which is what starting Docker
      // after the extension activated looks like.
      discover: async () => (daemonStarted ? [{ kind: 'socket', path: live }] : []),
    });

    const first = await client.listContainers({ timeoutMs: 500 });
    assert.equal(first.unavailable?.reason, 'notFound');

    await fakeDaemon(live, [CONTAINER]);
    daemonStarted = true;

    const backedOff = await client.listContainers({ timeoutMs: 500 });
    assert.equal(backedOff.containers.length, 0, 'still inside the backoff');

    client.reset();
    const afterReset = await client.listContainers({ timeoutMs: 500 });
    assert.equal(afterReset.containers.length, 1, 'reset is what the Refresh command calls');
  });
});
