import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ToolNotFoundError } from '../../core/errors.js';
import type { CommandRunner, FileSystemReader, RunResult } from '../../core/exec.js';
import { DarwinPortScanner } from '../../core/ports/darwin.js';
import { LinuxPortScanner } from '../../core/ports/linux.js';
import { buildProbeScript, encodePowerShellCommand, Win32PortScanner } from '../../core/ports/win32.js';

const NOW = 1_700_000_000_000;
const options = { timeoutMs: 1000, enrich: true };

function fakeRunner(handlers: Record<string, () => RunResult | Promise<RunResult>>): CommandRunner {
  return async (command, args) => {
    for (const [key, handler] of Object.entries(handlers)) {
      if (`${command} ${args.join(' ')}`.includes(key)) {
        return handler();
      }
    }
    throw new ToolNotFoundError(command);
  };
}

const ok = (stdout: string, code = 0): RunResult => ({ stdout, stderr: '', code, truncated: false });

describe('DarwinPortScanner', () => {
  const lsofOutput = ['p9001', 'cnode', 'Lkursad', 'f23', 'tIPv4', 'PTCP', 'n*:3000'].join('\n');

  it('assembles ports, start time and working directory from three probes', async () => {
    const scanner = new DarwinPortScanner(
      fakeRunner({
        '-iTCP': () => ok(lsofOutput),
        '-o pid=,etime=,user=,args=': () => ok('9001 00:05:00 kursad /usr/local/bin/node server.js\n'),
        '-d cwd': () => ok(['p9001', 'fcwd', 'n/Users/me/api'].join('\n')),
      }),
      () => NOW,
    );

    const result = await scanner.scan(options);
    assert.equal(result.ports.length, 1);
    const [port] = result.ports;
    assert.equal(port.port, 3000);
    assert.equal(port.process?.name, 'node');
    assert.equal(port.process?.cwd, '/Users/me/api');
    assert.equal(port.process?.executablePath, '/usr/local/bin/node');
    assert.equal(port.process?.startedAt, NOW - 300_000);
    assert.deepEqual(result.warnings, []);
  });

  it('still lists ports when enrichment fails', async () => {
    const scanner = new DarwinPortScanner(
      fakeRunner({ '-iTCP': () => ok(lsofOutput) }),
      () => NOW,
    );
    const result = await scanner.scan(options);
    assert.equal(result.ports.length, 1);
    assert.equal(result.ports[0].process?.startedAt, undefined);
  });

  it('warns instead of failing when lsof reports partial visibility', async () => {
    const scanner = new DarwinPortScanner(
      fakeRunner({ '-iTCP': () => ok(lsofOutput, 1), '-o pid=': () => ok(''), '-d cwd': () => ok('') }),
      () => NOW,
    );
    const result = await scanner.scan(options);
    assert.equal(result.ports.length, 1);
    assert.equal(result.warnings[0]?.code, 'partialVisibility');
  });

  it('reports a missing lsof as an unavailable tool rather than throwing', async () => {
    const scanner = new DarwinPortScanner(fakeRunner({}), () => NOW);
    const result = await scanner.scan(options);
    assert.deepEqual(result.ports, []);
    assert.equal(result.warnings[0]?.code, 'noToolAvailable');
  });
});

describe('LinuxPortScanner', () => {
  function fakeFs(files: Record<string, string>, links: Record<string, string>, dirs: Record<string, string[]>): FileSystemReader {
    return {
      readFile: async (path) => {
        if (path in files) {
          return files[path];
        }
        throw new Error(`ENOENT ${path}`);
      },
      readLink: async (path) => {
        if (path in links) {
          return links[path];
        }
        throw new Error(`EINVAL ${path}`);
      },
      readDir: async (path) => {
        if (path in dirs) {
          return dirs[path];
        }
        throw new Error(`ENOENT ${path}`);
      },
      exists: async (path) => path in files || path in links || path in dirs,
    };
  }

  const procNet = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 45678 1 0000 100 0 0 10 0',
  ].join('\n');

  it('maps a listening socket to its process through /proc', async () => {
    const scanner = new LinuxPortScanner(
      fakeFs(
        {
          '/proc/net/tcp': procNet,
          '/proc/stat': 'btime 1699000000\n',
          // 19 fields after `comm`, then field 22: the start time in clock ticks.
          '/proc/9001/stat': `9001 (node) ${Array.from({ length: 19 }, () => '0').join(' ')} 100000 0 0`,
          '/proc/9001/cmdline': 'node\0server.js\0',
        },
        {
          '/proc/9001/fd/23': 'socket:[45678]',
          '/proc/9001/exe': '/usr/bin/node',
          '/proc/9001/cwd': '/home/me/api',
        },
        { '/proc': ['1', '9001', 'self', 'meminfo'], '/proc/9001/fd': ['0', '23'] },
      ),
      fakeRunner({}),
      () => NOW,
      '/proc',
      1000, // uid 1000 owns the socket in the fixture below
    );

    const result = await scanner.scan(options);
    assert.equal(result.source, 'linux/proc');
    assert.equal(result.ports.length, 1);
    assert.equal(result.ports[0].port, 3000);
    assert.equal(result.ports[0].process?.pid, 9001);
    assert.equal(result.ports[0].process?.name, 'node');
    assert.equal(result.ports[0].process?.cwd, '/home/me/api');
    assert.equal(result.ports[0].process?.commandLine, 'node server.js');
  });

  it('lists the port and warns when the owning process is not readable', async () => {
    const scanner = new LinuxPortScanner(
      fakeFs({ '/proc/net/tcp': procNet }, {}, { '/proc': ['1', '9001'] }),
      fakeRunner({}),
      () => NOW,
      '/proc',
      1000,
    );
    const result = await scanner.scan(options);
    assert.equal(result.ports.length, 1);
    assert.equal(result.ports[0].process, undefined);
    assert.equal(result.warnings[0]?.code, 'partialVisibility');
  });

  it('falls back to ss when /proc/net/tcp cannot be read', async () => {
    const scanner = new LinuxPortScanner(
      fakeFs({}, {}, {}),
      fakeRunner({
        'ss -ltnpH': () => ok('LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=9001,fd=23))\n'),
      }),
      () => NOW,
    );
    const result = await scanner.scan(options);
    assert.equal(result.source, 'linux/ss');
    assert.equal(result.ports[0].process?.pid, 9001);
    assert.equal(result.warnings[0]?.code, 'fallbackUsed');
  });

  it('reports no tool available when neither /proc nor ss works', async () => {
    const scanner = new LinuxPortScanner(fakeFs({}, {}, {}), fakeRunner({}), () => NOW);
    const result = await scanner.scan(options);
    assert.deepEqual(result.ports, []);
    assert.equal(result.warnings[0]?.code, 'noToolAvailable');
  });
});

