import type { CommandRunner, FileSystemReader } from '../exec.js';
import type { BindScope, ListeningPort, PortScanner, ProcessInfo, SupportedPlatform } from '../types.js';
import { DarwinPortScanner } from './darwin.js';
import { LinuxPortScanner } from './linux.js';
import { Win32PortScanner } from './win32.js';

export interface ScannerDependencies {
  readonly run: CommandRunner;
  readonly fs: FileSystemReader;
  readonly now?: () => number;
}

export function isSupportedPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

export function createScanner(platform: SupportedPlatform, deps: ScannerDependencies): PortScanner {
  switch (platform) {
    case 'darwin':
      return new DarwinPortScanner(deps.run, deps.now);
    case 'linux':
      return new LinuxPortScanner(deps.fs, deps.run, deps.now);
    case 'win32':
      return new Win32PortScanner(deps.run, deps.now);
  }
}

export interface Binding {
  readonly address: string;
  readonly family: 'ipv4' | 'ipv6';
  readonly scope: BindScope;
}

/** One row in the UI: a port together with the single process holding it. */
export interface PortEntry {
  readonly port: number;
  readonly process?: ProcessInfo;
  readonly bindings: readonly Binding[];
  /** The most permissive scope among the bindings — what the user actually cares about. */
  readonly scope: BindScope;
}

export interface NormaliseOptions {
  readonly showAllInterfaces: boolean;
  readonly portRange: readonly [number, number];
  readonly ignoredPorts: ReadonlySet<number>;
}

const SCOPE_RANK: Record<BindScope, number> = { loopback: 0, specific: 1, any: 2 };

/**
 * Collapses the raw socket list into what the user sees.
 *
 * A dual-stack dev server appears twice in every platform tool (`0.0.0.0:3000` and
 * `[::]:3000`); showing it twice would be noise. Rows are merged per port *and* pid, so
 * two different processes on the same port — which does happen with `SO_REUSEPORT` and
 * with separate IPv4/IPv6 servers — stay visible as two rows.
 */
export function normalisePorts(
  ports: readonly ListeningPort[],
  options: NormaliseOptions,
): PortEntry[] {
  const [minPort, maxPort] = options.portRange;
  const groups = new Map<string, { port: number; process?: ProcessInfo; bindings: Binding[] }>();

  for (const port of ports) {
    if (port.port < minPort || port.port > maxPort || options.ignoredPorts.has(port.port)) {
      continue;
    }
    if (!options.showAllInterfaces && port.scope === 'specific') {
      continue;
    }
    const key = `${port.port}:${port.process?.pid ?? 'unknown'}`;
    const binding: Binding = { address: port.address, family: port.family, scope: port.scope };
    const existing = groups.get(key);
    if (existing) {
      if (!existing.bindings.some((b) => b.address === binding.address && b.family === binding.family)) {
        existing.bindings.push(binding);
      }
      // Prefer the richer process record if a later row carries more detail.
      if (port.process && (!existing.process || describeRichness(port.process) > describeRichness(existing.process))) {
        existing.process = port.process;
      }
    } else {
      groups.set(key, { port: port.port, ...(port.process ? { process: port.process } : {}), bindings: [binding] });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      port: group.port,
      ...(group.process ? { process: group.process } : {}),
      bindings: group.bindings,
      scope: group.bindings.reduce<BindScope>(
        (widest, binding) => (SCOPE_RANK[binding.scope] > SCOPE_RANK[widest] ? binding.scope : widest),
        'loopback',
      ),
    }))
    .sort((a, b) => a.port - b.port || (a.process?.pid ?? 0) - (b.process?.pid ?? 0));
}

function describeRichness(info: ProcessInfo): number {
  return (
    (info.name ? 1 : 0) +
    (info.commandLine ? 1 : 0) +
    (info.executablePath ? 1 : 0) +
    (info.cwd ? 1 : 0) +
    (info.startedAt !== undefined ? 1 : 0)
  );
}
