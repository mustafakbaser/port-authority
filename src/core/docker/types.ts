/**
 * Domain types for the container side of a port listing.
 *
 * A published container port is the one case where the process holding the socket tells
 * you nothing useful. Every port Docker publishes is held by the same daemon process, so
 * the tree would otherwise show four rows of `com.docker.backend` with one pid between
 * them, and terminating that pid would take every container on the machine with it.
 */

export interface ContainerPortBinding {
  /** Host address the port is published on, e.g. `0.0.0.0`, `127.0.0.1`, `::`. */
  readonly hostIp: string;
  /** Port on this machine. This is what a listening socket scan sees. */
  readonly hostPort: number;
  /** Port inside the container, which is usually the one the image documents. */
  readonly containerPort: number;
}

/** Compose puts these on every container it starts, and they are what make ownership work. */
export interface ComposeMetadata {
  readonly project: string;
  readonly service: string;
  /** Absolute path of the directory holding the compose file, when Compose recorded it. */
  readonly workingDir?: string;
  readonly configFile?: string;
}

export interface ContainerInfo {
  readonly id: string;
  /** First twelve characters of the id, which is what `docker ps` and every doc shows. */
  readonly shortId: string;
  /** Container name without the leading slash the API returns. */
  readonly name: string;
  readonly image: string;
  /** `running`, `exited`, `paused`, and so on, straight from the daemon. */
  readonly state: string;
  /** Human phrase the daemon composes, e.g. `Up 2 days`. Always English, so it is safe to show. */
  readonly status: string;
  readonly compose?: ComposeMetadata;
  /** Only TCP bindings that are actually published to a host port. */
  readonly bindings: readonly ContainerPortBinding[];
}

export type DockerUnavailableReason =
  /** No socket or pipe was found at any known location. */
  | 'notFound'
  /** Something exists but the daemon did not answer, or answered with an error. */
  | 'unreachable'
  /** `DOCKER_HOST` points somewhere this extension will not go. */
  | 'remoteRefused'
  /** The user turned the integration off. */
  | 'disabled';

export interface DockerSnapshot {
  readonly containers: readonly ContainerInfo[];
  /** Set when there are no containers because Docker could not be consulted at all. */
  readonly unavailable?: { readonly reason: DockerUnavailableReason; readonly message: string };
}
