import { parseProcNetAddress } from './address.js';
import type { BindScope } from '../../types.js';

/** TCP_LISTEN in the kernel's state table. */
const TCP_LISTEN = '0A';

export interface ProcNetSocket {
  readonly address: string;
  readonly port: number;
  readonly family: 'ipv4' | 'ipv6';
  readonly scope: BindScope;
  readonly inode: number;
  readonly uid: number;
}

/**
 * Parses `/proc/net/tcp` and `/proc/net/tcp6`.
 *
 * Columns:
 *   sl  local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
 */
export function parseProcNetTcp(content: string, family: 'ipv4' | 'ipv6'): ProcNetSocket[] {
  const sockets: ProcNetSocket[] = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('sl')) {
      continue;
    }
    const columns = line.split(/\s+/);
    if (columns.length < 10) {
      continue;
    }
    if (columns[3] !== TCP_LISTEN) {
      continue;
    }
    const parsed = parseProcNetAddress(columns[1]);
    if (!parsed || parsed.family !== family) {
      continue;
    }
    const uid = Number(columns[7]);
    const inode = Number(columns[9]);
    if (!Number.isInteger(inode) || inode <= 0) {
      continue;
    }
    sockets.push({
      address: parsed.address,
      port: parsed.port,
      family: parsed.family,
      scope: parsed.scope,
      inode,
      uid: Number.isInteger(uid) ? uid : -1,
    });
  }

  return sockets;
}

/** Extracts the socket inode from a `/proc/<pid>/fd/<n>` symlink target. */
export function parseSocketInode(linkTarget: string): number | undefined {
  const match = /^socket:\[(\d+)\]$/.exec(linkTarget.trim());
  if (!match) {
    return undefined;
  }
  const inode = Number(match[1]);
  return Number.isInteger(inode) && inode > 0 ? inode : undefined;
}

export interface ProcStat {
  /** Start time in clock ticks since boot (field 22). */
  readonly startTimeTicks: number;
  /** Executable name as reported in field 2, without the surrounding parentheses. */
  readonly comm: string;
}

/**
 * Parses `/proc/<pid>/stat`.
 *
 * Field 2 (`comm`) is wrapped in parentheses and may itself contain spaces and
 * parentheses, so the tail is located from the *last* `)` rather than by splitting.
 */
export function parseProcStat(content: string): ProcStat | undefined {
  const open = content.indexOf('(');
  const close = content.lastIndexOf(')');
  if (open < 0 || close < open) {
    return undefined;
  }
  const comm = content.slice(open + 1, close);
  const rest = content.slice(close + 2).trim().split(/\s+/);
  // After `comm` the fields restart at 3, so field 22 is index 19 of `rest`.
  const startTimeTicks = Number(rest[19]);
  if (!Number.isFinite(startTimeTicks)) {
    return undefined;
  }
  return { startTimeTicks, comm };
}

/** Extracts `btime` (boot time, epoch seconds) from `/proc/stat`. */
export function parseBootTime(content: string): number | undefined {
  const match = /^btime\s+(\d+)$/m.exec(content);
  if (!match) {
    return undefined;
  }
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** `/proc/<pid>/cmdline` is NUL separated with a trailing NUL. */
export function parseProcCmdline(content: string): string | undefined {
  const parts = content.split('\0').filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join(' ') : undefined;
}
