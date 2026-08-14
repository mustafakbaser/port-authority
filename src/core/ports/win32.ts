import type { CommandRunner } from '../exec.js';
import { ToolNotFoundError } from '../errors.js';
import type { ListeningPort, PortScanner, ScanOptions, ScanResult, ScanWarning } from '../types.js';
import { parseWindowsProbeJson } from './parse/powershell.js';

/**
 * PowerShell probe.
 *
 * Timestamps are converted to epoch milliseconds inside the script so that no date
 * formatting — which is locale and culture dependent — has to be parsed on this side.
 * `ConvertTo-Json` is fed an explicitly wrapped array so a single listening port still
 * produces an array.
 */
export function buildProbeScript(includeDetails: boolean): string {
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}`,
    // A failure of Get-NetTCPConnection itself must not look like "nothing is listening".
    `$conns = @()`,
    `try { $conns = @(Get-NetTCPConnection -State Listen -ErrorAction Stop) }`,
    `catch { Write-Output (ConvertTo-Json -InputObject @{ error = $_.Exception.Message } -Compress); exit 0 }`,
    `if ($conns.Count -eq 0) { Write-Output '[]'; exit 0 }`,
    `$details = @{}`,
    includeDetails
      ? [
          // Filtered by ProcessId rather than enumerating every process on the machine:
          // an unfiltered Win32_Process walk runs on every poll and is expensive.
          `$ids = @($conns | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)`,
          `$filter = ($ids | ForEach-Object { "ProcessId=$_" }) -join ' OR '`,
          `foreach ($p in @(Get-CimInstance -ClassName Win32_Process -Filter $filter)) {`,
          `  $details[[int]$p.ProcessId] = $p`,
          `}`,
        ].join('\n')
      : '',
    `$epoch = [datetime]::SpecifyKind([datetime]'1970-01-01', [System.DateTimeKind]::Utc)`,
    `$rows = foreach ($c in $conns) {`,
    `  $p = $details[[int]$c.OwningProcess]`,
    `  [pscustomobject]@{`,
    `    LocalAddress = [string]$c.LocalAddress`,
    `    LocalPort = [int]$c.LocalPort`,
    `    Pid = [int]$c.OwningProcess`,
    `    Name = $(if ($p) { [string]$p.Name } else { $null })`,
    `    Path = $(if ($p) { [string]$p.ExecutablePath } else { $null })`,
    `    CommandLine = $(if ($p) { [string]$p.CommandLine } else { $null })`,
    `    StartedAt = $(if ($p -and $p.CreationDate) { [int64](($p.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds) } else { $null })`,
    `  }`,
    `}`,
    `ConvertTo-Json -InputObject @($rows) -Depth 3 -Compress`,
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

/** Reads the `{"error": ...}` sentinel the probe emits when the cmdlet itself fails. */
export function readProbeError(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: unknown };
    return typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** PowerShell's `-EncodedCommand` takes base64 of UTF-16LE, which removes all quoting risk. */
export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Windows scanner.
 *
 * `powershell.exe` is resolved from `%SystemRoot%` rather than `PATH` so a shadowed
 * executable earlier in the user's `PATH` cannot be invoked instead.
 */
export class Win32PortScanner implements PortScanner {
  readonly id = 'win32/powershell';

  constructor(
    private readonly run: CommandRunner,
    private readonly now: () => number = Date.now,
    private readonly systemRoot = process.env.SystemRoot ?? 'C:\\Windows',
  ) {}

  private get powerShellPath(): string {
    return `${this.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  }

  async scan(options: ScanOptions): Promise<ScanResult> {
    const started = this.now();
    const warnings: ScanWarning[] = [];
    const encoded = encodePowerShellCommand(buildProbeScript(options.enrich));

    let stdout: string;
    try {
      const result = await this.run(
        this.powerShellPath,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeoutMs: options.timeoutMs, signal: options.signal, maxBufferBytes: 8 * 1024 * 1024 },
      );
      stdout = result.stdout;
      if (result.truncated) {
        warnings.push({
          code: 'fallbackUsed',
          message: 'The PowerShell probe produced more output than the scan buffer allows; some ports are missing.',
        });
      }
    } catch (error) {
      return {
        ports: [],
        warnings: [
          {
            code: 'noToolAvailable',
            message:
              error instanceof ToolNotFoundError
                ? `Windows PowerShell was not found at ${this.powerShellPath}, so ports cannot be listed.`
                : `The PowerShell port probe failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        source: this.id,
        durationMs: this.now() - started,
      };
    }

    const probeError = readProbeError(stdout);
    if (probeError) {
      return {
        ports: [],
        warnings: [
          {
            code: 'noToolAvailable',
            message: `Windows could not enumerate TCP connections: ${probeError}`,
          },
        ],
        source: this.id,
        durationMs: this.now() - started,
      };
    }

    const sockets = parseWindowsProbeJson(stdout);
    if (sockets.length === 0 && stdout.trim().length > 0 && stdout.trim() !== '[]') {
      warnings.push({
        code: 'noToolAvailable',
        message: 'The PowerShell port probe returned output that could not be parsed. See the log for details.',
      });
    }
    if (options.enrich && sockets.some((socket) => socket.pid !== undefined && !socket.processName)) {
      warnings.push({
        code: 'partialVisibility',
        message:
          'Some processes are owned by another account and could not be inspected. Run VS Code elevated to see them.',
      });
    }

    const ports: ListeningPort[] = sockets.map((socket) => ({
      port: socket.port,
      address: socket.address,
      family: socket.family,
      scope: socket.scope,
      ...(socket.pid !== undefined
        ? {
            process: {
              pid: socket.pid,
              ...(socket.processName ? { name: socket.processName } : {}),
              ...(socket.executablePath ? { executablePath: socket.executablePath } : {}),
              ...(socket.commandLine ? { commandLine: socket.commandLine } : {}),
              ...(socket.startedAt !== undefined ? { startedAt: socket.startedAt } : {}),
            },
          }
        : {}),
    }));

    return { ports, warnings, source: this.id, durationMs: this.now() - started };
  }
}
