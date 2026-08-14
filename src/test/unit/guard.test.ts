import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateKill, type KillGuardContext } from '../../core/process/guard.js';
import type { ProcessInfo } from '../../core/types.js';

const baseContext: KillGuardContext = {
  platform: 'darwin',
  protectedPids: new Set([100, 101]),
  userProtectedNames: [],
  currentUser: 'kursad',
};

const node = (overrides: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid: 9001,
  name: 'node',
  user: 'kursad',
  ...overrides,
});

describe('kill guard', () => {
  it('allows an ordinary dev server', () => {
    const decision = evaluateKill(node(), baseContext);
    assert.equal(decision.risk, 'normal');
    assert.deepEqual(decision.warnings, []);
  });

  it('refuses when the owning process is unknown', () => {
    const decision = evaluateKill(undefined, baseContext);
    assert.equal(decision.risk, 'blocked');
    assert.match(decision.blockedReason ?? '', /could not be identified/);
  });

  it('refuses to signal VS Code itself or its parents', () => {
    for (const pid of [100, 101]) {
      const decision = evaluateKill(node({ pid }), baseContext);
      assert.equal(decision.risk, 'blocked');
      assert.match(decision.blockedReason ?? '', /VS Code/);
    }
  });

  it('refuses pid 1 everywhere and the Windows system pids', () => {
    assert.equal(evaluateKill(node({ pid: 1 }), baseContext).risk, 'blocked');
    const windows: KillGuardContext = { ...baseContext, platform: 'win32' };
    assert.equal(evaluateKill(node({ pid: 4, name: 'System' }), windows).risk, 'blocked');
    assert.equal(evaluateKill(node({ pid: 0 }), windows).risk, 'blocked');
  });

  it('refuses operating system processes by name, per platform', () => {
    assert.equal(evaluateKill(node({ name: 'launchd' }), baseContext).risk, 'blocked');
    assert.equal(
      evaluateKill(node({ name: 'lsass.exe' }), { ...baseContext, platform: 'win32' }).risk,
      'blocked',
    );
    assert.equal(
      evaluateKill(node({ name: 'systemd' }), { ...baseContext, platform: 'linux' }).risk,
      'blocked',
    );
    // A macOS-only name must not be blocked on Linux, and vice versa.
    assert.equal(evaluateKill(node({ name: 'WindowServer' }), { ...baseContext, platform: 'linux' }).risk, 'normal');
  });

  it('refuses editor processes so a window cannot be closed by accident', () => {
    assert.equal(evaluateKill(node({ name: 'Code Helper' }), baseContext).risk, 'blocked');
    assert.equal(evaluateKill(node({ name: 'cursor' }), baseContext).risk, 'blocked');
  });

  it('honours the user protected list, case-insensitively and with .exe stripped', () => {
    const context = { ...baseContext, userProtectedNames: ['MyDaemon'] };
    const decision = evaluateKill(node({ name: 'mydaemon.exe' }), context);
    assert.equal(decision.risk, 'blocked');
    assert.match(decision.blockedReason ?? '', /protectedProcessNames/);
  });

  it('escalates shared infrastructure to a high-risk confirmation', () => {
    const decision = evaluateKill(node({ name: 'postgres' }), baseContext);
    assert.equal(decision.risk, 'high');
    assert.equal(decision.warnings.length, 1);
  });

  it('escalates a process owned by another user', () => {
    const decision = evaluateKill(node({ user: 'root' }), baseContext);
    assert.equal(decision.risk, 'high');
    assert.match(decision.warnings.join(' '), /runs as "root"/);
  });

  it('does not escalate when the current user is unknown', () => {
    const decision = evaluateKill(node({ user: 'root' }), { ...baseContext, currentUser: undefined });
    assert.equal(decision.risk, 'normal');
  });
});
