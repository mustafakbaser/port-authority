import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectPortConflicts, StreamingConflictDetector, stripAnsi } from '../../core/terminal/eaddrinuse.js';

const ESC = String.fromCharCode(27);

describe('port conflict detection', () => {
  it('recognises the message each major runtime prints', () => {
    const corpus: [string, number][] = [
      ['Error: listen EADDRINUSE: address already in use :::3000', 3000],
      ['Error: listen EADDRINUSE: address already in use 127.0.0.1:5173', 5173],
      ['listen EADDRINUSE 0.0.0.0:8080', 8080],
      ['listen tcp :8081: bind: address already in use', 8081],
      ['listen tcp 127.0.0.1:9090: bind: address already in use', 9090],
      ['Error: Bind for 0.0.0.0:3000 failed: port is already allocated', 3000],
      ['Web server failed to start. Port 8080 was already in use.', 8080],
      ['Error: Port 4200 is already in use', 4200],
      ['Port 5173 is in use, trying another one...', 5173],
      // Runtimes the first pattern set silently missed.
      ['Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)', 3000],
      ['Failed to bind to address http://127.0.0.1:5000: address already in use.', 5000],
      ['nginx: [emerg] bind() to 0.0.0.0:80 failed (98: Address already in use)', 80],
      ["{ errno: -48, code: 'EADDRINUSE', syscall: 'listen', address: '::', port: 4000 }", 4000],
    ];

    for (const [line, expected] of corpus) {
      const conflicts = detectPortConflicts(line);
      assert.equal(conflicts.length, 1, `expected a match for: ${line}`);
      assert.equal(conflicts[0].port, expected, `wrong port for: ${line}`);
    }
  });

  it('sees through ANSI colour codes', () => {
    const coloured = `${ESC}[31mError: listen EADDRINUSE: address already in use :::3000${ESC}[0m`;
    assert.equal(detectPortConflicts(coloured)[0]?.port, 3000);
    assert.equal(stripAnsi(coloured).includes(ESC), false);
  });

  /**
   * The false-positive corpus. Every line here appears in real terminals, and none of
   * them describes a port that is currently blocked. A match on any of these would turn
   * the feature into noise, which is the failure mode that gets extensions uninstalled.
   */
  it('stays silent on lines that are not an actionable conflict', () => {
    const mustNotMatch = [
      'address already in use',
      'EADDRINUSE',
      'grep -r EADDRINUSE src/',
      '# handle EADDRINUSE by retrying',
      'OSError: [Errno 48] Address already in use',
      'Listening on http://localhost:3000',
      'error: port must be a number',
      'if (err.code === "EADDRINUSE") { retry(); }',
      '  "eaddrinuse-retry": "^1.2.3",',
      'Port scanning finished in 3000 ms',
      // Both of these matched the old catch-all rule: the first yielded "port 30" from
      // the clock, the second "port 8443" from a documentation URL.
      '2024-05-01 12:29:59 ERROR address already in use, retrying at 12:30',
      'Error: address already in use - see https://docs.example.com:8443/troubleshooting',
      'Error: That port is already in use.',
      'OSError: [Errno 48] Address already in use',
    ];

    for (const line of mustNotMatch) {
      assert.deepEqual(detectPortConflicts(line), [], `should not have matched: ${line}`);
    }
  });

  it('rejects out-of-range ports', () => {
    assert.deepEqual(detectPortConflicts('listen EADDRINUSE 0.0.0.0:99999'), []);
    assert.deepEqual(detectPortConflicts('Port 0 is already in use'), []);
  });

  it('reports each port once per chunk', () => {
    const text = [
      'Error: listen EADDRINUSE: address already in use :::3000',
      'Error: listen EADDRINUSE: address already in use :::3000',
      'Error: listen EADDRINUSE: address already in use :::4000',
    ].join('\n');
    assert.deepEqual(
      detectPortConflicts(text).map((conflict) => conflict.port),
      [3000, 4000],
    );
  });

  it('truncates the evidence it keeps', () => {
    const padding = 'x'.repeat(500);
    const [conflict] = detectPortConflicts(`${padding} listen EADDRINUSE 0.0.0.0:3000`);
    assert.ok(conflict.evidence.length <= 201);
  });
});

describe('streaming detection', () => {
  it('finds a message split across chunk boundaries', () => {
    const detector = new StreamingConflictDetector();
    assert.deepEqual(detector.push('Error: listen EADDRIN'), []);
    assert.deepEqual(detector.push('USE: address already in use :::3000\n')[0]?.port, 3000);
  });

  it('does not re-report a line once it has been consumed', () => {
    const detector = new StreamingConflictDetector();
    assert.equal(detector.push('listen EADDRINUSE 0.0.0.0:3000\n').length, 1);
    assert.equal(detector.push('some other output\n').length, 0);
  });

  it('flushes a final line that never got a newline', () => {
    const detector = new StreamingConflictDetector();
    assert.deepEqual(detector.push('listen EADDRINUSE 0.0.0.0:3000'), []);
    assert.equal(detector.flush()[0]?.port, 3000);
    assert.deepEqual(detector.flush(), []);
  });

  it('bounds the carry buffer so a long line cannot grow without limit', () => {
    const detector = new StreamingConflictDetector(64);
    for (let i = 0; i < 100; i += 1) {
      detector.push('x'.repeat(100));
    }
    // Nothing matched, and the detector still works afterwards.
    assert.equal(detector.push('\nlisten EADDRINUSE 0.0.0.0:3000\n')[0]?.port, 3000);
  });
});
