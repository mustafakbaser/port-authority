import type { CommandRunner, FileSystemReader } from '../exec.js';
import { ToolNotFoundError } from '../errors.js';
import type {
  ListeningPort,
  PortScanner,
  ProcessInfo,
  ScanOptions,
  ScanResult,
  ScanWarning,
} from '../types.js';
import { forEachLimited } from '../util/concurrency.js';
import { extractExecutablePath } from './parse/ps.js';
import {
  parseBootTime,
  parseProcCmdline,
  parseProcNetTcp,
  parseProcStat,
  parseSocketInode,
  type ProcNetSocket,
} from './parse/procNet.js';
import { parseSsOutput } from './parse/ss.js';

/** Practically universal on Linux; the kernel exposes no cheap way to read it back. */
const CLOCK_TICKS_PER_SECOND = 100;
const FD_SCAN_CONCURRENCY = 24;

/**
 * Linux scanner.
 *
 * `/proc` is the primary strategy, for two reasons that matter in this extension's
 * environments: it needs no external binary (minimal devcontainer images ship neither
 * `ss` nor `lsof`), and it spawns no child process at all. `ss` is kept as a fallback
 * for the rare kernel configuration where `/proc/net/tcp` is unavailable.
 *
 * Neither strategy can map a socket to a process owned by another user without root.
 * That is reported, not hidden.
 */
export class LinuxPortScanner implements PortScanner {
  readonly id = 'linux/proc';

  constructor(
    private readonly fs: FileSystemReader,
    private readonly run: CommandRunner,
    private readonly now: () => number = Date.now,
    private readonly procRoot = '/proc',
    /** Injected so tests can describe a socket this user owns without running as it. */
    private readonly currentUid: number | undefined = typeof process.getuid === 'function'
      ? process.getuid()
      : undefined,
  ) {}

  async scan(options: ScanOptions): Promise<ScanResult> {
    const started = this.now();

    const sockets = await this.readListeningSockets();
    if (sockets === undefined) {
      const fallback = await this.scanWithSs(options);
      return { ...fallback, durationMs: this.now() - started };
    }

    const warnings: ScanWarning[] = [];
    const inodeToPid = await this.mapInodesToPids(sockets, options);

    const processes = new Map<number, ProcessInfo>();
    if (options.enrich) {
      const bootTimeMs = await this.readBootTime();
      await forEachLimited([...new Set(inodeToPid.values())], FD_SCAN_CONCURRENCY, async (pid) => {
        const info = await this.readProcessInfo(pid, bootTimeMs);
        if (info) {
          processes.set(pid, info);
        }
      }, { signal: options.signal });
    } else {
      for (const pid of new Set(inodeToPid.values())) {
        processes.set(pid, { pid });
      }
    }

    const unresolved = sockets.filter((socket) => !inodeToPid.has(socket.inode)).length;
    if (unresolved > 0) {
      warnings.push({
        code: 'partialVisibility',
        message: `${unresolved} listening socket(s) belong to another user; their process details are not readable.`,
      });
    }

    const ports: ListeningPort[] = sockets.map((socket) => {
      const pid = inodeToPid.get(socket.inode);
      const info = pid === undefined ? undefined : (processes.get(pid) ?? { pid });
      return {
        port: socket.port,
        address: socket.address,
        family: socket.family,
        scope: socket.scope,
        ...(info ? { process: info } : {}),
      };
    });

    return { ports, warnings, source: this.id, durationMs: this.now() - started };
  }

  /** Returns undefined when `/proc/net/tcp` cannot be read at all, so the caller can fall back. */
  private async readListeningSockets(): Promise<ProcNetSocket[] | undefined> {
    const results: ProcNetSocket[] = [];
    let readAny = false;

    for (const [file, family] of [
      ['net/tcp', 'ipv4'],
      ['net/tcp6', 'ipv6'],
    ] as const) {
      try {
        const content = await this.fs.readFile(`${this.procRoot}/${file}`);
        results.push(...parseProcNetTcp(content, family));
        readAny = true;
      } catch {
        // tcp6 is absent on IPv6-disabled kernels; that is normal, not an error.
      }
    }

    return readAny ? results : undefined;
  }

