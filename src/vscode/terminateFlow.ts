import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { evaluateKill, type KillDecision } from '../core/process/guard.js';
import { describeProcessBriefly, isSameProcess } from '../core/process/identity.js';
import type { PortEntry } from '../core/ports/scanner.js';
import type { ProcessInfo, SupportedPlatform } from '../core/types.js';
import { tildify } from '../core/util/paths.js';
import { formatAge } from '../core/util/time.js';
import { runCommand } from '../node/exec.js';
import { collectProtectedPids, NodeProcessTerminator, type ProcessTerminator } from '../node/terminator.js';
import { readTerminateSettings, type TerminateSettings } from './config.js';
import type { Logger } from './logger.js';
import type { PortService } from './portService.js';

const POLL_INTERVAL_MS = 200;

export interface TerminateRequest {
  readonly port: number;
  /** The pid the user was looking at. Used to detect that the port changed hands. */
  readonly expectedPid?: number;
  /**
   * True only for a port this workspace expects *and* provably owns via a real working
   * directory. This is the sole condition that can skip the confirmation modal, so a
   * command-line guess must never set it.
   */
  readonly isExpectedWorkspacePort?: boolean;
  readonly source: 'tree' | 'palette' | 'notification';
}

interface Target {
  readonly entry: PortEntry;
  readonly info: ProcessInfo;
  readonly decision: KillDecision;
}

type Resolution = { readonly ok: true; readonly target: Target } | { readonly ok: false; readonly reason: string };

/**
 * The one destructive path in this extension.
 *
 * Three properties hold regardless of settings:
 *
 *   1. **The target is re-identified immediately before every signal.** Not once at the
 *      start — a confirmation modal can stay open for hours, and a pid that was a dev
 *      server when the dialog opened can be an unrelated process by the time it is
 *      answered. Identity means pid *and* start time, so a recycled pid reads as a
 *      different process and the flow refuses.
 *   2. `evaluateKill` can refuse outright, and no setting overrides a refusal.
 *   3. Force-killing is a second, separate decision made after a graceful attempt — and
 *      it re-verifies again before firing.
 */
export class TerminateFlow {
  private protectedPids: Set<number> | undefined;

  constructor(
    private readonly ports: PortService,
    private readonly logger: Logger,
    private readonly platform: SupportedPlatform,
    private readonly terminator: ProcessTerminator = new NodeProcessTerminator(platform, runCommand),
  ) {}

  async run(request: TerminateRequest): Promise<void> {
    const settings = readTerminateSettings();

    const initial = await this.resolveTarget(request.port, request.expectedPid, undefined, settings);
    if (!initial.ok) {
      void vscode.window.showInformationMessage(initial.reason);
      return;
    }

    if (!(await this.confirm(initial.target, request, settings))) {
      return;
    }

    // Re-resolve after the modal. The user may have taken any amount of time, and the
    // first resolution is now only a description of what they *intended* to stop.
    const confirmed = await this.resolveTarget(
      request.port,
      initial.target.info.pid,
      initial.target.info,
      settings,
    );
    if (!confirmed.ok) {
      this.logger.info(`Aborted terminate on port ${request.port}: ${confirmed.reason}`);
      void vscode.window.showWarningMessage(`Nothing was terminated. ${confirmed.reason}`);
      return;
    }

    await this.terminate(confirmed.target, settings);
  }

