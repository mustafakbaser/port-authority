import * as os from 'node:os';
import * as vscode from 'vscode';
import { containerForScannedPort, describeContainer, indexContainersByHostPort } from '../core/docker/match.js';
import type { ContainerInfo } from '../core/docker/types.js';
import { describeError } from '../core/errors.js';
import { StreamingConflictDetector } from '../core/terminal/eaddrinuse.js';
import type { PortConflict } from '../core/types.js';
import { tildify } from '../core/util/paths.js';
import { formatAge } from '../core/util/time.js';
import { currentSettings } from './config.js';
import type { DockerService } from './dockerService.js';
import type { IgnoredPortStore } from './ignoredPorts.js';
import type { Logger } from './logger.js';
import type { PortService } from './portService.js';
import type { StopContainerFlow } from './stopContainerFlow.js';
import type { TerminateFlow } from './terminateFlow.js';

/** Stop scanning a single command's output past this much text; build logs are unbounded. */
const MAX_EXECUTION_BYTES = 2 * 1024 * 1024;

/**
 * Turns "port already in use" errors into a one-click resolution.
 *
 * Two design decisions carry the feature:
 *
 * 1. **Verify before notifying.** A match in terminal text is only a hint — the same
 *    string appears when someone greps a log or reads this README in the terminal. The
 *    notification is only raised after a real scan confirms a process is holding that
 *    exact port. This is the precision gate that keeps the feature from becoming noise.
 *
 * 2. **Terminal reading uses the stable shell integration API.** No proposed API is
 *    used, so when shell integration is unavailable the feature degrades to the debug
 *    console watcher and says so in the log rather than failing silently.
 */
