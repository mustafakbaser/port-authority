import type { ComposeMetadata, ContainerInfo, ContainerPortBinding } from './types.js';

const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_SERVICE = 'com.docker.compose.service';
const COMPOSE_WORKING_DIR = 'com.docker.compose.project.working_dir';
const COMPOSE_CONFIG_FILES = 'com.docker.compose.project.config_files';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asPort(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined;
}

/**
 * Parses the daemon's `GET /containers/json` response.
 *
 * Written against a recorded response from a real machine rather than the reference docs,
 * which is why `IP` is treated as optional and both the IPv4 and IPv6 rows of a single
 * published port are expected: Docker emits one entry per address family for the same
 * mapping, so `-p 8098:80` arrives as two objects.
 *
 * Anything malformed is skipped rather than thrown. A partial container list still makes
 * the tree more useful than a daemon-shaped hole in it.
 */
export function parseContainers(payload: unknown): ContainerInfo[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  const containers: ContainerInfo[] = [];

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as Record<string, unknown>;

    const id = asString(entry.Id);
    if (!id) {
      continue;
    }

    const names = Array.isArray(entry.Names) ? entry.Names.filter((n): n is string => typeof n === 'string') : [];
    const name = names[0]?.replace(/^\//, '') ?? id.slice(0, 12);
    const labels = (entry.Labels && typeof entry.Labels === 'object' ? entry.Labels : {}) as Record<string, unknown>;

    containers.push({
      id,
      shortId: id.slice(0, 12),
      name,
      image: asString(entry.Image) ?? 'unknown image',
      state: asString(entry.State) ?? 'unknown',
      status: asString(entry.Status) ?? '',
      ...(readCompose(labels) ? { compose: readCompose(labels)! } : {}),
      bindings: readBindings(entry.Ports),
    });
  }

  return containers;
}

function readCompose(labels: Record<string, unknown>): ComposeMetadata | undefined {
  const project = asString(labels[COMPOSE_PROJECT]);
  const service = asString(labels[COMPOSE_SERVICE]);
  if (!project || !service) {
    return undefined;
  }
  const workingDir = asString(labels[COMPOSE_WORKING_DIR]);
  // `config_files` can hold several paths separated by commas; the first is the one that
  // names the project directory.
  const configFile = asString(labels[COMPOSE_CONFIG_FILES])?.split(',')[0]?.trim();
  return {
    project,
    service,
    ...(workingDir ? { workingDir } : {}),
    ...(configFile ? { configFile } : {}),
  };
}

function readBindings(value: unknown): ContainerPortBinding[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const bindings: ContainerPortBinding[] = [];
  const seen = new Set<string>();

  for (const raw of value) {
    if (!raw || typeof raw !== 'object') {
      continue;
    }
    const entry = raw as Record<string, unknown>;

    // Only TCP, and only ports actually published to the host. An unpublished port is
    // reachable inside the container network and never appears in a host socket scan.
    if (asString(entry.Type) !== 'tcp') {
      continue;
    }
    const hostPort = asPort(entry.PublicPort);
    const containerPort = asPort(entry.PrivatePort);
    if (hostPort === undefined || containerPort === undefined) {
      continue;
    }

    const hostIp = asString(entry.IP) ?? '0.0.0.0';
    const key = `${hostIp}:${hostPort}->${containerPort}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bindings.push({ hostIp, hostPort, containerPort });
  }

  return bindings;
}
