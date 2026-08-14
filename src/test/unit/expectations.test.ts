import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseDotEnv } from '../../core/workspace/dotenv.js';
import {
  extractPortsFromScript,
  inferExpectations,
  isLocalEnvFile,
  portFromLocalUrl,
} from '../../core/workspace/expectations.js';

const FOLDER = '/Users/me/api';

describe('dotenv parsing', () => {
  it('reads the shapes a real .env file uses', () => {
    const assignments = parseDotEnv(
      [
        '# comment',
        '',
        'PORT=3000',
        'export API_PORT=4000',
        'QUOTED="5000"',
        "SINGLE='6000'",
        'WITH_COMMENT=7000 # the api port',
        'DATABASE_URL=postgresql://user:pa#ss@localhost:5432/db',
        'not a valid line',
        '=8000',
      ].join('\n'),
    );

    assert.deepEqual(
      assignments.map((assignment) => [assignment.key, assignment.value]),
      [
        ['PORT', '3000'],
        ['API_PORT', '4000'],
        ['QUOTED', '5000'],
        ['SINGLE', '6000'],
        ['WITH_COMMENT', '7000'],
        ['DATABASE_URL', 'postgresql://user:pa#ss@localhost:5432/db'],
      ],
    );
  });
});

describe('port extraction from package.json scripts', () => {
  it('recognises the explicit forms', () => {
    assert.deepEqual(extractPortsFromScript('next dev -p 3001'), [3001]);
    assert.deepEqual(extractPortsFromScript('vite --port 5173'), [5173]);
    assert.deepEqual(extractPortsFromScript('vite --port=5174'), [5174]);
    assert.deepEqual(extractPortsFromScript('PORT=3000 node server.js'), [3000]);
    assert.deepEqual(extractPortsFromScript('API_PORT=4000 nodemon index.js'), [4000]);
  });

  /**
   * `-p` means something different in almost every other CLI. Honouring it everywhere
   * would invent expected ports out of ordinary build scripts.
   */
  it('does not treat every -p flag as a port', () => {
    assert.deepEqual(extractPortsFromScript('mkdir -p 1234 && tsc'), []);
    assert.deepEqual(extractPortsFromScript('docker build -p 8080 .'), []);
    assert.deepEqual(extractPortsFromScript('rimraf dist'), []);
    assert.deepEqual(extractPortsFromScript('jest --maxWorkers 4'), []);
    assert.deepEqual(extractPortsFromScript('tsc --outDir dist'), []);
  });

  it('rejects out-of-range numbers', () => {
    assert.deepEqual(extractPortsFromScript('vite --port 0'), []);
    assert.deepEqual(extractPortsFromScript('vite --port 70000'), []);
  });
});

describe('connection strings', () => {
  it('accepts an explicit port on a local host', () => {
    assert.equal(portFromLocalUrl('postgresql://user:secret@localhost:5432/app'), 5432);
    assert.equal(portFromLocalUrl('redis://127.0.0.1:6379'), 6379);
    assert.equal(portFromLocalUrl('http://[::1]:8080/health'), 8080);
  });

  it('ignores remote hosts and implicit ports', () => {
    assert.equal(portFromLocalUrl('postgresql://user:secret@db.prod.example.com:5432/app'), undefined);
    assert.equal(portFromLocalUrl('postgresql://localhost/app'), undefined);
    assert.equal(portFromLocalUrl('https://api.example.com'), undefined);
    // A Compose service name resolves inside the container network, not on this host.
    assert.equal(portFromLocalUrl('postgresql://db:5432/app'), undefined);
  });
});

