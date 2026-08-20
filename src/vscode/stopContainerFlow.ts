import * as vscode from 'vscode';
import { describeContainer } from '../core/docker/match.js';
import { evaluateContainerStop, publishedHostPorts } from '../core/docker/stop.js';
import type { ContainerInfo } from '../core/docker/types.js';
import { readTerminateSettings } from './config.js';
import type { DockerService } from './dockerService.js';
import type { Logger } from './logger.js';
import type { PortService } from './portService.js';

/** Docker's own default. Anything shorter tends to cut databases off mid-flush. */
const MINIMUM_GRACE_SECONDS = 10;

export interface StopContainerRequest {
  readonly port: number;
  readonly containerId: string;
}

/**
 * Stopping a container is a different operation from terminating a process, and treating
 * it as the same thing is how a user ends up killing the Docker daemon.
 *
 * Two differences drive the design. The daemon holds every published port, so signalling
 * the process behind a container port would take every container on the machine down at
 * once. And a stopped container can be started again, which a killed process cannot, so
 * the confirmation says so rather than borrowing the irreversible warning wholesale.
 *
 * What is kept from the process flow is the part that matters: the target is re-read from
 * the daemon immediately before the request, so a container that has already stopped, or
 * a port that has changed hands, cannot be acted on by a dialog left open.
 */
export class StopContainerFlow {
  constructor(
    private readonly docker: DockerService,
    private readonly ports: PortService,
    private readonly logger: Logger,
  ) {}

  async run(request: StopContainerRequest): Promise<void> {
    const target = await this.resolve(request);
    if (!target.ok) {
      void vscode.window.showInformationMessage(target.reason);
      return;
    }

    const container = target.container;
    if (!(await this.confirm(container, request.port))) {
      return;
    }

    // Re-read after the dialog, for the same reason the process flow does.
    const confirmed = await this.resolve(request);
    if (!confirmed.ok) {
      this.logger.info(`Aborted stopping ${container.name}: ${confirmed.reason}`);
      void vscode.window.showWarningMessage(`Nothing was stopped. ${confirmed.reason}`);
      return;
    }

    const graceSeconds = Math.max(
      MINIMUM_GRACE_SECONDS,
      Math.round(readTerminateSettings().gracePeriodMs / 1000),
    );

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Stopping ${describeContainer(container)}…`,
        },
        () => this.docker.stopContainer(container.id, graceSeconds),
      );
    } catch (error) {
      this.logger.error(`Failed to stop container ${container.shortId}`, error);
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : `Could not stop ${describeContainer(container)}.`,
      );
      return;
    }

    this.logger.info(`Stopped container ${container.shortId} (${describeContainer(container)}).`);
    await this.ports.refresh('container-stopped', true);

    // Claiming the port is free is only honest once a scan agrees.
    const remaining = this.ports.findEntry(request.port, undefined);
    if (remaining) {
      void vscode.window.showWarningMessage(
        `${describeContainer(container)} stopped, but port ${request.port} is still in use.`,
      );
      return;
    }
    void vscode.window.showInformationMessage(
      `Port ${request.port} released. Start it again with \`docker start ${container.name}\`.`,
    );
  }

  private async resolve(
    request: StopContainerRequest,
  ): Promise<{ ok: true; container: ContainerInfo } | { ok: false; reason: string }> {
    await this.docker.refresh(true);
    return evaluateContainerStop(this.docker.snapshot, request);
  }

  private async confirm(container: ContainerInfo, port: number): Promise<boolean> {
    const compose = container.compose;
    // A range publication frees more than the port the user clicked on.
    const otherPorts = publishedHostPorts(container).filter((candidate) => candidate !== port);
    const detail = [
      `Container: ${container.name} (${container.shortId})`,
      `Image: ${container.image}`,
      compose ? `Compose: ${compose.project} / ${compose.service}` : undefined,
      compose?.workingDir ? `Project: ${compose.workingDir}` : undefined,
      container.status ? `State: ${container.status}` : undefined,
      otherPorts.length > 0
        ? `This also frees port${otherPorts.length > 1 ? 's' : ''} ${otherPorts.join(', ')}.`
        : undefined,
      '',
      // The honest framing. This is not the irreversible warning the process flow uses,
      // and pretending otherwise would train users to ignore both.
      `The container will be sent a stop signal and can be started again with "docker start ${container.name}".`,
      compose
        ? `Other services in the "${compose.project}" project will keep running and may fail while this one is down.`
        : undefined,
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    const answer = await vscode.window.showWarningMessage(
      `Stop the container publishing port ${port}?`,
      { modal: true, detail },
      'Stop Container',
    );
    return answer === 'Stop Container';
  }
}
