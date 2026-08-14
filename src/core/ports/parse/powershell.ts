import { classifyScope } from './address.js';
import type { BindScope } from '../../types.js';

export interface WindowsSocket {
  readonly address: string;
  readonly port: number;
  readonly family: 'ipv4' | 'ipv6';
  readonly scope: BindScope;
  readonly pid?: number;
  readonly processName?: string;
  readonly executablePath?: string;
  readonly commandLine?: string;
  readonly startedAt?: number;
}

/** Shape emitted by the PowerShell probe in `win32.ts`. Everything is optional by design. */
interface RawRecord {
  LocalAddress?: unknown;
  LocalPort?: unknown;
  Pid?: unknown;
  Name?: unknown;
  Path?: unknown;
  CommandLine?: unknown;
  /** Epoch milliseconds, computed inside the PowerShell script to dodge date formatting. */
  StartedAt?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Parses the JSON emitted by the Windows probe.
 *
 * `ConvertTo-Json` collapses a single-element array into a bare object, so both shapes
 * must be accepted. Anything malformed is skipped rather than throwing: a partial port
 * list is useful, an exception is not.
 */
export function parseWindowsProbeJson(stdout: string): WindowsSocket[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const records: RawRecord[] = Array.isArray(parsed)
    ? (parsed as RawRecord[])
    : parsed && typeof parsed === 'object'
      ? [parsed as RawRecord]
      : [];

  const sockets: WindowsSocket[] = [];
  for (const record of records) {
    const port = asNumber(record.LocalPort);
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
      continue;
    }
    const rawAddress = asString(record.LocalAddress) ?? '0.0.0.0';
    const address = rawAddress.replace(/^\[|\]$/g, '');
    const pid = asNumber(record.Pid);
    const startedAt = asNumber(record.StartedAt);

    sockets.push({
      address,
      port,
      family: address.includes(':') ? 'ipv6' : 'ipv4',
      scope: classifyScope(address),
      ...(pid !== undefined && Number.isInteger(pid) && pid > 0 ? { pid } : {}),
      ...(asString(record.Name) ? { processName: asString(record.Name) } : {}),
      ...(asString(record.Path) ? { executablePath: asString(record.Path) } : {}),
      ...(asString(record.CommandLine) ? { commandLine: asString(record.CommandLine) } : {}),
      ...(startedAt !== undefined && startedAt > 0 ? { startedAt } : {}),
    });
  }

  return sockets;
}
