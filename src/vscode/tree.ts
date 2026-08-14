import * as os from 'node:os';
import * as vscode from 'vscode';
import { buildModel, type ExpectationRow, type PortModel, type PortRow } from '../core/model.js';
import type { PortEntry } from '../core/ports/scanner.js';
import type { OwnershipBasis } from '../core/ownership.js';
import type { Ownership, ScanWarning } from '../core/types.js';
import { isCaseInsensitivePlatform, tildify } from '../core/util/paths.js';
import { formatAge } from '../core/util/time.js';
import { currentSettings } from './config.js';
import type { ExpectationService } from './expectationService.js';
import type { PortService } from './portService.js';

export type TreeNode = GroupNode | ExpectationNode | PortNode | MessageNode;

export interface GroupNode {
  readonly kind: 'group';
  readonly id: string;
  readonly label: string;
  readonly children: TreeNode[];
  readonly expanded: boolean;
}

export interface ExpectationNode {
  readonly kind: 'expectation';
  readonly row: ExpectationRow;
}

export interface PortNode {
  readonly kind: 'port';
  readonly row: PortRow;
}

export interface MessageNode {
  readonly kind: 'message';
  readonly id: string;
  readonly label: string;
  readonly severity: 'info' | 'warning';
  readonly tooltip?: string;
}

/** A tree node that carries a port, which is what every context menu command operates on. */
export type ActionableNode = ExpectationNode | PortNode;

export function isActionableNode(node: unknown): node is ActionableNode {
  return (
    typeof node === 'object' &&
    node !== null &&
    ((node as TreeNode).kind === 'port' || (node as TreeNode).kind === 'expectation')
  );
}

/**
 * The listening port behind a node, if there is one. An expectation row has no entry
 * when nothing is listening on that port.
 */
export function entryOf(node: ActionableNode): PortEntry | undefined {
  return node.row.entry;
}

export function portOf(node: ActionableNode): number {
  return node.kind === 'port' ? node.row.entry.port : node.row.expectation.port;
}

const OWNERSHIP_LABEL: Record<Ownership, string> = {
  workspace: 'this workspace',
  foreign: 'FOREIGN',
  unknown: 'owner unknown',
};

