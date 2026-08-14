import { parseAddressPort } from './address.js';

export interface SsSocket {
  readonly address: string;
  readonly port: number;
  readonly family: 'ipv4' | 'ipv6';
  readonly scope: 'loopback' | 'any' | 'specific';
  readonly pid?: number;
  readonly processName?: string;
}

/**
 * Parses `ss -ltnpH` output.
 *
 * Columns: State Recv-Q Send-Q Local-Address:Port Peer-Address:Port [Process]
 * Process column example: `users:(("node",pid=1234,fd=23))`
 *
 * The process column is absent when `ss` runs without the privileges needed to map
 * a socket to a process — that is reported as an unknown owner, not as an error.
 */
export function parseSsOutput(stdout: string): SsSocket[] {
  const sockets: SsSocket[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '').trim();
    if (!line || line.startsWith('State')) {
      continue;
    }
    const columns = line.split(/\s+/);
    if (columns.length < 4) {
      continue;
    }
    // With -H there is no header, so column 0 is the state; tolerate both layouts by
    // locating the first column that parses as an address:port pair.
    const localIndex = columns.findIndex((column, index) => index >= 3 && parseAddressPort(column));
    if (localIndex < 0) {
      continue;
    }
    const parsed = parseAddressPort(columns[localIndex]);
    if (!parsed) {
      continue;
    }

    // Everything after the local address; only the process column can contain `users:((`.
    const owner = parseSsProcessColumn(columns.slice(localIndex + 1).join(' '));

    sockets.push({
      address: parsed.address,
      port: parsed.port,
      family: parsed.family,
      scope: parsed.scope,
      ...(owner ?? {}),
    });
  }

  return sockets;
}

function parseSsProcessColumn(text: string): { pid: number; processName?: string } | undefined {
  const match = /\(\("([^"]*)",pid=(\d+)/.exec(text);
  if (!match) {
    return undefined;
  }
  const pid = Number(match[2]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  return { pid, processName: match[1] || undefined };
}
