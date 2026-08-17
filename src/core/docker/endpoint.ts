import { createHash } from 'node:crypto';
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
    '~/.orbstack/run/docker.sock',
    '~/.colima/default/docker.sock',
    '~/.rd/docker.sock',
    '~/.lima/docker/sock/docker.sock',
  ],
  linux: [
    '/var/run/docker.sock',
    '/run/docker.sock',
    // Rootless Docker, whose DOCKER_HOST is exported from a shell profile that VS Code
    // does not inherit when it is launched from a desktop entry.
    '$XDG_RUNTIME_DIR/docker.sock',
    // Docker Desktop for Linux, which does not create /var/run/docker.sock at all.
    '~/.docker/desktop/docker.sock',
    '~/.docker/run/docker.sock',
    // Podman's Docker-compatible API, rootless first.
    '$XDG_RUNTIME_DIR/podman/podman.sock',
    '/run/podman/podman.sock',
    '~/.rd/docker.sock',
  ],
};

export const WINDOWS_PIPE = '\\\\.\\pipe\\docker_engine';

/**
 * Expands a leading `~` and a leading `$XDG_RUNTIME_DIR`. Nothing else is expanded, and a
 * candidate whose variable is unset is dropped rather than left as a literal path.
 */
export function expandCandidate(
  candidate: string,
  home: string | undefined,
  env: { XDG_RUNTIME_DIR?: string } = {},
): string | undefined {
  if (candidate.startsWith('$XDG_RUNTIME_DIR/')) {
    const base = env.XDG_RUNTIME_DIR?.replace(/[/\\]$/, '');
    return base ? `${base}/${candidate.slice('$XDG_RUNTIME_DIR/'.length)}` : undefined;
  }
  if (candidate.startsWith('~/')) {
    return home ? `${home.replace(/[/\\]$/, '')}/${candidate.slice(2)}` : undefined;
  }
  return candidate;
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
    const path = trimmed.slice('unix://'.length);
    // An empty path is not a socket. Node treats a falsy `socketPath` as absent and falls
    // back to a TCP connection to localhost:80, which would break the promise that this
    // extension makes no network requests.
    return path
      ? { kind: 'socket', path }
      : { kind: 'unavailable', reason: 'notFound', message: 'DOCKER_HOST names no socket path.' };
  }
  if (trimmed.startsWith('npipe://')) {
    const path = trimmed.slice('npipe://'.length).replace(/\//g, '\\');
    return path
      ? { kind: 'pipe', path }
      : { kind: 'unavailable', reason: 'notFound', message: 'DOCKER_HOST names no pipe path.' };
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

/**
 * The Docker CLI reads its endpoint from the active context, not from a fixed path, so a
 * machine with both Docker Desktop and Colima can have `docker ps` pointed somewhere the
 * candidate list would never choose. Following the context is what keeps this extension
 * looking at the same daemon the user is.
 */
export function readCurrentContextName(configJson: string): string | undefined {
  try {
    const parsed = JSON.parse(configJson) as { currentContext?: unknown };
    const name = typeof parsed.currentContext === 'string' ? parsed.currentContext.trim() : '';
    // `default` means "no context", and its endpoint is the platform default anyway.
    return name && name !== 'default' ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Contexts are stored under the hex sha256 of their name. */
export function contextMetaDirectory(contextName: string): string {
  return createHash('sha256').update(contextName).digest('hex');
}

export function endpointFromContextMeta(metaJson: string): DockerEndpoint | undefined {
  try {
    const parsed = JSON.parse(metaJson) as { Endpoints?: { docker?: { Host?: unknown } } };
    const host = parsed.Endpoints?.docker?.Host;
    if (typeof host !== 'string' || host.length === 0) {
      return undefined;
    }
    const endpoint = endpointFromDockerHost(host);
    // A context pointing at a remote daemon is refused for the same reason DOCKER_HOST is.
    return endpoint.kind === 'unavailable' && endpoint.reason !== 'remoteRefused' ? undefined : endpoint;
  } catch {
    return undefined;
  }
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
  env: { DOCKER_HOST?: string; XDG_RUNTIME_DIR?: string } = {},
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
    candidates: SOCKET_CANDIDATES[platform]
      .map((candidate) => expandCandidate(candidate, home, env))
      .filter((candidate): candidate is string => candidate !== undefined),
  };
}
