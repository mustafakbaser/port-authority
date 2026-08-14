import type { PortConflict } from '../types.js';

/**
 * Strips ANSI escape sequences (colours, cursor movement, OSC hyperlinks) so that a
 * coloured `EADDRINUSE` from a dev server matches the same pattern as a plain one.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * CSI sequences, OSC sequences (BEL- or ST-terminated) and single-character Fe escapes.
 * Built from char codes so the source file stays free of literal control characters.
 */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ANSI_PATTERN = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`,
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
    `${ESC}[@-Z\\\\-_]`,
  ].join('|'),
  'g',
);

/**
 * Patterns that carry a port number.
 *
 * A message is only actionable if the port can be extracted, so "address already in
 * use" on its own is deliberately *not* matched: notifying without a port would be
 * noise the user cannot act on. Each pattern is anchored on wording that a real runtime
 * emits, not on the loose phrase alone.
 */
const PATTERNS: readonly RegExp[] = [
  // Node: `Error: listen EADDRINUSE: address already in use :::3000` / `127.0.0.1:3000`
  // Node (older): `listen EADDRINUSE 0.0.0.0:3000`
  /EADDRINUSE[^\n]*?[:\s](?:\[[0-9a-fA-F:]+\]|[0-9a-fA-F.:*]*):(\d{1,5})\b/,
  // Node inspected error object: `{ errno: -48, code: 'EADDRINUSE', ..., port: 3000 }`
  /EADDRINUSE[^\n]*?\bport:\s*(\d{1,5})\b/,
  // Go: `listen tcp :8080: bind: address already in use`
  /listen tcp\s+\S*?:(\d{1,5}):\s*bind:\s*address already in use/i,
  // Docker: `Bind for 0.0.0.0:3000 failed: port is already allocated`
  /Bind for \S*?:(\d{1,5}) failed: port is already allocated/i,
  // nginx: `bind() to 0.0.0.0:80 failed (98: Address already in use)`
  /bind\(\)\s+to\s+\S*?:(\d{1,5})\s+failed[^\n]*address already in use/i,
  // Kestrel / .NET: `Failed to bind to address http://127.0.0.1:5000: address already in use.`
  /Failed to bind to address\s+\S*?:(\d{1,5})(?:\/\S*)?:[^\n]*address already in use/i,
  // Puma / Rails: `Address already in use - bind(2) for "127.0.0.1" port 3000 (Errno::EADDRINUSE)`
  /address already in use[^\n]*?\bport\s+(\d{1,5})\b/i,
  // Spring Boot / Vite strictPort: `Port 8080 was already in use`
  /\bport\s+(\d{1,5})\s+(?:was|is)\s+already\s+(?:in use|allocated|bound)/i,
  // Vite: `Port 5173 is in use`
  /\bport\s+(\d{1,5})\s+is\s+in\s+use/i,
];

/**
 * Deliberately absent: a loose `address already in use … :<digits>` rule.
 *
 * It looked like a useful catch-all and was in fact a false-positive generator — it
 * matched the clock in `address already in use, retrying at 12:30` (port 30) and the
 * port of a URL in `address already in use - see https://docs.example.com:8443/help`.
 * Both are shapes that occur in real logs. A rule that cannot name the runtime it is
 * parsing does not belong here; a missed detection costs the user nothing, a wrong
 * "terminate this process?" prompt costs them trust.
 *
 * Also absent on purpose: Django's `Error: That port is already in use.` and Python's
 * `OSError: [Errno 48] Address already in use`, neither of which names a port. There is
 * no action to offer without one.
 */

/** Longest single line we will keep as evidence, to bound memory and log size. */
const MAX_EVIDENCE_LENGTH = 200;

/**
 * Finds port conflicts in a chunk of terminal or debug console output.
 *
 * Pure and line-oriented so it can be unit tested against a corpus of real error
 * messages — and, just as importantly, against a corpus of lines that must *not* match.
 */
export function detectPortConflicts(text: string): PortConflict[] {
  const conflicts: PortConflict[] = [];
  const seen = new Set<number>();

  for (const rawLine of stripAnsi(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.length > 4000) {
      continue;
    }
    for (const pattern of PATTERNS) {
      const match = pattern.exec(line);
      if (!match) {
        continue;
      }
      const port = Number(match[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535 || seen.has(port)) {
        break;
      }
      seen.add(port);
      conflicts.push({
        port,
        evidence: line.length > MAX_EVIDENCE_LENGTH ? `${line.slice(0, MAX_EVIDENCE_LENGTH)}…` : line,
      });
      break;
    }
  }

  return conflicts;
}

/**
 * Incremental detector for streamed output.
 *
 * Terminal chunks arrive split at arbitrary byte boundaries, so a carry-over buffer
 * keeps the tail of the previous chunk. The buffer is capped: a build log can emit
 * megabytes, and none of it is worth retaining.
 */
export class StreamingConflictDetector {
  private carry = '';

  constructor(private readonly maxCarryLength = 8 * 1024) {}

  push(chunk: string): PortConflict[] {
    const combined = this.carry + chunk;
    const lastNewline = combined.lastIndexOf('\n');

    if (lastNewline < 0) {
      this.carry = combined.length > this.maxCarryLength ? combined.slice(-this.maxCarryLength) : combined;
      return [];
    }

    const complete = combined.slice(0, lastNewline);
    const remainder = combined.slice(lastNewline + 1);
    this.carry = remainder.length > this.maxCarryLength ? remainder.slice(-this.maxCarryLength) : remainder;
    return detectPortConflicts(complete);
  }

  /** Flushes a trailing line that never received its newline, e.g. at process exit. */
  flush(): PortConflict[] {
    if (!this.carry) {
      return [];
    }
    const conflicts = detectPortConflicts(this.carry);
    this.carry = '';
    return conflicts;
  }
}
