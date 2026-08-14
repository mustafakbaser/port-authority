import type { CommandRunner } from '../core/exec.js';
import type { SupportedPlatform } from '../core/types.js';

export type SignalOutcome =
  | { readonly kind: 'sent' }
  | { readonly kind: 'notFound' }
  | { readonly kind: 'permissionDenied' }
  | { readonly kind: 'failed'; readonly message: string };

export interface ProcessTerminator {
  isAlive(pid: number): Promise<boolean>;
  requestStop(pid: number): Promise<SignalOutcome>;
  forceStop(pid: number): Promise<SignalOutcome>;
}

/**
 * Sends termination signals.
 *
 * Graceful first, always. A dev server that receives `SIGTERM` flushes its state and
 * removes its socket file; `SIGKILL` leaves both behind. The force path exists but is
 * only ever reached through a second, explicit user decision.
 */
export class NodeProcessTerminator implements ProcessTerminator {
  constructor(
    private readonly platform: SupportedPlatform,
    private readonly run: CommandRunner,
    private readonly timeoutMs = 5000,
  ) {}

  /**
   * Signal 0 performs the permission and existence checks without delivering anything.
   * `EPERM` means the process exists but belongs to someone else — still alive.
   */
  async isAlive(pid: number): Promise<boolean> {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  async requestStop(pid: number): Promise<SignalOutcome> {
    if (this.platform === 'win32') {
      // Windows has no SIGTERM. `taskkill` without /F posts WM_CLOSE, which is the
      // closest equivalent to a graceful request. /T includes the process tree, which
      // matters because `npm run dev` spawns the real server as a child.
      return this.taskkill(pid, ['/PID', String(pid), '/T']);
    }
    return this.signal(pid, 'SIGTERM');
  }

  async forceStop(pid: number): Promise<SignalOutcome> {
    if (this.platform === 'win32') {
      return this.taskkill(pid, ['/PID', String(pid), '/T', '/F']);
    }
    return this.signal(pid, 'SIGKILL');
  }

  private async signal(pid: number, signal: NodeJS.Signals): Promise<SignalOutcome> {
    try {
      process.kill(pid, signal);
      return { kind: 'sent' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') {
        return { kind: 'notFound' };
      }
      if (code === 'EPERM') {
        return { kind: 'permissionDenied' };
      }
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * `taskkill` reports failures in the console's own language, and its output arrives in
   * the OEM code page rather than UTF-8 — so matching English (or Turkish) phrases in it
   * is doubly unreliable. The outcome is derived from observable state instead: if the
   * process is gone it was already gone, otherwise the failure is a permission problem.
   */
  private async taskkill(pid: number, args: readonly string[]): Promise<SignalOutcome> {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    try {
      const result = await this.run(`${systemRoot}\\System32\\taskkill.exe`, args, {
        timeoutMs: this.timeoutMs,
      });
      if (result.code === 0) {
        return { kind: 'sent' };
      }
      if (!(await this.isAlive(pid))) {
        return { kind: 'notFound' };
      }
      // Exit code 1 with a still-running process is `taskkill`'s access-denied case.
      return result.code === 1
        ? { kind: 'permissionDenied' }
        : { kind: 'failed', message: `taskkill exited with code ${result.code}` };
    } catch (error) {
      return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Collects the process ids that must never be signalled: this extension host and its
 * ancestors, which include the VS Code window and, under Remote SSH, the server.
 *
 * Failure to walk the chain is not an error — the guard falls back to `pid`/`ppid`,
 * which already covers the case that matters most.
 */
export async function collectProtectedPids(
  platform: SupportedPlatform,
  run: CommandRunner,
  readFile: (path: string) => Promise<string>,
): Promise<Set<number>> {
  const protectedPids = new Set<number>([process.pid]);
  if (typeof process.ppid === 'number' && process.ppid > 0) {
    protectedPids.add(process.ppid);
  }
  if (platform === 'win32') {
    return protectedPids;
  }

  let current = process.ppid;
  for (let depth = 0; depth < 12 && current > 1; depth += 1) {
    const parent = await readParentPid(platform, current, run, readFile);
    if (parent === undefined || parent <= 0 || protectedPids.has(parent)) {
      break;
    }
    protectedPids.add(parent);
    current = parent;
  }

  return protectedPids;
}

async function readParentPid(
  platform: SupportedPlatform,
  pid: number,
  run: CommandRunner,
  readFile: (path: string) => Promise<string>,
): Promise<number | undefined> {
  try {
    if (platform === 'linux') {
      const content = await readFile(`/proc/${pid}/stat`);
      const close = content.lastIndexOf(')');
      const fields = content.slice(close + 2).trim().split(/\s+/);
      const ppid = Number(fields[1]); // field 4 overall
      return Number.isInteger(ppid) ? ppid : undefined;
    }
    const result = await run('/bin/ps', ['-o', 'ppid=', '-p', String(pid)], { timeoutMs: 2000 });
    const ppid = Number(result.stdout.trim());
    return Number.isInteger(ppid) ? ppid : undefined;
  } catch {
    return undefined;
  }
}
