import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { CancelledError } from '../core/errors.js';
import type { DockerEndpoint } from '../core/docker/endpoint.js';
import {
  contextMetaDirectory,
  endpointFromContextMeta,
  readCurrentContextName,
  resolveDockerEndpoint,
} from '../core/docker/endpoint.js';
import { parseContainers } from '../core/docker/parse.js';
import type { DockerSnapshot } from '../core/docker/types.js';

export interface DockerRequestOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** Cap on a daemon response. A machine with hundreds of containers still fits comfortably. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Talks to the Docker daemon over a local socket or named pipe.
 *
 * No HTTP library and no Docker SDK. The two calls this extension makes are a GET and a
 * POST against a socket that Node can already open, and a dependency here would be a
 * supply chain risk taken on for about forty lines of code.
 *
 * The endpoint is resolved once and remembered. When no daemon is found the failure is
 * remembered too, with a backoff, so a machine without Docker does not pay for a
 * filesystem probe on every port scan.
 */
export interface DockerClientOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: { DOCKER_HOST?: string; XDG_RUNTIME_DIR?: string };
  readonly home?: string;
  readonly now?: () => number;
  /** How long to wait before looking for a daemon again after failing to find one. */
  readonly backoffMs?: number;
  /** A liveness probe should fail fast; the daemon answers `/_ping` in a millisecond. */
  readonly probeTimeoutMs?: number;
  /**
   * Where to look for a daemon, in order. Injected the way the port scanners take their
   * command runner, so discovery can be exercised against a socket a test controls rather
   * than whatever happens to exist on the machine running the suite.
   */
  readonly discover?: () => Promise<readonly DockerEndpoint[]>;
}

export class DockerClient {
  private endpoint: DockerEndpoint | undefined;
  private lastFailure: Extract<DockerEndpoint, { kind: 'unavailable' }> | undefined;
  private nextProbeAt = 0;

  private readonly platform: NodeJS.Platform;
  private readonly env: { DOCKER_HOST?: string; XDG_RUNTIME_DIR?: string };
  private readonly home: string | undefined;
  private readonly now: () => number;
  private readonly backoffMs: number;
  private readonly probeTimeoutMs: number;
  private readonly discover: () => Promise<readonly DockerEndpoint[]>;

  constructor(options: DockerClientOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.home = options.home ?? process.env.HOME ?? process.env.USERPROFILE;
    this.now = options.now ?? Date.now;
    this.backoffMs = options.backoffMs ?? 60_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1500;
    this.discover = options.discover ?? (() => this.discoverLocally());
  }

  /** Forgets a cached failure so the next call probes again, e.g. after Docker was started. */
  reset(): void {
    this.endpoint = undefined;
    this.lastFailure = undefined;
    this.nextProbeAt = 0;
  }

