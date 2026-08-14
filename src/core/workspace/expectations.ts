import type { PortExpectation } from '../types.js';
import { parseDotEnv } from './dotenv.js';

export interface WorkspaceFile {
  /** Path relative to the workspace folder, used verbatim in the UI. */
  readonly relativePath: string;
  readonly content: string;
}

export interface ExpectationInput {
  /** Absolute path of the workspace folder these files belong to. */
  readonly folder: string;
  readonly packageJsonFiles: readonly WorkspaceFile[];
  readonly envFiles: readonly WorkspaceFile[];
  readonly additionalPorts: readonly { port: number; label?: string }[];
}

/**
 * Dev servers whose `-p` flag means "port". `-p` is only honoured for these because it
 * means something else entirely elsewhere (`mkdir -p`, `docker run -p`), and a wrong
 * expected port is exactly the kind of noise that gets an extension uninstalled.
 */
const PORT_FLAG_COMMANDS = [
  'next',
  'vite',
  'nuxt',
  'astro',
  'remix',
  'ng',
  'serve',
  'http-server',
  'webpack',
  'webpack-dev-server',
  'webpack-serve',
  'parcel',
  'react-scripts',
  'vue-cli-service',
  'gatsby',
  'docusaurus',
  'storybook',
  'start-storybook',
  'nodemon',
  'tsx',
  'hugo',
  'jekyll',
  'rails',
  'uvicorn',
  'gunicorn',
  'flask',
  'php',
  'json-server',
  'wrangler',
];

/**
 * Hosts whose port genuinely listens on this machine. A production host's port must not
 * be listed, and neither must a Compose service name like `db` — that port lives inside
 * the container network and would show up as a permanently "closed" expectation.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']);

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * `.env` variants that do not describe what runs on *this* machine.
 *
 * `.env.example` and friends are templates full of placeholder ports; `.env.production`
 * and `.env.staging` describe someone else's infrastructure. Treating either as a local
 * expectation produces rows that are permanently "not running", which trains the user to
 * ignore the panel.
 */
const NON_LOCAL_ENV_SUFFIXES = [
  'example',
  'sample',
  'template',
  'dist',
  'defaults',
  'production',
  'prod',
  'staging',
  'stage',
  'ci',
];

/** Exported for unit tests: which `.env*` files feed port inference. */
export function isLocalEnvFile(relativePath: string): boolean {
  const name = relativePath.replace(/^.*[\\/]/, '');
  if (name === '.env') {
    return true;
  }
  const suffix = /^\.env\.(.+)$/.exec(name)?.[1]?.toLowerCase();
  return suffix === undefined ? false : !NON_LOCAL_ENV_SUFFIXES.includes(suffix);
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT;
}

/** `${PORT}` and `$(cmd)` cannot be resolved statically; a guess here would be a lie. */
function isInterpolated(value: string): boolean {
  return value.includes('${') || value.includes('$(');
}

/**
 * Infers the ports a workspace folder expects from its `package.json` scripts and
 * `.env` files — the two sources named in the v0.1 scope.
 *
 * Every rule is intentionally narrow: it must be possible to point at the exact file
 * and key each expectation came from, which is what `ExpectationSource` carries.
 */
export function inferExpectations(input: ExpectationInput): PortExpectation[] {
  const found: PortExpectation[] = [];

  for (const file of input.packageJsonFiles) {
    found.push(...fromPackageJson(file, input.folder));
  }
  for (const file of input.envFiles) {
    if (isLocalEnvFile(file.relativePath)) {
      found.push(...fromEnvFile(file, input.folder));
    }
  }
  for (const entry of input.additionalPorts) {
    if (isValidPort(entry.port)) {
      found.push({
        port: entry.port,
        label: entry.label?.trim() || `port ${entry.port}`,
        source: { file: 'settings', hint: 'portAuthority.workspaceExpectations.additionalPorts' },
        folder: input.folder,
      });
    }
  }

  return dedupe(found);
}

function fromPackageJson(file: WorkspaceFile, folder: string): PortExpectation[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(file.content);
  } catch {
    return []; // A manifest mid-edit is not an error worth surfacing.
  }
  if (!manifest || typeof manifest !== 'object') {
    return [];
  }
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== 'object') {
    return [];
  }

  const results: PortExpectation[] = [];
  for (const [scriptName, rawScript] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof rawScript !== 'string' || isInterpolated(rawScript)) {
      continue;
    }
    for (const port of extractPortsFromScript(rawScript)) {
      results.push({
        port,
        label: describeScript(scriptName, rawScript),
        source: { file: file.relativePath, hint: `scripts.${scriptName}` },
        folder,
      });
    }
  }
  return results;
}