export class ConflictWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lastNotifiedAt = new Map<number, number>();
  /** Ports with an open notification, so a restart loop cannot stack dialogs. */
  private readonly notifying = new Set<number>();
  private disposed = false;

  constructor(
    private readonly ports: PortService,
    private readonly terminateFlow: TerminateFlow,
    private readonly stopContainerFlow: StopContainerFlow,
    private readonly docker: DockerService,
    private readonly ignored: IgnoredPortStore,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.watchTerminals();
    this.watchDebugSessions();
  }

  private watchTerminals(): void {
    const api = vscode.window as Partial<typeof vscode.window>;
    if (typeof api.onDidStartTerminalShellExecution !== 'function') {
      this.logger.info(
        'Terminal shell integration is unavailable in this VS Code build; port conflicts will only be detected in the debug console.',
      );
      return;
    }

    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) => {
        if (this.disposed || !currentSettings().eaddrinuseEnabled) {
          return;
        }
        // `read()` must be called synchronously inside the handler, before any await.
        void this.consume(event.execution.read());
      }),
    );
  }

  private async consume(stream: AsyncIterable<string>): Promise<void> {
    const detector = new StreamingConflictDetector();
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        if (this.disposed) {
          return; // The extension was torn down while this execution was still running.
        }
        bytes += Buffer.byteLength(chunk, 'utf8');
        for (const conflict of detector.push(chunk)) {
          void this.handle(conflict);
        }
        if (bytes > MAX_EXECUTION_BYTES) {
          this.logger.trace('Stopped scanning a terminal execution: output exceeded the size cap.');
          return;
        }
      }
      for (const conflict of detector.flush()) {
        void this.handle(conflict);
      }
    } catch (error) {
      // A terminal can be disposed mid-stream; that is expected, not an error.
      this.logger.trace(`Terminal stream ended: ${describeError(error)}`);
    }
  }

  private watchDebugSessions(): void {
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: () => {
          const detector = new StreamingConflictDetector();
          return {
            onDidSendMessage: (message: unknown): void => {
              // Narrow first: this fires for every DAP message, and a stepping session
              // emits thousands. Only `output` events are worth a settings lookup.
              const body = asOutputEvent(message);
              if (body === undefined || this.disposed) {
                return;
              }
              const settings = currentSettings();
              if (!settings.eaddrinuseEnabled || !settings.watchDebugConsole) {
                return;
              }
              for (const conflict of detector.push(body)) {
                void this.handle(conflict);
              }
            },
            onWillStopSession: (): void => {
              for (const conflict of detector.flush()) {
                void this.handle(conflict);
              }
            },
          };
        },
      }),
    );
  }

  private async handle(conflict: PortConflict): Promise<void> {
    const settings = currentSettings();
    if (this.disposed || !settings.eaddrinuseEnabled) {
      return;
    }
    if (settings.ignoredPorts.has(conflict.port) || this.ignored.has(conflict.port)) {
      return;
    }

    const now = Date.now();
    const last = this.lastNotifiedAt.get(conflict.port);
    if (this.notifying.has(conflict.port) || (last !== undefined && now - last < settings.eaddrinuseCooldownMs)) {
      return;
    }
    // Claim the slot before the scan so two chunks cannot race into two dialogs, and
    // hold it for the dialog's whole lifetime — a restart loop outlives the cooldown.
    this.lastNotifiedAt.set(conflict.port, now);
    this.notifying.add(conflict.port);
    try {
      await this.notify(conflict);
    } finally {
      this.notifying.delete(conflict.port);
    }
  }

  private async notify(conflict: PortConflict): Promise<void> {
    // Only the port is logged. `evidence` is raw terminal text from an arbitrary process
    // and can contain a connection string.
    this.logger.debug(`Port conflict candidate on ${conflict.port}`);
    // Both are needed before the notification can name the holder correctly, and neither
    // depends on the other, so they run together.
    await Promise.all([this.ports.refresh('conflict', true), this.docker.refresh(true)]);
    if (this.disposed) {
      return;
    }

    const entry = this.ports.findEntry(conflict.port, undefined);
    if (!entry?.process) {
      // Either the port was freed already, or the holder belongs to another user and is
      // invisible to us. Either way there is no action to offer, so stay quiet.
      this.logger.debug(`No visible holder for port ${conflict.port}; no notification raised.`);
      this.lastNotifiedAt.delete(conflict.port);
      return;
    }

    const info = entry.process;
    const container = this.containerFor(conflict.port, entry);

    // The process behind a published container port is the Docker daemon, which holds
    // every other container's ports too. Offering to terminate it here was the one path
    // that still could, and it is the path users reach most often.
    const description = container
      ? this.describeContainerHolder(conflict.port, container)
      : this.describeProcessHolder(conflict.port, info);

    // In an untrusted workspace the terminal text driving this notification is fully
    // repo-controlled, so the destructive action is withheld either way.
    const destructive = container ? 'Stop Container…' : 'Terminate…';
    const actions = vscode.workspace.isTrusted
      ? [destructive, 'Show Details', 'Ignore This Port']
      : ['Show Details', 'Ignore This Port'];
    const choice = await vscode.window.showWarningMessage(`${description}.`, ...actions);
    if (this.disposed) {
      return;
    }

    switch (choice) {
      case 'Stop Container…':
        if (container) {
          await this.stopContainerFlow.run({ port: conflict.port, containerId: container.id });
        }
        break;
      case 'Terminate…':
        await this.terminateFlow.run({
          port: conflict.port,
          expectedPid: info.pid,
          source: 'notification',
        });
        break;
      case 'Show Details':
        await vscode.commands.executeCommand('portAuthority.ports.focus');
        break;
      case 'Ignore This Port':
        await this.ignored.add(conflict.port);
        break;
      default:
        break;
    }
  }

  private containerFor(port: number, entry: { process?: { name?: string }; bindings: readonly { address: string }[] }): ContainerInfo | undefined {
    const snapshot = this.docker.snapshot;
    if (snapshot.containers.length === 0) {
      return undefined;
    }
    return containerForScannedPort(
      indexContainersByHostPort(snapshot.containers),
      port,
      entry.process?.name,
      entry.bindings.map((binding) => binding.address),
    );
  }

  private describeContainerHolder(port: number, container: ContainerInfo): string {
    const where = container.compose?.workingDir
      ? tildify(container.compose.workingDir, os.homedir())
      : undefined;
    return [
      `Port ${port} is published by the container ${describeContainer(container)} (${container.image})`,
      container.status ? container.status.toLowerCase() : undefined,
      where ? `from ${where}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
  }

  private describeProcessHolder(port: number, info: NonNullable<ReturnType<PortService['findEntry']>>['process']): string {
    const where = tildify(info?.cwd ?? info?.executablePath, os.homedir());
    const age = formatAge(info?.startedAt, Date.now());
    return [
      `Port ${port} is held by ${info?.name ?? 'a process'} (PID ${info?.pid})`,
      age ? `started ${age}` : undefined,
      where ? `in ${where}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
  }

  dispose(): void {
    this.disposed = true;
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.lastNotifiedAt.clear();
  }
}

/** Narrows a Debug Adapter Protocol message to the text of an `output` event. */
function asOutputEvent(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const candidate = message as { type?: unknown; event?: unknown; body?: { output?: unknown; category?: unknown } };
  if (candidate.type !== 'event' || candidate.event !== 'output') {
    return undefined;
  }
  const output = candidate.body?.output;
  const category = candidate.body?.category;
  if (typeof output !== 'string' || output.length === 0) {
    return undefined;
  }
  // `telemetry` output is structured data, never a user-visible error message.
  return category === 'telemetry' ? undefined : output;
}