  async listContainers(options: DockerRequestOptions): Promise<DockerSnapshot> {
    const endpoint = await this.resolve();
    if (endpoint.kind === 'unavailable') {
      return { containers: [], unavailable: { reason: endpoint.reason, message: endpoint.message } };
    }

    try {
      const body = await this.request(endpoint, 'GET', '/containers/json', options);
      return { containers: parseContainers(JSON.parse(body)) };
    } catch (error) {
      if (error instanceof CancelledError) {
        throw error;
      }
      // A daemon that stops answering invalidates the cached endpoint: Docker Desktop
      // moves its socket between restarts often enough that pinning to a dead path would
      // keep the integration broken until the window is reloaded.
      this.endpoint = undefined;
      this.lastFailure = undefined;
      return {
        containers: [],
        unavailable: {
          reason: 'unreachable',
          message: `The Docker daemon did not answer: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
    }
  }

  /**
   * Asks the daemon to stop a container, giving it `gracePeriodSeconds` to shut down
   * before the daemon escalates. This is the container equivalent of SIGTERM, and unlike
   * killing a process it can be undone with `docker start`.
   */
  async stopContainer(
    id: string,
    gracePeriodSeconds: number,
    options: DockerRequestOptions,
  ): Promise<void> {
    const endpoint = await this.resolve();
    if (endpoint.kind === 'unavailable') {
      throw new Error(endpoint.message);
    }
    const seconds = Math.max(0, Math.round(gracePeriodSeconds));
    await this.request(endpoint, 'POST', `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`, options);
  }

  private async resolve(): Promise<DockerEndpoint> {
    if (this.endpoint) {
      return this.endpoint;
    }
    if (this.now() < this.nextProbeAt) {
      // Report what actually failed. Synthesising "no socket found" here told a user who
      // is simply not in the docker group the wrong thing for 59 seconds out of every 60.
      return this.lastFailure ?? { kind: 'unavailable', reason: 'notFound', message: 'No Docker socket was found.' };
    }

    const options = await this.discover();

    // A decision, not a transient failure: cached and never re-probed.
    const decided = options.find(
      (option) => option.kind === 'unavailable' && option.reason === 'remoteRefused',
    );
    if (decided) {
      this.endpoint = decided;
      return decided;
    }
    const explicitFailure = options.length === 1 && options[0].kind === 'unavailable' ? options[0] : undefined;
    if (explicitFailure) {
      this.endpoint = explicitFailure;
      return explicitFailure;
    }

    let lastError: string | undefined;
    for (const option of options) {
      if (option.kind === 'unavailable') {
        continue;
      }
      try {
        await this.request(option, 'GET', '/_ping', { timeoutMs: this.probeTimeoutMs });
        this.endpoint = option;
        this.lastFailure = undefined;
        return option;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    this.lastFailure = {
      kind: 'unavailable',
      reason: lastError ? 'unreachable' : 'notFound',
      message: lastError ? describeProbeFailure(lastError) : 'No Docker socket was found.',
    };
    this.nextProbeAt = this.now() + this.backoffMs;
    return this.lastFailure;
  }

  /**
   * The real discovery order: an explicit DOCKER_HOST, then the active docker context,
   * then the per-platform candidate list.
   */
  private async discoverLocally(): Promise<readonly DockerEndpoint[]> {
    const { endpoint, candidates } = resolveDockerEndpoint(this.platform, this.env, this.home);

    // An explicit DOCKER_HOST is authoritative. If it is unusable, say so rather than
    // quietly falling through to a different daemon than the user asked for.
    if (this.env.DOCKER_HOST) {
      return [endpoint];
    }
    if (endpoint.kind !== 'unavailable') {
      return [endpoint];
    }
    return [...(await this.contextEndpoint()), ...candidates.map((path) => ({ kind: 'socket', path }) as const)];
  }

  /**
   * The endpoint the Docker CLI itself would use.
   *
   * Without this, a machine running both Docker Desktop and Colima can have the extension
   * listing containers from one daemon while `docker ps` shows the other, which would make
   * Stop Container act on something the user is not looking at.
   */
  private async contextEndpoint(): Promise<DockerEndpoint[]> {
    if (!this.home) {
      return [];
    }
    try {
      const name = readCurrentContextName(await fs.readFile(`${this.home}/.docker/config.json`, 'utf8'));
      if (!name) {
        return [];
      }
      const meta = await fs.readFile(
        `${this.home}/.docker/contexts/meta/${contextMetaDirectory(name)}/meta.json`,
        'utf8',
      );
      const endpoint = endpointFromContextMeta(meta);
      return endpoint ? [endpoint] : [];
    } catch {
      // No config, no context, or an unreadable one. The candidate list still applies.
      return [];
    }
  }

  private request(
    endpoint: Extract<DockerEndpoint, { kind: 'socket' | 'pipe' }>,
    method: 'GET' | 'POST',
    path: string,
    options: DockerRequestOptions,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new CancelledError());
        return;
      }

      const request = http.request(
        {
          socketPath: endpoint.path,
          path,
          method,
          // The daemon ignores Host, but Node requires one for a socket request.
          headers: { Host: 'docker', Accept: 'application/json' },
          timeout: options.timeoutMs,
        },
        (response) => {
          let body = '';
          let bytes = 0;
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            bytes += Buffer.byteLength(chunk, 'utf8');
            if (bytes > MAX_RESPONSE_BYTES) {
              request.destroy(new Error('The Docker daemon returned more data than expected.'));
              return;
            }
            body += chunk;
          });
          response.on('end', () => {
            const status = response.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(body);
            } else {
              reject(new Error(`Docker replied ${status}: ${describeDaemonError(body)}`));
            }
          });
        },
      );

      const onAbort = (): void => {
        request.destroy();
        reject(new CancelledError());
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      request.on('timeout', () => request.destroy(new Error(`Timed out after ${options.timeoutMs}ms`)));
      request.on('error', reject);
      request.on('close', () => options.signal?.removeEventListener('abort', onAbort));
      request.end();
    });
  }
}

/** The daemon reports errors as `{"message": "..."}`; anything else is passed through trimmed. */
function describeDaemonError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    if (typeof parsed.message === 'string' && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // Not JSON.
  }
  return body.trim().slice(0, 200) || 'no details';
}

/**
 * Turns a connect error into something a user can act on. `EACCES` on the socket is the
 * single most common Docker problem on Linux and the raw errno says nothing about the fix.
 */
function describeProbeFailure(message: string): string {
  if (message.includes('EACCES')) {
    return 'Docker is running but its socket is not readable by this user. On Linux, adding yourself to the "docker" group and logging in again usually fixes it.';
  }
  if (message.includes('ECONNREFUSED')) {
    return 'A Docker socket exists but nothing is listening on it. The daemon is probably stopped.';
  }
  return `The Docker daemon could not be reached: ${message}`;
}
