import * as vscode from 'vscode';
import { describeError } from '../core/errors.js';
import type { PortExpectation } from '../core/types.js';
import { inferExpectations, type WorkspaceFile } from '../core/workspace/expectations.js';
import { readFolderSettings } from './config.js';
import type { Logger } from './logger.js';

/** Files larger than this are not manifests or env files; reading them would be pointless work. */
const MAX_FILE_BYTES = 512 * 1024;
/** Upper bound on how many manifests a single folder contributes, for monorepo sanity. */
const MAX_PACKAGE_JSON = 100;
const MAX_ENV_FILES = 50;
const EXCLUDE_GLOB =
  '**/{node_modules,.git,dist,build,out,.next,.nuxt,vendor,target,.venv,.vscode-test,.yarn,coverage}/**';
const DEBOUNCE_MS = 500;

export interface ExpectationSnapshot {
  readonly expectations: readonly PortExpectation[];
  /** Set when expectations are intentionally empty, e.g. an untrusted workspace. */
  readonly disabledReason?: string;
  /**
   * Set when the file search hit its cap, so the inference is known to be incomplete.
   * Silent truncation would read as "your monorepo declares no ports".
   */
  readonly truncatedReason?: string;
}

/**
 * Infers the ports the open workspace expects.
 *
 * Everything here is scheduled, never done during activation: a monorepo file search is
 * the kind of work that shows up in "extension slowed down startup" reports.
 *
 * Workspace trust matters for a specific reason — this service reads `.env` files. Their
 * *values* never leave the pure inference functions and are never logged, but reading
 * them at all is something a user should have consented to first.
 */
export class ExpectationService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ExpectationSnapshot>();
  readonly onDidChange = this.emitter.event;

  private snapshotValue: ExpectationSnapshot = { expectations: [] };
  private watchers: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;

  constructor(private readonly logger: Logger) {}

  get snapshot(): ExpectationSnapshot {
    return this.snapshotValue;
  }

  /** Installs file watchers for the current folders. Cheap: no file is read here. */
  start(): void {
    this.installWatchers();
    this.scheduleRefresh();
  }

  scheduleRefresh(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.refresh();
    }, DEBOUNCE_MS);
  }

  onWorkspaceFoldersChanged(): void {
    this.installWatchers();
    this.scheduleRefresh();
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.generation;

    if (!vscode.workspace.isTrusted) {
      this.publish(generation, {
        expectations: [],
        disabledReason:
          'Workspace expectations are disabled in Restricted Mode because they require reading `package.json` and `.env`.',
      });
      return;
    }

    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.publish(generation, { expectations: [] });
      return;
    }

    const all: PortExpectation[] = [];
    const truncated: string[] = [];
    let enabledFolders = 0;

    for (const folder of folders) {
      const settings = readFolderSettings(folder.uri);
      if (!settings.expectationsEnabled) {
        continue;
      }
      enabledFolders += 1;
      try {
        const [packageJsonFiles, envFiles] = await Promise.all([
          this.readMatching(folder, '**/package.json', MAX_PACKAGE_JSON),
          this.readMatching(folder, '**/{.env,.env.*}', MAX_ENV_FILES),
        ]);
        if (packageJsonFiles.length >= MAX_PACKAGE_JSON) {
          truncated.push(`${folder.name}: only the first ${MAX_PACKAGE_JSON} package.json files were read`);
        }
        if (envFiles.length >= MAX_ENV_FILES) {
          truncated.push(`${folder.name}: only the first ${MAX_ENV_FILES} .env files were read`);
        }
        all.push(
          ...inferExpectations({
            folder: folder.uri.fsPath,
            packageJsonFiles,
            envFiles,
            additionalPorts: settings.additionalPorts,
          }),
        );
      } catch (error) {
        this.logger.error(`Failed to infer expected ports for ${folder.name}`, error);
      }
      if (generation !== this.generation) {
        return; // Superseded by a newer refresh.
      }
    }

    all.sort((a, b) => a.port - b.port || a.folder.localeCompare(b.folder));
    this.logger.debug(`expectations: ${all.length} port(s) across ${enabledFolders} folder(s)`);
    for (const message of truncated) {
      this.logger.warn(`Expectation inference truncated — ${message}`);
    }

    this.publish(generation, {
      expectations: all,
      ...(enabledFolders === 0
        ? {
            disabledReason:
              '`portAuthority.workspaceExpectations.enabled` is off, so no expected ports are inferred.',
          }
        : {}),
      ...(truncated.length > 0 ? { truncatedReason: truncated.join('; ') } : {}),
    });
  }

  private publish(generation: number, snapshot: ExpectationSnapshot): void {
    if (generation !== this.generation || this.disposed) {
      return;
    }
    this.snapshotValue = snapshot;
    this.emitter.fire(snapshot);
  }

  private async readMatching(
    folder: vscode.WorkspaceFolder,
    pattern: string,
    maxResults: number,
  ): Promise<WorkspaceFile[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, pattern),
      EXCLUDE_GLOB,
      maxResults,
    );

    const files: WorkspaceFile[] = [];
    for (const uri of uris) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) {
          continue;
        }
        const bytes = await vscode.workspace.fs.readFile(uri);
        files.push({
          relativePath: vscode.workspace.asRelativePath(uri, false),
          content: new TextDecoder('utf-8').decode(bytes),
        });
      } catch (error) {
        // A file can vanish between the search and the read; that is not worth a warning.
        this.logger.trace(`Skipped ${uri.fsPath}: ${describeError(error)}`);
      }
    }
    return files;
  }

  private installWatchers(): void {
    this.disposeWatchers();
    if (!vscode.workspace.isTrusted) {
      return;
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '**/{package.json,.env,.env.*}'),
      );
      const onEvent = (uri: vscode.Uri): void => {
        if (/[\\/](node_modules|\.git)[\\/]/.test(uri.fsPath)) {
          return;
        }
        this.scheduleRefresh();
      };
      watcher.onDidCreate(onEvent);
      watcher.onDidChange(onEvent);
      watcher.onDidDelete(onEvent);
      this.watchers.push(watcher);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.disposeWatchers();
    this.emitter.dispose();
  }
}