  /**
   * Rescans and re-checks everything that could have changed: whether the port is still
   * held, whether it is held by the *same* process, and whether the guard still allows
   * it. `previous` is supplied on every call after the first so identity can be compared.
   */
  private async resolveTarget(
    port: number,
    expectedPid: number | undefined,
    previous: ProcessInfo | undefined,
    settings: TerminateSettings,
  ): Promise<Resolution> {
    await this.ports.refresh('terminate:verify', true);

    const snapshot = this.ports.snapshot;
    if (snapshot.stale || snapshot.scannedAt === undefined) {
      return {
        ok: false,
        reason: 'The port list could not be refreshed, so the process could not be verified. Check the Port Authority log.',
      };
    }

    const entry = this.ports.findEntry(port, expectedPid);
    if (!entry?.process) {
      const other = this.ports.findEntry(port, undefined);
      return {
        ok: false,
        reason: other
          ? `Port ${port} is now held by ${describeProcessBriefly(other.process)}.`
          : `Port ${port} is already free.`,
      };
    }

    if (previous && !isSameProcess(previous, entry.process)) {
      return {
        ok: false,
        reason: `Port ${port} changed hands — PID ${entry.process.pid} is not the process you selected.`,
      };
    }

    const decision = evaluateKill(entry.process, {
      platform: this.platform,
      protectedPids: await this.getProtectedPids(),
      userProtectedNames: settings.protectedProcessNames,
      currentUser: safeUserName(),
    });

    if (decision.risk === 'blocked') {
      this.logger.warn(
        `Refused to terminate PID ${entry.process.pid} on port ${port}: ${decision.blockedReason}`,
      );
      return {
        ok: false,
        reason: decision.blockedReason ?? 'This process cannot be terminated by Port Authority.',
      };
    }

    return { ok: true, target: { entry, info: entry.process, decision } };
  }

