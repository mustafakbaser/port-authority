import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyScope, parseAddressPort, parseProcNetAddress } from '../../core/ports/parse/address.js';
import { parseLsofCwdOutput, parseLsofFieldOutput } from '../../core/ports/parse/lsof.js';
import { extractExecutablePath, parsePsOutput } from '../../core/ports/parse/ps.js';
import { parseSsOutput } from '../../core/ports/parse/ss.js';
import {
  parseBootTime,
  parseProcCmdline,
  parseProcNetTcp,
  parseProcStat,
  parseSocketInode,
} from '../../core/ports/parse/procNet.js';
import { parseWindowsProbeJson } from '../../core/ports/parse/powershell.js';
import { readProbeError } from '../../core/ports/win32.js';

describe('address parsing', () => {
  it('parses the shapes each platform emits', () => {
    assert.deepEqual(parseAddressPort('*:3000'), {
      address: '*',
      port: 3000,
      family: 'ipv4',
      scope: 'any',
    });
    assert.deepEqual(parseAddressPort('127.0.0.1:5432'), {
      address: '127.0.0.1',
      port: 5432,
      family: 'ipv4',
      scope: 'loopback',
    });
    assert.deepEqual(parseAddressPort('[::1]:8080'), {
      address: '::1',
      port: 8080,
      family: 'ipv6',
      scope: 'loopback',
    });
    assert.equal(parseAddressPort('192.168.1.5:9000')?.scope, 'specific');
  });

  it('rejects anything without a usable port', () => {
    assert.equal(parseAddressPort(''), undefined);
    assert.equal(parseAddressPort('localhost'), undefined);
    assert.equal(parseAddressPort('*:0'), undefined);
    assert.equal(parseAddressPort('*:70000'), undefined);
    assert.equal(parseAddressPort('*:abc'), undefined);
  });

  it('classifies wildcard binds as reachable from anywhere', () => {
    assert.equal(classifyScope('0.0.0.0'), 'any');
    assert.equal(classifyScope('::'), 'any');
    assert.equal(classifyScope('127.0.0.53'), 'loopback');
    assert.equal(classifyScope('10.0.0.4'), 'specific');
  });

  it('recognises IPv4-mapped loopback, which dual-stack servers actually bind', () => {
    // A JVM or .NET server bound to 127.0.0.1 shows up only in /proc/net/tcp6.
    assert.equal(classifyScope('::ffff:7f00:1'), 'loopback');
    assert.equal(classifyScope('::ffff:127.0.0.1'), 'loopback');
    assert.equal(classifyScope('::ffff:0:0'), 'any');
    assert.equal(classifyScope('::ffff:c0a8:105'), 'specific');
    // Zone indices must not turn loopback into a LAN address.
    assert.equal(classifyScope('127.0.0.53%lo'), 'loopback');
    assert.equal(classifyScope('[::1]'), 'loopback');
  });

  it('decodes the kernel hex form of an IPv4-mapped address to loopback', () => {
    const parsed = parseProcNetAddress('0000000000000000FFFF00000100007F:1F90');
    assert.equal(parsed?.scope, 'loopback');
    assert.equal(parsed?.port, 8080);
  });

  it('decodes the hex form used by /proc/net/tcp', () => {
    // 0100007F = 127.0.0.1 little-endian, 1F90 = 8080
    assert.deepEqual(parseProcNetAddress('0100007F:1F90'), {
      address: '127.0.0.1',
      port: 8080,
      family: 'ipv4',
      scope: 'loopback',
    });
    assert.equal(parseProcNetAddress('00000000:0BB8')?.address, '0.0.0.0');
    assert.equal(parseProcNetAddress('00000000000000000000000000000000:0BB8')?.address, '::');
    // Neither an 8- nor a 32-character address is present, so the row must be skipped.
    assert.equal(parseProcNetAddress('0100:0BB8'), undefined);
    assert.equal(parseProcNetAddress('0100007F'), undefined);
  });
});

describe('lsof field output', () => {
  const sample = [
    'p634',
    'cControl Center',
    'Lkursad',
    'f9',
    'tIPv4',
    'PTCP',
    'n*:7000',
    'f10',
    'tIPv6',
    'PTCP',
    'n*:7000',
    'p9001',
    'cnode',
    'Lkursad',
    'f23',
    'tIPv4',
    'PTCP',
    'n127.0.0.1:3000',
  ].join('\n');

  it('keeps process names that contain spaces', () => {
    const sockets = parseLsofFieldOutput(sample);
    assert.equal(sockets.length, 3);
    assert.equal(sockets[0].command, 'Control Center');
    assert.equal(sockets[0].pid, 634);
    assert.equal(sockets[1].family, 'ipv6');
    assert.deepEqual(
      sockets.map((socket) => socket.port),
      [7000, 7000, 3000],
    );
  });

  it('ignores established connections that slip through the filter', () => {
    const sockets = parseLsofFieldOutput(
      ['p1', 'cnode', 'f3', 'tIPv4', 'PTCP', 'n127.0.0.1:3000->127.0.0.1:51234'].join('\n'),
    );
    assert.deepEqual(sockets, []);
  });

  it('ignores non-TCP file records', () => {
    const sockets = parseLsofFieldOutput(['p1', 'cnode', 'f3', 'tIPv4', 'PUDP', 'n*:5353'].join('\n'));
    assert.deepEqual(sockets, []);
  });

  it('reads working directories from the cwd probe', () => {
    const map = parseLsofCwdOutput(['p634', 'fcwd', 'n/', 'p9001', 'fcwd', 'n/Users/me/api'].join('\n'));
    assert.equal(map.get(9001), '/Users/me/api');
    assert.equal(map.size, 2);
  });
});

