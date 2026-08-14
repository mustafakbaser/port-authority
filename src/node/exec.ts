import { spawn } from 'node:child_process';
import * as os from 'node:os';
import { CancelledError, CommandFailedError, CommandTimeoutError, ToolNotFoundError } from '../core/errors.js';
import type { CommandRunner, RunOptions, RunResult } from '../core/exec.js';

const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

/**
 * Runs a command and captures its output.
 *
 * Never uses a shell. Every argument this extension passes is derived from operating
 * system output or user settings, and `shell: true` would turn a process name
 * containing `;` into command injection.
 *
 * Non-zero exit codes are *not* thrown for: `lsof` returns 1 whenever any information
 * was inaccessible, which is the normal case for an unprivileged user, and its partial
 * output is still worth showing. Callers decide what an exit code means.
 */
export const runCommand: CommandRunner = (command, args, options) =>
  new Promise<RunResult>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new CancelledError());
      return;
    }

    const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Explicitly the temp directory, not the inherited cwd. `cwd: undefined` would
      // mean "inherit", and the extension host's working directory can be a workspace
      // folder that the user deletes while VS Code is running — after which every spawn
      // fails with ENOENT and looks indistinguishable from a missing tool.
      cwd: os.tmpdir(),
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let truncated = false;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn();
    };

    const kill = (): void => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    };

    const timer = setTimeout(() => {
      kill();
      finish(() => reject(new CommandTimeoutError(command, options.timeoutMs)));
    }, options.timeoutMs);

    const onAbort = (): void => {
      kill();
      finish(() => reject(new CancelledError()));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (truncated) {
        return;
      }
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > maxBuffer) {
        truncated = true;
        kill();
        return;
      }
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // stderr is only ever used for diagnostics; a hard cap is enough.
      if (stderr.length < 64 * 1024) {
        stderr += chunk;
      }
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        reject(error.code === 'ENOENT' ? new ToolNotFoundError(command) : error);
      });
    });

    child.on('close', (code) => {
      finish(() => resolve({ stdout, stderr, code, truncated }));
    });
  });

/** Convenience wrapper for callers that genuinely require a zero exit code. */
export async function runCommandStrict(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new CommandFailedError(command, result.code, result.stderr);
  }
  return result;
}
