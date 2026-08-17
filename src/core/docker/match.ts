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
 * States in which a container still holds its published host ports.
 *
 * `running` is not enough. A paused container keeps its bindings, and a restarting one
 * reclaims them; the unfiltered `/containers/json` this client calls returns both.
 * Treating them as absent sent the row back to the Docker daemon, which removed the Stop
 * Container action and put Terminate Process back in its place.
 */
const PORT_HOLDING_STATES: readonly string[] = ['running', 'paused', 'restarting'];

export function holdsItsPorts(container: ContainerInfo): boolean {
  return PORT_HOLDING_STATES.includes(container.state);
}

/** Wildcard binds, which answer on every address the scan could have observed. */
function isWildcard(address: string): boolean {
  return address === '' || address === '*' || address === '0.0.0.0' || address === '::';
}

/**
 * Finds the container publishing a host port.
 *
 * Two containers can legitimately share a host port number on different addresses, for
 * example `0.0.0.0:9000` and `127.0.0.1:9000`, so the port alone does not always identify
 * one. When the scan tells us which addresses it saw, that disambiguates. When it cannot,
 * this returns nothing rather than picking by array order: a wrong container name on a row
 * that offers to stop it is worse than no container name at all.
 */
export function findContainerForHostPort(
  index: ContainerPortIndex,
  hostPort: number,
  observedAddresses: readonly string[] = [],
): ContainerInfo | undefined {
  const candidates = (index.get(hostPort) ?? []).filter(holdsItsPorts);
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }

  const matchesObserved = candidates.filter((container) =>
    container.bindings.some(
      (binding) =>
        binding.hostPort === hostPort &&
        (isWildcard(binding.hostIp) ||
          observedAddresses.some((address) => isWildcard(address) || address === binding.hostIp)),
    ),
  );
  return matchesObserved.length === 1 ? matchesObserved[0] : undefined;
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
  const service = container.compose?.service;
  if (service) {
    return `${container.compose!.project}/${service}`;
  }
  // Tooling that labels only the project leaves the container name as the clearest label,
  // and it usually already carries the project inside it.
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
