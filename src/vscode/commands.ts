import * as vscode from 'vscode';
import { containerOf, entryOf, isActionableNode, portOf, type PortTreeDataProvider } from './tree.js';
import type { IgnoredPortStore } from './ignoredPorts.js';
import type { Logger } from './logger.js';
import type { PortService } from './portService.js';
import type { DockerService } from './dockerService.js';
import type { StopContainerFlow } from './stopContainerFlow.js';
import type { TerminateFlow } from './terminateFlow.js';

export interface CommandDependencies {
  readonly ports: PortService;
  readonly tree: PortTreeDataProvider;
  readonly terminateFlow: TerminateFlow;
  readonly stopContainerFlow: StopContainerFlow;
  readonly docker: DockerService;
  readonly ignored: IgnoredPortStore;
  readonly logger: Logger;
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { ports, tree, terminateFlow, stopContainerFlow, ignored, logger } = deps;

  const register = (id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, handler);

  return [
    register('portAuthority.refresh', async () => {
      // Refresh is what a user presses when something looks wrong, so it also forgets a
      // cached Docker failure. Without this, starting Docker meant waiting out the backoff
      // or reloading the window, and the button appeared to do nothing.
      deps.docker.reset();
      await Promise.all([ports.refresh('command', true), deps.docker.refresh(true)]);
    }),

    register('portAuthority.showLog', () => logger.show()),

    register('portAuthority.stopContainer', async (node: unknown) => {
      if (!isActionableNode(node)) {
        return;
      }
      const container = containerOf(node);
      if (!container) {
        void vscode.window.showWarningMessage('This port is not published by a container.');
        return;
      }
      await stopContainerFlow.run({ port: portOf(node), containerId: container.id });
    }),

    register('portAuthority.terminate', async (node: unknown) => {
      if (!isActionableNode(node)) {
        return;
      }
      const container = containerOf(node);
      if (container) {
        // The process behind a container port is the Docker daemon, which holds every
        // other published port too. Signalling it is never what the user meant.
        void vscode.window.showWarningMessage(
          `Port ${portOf(node)} is published by the container "${container.name}". Use "Stop Container" instead; terminating the process would stop the Docker daemon and every container with it.`,
        );
        return;
      }
      const entry = entryOf(node);
      await terminateFlow.run({
        port: portOf(node),
        ...(entry?.process?.pid !== undefined ? { expectedPid: entry.process.pid } : {}),
        // `basis === 'cwd'` is required: the command-line heuristic is a display
        // convenience and must never be strong enough to skip the confirmation modal.
        isExpectedWorkspacePort:
          node.kind === 'expectation' && node.row.ownership === 'workspace' && node.row.basis === 'cwd',
        source: 'tree',
      });
    }),

    register('portAuthority.terminateByPort', async () => {
      await ports.refresh('quickPick', true);
      const killable = ports.snapshot.entries.filter((entry) => entry.process?.pid !== undefined);
      if (killable.length === 0) {
        void vscode.window.showInformationMessage('No listening port with an identifiable process was found.');
        return;
      }
      // The tree model already knows which ports belong to containers, and picking one
      // here has to take the same route as picking it in the tree.
      const rows = tree.model().all;
      const picked = await vscode.window.showQuickPick(
        killable.map((entry) => {
          const container = rows.find((row) => row.entry === entry)?.container;
          return {
            label: `$(${container ? 'package' : 'plug'}) ${entry.port}`,
            description: container
              ? `container ${container.name} · ${container.image}`
              : `${entry.process?.name ?? 'process'} (PID ${entry.process?.pid})`,
            detail: container?.compose?.workingDir ?? entry.process?.cwd ?? entry.process?.executablePath,
            entry,
            container,
          };
        }),
        { placeHolder: 'Select the port to free', matchOnDescription: true },
      );
      if (!picked) {
        return;
      }
      if (picked.container) {
        await stopContainerFlow.run({ port: picked.entry.port, containerId: picked.container.id });
        return;
      }
      await terminateFlow.run({
        port: picked.entry.port,
        ...(picked.entry.process?.pid !== undefined ? { expectedPid: picked.entry.process.pid } : {}),
        source: 'palette',
      });
    }),

    register('portAuthority.openInBrowser', async (node: unknown) => {
      if (!isActionableNode(node)) {
        return;
      }
      const port = portOf(node);
      await vscode.env.openExternal(vscode.Uri.parse(`http://localhost:${port}`));
    }),

    register('portAuthority.copyPid', async (node: unknown) => {
      const pid = isActionableNode(node) ? entryOf(node)?.process?.pid : undefined;
      if (pid === undefined) {
        void vscode.window.showWarningMessage('This port has no identifiable process.');
        return;
      }
      await vscode.env.clipboard.writeText(String(pid));
    }),

    register('portAuthority.copyCommandLine', async (node: unknown) => {
      const commandLine = isActionableNode(node) ? entryOf(node)?.process?.commandLine : undefined;
      if (!commandLine) {
        void vscode.window.showWarningMessage('The command line for this process is not available.');
        return;
      }
      await vscode.env.clipboard.writeText(commandLine);
    }),

    register('portAuthority.ignorePort', async (node: unknown) => {
      if (!isActionableNode(node)) {
        return;
      }
      await ignored.add(portOf(node));
      tree.refresh();
      void vscode.window.showInformationMessage(
        `Port ${portOf(node)} will no longer raise conflict notifications in this workspace.`,
      );
    }),

    register('portAuthority.clearIgnoredPorts', async () => {
      await ignored.clear();
      tree.refresh();
    }),
  ];
}
