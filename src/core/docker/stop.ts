import { describeContainer, holdsItsPorts } from './match.js';
import type { ContainerInfo, DockerSnapshot } from './types.js';

export type StopEvaluation =
  | { readonly ok: true; readonly container: ContainerInfo }
  | { readonly ok: false; readonly reason: string };

export interface StopRequest {
  readonly port: number;
  readonly containerId: string;
}

/**
 * Decides whether a container may be stopped, given the daemon's current view.
 *
 * Pure, and separate from the dialog for the same reason `evaluateKill` is: this is the
 * rule that has to hold after a confirmation has been sitting on screen, and a rule that
 * can only be exercised through the editor is a rule nobody tests.
 *
 * Three things are checked, and all three can change while a dialog is open: the container
 * must still exist, it must still be holding its ports, and it must still be the one
 * publishing the port the user acted on. Container ids are never reused, so identity here
 * is exact in a way a pid can never be.
 */
export function evaluateContainerStop(snapshot: DockerSnapshot, request: StopRequest): StopEvaluation {
  if (snapshot.unavailable) {
    return { ok: false, reason: snapshot.unavailable.message };
  }

  const container = snapshot.containers.find((candidate) => candidate.id === request.containerId);
  if (!container) {
    return { ok: false, reason: 'That container is no longer known to Docker.' };
  }
  if (!holdsItsPorts(container)) {
    return { ok: false, reason: `${describeContainer(container)} is already ${container.state}.` };
  }
  if (!container.bindings.some((binding) => binding.hostPort === request.port)) {
    return {
      ok: false,
      reason: `${describeContainer(container)} no longer publishes port ${request.port}.`,
    };
  }
  return { ok: true, container };
}

/**
 * Every host port this container publishes, so a confirmation can say what else goes away.
 * A range publication such as `-p 8000-8010:8000-8010` frees eleven ports, not the one the
 * user clicked.
 */
export function publishedHostPorts(container: ContainerInfo): number[] {
  return [...new Set(container.bindings.map((binding) => binding.hostPort))].sort((a, b) => a - b);
}
