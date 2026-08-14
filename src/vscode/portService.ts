import * as vscode from 'vscode';
import { describeError, isCancellation } from '../core/errors.js';
import { createScanner, isSupportedPlatform, normalisePorts, type PortEntry } from '../core/ports/scanner.js';
import type { PortScanner, ScanWarning, SupportedPlatform } from '../core/types.js';
import { runCommand } from '../node/exec.js';
import { nodeFileSystem } from '../node/fs.js';
import { currentSettings } from './config.js';
import type { Logger } from './logger.js';

export interface PortSnapshot {
  readonly entries: readonly PortEntry[];
  readonly warnings: readonly ScanWarning[];
  /** When the last *successful* scan completed. Undefined until one has. */
  readonly scannedAt: number | undefined;
  /**
   * True when the most recent attempt failed, meaning `entries` is left over from an
   * older scan. The terminate flow refuses to act on a stale snapshot, so this must
   * never be conflated with freshness.
   */
  readonly stale: boolean;
  /** Set when the platform has no usable strategy at all. */
  readonly unavailableReason?: string;
}

/** Minimum gap between two unforced scans, so a burst of triggers cannot spawn a burst of processes. */
const MIN_SCAN_GAP_MS = 1000;

/**
 * Owns the scan lifecycle: when to scan, how often, and never more than once at a time.
 *
 * The scheduling rules exist because every scan spawns a child process. Polling runs
 * only while something is actually displaying the data (the panel, or the status bar)
 * *and* the window has focus. A background window burning a `lsof` every ten seconds is
 * exactly the kind of behaviour that gets an extension blamed for battery drain.
 *
 * Forced and unforced refreshes have deliberately different semantics:
 *   - **Unforced** (polling, view became visible) joins whatever is already running.
 *   - **Forced** (a command, a terminate, a port conflict) *queues its own scan* behind
 *     the current one. Joining would hand the caller a result gathered before they
 *     asked, which on the terminate path is the difference between verifying a process
 *     and merely assuming it is still there.
 */
export class PortService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<PortSnapshot>();
  readonly onDidChange = this.emitter.event;

  private readonly scanner: PortScanner | undefined;

  private snapshotValue: PortSnapshot = { entries: [], warnings: [], scannedAt: undefined, stale: false };
  /** Serialises scans; a forced refresh chains onto the tail rather than joining it. */
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private controller: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pollers = new Map<string, number>();
  private disposed = false;

  constructor(
    private readonly logger: Logger,
    platform: NodeJS.Platform = process.platform,
  ) {
    if (isSupportedPlatform(platform)) {
      this.scanner = createScanner(platform as SupportedPlatform, {
        run: runCommand,
        fs: nodeFileSystem,
      });
    } else {
      const unavailableReason = `Port Authority does not support the "${platform}" platform.`;
      this.snapshotValue = { ...this.snapshotValue, unavailableReason };
    }
  }

  get snapshot(): PortSnapshot {
    return this.snapshotValue;
  }

  get isAvailable(): boolean {
    return this.scanner !== undefined;
  }

  findEntry(port: number, pid: number | undefined): PortEntry | undefined {
    return this.snapshotValue.entries.find(
      (entry) => entry.port === port && (pid === undefined || entry.process?.pid === pid),
    );
  }

  /**
   * Registers a reason to poll, with the interval that reason needs.
   * The effective interval is the smallest one any active reason asked for.
   */
  setPoller(key: string, intervalMs: number | undefined): void {
    if (intervalMs === undefined) {
      this.pollers.delete(key);
    } else {
      this.pollers.set(key, intervalMs);
    }
    this.reschedule();
  }

  /** Re-evaluates the timer after a settings change or a window focus change. */
  reschedule(): void {
    this.stopTimer();
    if (this.disposed || !this.scanner) {
      return;
    }
    const settings = currentSettings();
    if (!settings.autoRefreshEnabled || this.pollers.size === 0 || !vscode.window.state.focused) {
      return;
    }
    const interval = Math.min(...this.pollers.values());
    this.timer = setInterval(() => {
      void this.refresh('poll');
    }, interval);
  }

  /**
   * Scans. Returns once a scan has completed — for `force`, one that *started after this
   * call*. Never rejects: failures are reported through the snapshot's `stale` flag and
   * its warnings, so no caller has to wrap this in a try/catch.
   */
  refresh(reason: string, force = false): Promise<void> {
    if (this.disposed || !this.scanner) {
      return Promise.resolve();
    }

    if (!force) {
      if (this.pending > 0) {
        return this.tail;
      }
      if (Date.now() - (this.snapshotValue.scannedAt ?? 0) < MIN_SCAN_GAP_MS) {
        return Promise.resolve();
      }
    }

    this.pending += 1;
    const scan = this.tail.then(() => this.runScan(reason)).finally(() => {
      this.pending -= 1;
    });
    // The tail must never reject, or every later refresh would inherit the rejection.
    this.tail = scan.catch(() => undefined);
    return this.tail;
  }

  private async runScan(reason: string): Promise<void> {
    if (this.disposed || !this.scanner) {
      return;
    }
    const settings = currentSettings();
    const startedAt = Date.now();
    const controller = new AbortController();
    this.controller = controller;

    try {
      const result = await this.scanner.scan({
        timeoutMs: settings.scanTimeoutMs,
        signal: controller.signal,
        enrich: true,
      });
      if (this.disposed) {
        return;
      }

      const entries = normalisePorts(result.ports, {
        showAllInterfaces: settings.showAllInterfaces,
        portRange: settings.portRange,
        ignoredPorts: settings.ignoredPorts,
      });

      this.logger.debug(
        `scan(${reason}) via ${result.source}: ${entries.length} port(s) in ${Date.now() - startedAt}ms`,
      );
      for (const warning of result.warnings) {
        this.logger.debug(`scan warning [${warning.code}] ${warning.message}`);
      }

      this.snapshotValue = {
        entries,
        warnings: result.warnings,
        scannedAt: Date.now(),
        stale: false,
      };
      this.emitter.fire(this.snapshotValue);
    } catch (error) {
      if (isCancellation(error)) {
        this.logger.trace(`scan(${reason}) cancelled`);
        return;
      }
      this.logger.error(`Port scan failed (${reason})`, error);
      // `scannedAt` deliberately keeps its old value: the entries below are the previous
      // scan's, and marking them fresh would let the terminate flow act on stale data.
      this.snapshotValue = {
        entries: this.snapshotValue.entries,
        warnings: [{ code: 'noToolAvailable', message: `The last scan failed: ${describeError(error)}` }],
        scannedAt: this.snapshotValue.scannedAt,
        stale: true,
      };
      this.emitter.fire(this.snapshotValue);
    } finally {
      if (this.controller === controller) {
        this.controller = undefined;
      }
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.controller?.abort();
    this.emitter.dispose();
  }
}
