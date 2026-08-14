import assert from 'node:assert/strict';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { buildModel } from '../../core/model.js';
import { classifyOwnership } from '../../core/ownership.js';
import { normalisePorts, type PortEntry } from '../../core/ports/scanner.js';
import type { ListeningPort, PortExpectation } from '../../core/types.js';
import { isPathInside, tildify } from '../../core/util/paths.js';
import { formatAge, parseElapsedTime } from '../../core/util/time.js';

const FOLDER = path.resolve('/Users/me/api');

const listening = (overrides: Partial<ListeningPort> = {}): ListeningPort => ({
  port: 3000,
  address: '*',
  family: 'ipv4',
  scope: 'any',
  process: { pid: 9001, name: 'node' },
  ...overrides,
});

describe('path helpers', () => {
  it('compares by path segment, not by prefix', () => {
    assert.equal(isPathInside('/Users/me/api/src', '/Users/me/api', false), true);
    assert.equal(isPathInside('/Users/me/api', '/Users/me/api', false), true);
    assert.equal(isPathInside('/Users/me/api-backup', '/Users/me/api', false), false);
    assert.equal(isPathInside(undefined, '/Users/me/api', false), false);
  });

  it('respects case-insensitive platforms', () => {
    assert.equal(isPathInside('/Users/Me/API', '/users/me/api', true), true);
    assert.equal(isPathInside('/Users/Me/API', '/users/me/api', false), false);
  });

  it('shortens paths under the home directory', () => {
    assert.equal(tildify('/Users/me/api/src', '/Users/me'), `~${path.sep}api${path.sep}src`);
    assert.equal(tildify('/opt/thing', '/Users/me'), '/opt/thing');
    assert.equal(tildify(undefined, '/Users/me'), undefined);
  });
});

describe('time helpers', () => {
  it('parses every etime layout', () => {
    assert.equal(parseElapsedTime('27'), 27_000);
    assert.equal(parseElapsedTime('04:27'), (4 * 60 + 27) * 1000);
    assert.equal(parseElapsedTime('01:04:27'), (3600 + 4 * 60 + 27) * 1000);
    assert.equal(parseElapsedTime('10-00:04:27'), (10 * 86_400 + 4 * 60 + 27) * 1000);
    assert.equal(parseElapsedTime('not a time'), undefined);
  });

  it('formats an age coarsely', () => {
    const now = 1_000_000_000;
    assert.equal(formatAge(now - 2_000, now), '2s ago');
    assert.equal(formatAge(now - 5 * 60_000, now), '5m ago');
    assert.equal(formatAge(now - 6 * 3_600_000, now), '6h ago');
    assert.equal(formatAge(now - 5 * 86_400_000, now), '5d ago');
    assert.equal(formatAge(undefined, now), undefined);
  });
});

describe('normalisePorts', () => {
  const options = {
    showAllInterfaces: false,
    portRange: [1, 65535] as const,
    ignoredPorts: new Set<number>(),
  };

  it('merges the dual-stack pair a single server produces', () => {
    const entries = normalisePorts(
      [listening(), listening({ address: '::', family: 'ipv6' })],
      options,
    );
    assert.equal(entries.length, 1);
    assert.equal(entries[0].bindings.length, 2);
  });

  it('keeps two different processes on the same port apart', () => {
    const entries = normalisePorts(
      [listening(), listening({ process: { pid: 9002, name: 'python' } })],
      options,
    );
    assert.equal(entries.length, 2);
  });

  it('hides non-loopback interface binds unless asked', () => {
    const lanBind = listening({ address: '192.168.1.5', scope: 'specific' });
    assert.equal(normalisePorts([lanBind], options).length, 0);
    assert.equal(normalisePorts([lanBind], { ...options, showAllInterfaces: true }).length, 1);
  });

  it('applies the port range and the ignore list', () => {
    assert.equal(normalisePorts([listening()], { ...options, portRange: [4000, 5000] }).length, 0);
    assert.equal(
      normalisePorts([listening()], { ...options, ignoredPorts: new Set([3000]) }).length,
      0,
    );
  });

  it('reports the widest scope among the merged bindings', () => {
    const entries = normalisePorts(
      [listening({ address: '127.0.0.1', scope: 'loopback' }), listening({ address: '*', scope: 'any' })],
      options,
    );
    assert.equal(entries[0].scope, 'any');
  });
});

