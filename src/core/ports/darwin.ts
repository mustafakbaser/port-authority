import type { CommandRunner } from '../exec.js';
import { ToolNotFoundError } from '../errors.js';
import type {
  ListeningPort,
  PortScanner,
  ProcessInfo,
  ScanOptions,
  ScanResult,
  ScanWarning,
} from '../types.js';
import { parseLsofCwdOutput, parseLsofFieldOutput } from './parse/lsof.js';
import { parsePsOutput } from './parse/ps.js';

const LSOF = '/usr/sbin/lsof';
const PS = '/bin/ps';

/**
 * macOS scanner.
 *
 * `lsof` is the only tool on a stock macOS install that maps a listening socket to a
 * process. It reports sockets owned by other users but hides their process details
 * unless the caller is root — that gap is surfaced as a `partialVisibility` warning
 * instead of being silently swallowed.
 */
export class DarwinPortScanner implements PortScanner {
  readonly id = 'darwin/lsof';

  constructor(
    private readonly run: CommandRunner,
    private readonly now: () => number = Date.now,
  ) {}

  async scan(options: ScanOptions): Promise<ScanResult> {
    const started = this.now();
    const warnings: ScanWarning[] = [];

    let stdout: string;
    try {
      const result = await this.run(
        LSOF,
        ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcLPtn'],
        { timeoutMs: options.timeoutMs, signal: options.signal, maxBufferBytes: 4 * 1024 * 1024 },
      );
      // lsof exits 1 when *some* information was inaccessible, which is the normal case
      // for a non-root user. Partial output is still worth showing.
      stdout = result.stdout;
      if (result.truncated) {
        warnings.push({
          code: 'fallbackUsed',
          message:
            'The port list was cut short because `lsof` produced more output than the scan buffer allows. Some ports are missing.',
        });
      }
      if (result.code !== 0 && !result.truncated && stdout.trim().length > 0) {
        warnings.push({
          code: 'partialVisibility',
          message:
            'Some sockets are owned by other users and could not be fully inspected. Run VS Code as that user to see them.',
        });
      }
    } catch (error) {
      if (error instanceof ToolNotFoundError) {
        return {
          ports: [],
          warnings: [
            {
              code: 'noToolAvailable',
              message: `\`lsof\` was not found at ${LSOF}. Port Authority cannot list ports on this machine.`,
            },
          ],
          source: this.id,
          durationMs: this.now() - started,
        };
      }
      throw error;
    }

    const sockets = parseLsofFieldOutput(stdout);
    const processes = new Map<number, ProcessInfo>();
    for (const socket of sockets) {
      if (!processes.has(socket.pid)) {
        processes.set(socket.pid, {
          pid: socket.pid,
          ...(socket.command ? { name: socket.command } : {}),
          ...(socket.user ? { user: socket.user } : {}),
        });
      }
    }

    if (options.enrich && processes.size > 0) {
      try {
        await this.enrich(processes, options);
      } catch (error) {
        warnings.push({
          code: 'enrichmentFailed',
          message: `Start time and working directory could not be resolved: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }

    const ports: ListeningPort[] = sockets.map((socket) => ({
      port: socket.port,
      address: socket.address,
      family: socket.family,
      scope: socket.scope,
      ...(processes.has(socket.pid) ? { process: processes.get(socket.pid)! } : {}),
    }));

    return { ports, warnings, source: this.id, durationMs: this.now() - started };
  }

  /**
   * Two extra child processes for the whole scan (not per pid): `ps` for start time,
   * user and command line, `lsof -d cwd` for the working directory that ownership
   * detection needs.
   */
  private async enrich(processes: Map<number, ProcessInfo>, options: ScanOptions): Promise<void> {
    const pids = [...processes.keys()];
    const pidList = pids.join(',');
    const runOptions = {
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxBufferBytes: 2 * 1024 * 1024,
    };

    const [psResult, cwdResult] = await Promise.all([
      this.run(PS, ['-o', 'pid=,etime=,user=,args=', '-p', pidList], runOptions).catch(() => undefined),
      this.run(LSOF, ['-a', '-d', 'cwd', '-p', pidList, '-Fn'], runOptions).catch(() => undefined),
    ]);

    if (psResult) {
      for (const record of parsePsOutput(psResult.stdout, this.now())) {
        const existing = processes.get(record.pid);
        if (!existing) {
          continue;
        }
        processes.set(record.pid, {
          ...existing,
          ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
          ...(record.user ? { user: record.user } : {}),
          ...(record.commandLine ? { commandLine: record.commandLine } : {}),
          ...(record.executablePath ? { executablePath: record.executablePath } : {}),
        });
      }
    }

    if (cwdResult) {
      for (const [pid, cwd] of parseLsofCwdOutput(cwdResult.stdout)) {
        const existing = processes.get(pid);
        if (existing) {
          processes.set(pid, { ...existing, cwd });
        }
      }
    }
  }
}