export class PortTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly home = os.homedir();

  constructor(
    private readonly ports: PortService,
    private readonly expectations: ExpectationService,
  ) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'group':
        return this.groupItem(node);
      case 'message':
        return this.messageItem(node);
      case 'expectation':
        return this.expectationItem(node);
      case 'port':
        return this.portItem(node);
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) {
      return node.kind === 'group' ? node.children : [];
    }
    return this.rootNodes();
  }

  private rootNodes(): TreeNode[] {
    const nodes: TreeNode[] = [];
    const snapshot = this.ports.snapshot;

    if (snapshot.unavailableReason) {
      return [
        { kind: 'message', id: 'unavailable', label: snapshot.unavailableReason, severity: 'warning' },
      ];
    }

    if (snapshot.scannedAt === undefined) {
      // Without this the empty tree falls through to the welcome view, which would claim
      // no ports exist before anything has actually been scanned.
      return [
        {
          kind: 'message',
          id: 'not-scanned',
          label: 'Scanning for listening ports…',
          severity: 'info',
          tooltip: 'The first scan runs shortly after the panel opens.',
        },
      ];
    }

    for (const warning of snapshot.warnings) {
      nodes.push(warningNode(warning));
    }

    const expectationSnapshot = this.expectations.snapshot;
    if (expectationSnapshot.disabledReason) {
      nodes.push({
        kind: 'message',
        id: 'expectations-disabled',
        label: 'Expected ports are not being inferred',
        severity: 'info',
        tooltip: expectationSnapshot.disabledReason,
      });
    }
    if (expectationSnapshot.truncatedReason) {
      nodes.push({
        kind: 'message',
        id: 'expectations-truncated',
        label: 'Some workspace files were not scanned for expected ports',
        severity: 'info',
        tooltip: expectationSnapshot.truncatedReason,
      });
    }

    const model = this.model();

    if (model.all.length === 0) {
      const filter = describeActiveFilters();
      if (filter) {
        // The welcome view would otherwise claim nothing is listening, when in fact the
        // user's own filters hid everything.
        nodes.push({
          kind: 'message',
          id: 'all-filtered',
          label: 'Every listening port is hidden by your filters',
          severity: 'info',
          tooltip: filter,
        });
      }
    }

    if (model.expectations.length > 0) {
      nodes.push({
        kind: 'group',
        id: 'group:workspace',
        label: `This workspace (${model.expectations.filter((row) => row.status !== 'free').length}/${model.expectations.length} up)`,
        expanded: true,
        children: model.expectations.map((row) => ({ kind: 'expectation', row }) as const),
      });
      nodes.push({
        kind: 'group',
        id: 'group:all',
        label: `All listening ports (${model.all.length})`,
        expanded: false,
        children: model.all.map((row) => ({ kind: 'port', row }) as const),
      });
      return nodes;
    }

    nodes.push(...model.all.map((row) => ({ kind: 'port', row }) as const));
    return nodes;
  }

  model(): PortModel {
    return buildModel(this.ports.snapshot.entries, this.expectations.snapshot.expectations, {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
      caseInsensitive: isCaseInsensitivePlatform(),
    });
  }

  private groupItem(node: GroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = node.id;
    item.contextValue = 'group';
    return item;
  }

  private messageItem(node: MessageNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.id = `message:${node.id}`;
    item.contextValue = 'message';
    item.iconPath = new vscode.ThemeIcon(
      node.severity === 'warning' ? 'warning' : 'info',
      new vscode.ThemeColor(
        node.severity === 'warning' ? 'list.warningForeground' : 'descriptionForeground',
      ),
    );
    item.tooltip = node.tooltip ?? node.label;
    return item;
  }

  private expectationItem(node: ExpectationNode): vscode.TreeItem {
    const { expectation, entry, status, ownership } = node.row;
    const item = new vscode.TreeItem(String(expectation.port), vscode.TreeItemCollapsibleState.None);
    item.id = `expectation:${expectation.folder}:${expectation.port}`;

    const parts: string[] = [expectation.label];
    if (entry?.process) {
      parts.push(describeProcess(entry, this.home));
    }
    if (status === 'free') {
      parts.push('not running');
    } else {
      parts.push(OWNERSHIP_LABEL[ownership]);
      const age = formatAge(entry?.process?.startedAt, Date.now());
      if (age) {
        parts.push(age);
      }
    }
    item.description = parts.join(' · ');
    item.tooltip = this.tooltip(node.row.entry, expectation.port, ownership, node.row.basis, {
      label: expectation.label,
      file: expectation.source.file,
      hint: expectation.source.hint,
    });
    item.iconPath = statusIcon(status);
    item.contextValue = entry?.process?.pid
      ? 'port.listening:expected:killable'
      : entry
        ? 'port.listening:expected'
        : 'port.expected.free';
    item.accessibilityInformation = {
      label: `Port ${expectation.port}, ${expectation.label}, ${
        status === 'free' ? 'not running' : `held by ${OWNERSHIP_LABEL[ownership]}`
      }`,
    };
    return item;
  }

  private portItem(node: PortNode): vscode.TreeItem {
    const { entry, ownership, expectation } = node.row;
    const item = new vscode.TreeItem(String(entry.port), vscode.TreeItemCollapsibleState.None);
    item.id = `port:${entry.port}:${entry.process?.pid ?? 'unknown'}`;

    const parts = [describeProcess(entry, this.home)];
    const age = formatAge(entry.process?.startedAt, Date.now());
    if (age) {
      parts.push(age);
    }
    if (ownership === 'foreign') {
      parts.push(OWNERSHIP_LABEL.foreign);
    }
    item.description = parts.filter(Boolean).join(' · ');
    item.tooltip = this.tooltip(
      entry,
      entry.port,
      ownership,
      node.row.basis,
      expectation ? { label: expectation.label } : undefined,
    );
    item.iconPath = ownershipIcon(ownership, entry.scope);
    item.contextValue = entry.process?.pid ? 'port.listening:killable' : 'port.listening';
    item.accessibilityInformation = {
      label: `Port ${entry.port}, ${entry.process?.name ?? 'unknown process'}, ${OWNERSHIP_LABEL[ownership]}`,
    };
    return item;
  }

  private tooltip(
    entry: PortEntry | undefined,
    port: number,
    ownership: Ownership,
    basis: OwnershipBasis,
    expectation?: { label: string; file?: string; hint?: string },
  ): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.supportThemeIcons = true;
    // Left untrusted on purpose: every value below originates from the workspace or from
    // another process, so command URIs must never be executable from here.
    markdown.isTrusted = false;
    markdown.appendMarkdown(`**Port ${port}**\n\n`);

    if (expectation) {
      markdown.appendMarkdown(`Expected by this workspace as \`${escapeInlineCode(expectation.label)}\``);
      if (expectation.file && expectation.hint) {
        markdown.appendMarkdown(
          ` — from \`${escapeInlineCode(expectation.file)}\` (\`${escapeInlineCode(expectation.hint)}\`)`,
        );
      }
      markdown.appendMarkdown('\n\n');
    }

    if (!entry) {
      markdown.appendMarkdown('_Nothing is listening on this port._');
      return markdown;
    }

    const rows: [string, string | undefined][] = [
      ['Process', entry.process?.name],
      ['PID', entry.process?.pid === undefined ? undefined : String(entry.process.pid)],
      ['User', entry.process?.user],
      ['Started', formatAge(entry.process?.startedAt, Date.now())],
      ['Directory', tildify(entry.process?.cwd, this.home)],
      ['Executable', tildify(entry.process?.executablePath, this.home)],
      ['Bound to', entry.bindings.map((binding) => `${binding.address}:${port}`).join(', ')],
      ['Ownership', describeOwnership(ownership, basis)],
    ];

    for (const [label, value] of rows) {
      if (value) {
        markdown.appendMarkdown(`- **${label}:** ${escapeMarkdown(value)}\n`);
      }
    }

    if (entry.process?.commandLine) {
      const command = truncate(entry.process.commandLine, 400);
      // A command line containing backticks would otherwise close the fence early and
      // let the rest render as markdown; the fence is made longer than any run inside it.
      markdown.appendMarkdown(`\n${fenceFor(command)}\n${command}\n${fenceFor(command)}\n`);
    }
    if (entry.scope === 'any') {
      markdown.appendMarkdown('\n$(warning) Bound to every interface — reachable from your network.\n');
    }
    return markdown;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Describes which settings are currently hiding ports, or undefined when none are. */
