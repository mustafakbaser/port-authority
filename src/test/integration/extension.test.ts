import * as assert from 'node:assert/strict';
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
