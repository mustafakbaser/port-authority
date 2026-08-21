import * as vscode from 'vscode';
import { isSupportedPlatform } from './core/ports/scanner.js';
import type { SupportedPlatform } from './core/types.js';
import { registerCommands } from './vscode/commands.js';
import { affectsUs, currentSettings, invalidateSettingsCache } from './vscode/config.js';
import { ConflictWatcher } from './vscode/conflictWatcher.js';
import { DockerService } from './vscode/dockerService.js';
import { ExpectationService } from './vscode/expectationService.js';
import { IgnoredPortStore } from './vscode/ignoredPorts.js';
import { Logger } from './vscode/logger.js';
import { PortService } from './vscode/portService.js';
import { PortStatusBar } from './vscode/statusBar.js';
import { TerminateFlow } from './vscode/terminateFlow.js';
import { StopContainerFlow } from './vscode/stopContainerFlow.js';
import { PortTreeDataProvider } from './vscode/tree.js';

/** Status bar polling is deliberately lazier than panel polling: it is glanceable, not live. */
const STATUS_BAR_MIN_INTERVAL_MS = 30_000;
/**
 * Delay before the first background scan, so activation never competes with editor
 * startup. The extension now activates on startup in every window, so this is also what
 * keeps five open windows from firing five `lsof` calls at once.
 */
const FIRST_SCAN_DELAY_MS = 4_000;

/**
 * Read-only accessors used by the integration tests.
 *
 * This is the extension's entire public API surface. It exposes no mutation and no
 * destructive path — a test must go through the same commands a user does.
 */
export interface PortAuthorityApi {
  getExpectedPortsForTests(): number[];
  getListeningPortsForTests(): number[];
  /** Host port to the container publishing it, as the tree would show it. */
  getContainerPortsForTests(): { port: number; container: string; image: string }[];
  /** Whether the daemon answered, so CI can prove the transport works on each platform. */
  getDockerStatusForTests(): { reachable: boolean; reason?: string; containers: number };
}

/**
 * Activation does no scanning, no file reading and no parsing.
 *
 * Everything expensive is either scheduled (the first scan, the expectation inference)
 * or demand-driven (a scan runs when the panel becomes visible, when a command asks for
 * it, or when a port conflict needs verifying).
 */
export function activate(context: vscode.ExtensionContext): PortAuthorityApi {
  const logger = Logger.create();
  context.subscriptions.push(logger);

  const platform = process.platform;
  if (!isSupportedPlatform(platform)) {
    logger.warn(`Unsupported platform "${platform}"; Port Authority will stay idle.`);
  }

  const ports = new PortService(logger, platform);
  const expectations = new ExpectationService(logger);
  const docker = new DockerService(logger);
  const ignored = new IgnoredPortStore(context.workspaceState);
  const tree = new PortTreeDataProvider(ports, expectations, docker);
  const statusBar = new PortStatusBar();
  const stopContainerFlow = new StopContainerFlow(docker, ports, logger);
  const terminateFlow = new TerminateFlow(
    ports,
    logger,
    (isSupportedPlatform(platform) ? platform : 'linux') as SupportedPlatform,
  );

  context.subscriptions.push(ports, expectations, docker, tree, statusBar);

  const view = vscode.window.createTreeView('portAuthority.ports', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  const syncUi = (): void => {
    tree.refresh();
    statusBar.update(tree.model(), ports.snapshot.scannedAt);
  };

  context.subscriptions.push(
    // A port scan is the moment the container list matters, so the two stay in step
    // without Docker ever being able to hold up the scan itself.
    ports.onDidChange(() => {
      syncUi();
      void docker.refresh();
    }),
    expectations.onDidChange(syncUi),
    docker.onDidChange(syncUi),
  );

  // Polling is driven by who is actually looking at the data.
  const applyPollers = (): void => {
    const settings = currentSettings();
    ports.setPoller('view', view.visible ? settings.autoRefreshIntervalMs : undefined);
    ports.setPoller(
      'statusBar',
      settings.statusBarEnabled ? Math.max(STATUS_BAR_MIN_INTERVAL_MS, settings.autoRefreshIntervalMs) : undefined,
    );
  };

  context.subscriptions.push(
    view.onDidChangeVisibility((event) => {
      applyPollers();
      if (event.visible) {
        void ports.refresh('view-visible');
      }
    }),
    vscode.window.onDidChangeWindowState(() => ports.reschedule()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsUs(event)) {
        return;
      }
      invalidateSettingsCache();
      docker.reset();
      applyPollers();
      void expectations.refresh();
      void docker.refresh(true);
      void ports.refresh('config-changed', true);
      syncUi();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => expectations.onWorkspaceFoldersChanged()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      logger.info('Workspace trust granted; enabling workspace expectations.');
      expectations.start();
    }),
    ...registerCommands({ ports, tree, terminateFlow, stopContainerFlow, docker, ignored, logger }),
  );

  // The watcher is always installed; it reads `eaddrinuse.enabled` on every event so the
  // setting can be toggled without a reload. Its listeners cost nothing while disabled.
  const watcher = new ConflictWatcher(ports, terminateFlow, stopContainerFlow, docker, ignored, logger);
  watcher.start();
  context.subscriptions.push(watcher);

  expectations.start();
  applyPollers();
  syncUi();

  const firstScan = setTimeout(() => {
    // Only when something will display the result, and only when this window is the one
    // the user is actually looking at.
    if ((view.visible || currentSettings().statusBarEnabled) && vscode.window.state.focused) {
      void ports.refresh('activation');
    }
  }, FIRST_SCAN_DELAY_MS);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(firstScan)));

  logger.info(`Port Authority activated on ${platform}.`);

  return {
    getExpectedPortsForTests: () =>
      expectations.snapshot.expectations.map((expectation) => expectation.port),
    getListeningPortsForTests: () => ports.snapshot.entries.map((entry) => entry.port),
    getContainerPortsForTests: () =>
      tree
        .model()
        .all.filter((row) => row.container)
        .map((row) => ({
          port: row.entry.port,
          container: row.container!.name,
          image: row.container!.image,
        })),
    getDockerStatusForTests: () => {
      const snapshot = docker.snapshot;
      return {
        reachable: snapshot.unavailable === undefined,
        ...(snapshot.unavailable ? { reason: snapshot.unavailable.message } : {}),
        containers: snapshot.containers.length,
      };
    },
  };
}

export function deactivate(): void {
  // Everything is registered in `context.subscriptions`; VS Code disposes it for us.
  // No state needs flushing: the only persisted value is written eagerly on change.
}