describe('ownership', () => {
  const context = { workspaceFolders: [FOLDER], caseInsensitive: false };

  it('claims a process whose working directory is inside the workspace', () => {
    assert.equal(classifyOwnership({ pid: 1, cwd: path.join(FOLDER, 'src') }, context), 'workspace');
  });

  it('marks a process with a known outside directory as foreign', () => {
    assert.equal(classifyOwnership({ pid: 1, cwd: path.resolve('/Users/me/other') }, context), 'foreign');
  });

  it('never claims foreign without evidence', () => {
    assert.equal(classifyOwnership({ pid: 1 }, context), 'unknown');
    assert.equal(classifyOwnership({ pid: 1, commandLine: 'node server.js' }, context), 'unknown');
    assert.equal(classifyOwnership(undefined, context), 'unknown');
    assert.equal(
      classifyOwnership({ pid: 1, cwd: path.resolve('/x') }, { ...context, workspaceFolders: [] }),
      'unknown',
    );
  });

  it('falls back to the command line when no working directory is available', () => {
    assert.equal(
      classifyOwnership({ pid: 1, commandLine: `node ${path.join(FOLDER, 'server.js')}` }, context),
      'workspace',
    );
  });
});

describe('buildModel', () => {
  const expectation = (port: number, label = 'dev'): PortExpectation => ({
    port,
    label,
    source: { file: 'package.json', hint: 'scripts.dev' },
    folder: FOLDER,
  });

  const entry = (port: number, cwd?: string): PortEntry => ({
    port,
    process: { pid: 9000 + port, name: 'node', ...(cwd ? { cwd } : {}) },
    bindings: [{ address: '*', family: 'ipv4', scope: 'any' }],
    scope: 'any',
  });

  const context = { workspaceFolders: [FOLDER], caseInsensitive: false };

  it('labels an expected port held by our own process', () => {
    const model = buildModel([entry(3000, path.join(FOLDER, 'web'))], [expectation(3000)], context);
    assert.equal(model.expectations[0].status, 'held-by-workspace');
  });

  it('labels an expected port held by someone else', () => {
    const model = buildModel(
      [entry(5432, path.resolve('/Users/me/other'))],
      [expectation(5432, 'DATABASE_URL')],
      context,
    );
    assert.equal(model.expectations[0].status, 'held-by-foreign');
  });

  it('labels an expected port that nothing is listening on', () => {
    const model = buildModel([], [expectation(6379, 'REDIS_PORT')], context);
    assert.equal(model.expectations[0].status, 'free');
    assert.equal(model.expectations[0].entry, undefined);
  });

  it('prefers the workspace-owned process when a port has several holders', () => {
    const model = buildModel(
      [
        entry(3000, path.resolve('/elsewhere')),
        { ...entry(3000, path.join(FOLDER, 'web')), process: { pid: 4242, cwd: path.join(FOLDER, 'web') } },
      ],
      [expectation(3000)],
      context,
    );
    assert.equal(model.expectations[0].entry?.process?.pid, 4242);
    assert.equal(model.expectations[0].status, 'held-by-workspace');
  });

  it('cross-links expectations into the full port list', () => {
    const model = buildModel(
      [entry(3000, path.join(FOLDER, 'web')), entry(9999)],
      [expectation(3000)],
      context,
    );
    assert.equal(model.all.length, 2);
    assert.equal(model.all[0].expectation?.port, 3000);
    assert.equal(model.all[1].expectation, undefined);
  });
});
