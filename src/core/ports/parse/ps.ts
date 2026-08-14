import { parseElapsedTime } from '../../util/time.js';

export interface PsRecord {
  readonly pid: number;
  readonly startedAt?: number;
  readonly user?: string;
  readonly commandLine?: string;
  readonly executablePath?: string;
}

/**
 * Parses `ps -o pid=,etime=,user=,args= -p <pids>`.
 *
 * `etime` is used rather than `lstart` because `lstart` is locale dependent and would
 * break under a non-English system locale. `args` is last because it is the only
 * column allowed to contain spaces.
 */
export function parsePsOutput(stdout: string, now: number): PsRecord[] {
  const records: PsRecord[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line) {
      continue;
    }
    const match = /^(\d+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, pidText, etime, user, args] = match;
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const elapsedMs = parseElapsedTime(etime);
    const commandLine = args.trim() || undefined;
    records.push({
      pid,
      startedAt: elapsedMs === undefined ? undefined : now - elapsedMs,
      user: user || undefined,
      commandLine,
      executablePath: extractExecutablePath(commandLine),
    });
  }

  return records;
}

/**
 * Best-effort executable path from a command line. Only absolute paths are accepted:
 * reporting `npm` as an "executable path" would be misleading, and a path containing
 * spaces cannot be recovered from `args` at all — undefined is the honest answer.
 */
export function extractExecutablePath(commandLine: string | undefined): string | undefined {
  if (!commandLine) {
    return undefined;
  }
  const first = commandLine.split(/\s+/, 1)[0];
  return first && (first.startsWith('/') || /^[A-Za-z]:[\\/]/.test(first)) ? first : undefined;
}
