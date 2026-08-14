import type { ProcessInfo } from '../types.js';

/** Two start times this close are treated as the same process; platforms round differently. */
const START_TIME_TOLERANCE_MS = 2000;

/**
 * Decides whether two observations describe the same running process.
 *
 * This is what makes PID reuse survivable. A pid on its own is not an identity: the
 * kernel recycles pids, and on a busy machine the wrap-around can happen in minutes.
 * Comparing the start time as well means a recycled pid reads as a *different* process
 * and the terminate flow can refuse instead of signalling a stranger.
 *
 * When neither observation carries a start time — Linux `ss` fallback, or an
 * unprivileged scan — the answer is `false`: without evidence of sameness, the
 * destructive path must stop and ask again rather than assume.
 */
export function isSameProcess(before: ProcessInfo | undefined, after: ProcessInfo | undefined): boolean {
  if (!before || !after || before.pid !== after.pid) {
    return false;
  }

  if (before.startedAt !== undefined && after.startedAt !== undefined) {
    return Math.abs(before.startedAt - after.startedAt) <= START_TIME_TOLERANCE_MS;
  }

  // No start time on either side. Fall back to the strongest remaining evidence; if the
  // platform gave us nothing to compare, refuse to claim they are the same.
  if (before.commandLine && after.commandLine) {
    return before.commandLine === after.commandLine;
  }
  if (before.executablePath && after.executablePath) {
    return before.executablePath === after.executablePath;
  }
  return false;
}

/** Short description used in the "the port changed hands" message. */
export function describeProcessBriefly(info: ProcessInfo | undefined): string {
  if (!info) {
    return 'an unidentified process';
  }
  return info.name ? `${info.name} (PID ${info.pid})` : `PID ${info.pid}`;
}