  /**
   * Walks `/proc/<pid>/fd` looking for `socket:[inode]` links.
   *
   * The walk stops as soon as every *resolvable* socket has an owner. "Resolvable" is
   * the important word: sockets owned by another uid — `sshd` on 22, `systemd-resolved`
   * on 127.0.0.53:53, which exist on essentially every Linux box — can never be mapped
   * without root, so waiting for them would mean walking the entire process table on
   * every single poll. Counting only the sockets we can actually resolve is what makes
   * the early exit fire in practice.
   */
  private async mapInodesToPids(
    sockets: readonly ProcNetSocket[],
    options: ScanOptions,
  ): Promise<Map<number, number>> {
    const found = new Map<number, number>();
    const wanted = new Set(sockets.map((socket) => socket.inode));
    if (wanted.size === 0) {
      return found;
    }

    const resolvable = new Set(
      sockets
        .filter(
          (socket) => this.currentUid === undefined || this.currentUid === 0 || socket.uid === this.currentUid,
        )
        .map((socket) => socket.inode),
    );

    let entries: string[];
    try {
      entries = await this.fs.readDir(this.procRoot);
    } catch {
      return found;
    }

    const pids = entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(Number)
      .sort((a, b) => b - a); // Newest processes first: dev servers are usually recent.

    const resolvedCount = (): number => {
      let count = 0;
      for (const inode of resolvable) {
        if (found.has(inode)) {
          count += 1;
        }
      }
      return count;
    };
    const done = (): boolean => resolvedCount() === resolvable.size;

    await forEachLimited(
      pids,
      FD_SCAN_CONCURRENCY,
      async (pid) => {
        let fds: string[];
        try {
          fds = await this.fs.readDir(`${this.procRoot}/${pid}/fd`);
        } catch {
          return; // Another user's process, or it exited mid-scan.
        }
        for (const fd of fds) {
          if (done()) {
            return;
          }
          let target: string;
          try {
            target = await this.fs.readLink(`${this.procRoot}/${pid}/fd/${fd}`);
          } catch {
            continue;
          }
          const inode = parseSocketInode(target);
          if (inode !== undefined && wanted.has(inode) && !found.has(inode)) {
            found.set(inode, pid);
          }
        }
      },
      { signal: options.signal, stopWhen: done },
    );

    return found;
  }

  private async readBootTime(): Promise<number | undefined> {
    try {
      const seconds = parseBootTime(await this.fs.readFile(`${this.procRoot}/stat`));
      return seconds === undefined ? undefined : seconds * 1000;
    } catch {
      return undefined;
    }
  }

  private async readProcessInfo(pid: number, bootTimeMs: number | undefined): Promise<ProcessInfo | undefined> {
    const base = `${this.procRoot}/${pid}`;
    const info: {
      -readonly [K in keyof ProcessInfo]: ProcessInfo[K];
    } = { pid };

    try {
      const stat = parseProcStat(await this.fs.readFile(`${base}/stat`));
      if (stat) {
        info.name = stat.comm;
        if (bootTimeMs !== undefined) {
          info.startedAt = bootTimeMs + (stat.startTimeTicks / CLOCK_TICKS_PER_SECOND) * 1000;
        }
      }
    } catch {
      return undefined; // The process exited between listing and reading.
    }

    try {
      info.commandLine = parseProcCmdline(await this.fs.readFile(`${base}/cmdline`));
    } catch {
      // Zombie processes have an empty cmdline.
    }

    try {
      info.executablePath = await this.fs.readLink(`${base}/exe`);
    } catch {
      info.executablePath = extractExecutablePath(info.commandLine);
    }

    try {
      info.cwd = await this.fs.readLink(`${base}/cwd`);
    } catch {
      // Needs the same uid or CAP_SYS_PTRACE; ownership stays `unknown`.
    }

    return info;
  }

  private async scanWithSs(options: ScanOptions): Promise<Omit<ScanResult, 'durationMs'>> {
    try {
      const result = await this.run('ss', ['-ltnpH'], {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        maxBufferBytes: 2 * 1024 * 1024,
      });
      const sockets = parseSsOutput(result.stdout);
      return {
        source: 'linux/ss',
        warnings: [
          {
            code: 'fallbackUsed',
            message: '`/proc/net/tcp` was unreadable, so `ss` was used. Process start time and working directory are unavailable.',
          },
        ],
        ports: sockets.map((socket) => ({
          port: socket.port,
          address: socket.address,
          family: socket.family,
          scope: socket.scope,
          ...(socket.pid !== undefined
            ? { process: { pid: socket.pid, ...(socket.processName ? { name: socket.processName } : {}) } }
            : {}),
        })),
      };
    } catch (error) {
      return {
        source: 'linux/ss',
        ports: [],
        warnings: [
          {
            code: 'noToolAvailable',
            message:
              error instanceof ToolNotFoundError
                ? 'Neither `/proc/net/tcp` nor `ss` is available in this environment, so ports cannot be listed.'
                : `Port listing failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
}
