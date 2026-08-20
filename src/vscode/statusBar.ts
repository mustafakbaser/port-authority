import * as vscode from 'vscode';
import type { PortModel } from '../core/model.js';
import { currentSettings } from './config.js';

/**
 * A one-glance summary of the workspace's ports.
 *
 * It deliberately does not drive its own polling: it consumes whatever the port service
 * already produced. The service polls at a slower cadence when only the status bar is
 * listening, so an always-visible item does not translate into an always-running `lsof`.
 */
export class PortStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('portAuthority.status', vscode.StatusBarAlignment.Right, 45);
    this.item.name = 'Port Authority';
    // VS Code auto-registers `<viewId>.focus` for every contributed view.
    this.item.command = 'portAuthority.ports.focus';
  }

  update(model: PortModel, scannedAt: number | undefined): void {
    if (!currentSettings().statusBarEnabled) {
      this.item.hide();
      return;
    }

    if (scannedAt === undefined) {
      this.item.text = '$(plug) —';
      this.item.tooltip = 'Port Authority has not scanned yet.';
      this.item.backgroundColor = undefined;
      this.item.accessibilityInformation = { label: 'Port Authority: not scanned yet' };
      this.item.show();
      return;
    }

    if (model.expectations.length === 0) {
      this.item.text = `$(plug) ${model.all.length}`;
      this.item.tooltip = new vscode.MarkdownString(
        `**Port Authority**\n\n${model.all.length} listening port(s) on this machine.`,
      );
      this.item.backgroundColor = undefined;
      this.item.accessibilityInformation = {
        label: `Port Authority: ${model.all.length} listening ports`,
      };
      this.item.show();
      return;
    }

    const up = model.expectations.filter((row) => row.status !== 'free').length;
    const foreign = model.expectations.filter((row) => row.status === 'held-by-foreign').length;

    this.item.text = `$(plug) ${up}/${model.expectations.length}`;
    this.item.backgroundColor = foreign > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;

    const lines = model.expectations.map((row) => {
      const marker = row.status === 'free' ? '○' : row.status === 'held-by-foreign' ? '⚠' : '●';
      const holder = row.container
        ? `container ${row.container.name}`
        : `PID ${row.entry?.process?.pid ?? '?'}`;
      const suffix =
        row.status === 'free'
          ? 'not running'
          : row.status === 'held-by-foreign'
            ? `held by another project, ${holder}`
            : holder;
      return `${marker} \`${row.expectation.port}\` ${row.expectation.label.replace(/`/g, '\u02cb')} — ${suffix}`;
    });

    const tooltip = new vscode.MarkdownString(
      [`**Ports this workspace expects**`, '', ...lines].join('\n\n'),
    );
    tooltip.supportThemeIcons = true;
    this.item.tooltip = tooltip;
    this.item.accessibilityInformation = {
      label: `Port Authority: ${up} of ${model.expectations.length} expected ports running`,
    };
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
