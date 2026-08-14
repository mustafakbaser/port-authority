/** Errors that the adapter layer needs to distinguish. Kept free of `vscode`. */

export class ToolNotFoundError extends Error {
  constructor(public readonly tool: string) {
    super(`Required tool not found: ${tool}`);
    this.name = 'ToolNotFoundError';
  }
}

export class CommandTimeoutError extends Error {
  constructor(
    public readonly command: string,
    public readonly timeoutMs: number,
  ) {
    super(`Command timed out after ${timeoutMs}ms: ${command}`);
    this.name = 'CommandTimeoutError';
  }
}

export class CommandFailedError extends Error {
  constructor(
    public readonly command: string,
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(`Command failed (exit ${code ?? 'null'}): ${command}`);
    this.name = 'CommandFailedError';
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Operation cancelled');
    this.name = 'CancelledError';
  }
}

export function isCancellation(error: unknown): boolean {
  return (
    error instanceof CancelledError ||
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'Canceled'))
  );
}

/** Never let an unknown throwable reach a log line as `[object Object]`. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.name}: ${error.message}` : String(error);
  }
  return typeof error === 'string' ? error : JSON.stringify(error);
}
