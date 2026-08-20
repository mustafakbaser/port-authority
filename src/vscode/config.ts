import * as vscode from 'vscode';

export const CONFIG_SECTION = 'portAuthority';

export interface AdditionalPort {
  readonly port: number;
  readonly label?: string;
}

export interface Settings {
  readonly autoRefreshEnabled: boolean;
  readonly autoRefreshIntervalMs: number;
  readonly showAllInterfaces: boolean;
  readonly portRange: readonly [number, number];
  readonly ignoredPorts: ReadonlySet<number>;
  readonly statusBarEnabled: boolean;
  readonly eaddrinuseEnabled: boolean;
  readonly watchDebugConsole: boolean;
  readonly eaddrinuseCooldownMs: number;
  readonly scanTimeoutMs: number;
  readonly dockerEnabled: boolean;
  readonly dockerTimeoutMs: number;
}

export interface FolderSettings {
  readonly expectationsEnabled: boolean;
  readonly additionalPorts: readonly AdditionalPort[];
  readonly confirmation: 'always' | 'unexpectedOnly';
  readonly gracePeriodMs: number;
  readonly protectedProcessNames: readonly string[];
}

function toPortSet(values: unknown): ReadonlySet<number> {
  if (!Array.isArray(values)) {
    return new Set();
  }
  return new Set(
    values.filter(
      (value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535,
    ),
  );
}

/**
 * Reads settings defensively.
 *
 * Values arrive from `settings.json`, which a user can edit into any shape, so every
 * field is validated here rather than trusted at the point of use — an out-of-range
 * port range would silently hide every port and look like a broken extension.
 */
export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawRange = config.get<number[]>('portRange', [1, 65535]);
  const min = Number.isInteger(rawRange?.[0]) ? Math.min(Math.max(rawRange[0], 1), 65535) : 1;
  const max = Number.isInteger(rawRange?.[1]) ? Math.min(Math.max(rawRange[1], 1), 65535) : 65535;

  return {
    autoRefreshEnabled: config.get<boolean>('autoRefresh.enabled', true),
    autoRefreshIntervalMs: clamp(config.get<number>('autoRefresh.intervalSeconds', 10), 2, 600) * 1000,
    showAllInterfaces: config.get<boolean>('showAllInterfaces', false),
    portRange: min <= max ? [min, max] : [1, 65535],
    ignoredPorts: toPortSet(config.get('ignorePorts', [])),
    statusBarEnabled: config.get<boolean>('statusBar.enabled', true),
    eaddrinuseEnabled: config.get<boolean>('eaddrinuse.enabled', true),
    watchDebugConsole: config.get<boolean>('eaddrinuse.watchDebugConsole', true),
    eaddrinuseCooldownMs: clamp(config.get<number>('eaddrinuse.cooldownSeconds', 60), 5, 3600) * 1000,
    scanTimeoutMs: clamp(config.get<number>('scan.timeoutMs', 5000), 500, 60000),
    dockerEnabled: config.get<boolean>('docker.enabled', true),
    dockerTimeoutMs: clamp(config.get<number>('docker.timeoutMs', 3000), 250, 30000),
  };
}

let cachedSettings: Settings | undefined;

/**
 * Cached window-level settings.
 *
 * `readSettings` is not free — it is a configuration lookup plus ten typed reads — and
 * the conflict watcher consults it for *every* debug adapter message, which during a
 * stepping session means thousands of times a second. The cache is invalidated from the
 * single `onDidChangeConfiguration` handler in `extension.ts`.
 */
export function currentSettings(): Settings {
  cachedSettings ??= readSettings();
  return cachedSettings;
}

export function invalidateSettingsCache(): void {
  cachedSettings = undefined;
}

export function readFolderSettings(scope: vscode.Uri | undefined): FolderSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, scope ?? null);
  const rawAdditional = config.get<unknown[]>('workspaceExpectations.additionalPorts', []);

  return {
    expectationsEnabled: config.get<boolean>('workspaceExpectations.enabled', true),
    additionalPorts: Array.isArray(rawAdditional)
      ? rawAdditional.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') {
            return [];
          }
          const port = (entry as { port?: unknown }).port;
          const label = (entry as { label?: unknown }).label;
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            return [];
          }
          return [{ port, ...(typeof label === 'string' ? { label } : {}) }];
        })
      : [],
    confirmation: config.get<'always' | 'unexpectedOnly'>('terminate.confirmation', 'always') === 'unexpectedOnly'
      ? 'unexpectedOnly'
      : 'always',
    gracePeriodMs: clamp(config.get<number>('terminate.gracePeriodMs', 3000), 0, 30000),
    protectedProcessNames: (config.get<unknown[]>('protectedProcessNames', []) ?? []).filter(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    ),
  };
}

export interface TerminateSettings {
  readonly confirmation: 'always' | 'unexpectedOnly';
  readonly gracePeriodMs: number;
  readonly protectedProcessNames: readonly string[];
}

/**
 * Resolves the terminate settings for the whole window.
 *
 * A process is not owned by one workspace folder, so a multi-root window has to pick a
 * single answer. The safest value wins in every case: any folder asking for a
 * confirmation makes it mandatory, the longest grace period is used, and protected
 * names are unioned. Picking "the first folder" would let an unrelated folder's settings
 * weaken a destructive action.
 */
export function readTerminateSettings(): TerminateSettings {
  const folders = vscode.workspace.workspaceFolders;
  const scopes: (vscode.Uri | undefined)[] = folders?.length ? folders.map((folder) => folder.uri) : [undefined];
  const perFolder = scopes.map((scope) => readFolderSettings(scope));

  return {
    confirmation: perFolder.some((settings) => settings.confirmation === 'always') ? 'always' : 'unexpectedOnly',
    gracePeriodMs: Math.max(...perFolder.map((settings) => settings.gracePeriodMs)),
    protectedProcessNames: [...new Set(perFolder.flatMap((settings) => settings.protectedProcessNames))],
  };
}

function clamp(value: number | undefined, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

/** True when a configuration change event touches anything this extension reads. */
export function affectsUs(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(CONFIG_SECTION);
}
