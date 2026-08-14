import * as vscode from 'vscode';
import { entryOf, isActionableNode, portOf, type PortTreeDataProvider } from './tree.js';
import type { IgnoredPortStore } from './ignoredPorts.js';
import type { Logger } from './logger.js';
import type { PortService } from './portService.js';
import type { TerminateFlow } from './terminateFlow.js';

export interface CommandDependencies {
  readonly ports: PortService;
  readonly tree: PortTreeDataProvider;
  readonly terminateFlow: TerminateFlow;
  readonly ignored: IgnoredPortStore;
  readonly logger: Logger;
}

export function registerCommands(deps: CommandDependencies): vscode.Disposable[] {
  const { ports, tree, terminateFlow, ignored, logger } = deps;

  const register = (id: string, handler: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, handler);

  return [
    register('portAuthority.refresh', () => ports.refresh('command', true)),

    register('portAuthority.showLog', () => logger.show()),

    register('portAuthority.terminate', async (node: unknown) => {
      if (!isActionableNode(node)) {
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
      const picked = await vscode.window.showQuickPick(
        killable.map((entry) => ({
          label: `$(plug) ${entry.port}`,
          description: `${entry.process?.name ?? 'process'} (PID ${entry.process?.pid})`,
          detail: entry.process?.cwd ?? entry.process?.executablePath,
          entry,
        })),
        { placeHolder: 'Select the port whose process should be terminated', matchOnDescription: true },
      );
      if (!picked) {
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