describe('inferExpectations', () => {
  it('combines manifests, env files and settings, and points at each source', () => {
    const expectations = inferExpectations({
      folder: FOLDER,
      packageJsonFiles: [
        {
          relativePath: 'package.json',
          content: JSON.stringify({
            scripts: { dev: 'next dev -p 3000', build: 'next build' },
          }),
        },
      ],
      envFiles: [
        {
          relativePath: '.env',
          content: ['DATABASE_URL=postgres://user:pw@localhost:5432/app', 'REDIS_PORT=6379'].join('\n'),
        },
      ],
      additionalPorts: [{ port: 9229, label: 'debugger' }],
    });

    assert.deepEqual(
      expectations.map((expectation) => [expectation.port, expectation.label, expectation.source.hint]),
      [
        [3000, 'dev (next)', 'scripts.dev'],
        [5432, 'DATABASE_URL', 'DATABASE_URL'],
        [6379, 'REDIS_PORT', 'REDIS_PORT'],
        [9229, 'debugger', 'portAuthority.workspaceExpectations.additionalPorts'],
      ],
    );
    assert.ok(expectations.every((expectation) => expectation.folder === FOLDER));
  });

  it('prefers the script-derived label when a port has several sources', () => {
    const [expectation] = inferExpectations({
      folder: FOLDER,
      packageJsonFiles: [
        { relativePath: 'package.json', content: JSON.stringify({ scripts: { dev: 'vite --port 5173' } }) },
      ],
      envFiles: [{ relativePath: '.env', content: 'PORT=5173' }],
      additionalPorts: [],
    });
    assert.equal(expectation.source.hint, 'scripts.dev');
  });

  it('never invents a port from an interpolated value', () => {
    const expectations = inferExpectations({
      folder: FOLDER,
      packageJsonFiles: [
        { relativePath: 'package.json', content: JSON.stringify({ scripts: { dev: 'vite --port $PORT' } }) },
      ],
      envFiles: [{ relativePath: '.env', content: 'PORT=${BASE_PORT}' }],
      additionalPorts: [],
    });
    assert.deepEqual(expectations, []);
  });

  it('survives a package.json that is being edited', () => {
    const expectations = inferExpectations({
      folder: FOLDER,
      packageJsonFiles: [{ relativePath: 'package.json', content: '{ "scripts": { "dev": ' }],
      envFiles: [],
      additionalPorts: [],
    });
    assert.deepEqual(expectations, []);
  });
});

describe('which .env files describe this machine', () => {
  it('accepts the local ones', () => {
    for (const file of ['.env', '.env.local', '.env.development', 'apps/api/.env.development.local']) {
      assert.equal(isLocalEnvFile(file), true, file);
    }
  });

  it('rejects templates and remote-environment files', () => {
    for (const file of ['.env.example', '.env.sample', '.env.template', '.env.production', '.env.staging']) {
      assert.equal(isLocalEnvFile(file), false, file);
    }
  });
});

describe('bare *_PORT variables', () => {
  const infer = (content: string): number[] =>
    inferExpectations({
      folder: FOLDER,
      packageJsonFiles: [],
      envFiles: [{ relativePath: '.env', content }],
      additionalPorts: [],
    }).map((expectation) => expectation.port);

  it('is accepted when no host is declared', () => {
    assert.deepEqual(infer('REDIS_PORT=6379'), [6379]);
  });

  it('is accepted when the paired host is local', () => {
    assert.deepEqual(infer('REDIS_HOST=127.0.0.1\nREDIS_PORT=6379'), [6379]);
  });

  /** The `_URL` rule already rejected remote hosts; the bare-port rule has to match it. */
  it('is rejected when the paired host is remote', () => {
    assert.deepEqual(infer('REDIS_HOST=redis.prod.internal\nREDIS_PORT=6379'), []);
    assert.deepEqual(infer('DB_HOSTNAME=db.example.com\nDB_PORT=5432'), []);
  });

  it('ignores a template .env entirely', () => {
    const expectations = inferExpectations({
      folder: FOLDER,
      packageJsonFiles: [],
      envFiles: [{ relativePath: '.env.example', content: 'PORT=3000' }],
      additionalPorts: [],
    });
    assert.deepEqual(expectations, []);
  });
});
