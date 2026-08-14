/**
 * Ports (in the hexagonal sense) for the two side effects the scanners need:
 * running a command, and reading the file system.
 *
 * Scanners take these as constructor arguments so unit tests can drive them with
 * recorded fixtures instead of the real operating system.
 */

export interface RunOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Hard cap on captured stdout. Exceeding it aborts the child rather than growing the heap. */
  readonly maxBufferBytes?: number;
}

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  /** True when the output was cut short because `maxBufferBytes` was hit. */
  readonly truncated: boolean;
}

/**
 * Runs an executable with an argv array. Implementations must never use a shell —
 * every argument this extension passes is derived from OS output or user settings.
 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

export interface FileSystemReader {
  readFile(path: string): Promise<string>;
  readLink(path: string): Promise<string>;
  readDir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}
