import * as vscode from 'vscode';
import { isCancellation } from '../core/errors.js';
import type { DockerSnapshot } from '../core/docker/types.js';
import { DockerClient } from '../node/docker.js';
import { currentSettings } from './config.js';
import type { Logger } from './logger.js';

/** Containers change far more slowly than sockets, so repeating the call inside this window is waste. */
const MIN_REFRESH_GAP_MS = 1000;

/**
 * Keeps the container list beside the port list.
 *
 * Deliberately independent of `PortService`, in the same way the expectation service is:
 * the two produce separate snapshots and the model joins them. That keeps a slow or
 * missing Docker daemon from ever delaying a port scan, which is the feature users
 * actually depend on.
 */
export class DockerService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<DockerSnapshot>();
  readonly onDidChange = this.emitter.event;

  private snapshotValue: DockerSnapshot = { containers: [] };
  /** Serialises requests; a forced refresh chains onto the tail rather than joining it. */
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private lastRefreshAt = 0;
  private controller: AbortController | undefined;
  private disposed = false;
  private lastReportedProblem: string | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly client = new DockerClient(),
  ) {}

  get snapshot(): DockerSnapshot {
    return this.snapshotValue;
  }

  /** Called when the user toggles the setting, so a fresh probe happens immediately. */
  reset(): void {
    this.client.reset();
    this.lastRefreshAt = 0;
    if (!currentSettings().dockerEnabled) {
      this.publish({ containers: [], unavailable: { reason: 'disabled', message: 'Docker integration is off.' } });
    }
  }

  refresh(force = false): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    if (!currentSettings().dockerEnabled) {
      if (this.snapshotValue.containers.length > 0 || this.snapshotValue.unavailable?.reason !== 'disabled') {
        this.publish({ containers: [], unavailable: { reason: 'disabled', message: 'Docker integration is off.' } });
      }
      return Promise.resolve();
    }
    if (!force) {
      if (this.pending > 0) {
        return this.tail;
      }
      if (Date.now() - this.lastRefreshAt < MIN_REFRESH_GAP_MS) {
        return Promise.resolve();
      }
    }

    // A forced refresh must be answered by a request that *started after the call*, or the
    // "re-read the container immediately before stopping it" property is not held: a poll
    // that began before the confirmation dialog opened would satisfy it otherwise.
    this.pending += 1;
    const run = this.tail
      .then(() => {
        const controller = new AbortController();
        this.controller = controller;
        return this.run(controller).finally(() => {
          if (this.controller === controller) {
            this.controller = undefined;
          }
        });
      })
      .finally(() => {
        this.pending -= 1;
      });
    this.tail = run.catch(() => undefined);
    return this.tail;
  }

  private async run(controller: AbortController): Promise<void> {
    const settings = currentSettings();
    try {
      const snapshot = await this.client.listContainers({
        timeoutMs: settings.dockerTimeoutMs,
        signal: controller.signal,
      });
      if (this.disposed) {
        return;
      }
      this.lastRefreshAt = Date.now();

      // A daemon that is simply not installed is the common case, and saying so on every
      // scan would turn the log into noise. Each distinct problem is reported once.
      const problem = snapshot.unavailable?.message;
      if (problem && problem !== this.lastReportedProblem) {
        this.logger.debug(`Docker unavailable: ${problem}`);
      } else if (!problem) {
        this.logger.trace(`docker: ${snapshot.containers.length} container(s)`);
      }
      this.lastReportedProblem = problem;

      this.publish(snapshot);
    } catch (error) {
      if (isCancellation(error)) {
        return;
      }
      this.logger.error('Failed to read the container list', error);
      this.publish({
        containers: [],
        unavailable: { reason: 'unreachable', message: 'The container list could not be read.' },
      });
    }
  }

  /** Stops a container through the daemon. Reversible with `docker start`, unlike a signal. */
  async stopContainer(id: string, gracePeriodSeconds: number): Promise<void> {
    await this.client.stopContainer(id, gracePeriodSeconds, {
      timeoutMs: Math.max(currentSettings().dockerTimeoutMs, (gracePeriodSeconds + 5) * 1000),
    });
    this.lastRefreshAt = 0;
    await this.refresh(true);
  }

  private publish(snapshot: DockerSnapshot): void {
    if (this.disposed) {
      return;
    }
    this.snapshotValue = snapshot;
    this.emitter.fire(snapshot);
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
    this.emitter.dispose();
  }
}