describe('ps output', () => {
  it('converts elapsed time into a start timestamp', () => {
    const now = 1_700_000_000_000;
    const records = parsePsOutput('  634 10-00:04:27 kursad /usr/libexec/rapportd --flag\n', now);
    assert.equal(records.length, 1);
    assert.equal(records[0].pid, 634);
    assert.equal(records[0].user, 'kursad');
    assert.equal(records[0].commandLine, '/usr/libexec/rapportd --flag');
    assert.equal(records[0].executablePath, '/usr/libexec/rapportd');
    const elapsedMs = (10 * 86_400 + 4 * 60 + 27) * 1000;
    assert.equal(records[0].startedAt, now - elapsedMs);
  });

  it('refuses to report a relative command as an executable path', () => {
    assert.equal(extractExecutablePath('node server.js'), undefined);
    assert.equal(extractExecutablePath('/usr/bin/node server.js'), '/usr/bin/node');
    assert.equal(extractExecutablePath('C:\\Program\\node.exe x'), 'C:\\Program\\node.exe');
    assert.equal(extractExecutablePath(undefined), undefined);
  });
});

describe('ss output', () => {
  it('extracts the owning process when it is visible', () => {
    const sockets = parseSsOutput(
      'LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*    users:(("node",pid=9001,fd=23))\n',
    );
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].port, 3000);
    assert.equal(sockets[0].pid, 9001);
    assert.equal(sockets[0].processName, 'node');
  });

  it('still lists the port when the process column is missing', () => {
    const sockets = parseSsOutput('LISTEN 0      4096         127.0.0.1:5432     0.0.0.0:*\n');
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].pid, undefined);
    assert.equal(sockets[0].scope, 'loopback');
  });
});

describe('/proc parsing', () => {
  it('keeps only listening sockets', () => {
    const content = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 45678 1 0000 100 0 0 10 0',
      '   1: 0100007F:1F91 0100007F:C000 01 00000000:00000000 00:00000000 00000000  1000        0 45679 1 0000 100 0 0 10 0',
    ].join('\n');
    const sockets = parseProcNetTcp(content, 'ipv4');
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].port, 8080);
    assert.equal(sockets[0].inode, 45678);
    assert.equal(sockets[0].uid, 1000);
  });

  it('reads socket inodes from fd links', () => {
    assert.equal(parseSocketInode('socket:[45678]'), 45678);
    assert.equal(parseSocketInode('/dev/null'), undefined);
    assert.equal(parseSocketInode('anon_inode:[eventpoll]'), undefined);
  });

  it('handles a comm field containing spaces and parentheses', () => {
    // Fields 3..21 come first; field 22 (index 19 after `comm`) is the start time.
    const leading = Array.from({ length: 19 }, (_, index) => String(index)).join(' ');
    const stat = parseProcStat(`9001 (my (weird) app) ${leading} 883212 0 0`);
    assert.equal(stat?.comm, 'my (weird) app');
    assert.equal(stat?.startTimeTicks, 883212);
  });

  it('reads boot time and cmdline', () => {
    assert.equal(parseBootTime('cpu 1 2 3\nbtime 1700000000\nprocesses 42\n'), 1_700_000_000);
    assert.equal(parseProcCmdline('node\0server.js\0--port\x003000\0'), 'node server.js --port 3000');
  });
});

describe('windows probe json', () => {
  it('accepts a single record that ConvertTo-Json did not wrap in an array', () => {
    const sockets = parseWindowsProbeJson(
      JSON.stringify({
        LocalAddress: '0.0.0.0',
        LocalPort: 3000,
        Pid: 4242,
        Name: 'node.exe',
        Path: 'C:\\Program Files\\nodejs\\node.exe',
        CommandLine: 'node server.js',
        StartedAt: 1700000000000,
      }),
    );
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].port, 3000);
    assert.equal(sockets[0].scope, 'any');
    assert.equal(sockets[0].startedAt, 1_700_000_000_000);
  });

  it('skips malformed rows instead of throwing', () => {
    const sockets = parseWindowsProbeJson('[{"LocalPort":"nope"},{"LocalAddress":"::1","LocalPort":8080}]');
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].family, 'ipv6');
  });

  it('reports a cmdlet failure instead of pretending nothing is listening', () => {
    assert.equal(
      readProbeError('{"error":"The term \'Get-NetTCPConnection\' is not recognized."}'),
      "The term 'Get-NetTCPConnection' is not recognized.",
    );
    assert.equal(readProbeError('[]'), undefined);
    assert.equal(readProbeError('[{"LocalPort":3000}]'), undefined);
  });

  it('returns nothing for unparsable output', () => {
    assert.deepEqual(parseWindowsProbeJson('At line:1 char:1 + Get-NetTCPConnection'), []);
    assert.deepEqual(parseWindowsProbeJson(''), []);
  });
});