function describeActiveFilters(): string | undefined {
  const settings = currentSettings();
  const reasons: string[] = [];
  if (settings.portRange[0] > 1 || settings.portRange[1] < 65535) {
    reasons.push(`portAuthority.portRange is [${settings.portRange[0]}, ${settings.portRange[1]}]`);
  }
  if (settings.ignoredPorts.size > 0) {
    reasons.push(`portAuthority.ignorePorts hides ${settings.ignoredPorts.size} port(s)`);
  }
  if (!settings.showAllInterfaces) {
    reasons.push('portAuthority.showAllInterfaces is off, so LAN-only binds are hidden');
  }
  return reasons.length > 0 ? reasons.join('; ') : undefined;
}

function warningNode(warning: ScanWarning): MessageNode {
  return {
    kind: 'message',
    id: `warning:${warning.code}`,
    label: warning.message,
    severity: warning.code === 'noToolAvailable' ? 'warning' : 'info',
    tooltip: warning.message,
  };
}

function describeProcess(entry: PortEntry, home: string): string {
  const info = entry.process;
  if (!info) {
    return 'unknown process';
  }
  const name = info.name ?? 'process';
  const location = tildify(info.cwd, home);
  return location ? `${name} (${info.pid}) · ${location}` : `${name} (${info.pid})`;
}

function statusIcon(status: ExpectationRow['status']): vscode.ThemeIcon {
  switch (status) {
    case 'held-by-workspace':
      return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
    case 'held-by-foreign':
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    case 'held-by-unknown':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    case 'free':
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
  }
}

function ownershipIcon(ownership: Ownership, scope: PortEntry['scope']): vscode.ThemeIcon {
  if (ownership === 'workspace') {
    return new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'));
  }
  if (scope === 'any') {
    return new vscode.ThemeIcon('radio-tower', new vscode.ThemeColor('charts.yellow'));
  }
  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('descriptionForeground'));
}

function describeOwnership(ownership: Ownership, basis: OwnershipBasis): string {
  if (ownership === 'workspace' && basis === 'commandLine') {
    // Say so: this verdict comes from a path appearing in argv, not from a real cwd.
    return 'this workspace (inferred from the command line)';
  }
  return OWNERSHIP_LABEL[ownership];
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}

/** Neutralises backticks so a value cannot break out of an inline code span. */
function escapeInlineCode(value: string): string {
  return value.replace(/`/g, '\u02cb');
}

/** A fence at least one backtick longer than the longest run inside the content. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
