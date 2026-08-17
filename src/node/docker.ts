import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import { CancelledError } from '../core/errors.js';
import type { DockerEndpoint } from '../core/docker/endpoint.js';
import { resolveDockerEndpoint } from '../core/docker/endpoint.js';
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
export class DockerClient {
  private endpoint: DockerEndpoint | undefined;
  private nextProbeAt = 0;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly env: { DOCKER_HOST?: string } = process.env,
    private readonly home: string | undefined = process.env.HOME ?? process.env.USERPROFILE,
    private readonly now: () => number = Date.now,
    /** How long to wait before looking for a daemon again after failing to find one. */
    private readonly backoffMs = 60_000,
  ) {}

  /** Forgets a cached failure so the next call probes again, e.g. after Docker was started. */
  reset(): void {
    this.endpoint = undefined;
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
      this.nextProbeAt = this.now() + this.backoffMs;
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
      return { kind: 'unavailable', reason: 'notFound', message: 'No Docker socket was found.' };
    }

    const { endpoint, candidates } = resolveDockerEndpoint(this.platform, this.env, this.home);
    if (endpoint.kind !== 'unavailable') {
      this.endpoint = endpoint;
      return endpoint;
    }
    if (endpoint.reason === 'remoteRefused') {
      // Not a transient failure, and not worth re-checking on a timer.
      this.endpoint = endpoint;
      return endpoint;
    }

    for (const candidate of candidates) {
      if (await isSocket(candidate)) {
        this.endpoint = { kind: 'socket', path: candidate };
        return this.endpoint;
      }
    }

    this.nextProbeAt = this.now() + this.backoffMs;
    return endpoint;
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

async function isSocket(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isSocket();
  } catch {
    return false;
  }
}
