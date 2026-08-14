import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateKill, type KillGuardContext } from '../../core/process/guard.js';
import { describeProcessBriefly, isSameProcess } from '../../core/process/identity.js';
import { classifyOwnershipDetailed } from '../../core/ownership.js';
import { redact } from '../../core/util/redact.js';
import * as path from 'node:path';
import { mentionsPath } from '../../core/util/paths.js';
import type { ProcessInfo } from '../../core/types.js';

const base: KillGuardContext = {
  platform: 'darwin',
  protectedPids: new Set([100]),
  userProtectedNames: [],
  currentUser: 'kursad',
};

/**
 * Regression tests for names the platforms genuinely emit.
 *
 * Every case here was observed on a real machine or comes from a documented kernel
 * limit. The original block lists were written against names that looked plausible but
 * that no platform actually produces, which made the guard weaker than it appeared.
 */
describe('kill guard — real platform names', () => {
  it('blocks every macOS editor helper variant, not just the bare name', () => {
    for (const name of ['Code Helper', 'Code Helper (Plugin)', 'Code Helper (Renderer)', 'Code Helper (GPU)']) {
      const decision = evaluateKill({ pid: 9001, name }, base);
      assert.equal(decision.risk, 'blocked', `should have blocked ${name}`);
      assert.match(decision.blockedReason ?? '', /editor process/);
    }
  });

  it('blocks a Linux name that the kernel truncated to 15 characters', () => {
    // `/proc/<pid>/stat` caps comm at TASK_COMM_LEN-1, so `systemd-resolved` arrives short.
    const decision = evaluateKill({ pid: 9001, name: 'systemd-resolve' }, { ...base, platform: 'linux' });
    assert.equal(decision.risk, 'blocked');
  });

  it('does not let truncation matching leak across platforms or shorten real names', () => {
    assert.equal(evaluateKill({ pid: 9001, name: 'systemd-resolve' }, base).risk, 'normal');
    // A 15-character name must not match an unrelated shorter entry.
    assert.equal(evaluateKill({ pid: 9001, name: 'my-own-service1' }, { ...base, platform: 'linux' }).risk, 'normal');
  });

  it('escalates a process whose name could not be read', () => {
    const decision = evaluateKill({ pid: 9001 }, base);
    assert.equal(decision.risk, 'high');
    assert.match(decision.warnings.join(' '), /could not be read/);
  });

  it('still honours the user list with qualifiers and .exe suffixes', () => {
    const decision = evaluateKill(
      { pid: 9001, name: 'MyDaemon (worker)' },
      { ...base, userProtectedNames: ['mydaemon.exe'] },
    );
    assert.equal(decision.risk, 'blocked');
  });
});

describe('process identity', () => {
  const at = (startedAt: number): ProcessInfo => ({ pid: 4242, name: 'node', startedAt });

  it('treats the same pid with the same start time as the same process', () => {
    assert.equal(isSameProcess(at(1000), at(1000)), true);
    assert.equal(isSameProcess(at(1000), at(1500)), true, 'small clock differences are tolerated');
  });

  it('treats a recycled pid as a different process', () => {
    assert.equal(isSameProcess(at(1000), at(60_000)), false);
    assert.equal(isSameProcess(at(1000), { ...at(1000), pid: 4243 }), false);
  });

  it('refuses to claim sameness without evidence', () => {
    assert.equal(isSameProcess({ pid: 1 }, { pid: 1 }), false);
    assert.equal(isSameProcess(undefined, at(1)), false);
    assert.equal(isSameProcess(at(1), undefined), false);
  });

  it('falls back to the command line when no start time is available', () => {
    const a: ProcessInfo = { pid: 7, commandLine: 'node server.js' };
    assert.equal(isSameProcess(a, { ...a }), true);
    assert.equal(isSameProcess(a, { pid: 7, commandLine: 'python app.py' }), false);
  });

  it('describes a process for the "changed hands" message', () => {
    assert.equal(describeProcessBriefly({ pid: 7, name: 'node' }), 'node (PID 7)');
    assert.equal(describeProcessBriefly({ pid: 7 }), 'PID 7');
    assert.equal(describeProcessBriefly(undefined), 'an unidentified process');
  });
});

