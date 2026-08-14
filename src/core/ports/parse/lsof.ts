import { parseAddressPort } from './address.js';

export interface LsofSocket {
  readonly pid: number;
  readonly command: string | undefined;
  readonly user: string | undefined;
  readonly address: string;
  readonly port: number;
  readonly family: 'ipv4' | 'ipv6';
  readonly scope: 'loopback' | 'any' | 'specific';
}

/**
 * Parses `lsof -nP -iTCP -sTCP:LISTEN -F pcLPtn` field output.
 *
 * Field output is used instead of the default columns on purpose: process names may
 * contain spaces (`Google Chrome Helper`), which makes column splitting unreliable.
 *
 * Shape:
 *   p<pid>            process set begins
 *   c<command>
 *   L<login>
 *   f<fd>             file set begins
 *   t<IPv4|IPv6>
 *   PTCP
 *   n<*:3000>
 */
export function parseLsofFieldOutput(stdout: string): LsofSocket[] {
  const sockets: LsofSocket[] = [];

  let pid: number | undefined;
  let command: string | undefined;
  let user: string | undefined;
  let family: 'ipv4' | 'ipv6' | undefined;
  let protocol: string | undefined;

  const flush = (name: string): void => {
    if (pid === undefined || protocol !== 'TCP') {
      return;
    }
    const parsed = parseAddressPort(name);
    if (!parsed) {
      return;
    }
    // lsof reports established sockets as `local->remote`; the LISTEN filter should
    // exclude them, but guard anyway so a stray row cannot become a fake listener.
    if (name.includes('->')) {
      return;
    }
    sockets.push({
      pid,
      command,
      user,
      address: parsed.address,
      port: parsed.port,
      family: family ?? parsed.family,
      scope: parsed.scope,
    });
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      continue;
    }
    const tag = line[0];
    const value = line.slice(1);
    switch (tag) {
      case 'p': {
        const parsedPid = Number(value);
        pid = Number.isInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined;
        command = undefined;
        user = undefined;
        family = undefined;
        protocol = undefined;
        break;
      }
      case 'c':
        command = value || undefined;
        break;
      case 'L':
        user = value || undefined;
        break;
      case 'f':
        // New file set: reset per-file fields, keep the process-level ones.
        family = undefined;
        protocol = undefined;
        break;
      case 't':
        family = value === 'IPv6' ? 'ipv6' : value === 'IPv4' ? 'ipv4' : undefined;
        break;
      case 'P':
        protocol = value;
        break;
      case 'n':
        flush(value);
        break;
      default:
        break;
    }
  }

  return sockets;
}

/** Parses `lsof -a -d cwd -p <pids> -Fn` into a pid → cwd map. */
export function parseLsofCwdOutput(stdout: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid: number | undefined;
  let inCwdRecord = false;

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line) {
      continue;
    }
    const tag = line[0];
    const value = line.slice(1);
    if (tag === 'p') {
      const parsed = Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
      inCwdRecord = false;
    } else if (tag === 'f') {
      inCwdRecord = value === 'cwd';
    } else if (tag === 'n' && inCwdRecord && pid !== undefined && value) {
      result.set(pid, value);
    }
  }

  return result;
}
