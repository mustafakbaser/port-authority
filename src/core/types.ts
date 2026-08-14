/**
 * Domain types for Port Authority.
 *
 * This module — and everything else under `src/core` — must never import `vscode`.
 * It is plain TypeScript so that the rules it encodes can be unit tested without an editor.
 */

export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

/** How a socket is bound, which decides whether it is reachable from outside the machine. */
export type BindScope =
  /** 127.0.0.1 / ::1 — reachable from this machine only. */
  | 'loopback'
  /** 0.0.0.0 / :: / * — reachable from every interface. */
  | 'any'
  /** A concrete non-loopback address, e.g. 192.168.1.20. */
  | 'specific';

export interface ProcessInfo {
  readonly pid: number;
  /** Short process name, e.g. `node`. Undefined when the platform did not report it. */
  readonly name?: string;
  /** Absolute path of the executable, when it could be resolved. */
  readonly executablePath?: string;
  /** Full command line, when the platform exposes it. */
  readonly commandLine?: string;
  /** Working directory of the process, when it could be resolved. Drives ownership detection. */
  readonly cwd?: string;
  /** Owning OS user name. */
  readonly user?: string;
  /** Process start time as epoch milliseconds. Approximate on platforms that only report elapsed time. */
  readonly startedAt?: number;
}

export interface ListeningPort {
  readonly port: number;
  /** Address exactly as the platform reported it, e.g. `*`, `127.0.0.1`, `::`. */
  readonly address: string;
  readonly family: 'ipv4' | 'ipv6';
  readonly scope: BindScope;
  /**
   * Owning process. Undefined when the socket is visible but its process is not —
   * on macOS and Linux this happens for processes owned by another user.
   */
  readonly process?: ProcessInfo;
}

export type ScanWarningCode =
  /** The platform tool exists but could not see processes owned by other users. */
  | 'partialVisibility'
  /** The preferred tool was missing and a fallback was used. */
  | 'fallbackUsed'
  /** Enrichment (start time, cwd, command line) failed; ports are still listed. */
  | 'enrichmentFailed'
  /** No usable tool was found for this platform. */
  | 'noToolAvailable';

export interface ScanWarning {
  readonly code: ScanWarningCode;
  readonly message: string;
}

export interface ScanResult {
  readonly ports: readonly ListeningPort[];
  readonly warnings: readonly ScanWarning[];
  /** Identifier of the strategy that produced the result, for logs and bug reports. */
  readonly source: string;
  readonly durationMs: number;
}

export interface ScanOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /**
   * Resolve start time, command line, cwd and user for the listed processes.
   * Costs one extra child process on macOS; free on Linux; already included on Windows.
   */
  readonly enrich: boolean;
}

export interface PortScanner {
  readonly id: string;
  scan(options: ScanOptions): Promise<ScanResult>;
}

/** Where a port expectation was inferred from. Shown to the user so the inference is auditable. */
export interface ExpectationSource {
  /** Workspace-relative path of the file, or `settings` for configured ports. */
  readonly file: string;
  /** Human readable pointer inside the file, e.g. `scripts.dev` or `PORT`. */
  readonly hint: string;
}

export interface PortExpectation {
  readonly port: number;
  /** Best-effort label, e.g. `next dev`, `DATABASE_URL`. */
  readonly label: string;
  readonly source: ExpectationSource;
  /** Absolute path of the workspace folder that expects this port. */
  readonly folder: string;
}

export type Ownership =
  /** The holding process runs from inside one of the open workspace folders. */
  | 'workspace'
  /** The holding process runs from somewhere else. */
  | 'foreign'
  /** Not enough information — never claim ownership we cannot prove. */
  | 'unknown';

export interface PortConflict {
  readonly port: number;
  /** Raw line the detector matched, trimmed and ANSI-stripped. Used for logs only. */
  readonly evidence: string;
}
