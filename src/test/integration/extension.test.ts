import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as net from 'node:net';
import * as vscode from 'vscode';

const EXTENSION_ID = 'mkbaser.port-authority';

/**
 * Integration tests run against a real editor instance with the fixture workspace open.
 *
 * They cover the contract that unit tests cannot: that the extension activates, that its
 * contributions are registered, and that a real listening socket on this machine shows
 * up in a real scan.
 */
suite('Port Authority', () => {
  suiteSetup(async function () {
    this.timeout(60_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `Extension ${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();
  });

  test('registers every contributed command', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const expected = [
      'portAuthority.refresh',
      'portAuthority.terminate',
      'portAuthority.terminateByPort',
      'portAuthority.stopContainer',
      'portAuthority.openInBrowser',
      'portAuthority.copyPid',
      'portAuthority.copyCommandLine',
      'portAuthority.ignorePort',
      'portAuthority.clearIgnoredPorts',
      'portAuthority.showLog',
    ];
    for (const command of expected) {
      assert.ok(registered.has(command), `missing command: ${command}`);
    }
  });

  test('ships sane configuration defaults', () => {
    const config = vscode.workspace.getConfiguration('portAuthority');
    assert.equal(config.get('autoRefresh.enabled'), true);
    assert.equal(config.get('autoRefresh.intervalSeconds'), 10);
    assert.equal(config.get('showAllInterfaces'), false);
    assert.equal(config.get('eaddrinuse.enabled'), true);
    // The destructive path must default to asking, whatever else changes.
    assert.equal(config.get('terminate.confirmation'), 'always');
    assert.equal(config.get('docker.enabled'), true);
  });

  test('finds a port that is genuinely listening on this machine', async function () {
    this.timeout(30_000);

    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Could not determine the test port'));
        }
      });
    });

    try {
      await vscode.commands.executeCommand('portAuthority.refresh');
      // The scan is asynchronous; poll briefly rather than guessing a fixed delay.
      const found = await waitFor(async () => {
        await vscode.commands.executeCommand('portAuthority.refresh');
        return isPortVisible(port);
      }, 15_000);
      assert.ok(found, `port ${port} did not appear in the scan`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  /**
   * The container mapping is the one part of the extension that cannot be proved by unit
   * tests alone, because it depends on what a real daemon reports. Running it here means
   * CI verifies it on Linux as well as on the machine it was written on.
   */
  test('maps a published container port to the container that publishes it', async function () {
    this.timeout(120_000);

    if (!(await dockerIsAvailable())) {
      this.skip();
      return;
    }

    // Pick a free port so the test never collides with whatever else is running.
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('could not reserve a port'));
        }
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    try {
      await docker('rm', '-f', CONTAINER_NAME);
    } catch {
      // Nothing to clean up.
    }

    try {
      await docker(
        'run', '-d', '--name', CONTAINER_NAME,
        '-p', `127.0.0.1:${port}:80`,
        CONTAINER_IMAGE,
        'sh', '-c', `nc -lk -p 80 -e /bin/true || sleep 300`,
      );

      const mapped = await waitFor(async () => {
        await vscode.commands.executeCommand('portAuthority.refresh');
        return testApi()?.getContainerPortsForTests().find((row) => row.port === port);
      }, 60_000);

      assert.ok(mapped, `port ${port} was not attributed to a container`);
      assert.equal(mapped.container, CONTAINER_NAME);
      assert.match(mapped.image, /^alpine/);
    } finally {
      try {
        await docker('rm', '-f', CONTAINER_NAME);
      } catch {
        // Already gone.
      }
    }
  });

  test('infers the fixture workspace ports and rejects the misleading ones', async function () {
    this.timeout(30_000);

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'the fixture workspace should be open');

    // Re-derive expectations through the same public settings surface the extension uses,
    // then assert on what the tree ends up showing.
    const inferred = await waitFor(async () => {
      const ports = await inferredPorts();
      return ports.length > 0 ? ports : undefined;
    }, 15_000);

    assert.ok(inferred, 'no expectations were inferred from the fixture workspace');
    assert.ok(inferred.includes(51990), 'vite --port 51990 should be expected');
    assert.ok(inferred.includes(51991), 'PORT=51991 should be expected');
    assert.ok(inferred.includes(51992), 'the local DATABASE_URL port should be expected');
    assert.ok(inferred.includes(51993), 'CACHE_PORT should be expected');
    assert.ok(!inferred.includes(6379), 'a remote REDIS_URL port must not be expected');
    assert.ok(!inferred.includes(1234), '`mkdir -p 1234` must not be read as a port');
    assert.ok(!inferred.includes(51994), '.env.production must not be read as a local expectation');
    assert.ok(!inferred.includes(51995), 'a remote host in .env.production must not be expected');
    assert.ok(!inferred.includes(51996), 'a *_PORT paired with a remote *_HOST must not be expected');
  });
});

interface TestApi {
  readonly getExpectedPortsForTests: () => number[];
  readonly getListeningPortsForTests: () => number[];
  readonly getContainerPortsForTests: () => { port: number; container: string; image: string }[];
}

/** The image is tiny and already cached on GitHub's Linux runners. */
const CONTAINER_IMAGE = 'alpine:3';
const CONTAINER_NAME = 'port-authority-integration';

// Async on purpose: a synchronous exec blocks the extension host, and VS Code reports it
// as unresponsive, which is noise at best and a flaky failure at worst.
const run = promisify(execFile);

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await run('docker', args);
  return stdout.trim();
}

async function dockerIsAvailable(): Promise<boolean> {
  try {
    await docker('info', '--format', '{{.ServerVersion}}');
    return true;
  } catch {
    return false;
  }
}

function testApi(): TestApi | undefined {
  return vscode.extensions.getExtension(EXTENSION_ID)?.exports as TestApi | undefined;
}

async function inferredPorts(): Promise<number[]> {
  await vscode.commands.executeCommand('portAuthority.ports.focus');
  return testApi()?.getExpectedPortsForTests() ?? [];
}

async function isPortVisible(port: number): Promise<boolean> {
  return (testApi()?.getListeningPortsForTests() ?? []).includes(port);
}

async function waitFor<T>(probe: () => Promise<T | undefined | false>, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result) {
      return result as T;
    }
    if (Date.now() >= deadline) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
