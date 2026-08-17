import type { OwnershipBasis } from '../ownership.js';
import type { Ownership } from '../types.js';
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
 * Process names the daemon uses to hold a published port on each platform.
 *
 * Observed rather than assumed: macOS Docker Desktop answers `com.docker.backend` for
 * every published port, Linux forks a `docker-proxy` per mapping, and `dockerd` holds
 * them directly when userland proxying is off.
 */
const DOCKER_PROCESS_NAMES: readonly string[] = [
  'com.docker.backend',
  'docker desktop backend',
  'dockerd',
  'docker-proxy',
  'com.docker.vpnkit',
  'vpnkit',
];

/**
 * True when the process holding a port is Docker itself rather than an ordinary program.
 *
 * This is the precision gate on the whole feature. The daemon's port list and a socket
 * scan are two observations taken moments apart, and when they disagree the scan is the
 * direct evidence: it names the process that actually owns the socket right now. A
 * container is therefore only attached to a row when Docker is genuinely holding it, or
 * when the holder could not be identified at all. Attaching it to someone else's process
 * would put a confident, wrong label on the one row a user is most likely to act on.
 */
export function isDockerProcess(name: string | undefined): boolean {
  if (!name) {
    return false;
  }
  const normalised = name.trim().toLowerCase().replace(/\.exe$/, '');
  return DOCKER_PROCESS_NAMES.includes(normalised);
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

/**
 * Ownership for a port held by a container.
 *
 * The daemon's own working directory says nothing about the container, so a port
 * published by Docker would otherwise be labelled FOREIGN on the strength of
 * `~/Library/Containers/com.docker.docker/Data`, which is both wrong and unhelpful. Once
 * a container is known, its Compose project directory replaces that verdict entirely.
 *
 * A container started with `docker run` carries no project directory. That resolves to
 * `unknown` rather than `foreign`, for the same reason the process rules do: an absent
 * answer must never be dressed up as a negative one.
 */
export function classifyContainerOwnership(
  container: ContainerInfo,
  workspaceFolders: readonly string[],
  caseInsensitive: boolean,
): { ownership: Ownership; basis: OwnershipBasis } {
  if (!container.compose?.workingDir) {
    return { ownership: 'unknown', basis: 'none' };
  }
  return {
    ownership: containerBelongsToWorkspace(container, workspaceFolders, caseInsensitive) ? 'workspace' : 'foreign',
    basis: 'container',
  };
}