  private async confirm(
    target: Target,
    request: TerminateRequest,
    settings: TerminateSettings,
  ): Promise<boolean> {
    const { entry, info, decision } = target;
    const skippable =
      settings.confirmation === 'unexpectedOnly' &&
      decision.risk === 'normal' &&
      request.isExpectedWorkspacePort === true;

    if (skippable) {
      this.logger.info(
        `Terminating PID ${info.pid} on port ${entry.port} without a modal: it is an expected, workspace-owned port and confirmation is set to "unexpectedOnly".`,
      );
      return true;
    }

    const detail = [
      `Process: ${info.name ?? 'unknown'} (PID ${info.pid})`,
      info.user ? `User: ${info.user}` : undefined,
      info.cwd ? `Directory: ${tildify(info.cwd, os.homedir())}` : undefined,
      info.startedAt !== undefined ? `Started: ${formatAge(info.startedAt, Date.now())}` : undefined,
      info.commandLine ? `Command: ${truncate(info.commandLine, 300)}` : undefined,
      '',
      'This cannot be undone. Unsaved work in that process will be lost.',
      ...decision.warnings,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    const answer = await vscode.window.showWarningMessage(
      `Terminate the process holding port ${entry.port}?`,
      { modal: true, detail },
      'Terminate',
    );
    if (answer !== 'Terminate') {
      return false;
    }

    // Shared infrastructure, cross-user processes and unidentifiable ones get a second,
    // deliberate step — the first dialog is easy to click through by reflex.
    if (decision.risk === 'high') {
      const confirmed = await vscode.window.showWarningMessage(
        `Really terminate "${info.name ?? `PID ${info.pid}`}"?`,
        {
          modal: true,
          detail: decision.warnings.join('\n\n') || 'This process is shared with other work on this machine.',
        },
        'Yes, terminate it',
      );
      if (confirmed !== 'Yes, terminate it') {
        return false;
      }
    }

    return true;
  }

  private async terminate(target: Target, settings: TerminateSettings): Promise<void> {
    const { entry, info, decision } = target;
    this.logger.info(
      `Terminating PID ${info.pid} (${info.name ?? 'unknown'}) on port ${entry.port}; risk=${decision.risk}`,
    );

    let alive: boolean;
    try {
      alive = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Stopping ${info.name ?? 'process'} on port ${entry.port}…`,
        },
        async () => {
          const outcome = await this.terminator.requestStop(info.pid);
          if (outcome.kind === 'notFound') {
            return false;
          }
          if (outcome.kind === 'permissionDenied') {
            throw new Error(
              `Permission denied. PID ${info.pid} runs as ${info.user ?? 'another user'}; VS Code cannot signal it.`,
            );
          }
          if (outcome.kind === 'failed') {
            throw new Error(outcome.message);
          }
          return this.waitForExit(info.pid, settings.gracePeriodMs);
        },
      );
    } catch (error) {
      this.logger.error(`Failed to stop PID ${info.pid}`, error);
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : `Could not stop PID ${info.pid}.`,
      );
      await this.ports.refresh('terminate:failed', true);
      return;
    }

    if (!alive) {
      await this.reportRelease(entry.port, info);
      return;
    }

    const force = await vscode.window.showWarningMessage(
      `${info.name ?? `PID ${info.pid}`} did not stop within ${Math.round(settings.gracePeriodMs / 1000)}s.`,
      {
        modal: true,
        detail:
          'Force killing skips the process’s shutdown handlers. Temporary files, lock files and unflushed writes may be left behind.',
      },
      'Force Kill',
    );
    if (force !== 'Force Kill') {
      this.logger.info(`User declined to force kill PID ${info.pid}.`);
      await this.ports.refresh('terminate:declined', true);
      return;
    }

    // The graceful attempt plus this second modal is more than enough time for the pid to
    // be recycled, so verify once more before the signal that cannot be taken back.
    const stillOurs = await this.resolveTarget(entry.port, info.pid, info, settings);
    if (!stillOurs.ok) {
      this.logger.info(`Aborted force kill of PID ${info.pid}: ${stillOurs.reason}`);
      void vscode.window.showInformationMessage(`Nothing was force killed. ${stillOurs.reason}`);
      return;
    }

    const outcome = await this.terminator.forceStop(info.pid);
    if (outcome.kind === 'sent') {
      const stillAlive = await this.waitForExit(info.pid, 2000);
      this.logger.info(`Force kill of PID ${info.pid}: ${stillAlive ? 'still alive' : 'exited'}`);
      if (stillAlive) {
        void vscode.window.showErrorMessage(`PID ${info.pid} is still running after a force kill.`);
        await this.ports.refresh('terminate:forced', true);
      } else {
        await this.reportRelease(entry.port, info);
      }
    } else {
      this.logger.error(`Force kill of PID ${info.pid} failed: ${outcome.kind}`);
      void vscode.window.showErrorMessage(`Could not force kill PID ${info.pid}.`);
      await this.ports.refresh('terminate:forced', true);
    }
  }

  /**
   * Confirms the port is actually free before claiming it is.
   *
   * A process exiting does not guarantee the port was released: with `SO_REUSEPORT`, or a
   * supervisor that respawns a worker, something else may still be listening. Reporting
   * "released" without checking would be the extension lying about the one outcome the
   * user came for.
   */
  private async reportRelease(port: number, info: ProcessInfo): Promise<void> {
    await this.ports.refresh('terminate:done', true);
    const remaining = this.ports.findEntry(port, undefined);
    if (remaining) {
      this.logger.info(`PID ${info.pid} exited but port ${port} is still held by PID ${remaining.process?.pid}.`);
      void vscode.window.showWarningMessage(
        `${describeProcessBriefly(info)} stopped, but port ${port} is still held by ${describeProcessBriefly(remaining.process)}.`,
      );
      return;
    }
    this.logger.info(`PID ${info.pid} exited; port ${port} released.`);
    void vscode.window.showInformationMessage(`Port ${port} released.`);
  }

  /** Returns true if the process is still alive when the grace period expires. */
  private async waitForExit(pid: number, gracePeriodMs: number): Promise<boolean> {
    const deadline = Date.now() + gracePeriodMs;
    for (;;) {
      if (!(await this.terminator.isAlive(pid))) {
        return false;
      }
      if (Date.now() >= deadline) {
        return true;
      }
      await delay(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }

  private async getProtectedPids(): Promise<Set<number>> {
    if (!this.protectedPids) {
      this.protectedPids = await collectProtectedPids(this.platform, runCommand, (path) =>
        fs.readFile(path, 'utf8'),
      );
      this.logger.debug(`Protected pids: ${[...this.protectedPids].join(', ')}`);
    }
    return this.protectedPids;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUserName(): string | undefined {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
