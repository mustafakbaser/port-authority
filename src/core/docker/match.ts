import { isPathInside } from '../util/paths.js';
import type { ContainerInfo } from './types.js';

/** Host port to the container publishing it. Built once per scan, queried once per row. */
export type ContainerPortIndex = ReadonlyMap<number, readonly ContainerInfo[]>;

export function indexContainersByHostPort(containers: readonly ContainerInfo[]): ContainerPortIndex {
  const index = new Map<number, ContainerInfo[]>();
  for (const container of containers) {
    for (const binding of container.bindings) {
      const existing = index.get(binding.hostPort);
      if (existing) {
        if (!existing.includes(container)) {
          existing.push(container);
        }
      } else {
        index.set(binding.hostPort, [container]);
      }
    }
  }
  return index;
}

/**
 * Finds the container publishing a host port.
 *
 * Two containers cannot hold the same host port at once, so the ambiguous case only
 * arises when the daemon's view is momentarily stale — one container stopping while
 * another starts. When that happens the running one is the honest answer, and if neither
 * is running the mapping is dropped rather than guessed.
 */
export function findContainerForHostPort(
  index: ContainerPortIndex,
  hostPort: number,
): ContainerInfo | undefined {
  const candidates = index.get(hostPort);
  if (!candidates || candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0].state === 'running' ? candidates[0] : undefined;
  }
  return candidates.find((container) => container.state === 'running');
}

/**
 * True when the container was started by a Compose project inside one of the open folders.
 *
 * This is the container equivalent of matching a process working directory, and it uses
 * the same containment rule, so `~/app-backup` still does not count as `~/app`. A
 * container started by `docker run` carries no project directory and therefore never
 * claims to belong to the workspace.
 */
export function containerBelongsToWorkspace(
  container: ContainerInfo,
  workspaceFolders: readonly string[],
  caseInsensitive: boolean,
): boolean {
  const directory = container.compose?.workingDir;
  if (!directory) {
    return false;
  }
  return workspaceFolders.some((folder) => isPathInside(directory, folder, caseInsensitive));
}

/**
 * Short label for a tree row: the Compose service when there is one, the container name
 * otherwise. The image is carried separately so the row can show both without repeating
 * a name that already contains the project.
 */
export function describeContainer(container: ContainerInfo): string {
  if (container.compose) {
    return `${container.compose.project}/${container.compose.service}`;
  }
  return container.name;
}