describe('ownership evidence', () => {
  // Absolute paths go through `path.resolve` so the fixtures are native everywhere. A
  // POSIX literal silently becomes C:\\Users\\me\\app on Windows while the command line in
  // the same assertion keeps its forward slashes, and the test then fails for a reason
  // that has nothing to do with the code under test.
  const APP = path.resolve('/Users/me/app');
  const APP_BACKUP = path.resolve('/Users/me/app-backup');
  const APPLICATION = path.resolve('/Users/me/application');
  const context = { workspaceFolders: [APP], caseInsensitive: false };

  it('reports the working directory as direct evidence', () => {
    assert.deepEqual(classifyOwnershipDetailed({ pid: 1, cwd: path.join(APP, 'web') }, context), {
      ownership: 'workspace',
      basis: 'cwd',
    });
  });

  /** The bug this replaced classified a sibling checkout as workspace-owned. */
  it('does not match a sibling directory that merely shares a prefix', () => {
    const verdict = classifyOwnershipDetailed(
      { pid: 1, commandLine: `node ${path.join(APP_BACKUP, 'server.js')}` },
      context,
    );
    assert.equal(verdict.ownership, 'unknown');
  });

  it('marks a command-line match as indirect evidence', () => {
    assert.deepEqual(
      classifyOwnershipDetailed({ pid: 1, commandLine: `node ${path.join(APP, 'server.js')}` }, context),
      { ownership: 'workspace', basis: 'commandLine' },
    );
  });

  it('never lets a shallow folder claim every process on the machine', () => {
    assert.equal(mentionsPath('/usr/sbin/sshd -D', path.sep, false), false);
    assert.equal(
      classifyOwnershipDetailed(
        { pid: 1, commandLine: '/usr/sbin/sshd -D' },
        { workspaceFolders: [path.sep], caseInsensitive: false },
      ).ownership,
      'unknown',
    );
  });

  it('accepts a folder mentioned at a path boundary', () => {
    assert.equal(mentionsPath(`node ${path.join(APP, 'server.js')}`, APP, false), true);
    assert.equal(mentionsPath(`cd "${APP}" && npm run dev`, APP, false), true);
    assert.equal(mentionsPath(`node ${path.join(APPLICATION, 'x.js')}`, APP, false), false);
  });

  it('matches a path written with the other separator', () => {
    // Real Windows command lines mix both, depending on which shell launched the process.
    const withSlashes = APP.split(path.sep).join('/');
    assert.equal(mentionsPath(`node ${withSlashes}/server.js`, APP, false), true);
  });
});

describe('log redaction', () => {
  it('removes credentials embedded in a connection string', () => {
    assert.equal(
      redact('psql postgres://admin:s3cr3t@localhost:5432/app'),
      'psql postgres://<redacted>@localhost:5432/app',
    );
  });

  it('removes flag- and key-style secrets', () => {
    assert.match(redact('node server.js --token=abc123'), /--token=<redacted>/);
    assert.match(redact('API_KEY=abcdef123456'), /API_KEY=<redacted>/);
    assert.match(redact('password: "hunter2"'), /password=<redacted>/);
    // Assert on the property that matters — the token must not survive — rather than on
    // an exact shape. An earlier rule ordering redacted the word "Bearer" and kept the token.
    const authorization = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9');
    assert.ok(!authorization.includes('eyJhbGciOiJIUzI1NiJ9'), authorization);
  });

  it('leaves ordinary log lines untouched', () => {
    const line = 'scan(poll) via darwin/lsof: 24 port(s) in 118ms';
    assert.equal(redact(line), line);
    assert.equal(redact('Terminating PID 4242 (node) on port 3000; risk=normal'), 'Terminating PID 4242 (node) on port 3000; risk=normal');
  });
});
