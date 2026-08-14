import * as vscode from 'vscode';
import { redact } from '../core/util/redact.js';

function redactUnknown(value: unknown): unknown {
  return typeof value === 'string' ? redact(value) : value;
}

/**
 * The extension's single log sink.
 *
 * `LogOutputChannel` is used rather than a plain output channel so the user controls
 * the level from the Output view and nothing has to be configured.
 *
 * Every message and argument passes through {@link redact} on the way out. Call sites
 * still avoid logging sensitive fields in the first place — this is the backstop, not
 * the policy.
 */
export class Logger {
  private constructor(private readonly channel: vscode.LogOutputChannel) {}

  static create(): Logger {
    return new Logger(vscode.window.createOutputChannel('Port Authority', { log: true }));
  }

  get outputChannel(): vscode.LogOutputChannel {
    return this.channel;
  }

  trace(message: string, ...args: unknown[]): void {
    this.channel.trace(redact(message), ...args.map(redactUnknown));
  }

  debug(message: string, ...args: unknown[]): void {
    this.channel.debug(redact(message), ...args.map(redactUnknown));
  }

  info(message: string, ...args: unknown[]): void {
    this.channel.info(redact(message), ...args.map(redactUnknown));
  }

  warn(message: string, ...args: unknown[]): void {
    this.channel.warn(redact(message), ...args.map(redactUnknown));
  }

  error(message: string, error?: unknown): void {
    if (error instanceof Error) {
      this.channel.error(error, redact(message));
    } else if (error !== undefined) {
      this.channel.error(redact(`${message}: ${String(error)}`));
    } else {
      this.channel.error(redact(message));
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