/** Exported for unit tests: the script-parsing rules are the highest false-positive risk. */
export function extractPortsFromScript(script: string): number[] {
  const ports: number[] = [];
  const add = (raw: string | undefined): void => {
    if (!raw) {
      return;
    }
    const port = Number(raw);
    if (isValidPort(port) && !ports.includes(port)) {
      ports.push(port);
    }
  };

  // `PORT=3000 node server.js` — an environment assignment anywhere in the script.
  for (const match of script.matchAll(/(?:^|[\s;&|])(?:[A-Z][A-Z0-9_]*_)?PORT=(\d{1,5})\b/g)) {
    add(match[1]);
  }

  // `--port 3000`, `--port=3000`, `--inspect-port` excluded by the word boundary.
  for (const match of script.matchAll(/(?:^|\s)--port(?:[=\s]+)(\d{1,5})\b/g)) {
    add(match[1]);
  }

  // `-p 3000` only for commands where `-p` is the port flag.
  if (PORT_FLAG_COMMANDS.some((command) => new RegExp(`(?:^|[\\s;&|/])${escapeRegExp(command)}(?:\\s|$)`).test(script))) {
    for (const match of script.matchAll(/(?:^|\s)-p(?:[=\s]+)(\d{1,5})\b/g)) {
      add(match[1]);
    }
  }

  return ports;
}

function describeScript(scriptName: string, script: string): string {
  const firstToken = script.trim().split(/\s+/).find((token) => !/^[A-Z][A-Z0-9_]*=/.test(token));
  const command = firstToken?.replace(/^.*[\\/]/, '');
  return command && command !== 'npm' && command !== 'yarn' && command !== 'pnpm'
    ? `${scriptName} (${command})`
    : scriptName;
}

function fromEnvFile(file: WorkspaceFile, folder: string): PortExpectation[] {
  const results: PortExpectation[] = [];
  const assignments = parseDotEnv(file.content);
  const byKey = new Map(assignments.map((assignment) => [assignment.key, assignment.value]));

  for (const assignment of assignments) {
    if (!assignment.value || isInterpolated(assignment.value)) {
      continue;
    }

    if (/^PORT$/.test(assignment.key) || /_PORT$/.test(assignment.key)) {
      const port = Number(assignment.value);
      if (isValidPort(port) && hasLocalHostSibling(assignment.key, byKey)) {
        results.push({
          port,
          label: assignment.key,
          source: { file: file.relativePath, hint: assignment.key },
          folder,
        });
      }
      continue;
    }

    if (/_(URL|URI|DSN|ENDPOINT)$/.test(assignment.key)) {
      const port = portFromLocalUrl(assignment.value);
      if (port !== undefined) {
        results.push({
          port,
          label: assignment.key,
          source: { file: file.relativePath, hint: assignment.key },
          folder,
        });
      }
    }
  }

  return results;
}

/**
 * True when the `*_PORT` variable is not paired with a `*_HOST` naming a remote machine.
 *
 * `REDIS_HOST=redis.prod.internal` + `REDIS_PORT=6379` describes a remote service; the
 * `*_URL` rule already rejects that case, and the bare-port rule has to match it or the
 * panel fills up with ports that will never be listening locally.
 */
function hasLocalHostSibling(portKey: string, byKey: ReadonlyMap<string, string>): boolean {
  const prefix = portKey === 'PORT' ? '' : portKey.replace(/_PORT$/, '_');
  for (const suffix of ['HOST', 'HOSTNAME', 'ADDRESS']) {
    const host = byKey.get(`${prefix}${suffix}`)?.trim().toLowerCase();
    if (host !== undefined && host.length > 0 && !isInterpolated(host)) {
      return LOCAL_HOSTS.has(host.replace(/^\[|\]$/g, ''));
    }
  }
  return true; // No host declared: assume local, which is the overwhelmingly common case.
}

/**
 * Extracts an explicit port from a connection string that points at this machine.
 * Remote hosts are skipped on purpose — a production database's port is not something
 * this workspace expects to be listening locally.
 *
 * The value itself (which routinely carries a password) is never returned or logged.
 */
export function portFromLocalUrl(value: string): number | undefined {
  const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/?#\s]+):(\d{1,5})(?:[/?#]|$)/.exec(
    value.trim(),
  );
  if (!match) {
    return undefined;
  }
  const host = match[1].toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    return undefined;
  }
  const port = Number(match[2]);
  return isValidPort(port) ? port : undefined;
}

function dedupe(expectations: readonly PortExpectation[]): PortExpectation[] {
  const byPort = new Map<string, PortExpectation>();
  for (const expectation of expectations) {
    const key = `${expectation.folder}::${expectation.port}`;
    const existing = byPort.get(key);
    // `package.json` beats `.env` beats settings: a script name reads better than a variable.
    if (!existing || rank(expectation) > rank(existing)) {
      byPort.set(key, expectation);
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function rank(expectation: PortExpectation): number {
  if (expectation.source.file === 'settings') {
    return 0;
  }
  return expectation.source.hint.startsWith('scripts.') ? 2 : 1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