describe('Win32PortScanner', () => {
  it('encodes the probe as UTF-16LE base64, as -EncodedCommand requires', () => {
    const encoded = encodePowerShellCommand('Write-Output 1');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), 'Write-Output 1');
  });

  it('omits the process query when enrichment is not requested', () => {
    assert.ok(!buildProbeScript(false).includes('Win32_Process'));
    assert.ok(buildProbeScript(true).includes('Win32_Process'));
  });

  it('parses the probe output into ports', async () => {
    const scanner = new Win32PortScanner(
      fakeRunner({
        'powershell.exe': () =>
          ok(
            JSON.stringify([
              {
                LocalAddress: '0.0.0.0',
                LocalPort: 3000,
                Pid: 4242,
                Name: 'node.exe',
                Path: 'C:\\nodejs\\node.exe',
                CommandLine: 'node server.js',
                StartedAt: NOW - 60_000,
              },
            ]),
          ),
      }),
      () => NOW,
      'C:\\Windows',
    );

    const result = await scanner.scan(options);
    assert.equal(result.ports.length, 1);
    assert.equal(result.ports[0].process?.pid, 4242);
    assert.equal(result.ports[0].scope, 'any');
    assert.equal(result.ports[0].process?.startedAt, NOW - 60_000);
  });

  it('degrades with a warning when PowerShell is missing', async () => {
    const scanner = new Win32PortScanner(fakeRunner({}), () => NOW, 'C:\\Windows');
    const result = await scanner.scan(options);
    assert.deepEqual(result.ports, []);
    assert.equal(result.warnings[0]?.code, 'noToolAvailable');
  });
});

describe('LinuxPortScanner early exit', () => {
  /**
   * Sockets owned by another uid can never be mapped to a process without root. Waiting
   * for them meant the fd walk visited the entire process table on every poll, which is
   * the opposite of what the concurrency limiter exists to prevent.
   */
  it('stops walking once every socket it could resolve has an owner', async () => {
    const visited: string[] = [];
    const procNet = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      // Ours (uid 1000) …
      '   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 45678 1 0000 100 0 0 10 0',
      // … and root's, which we can never read.
      '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11111 1 0000 100 0 0 10 0',
    ].join('\n');

    const fs: FileSystemReader = {
      readFile: async (path) => {
        if (path === '/proc/net/tcp') {
          return procNet;
        }
        throw new Error(`ENOENT ${path}`);
      },
      readLink: async (path) => (path === '/proc/9999/fd/3' ? 'socket:[45678]' : ''),
      readDir: async (path) => {
        if (path === '/proc') {
          return ['9999', ...Array.from({ length: 200 }, (_, index) => String(index + 1))];
        }
        visited.push(path);
        return path === '/proc/9999/fd' ? ['3'] : [];
      },
      exists: async () => true,
    };

    const scanner = new LinuxPortScanner(fs, fakeRunner({}), () => NOW, '/proc', 1000);
    const result = await scanner.scan({ timeoutMs: 1000, enrich: false });

    assert.equal(result.ports.length, 2);
    assert.equal(result.ports.find((port) => port.port === 3000)?.process?.pid, 9999);
    assert.equal(result.ports.find((port) => port.port === 22)?.process, undefined);
    // The highest pid is visited first, so the walk should end almost immediately rather
    // than reading all 201 process directories.
    assert.ok(visited.length < 50, `walked ${visited.length} process directories`);
  });
});
