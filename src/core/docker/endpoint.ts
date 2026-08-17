import type { DockerUnavailableReason } from './types.js';

export type DockerEndpoint =
  /** A Unix domain socket, the normal case on macOS and Linux. */
  | { readonly kind: 'socket'; readonly path: string }
  /** A Windows named pipe. Node connects to both through the same `socketPath` option. */
  | { readonly kind: 'pipe'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: DockerUnavailableReason; readonly message: string };

/**
 * Where each platform's daemon usually listens.
 *
 * Ordered by how likely each one is to be the live socket rather than a stale file.
 * Docker Desktop on macOS writes a per-user socket and symlinks `/var/run/docker.sock` to
 * it, but the symlink is the part that goes missing when the user declines the privileged
 * helper, so the per-user path is tried first. Colima and Rancher Desktop are common
 * enough on developer machines to be worth naming.
 */
export const SOCKET_CANDIDATES: Readonly<Record<'darwin' | 'linux', readonly string[]>> = {
  darwin: [
    '~/.docker/run/docker.sock',
    '/var/run/docker.sock',
    '~/.colima/default/docker.sock',
    '~/.rd/docker.sock',
    '~/.lima/docker/sock/docker.sock',
  ],
  linux: [
    '/var/run/docker.sock',
    '/run/docker.sock',
    '~/.docker/run/docker.sock',
    '~/.rd/docker.sock',
  ],
};

export const WINDOWS_PIPE = '\\\\.\\pipe\\docker_engine';

/** Expands a leading `~` against the given home directory. Nothing else is expanded. */
export function expandHome(candidate: string, home: string | undefined): string {
  if (!candidate.startsWith('~/') || !home) {
    return candidate;
  }
  return `${home.replace(/[/\\]$/, '')}/${candidate.slice(2)}`;
}

/**
 * Turns `DOCKER_HOST` into an endpoint, or explains why it will not be used.
 *
 * `tcp://` and `ssh://` are refused rather than supported. The extension promises that it
 * makes no network requests, and honouring a remote `DOCKER_HOST` would quietly break
 * that promise for anyone who has one set for unrelated reasons. Refusing is also the
 * safer default: a remote daemon's containers are not the ones holding this machine's
 * ports, so the mapping would be wrong even if the connection succeeded.
 */
export function endpointFromDockerHost(value: string): DockerEndpoint {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { kind: 'unavailable', reason: 'notFound', message: 'DOCKER_HOST is empty.' };
  }

  if (trimmed.startsWith('unix://')) {
    return { kind: 'socket', path: trimmed.slice('unix://'.length) };
  }
  if (trimmed.startsWith('npipe://')) {
    return { kind: 'pipe', path: trimmed.slice('npipe://'.length).replace(/\//g, '\\') };
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('\\\\')) {
    // A bare path, which some tooling writes instead of a URL.
    return trimmed.startsWith('\\\\') ? { kind: 'pipe', path: trimmed } : { kind: 'socket', path: trimmed };
  }

  return {
    kind: 'unavailable',
    reason: 'remoteRefused',
    message:
      `DOCKER_HOST is set to "${trimmed}". Port Authority only talks to a local Docker socket, ` +
      'because it makes no network requests, and a remote daemon does not own this machine’s ports.',
  };
}

export interface EndpointResolution {
  readonly endpoint: DockerEndpoint;
  /** Local socket paths worth checking, in order. Empty when `endpoint` is already decided. */
  readonly candidates: readonly string[];
}

/**
 * Decides where to look for the daemon. Pure: the caller checks which candidate exists.
 */
export function resolveDockerEndpoint(
  platform: NodeJS.Platform,
  env: { DOCKER_HOST?: string } = {},
  home?: string,
): EndpointResolution {
  if (env.DOCKER_HOST) {
    return { endpoint: endpointFromDockerHost(env.DOCKER_HOST), candidates: [] };
  }

  if (platform === 'win32') {
    return { endpoint: { kind: 'pipe', path: WINDOWS_PIPE }, candidates: [] };
  }

  if (platform !== 'darwin' && platform !== 'linux') {
    return {
      endpoint: { kind: 'unavailable', reason: 'notFound', message: `No Docker socket is known for ${platform}.` },
      candidates: [],
    };
  }

  return {
    endpoint: { kind: 'unavailable', reason: 'notFound', message: 'No Docker socket was found.' },
    candidates: SOCKET_CANDIDATES[platform].map((candidate) => expandHome(candidate, home)),
  };
}
