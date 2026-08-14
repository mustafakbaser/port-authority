import * as vscode from 'vscode';

const STORAGE_KEY = 'portAuthority.ignoredPorts';
const CONTEXT_KEY = 'portAuthority.hasIgnoredPorts';

/**
 * Ports the user dismissed from conflict notifications.
 *
 * Stored in workspace state rather than settings: this is a per-project, reversible
 * "not now", not a configuration choice worth committing to a repository. The
 * `Clear Ignored Ports` command is always available, so the state can never become an
 * invisible reason for the extension staying quiet.
 */
export class IgnoredPortStore {
  private ports: Set<number>;

  constructor(private readonly state: vscode.Memento) {
    const stored = state.get<number[]>(STORAGE_KEY, []);
    this.ports = new Set(
      (Array.isArray(stored) ? stored : []).filter(
        (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535,
      ),
    );
    void this.syncContext();
  }

  has(port: number): boolean {
    return this.ports.has(port);
  }

  get all(): readonly number[] {
    return [...this.ports].sort((a, b) => a - b);
  }

  async add(port: number): Promise<void> {
    if (this.ports.has(port)) {
      return;
    }
    this.ports.add(port);
    await this.persist();
  }

  async clear(): Promise<void> {
    if (this.ports.size === 0) {
      return;
    }
    this.ports = new Set();
    await this.persist();
  }

  private async persist(): Promise<void> {
    await this.state.update(STORAGE_KEY, [...this.ports]);
    await this.syncContext();
  }

  private async syncContext(): Promise<void> {
    await vscode.commands.executeCommand('setContext', CONTEXT_KEY, this.ports.size > 0);
  }
}
