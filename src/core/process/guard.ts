import type { ProcessInfo, SupportedPlatform } from '../types.js';

export type KillRisk =
  /** Refused outright. The extension will not send a signal under any confirmation. */
  | 'blocked'
  /** Allowed, but the confirmation must spell out why it is dangerous. */
  | 'high'
  /** Allowed with the normal confirmation. */
  | 'normal';

export interface KillDecision {
  readonly risk: KillRisk;
  /** Present when `risk` is `blocked`: the single reason to show the user. */
  readonly blockedReason?: string;
  /** Extra sentences to surface in the confirmation dialog. */
  readonly warnings: readonly string[];
}

export interface KillGuardContext {
  readonly platform: SupportedPlatform;
  /**
   * Process ids that must never be signalled: this extension host, its parents, and the
   * VS Code window itself. Populated by the adapter layer, which is the only place that
   * can read the real ancestry.
   */
  readonly protectedPids: ReadonlySet<number>;
  /** Extra names from `portAuthority.protectedProcessNames`. */
  readonly userProtectedNames: readonly string[];
  /** Current OS user, used to detect cross-user terminations. */
  readonly currentUser?: string;
}

/**
 * Processes whose termination breaks the operating system or the editor.
 * Compared case-insensitively against the process name with any `.exe` suffix removed.
 */
const CRITICAL_PROCESS_NAMES: Readonly<Record<SupportedPlatform, readonly string[]>> = {
  darwin: [
    'launchd',
    'kernel_task',
    'windowserver',
    'loginwindow',
    'mdnsresponder',
    'securityd',
    'opendirectoryd',
    'coreaudiod',
    'systemuiserver',
    'distnoted',
    'sshd',
    'cupsd',
    'controlcenter',
  ],
  linux: [
    'systemd',
    'init',
    'kthreadd',
    'dbus-daemon',
    'networkmanager',
    'sshd',
    'cupsd',
    'containerd',
    'polkitd',
    'udevd',
    'systemd-resolved',
  ],
  win32: [
    'system',
    'idle',
    'system idle process',
    'smss',
    'csrss',
    'wininit',
    'winlogon',
    'services',
    'lsass',
    'svchost',
    'spoolsv',
    'dwm',
    'explorer',
    'fontdrvhost',
  ],
};

/**
 * Infrastructure that is legitimate to stop but expensive to stop by accident:
 * killing `dockerd` takes every container with it, killing `postgres` drops open
 * transactions. Allowed, but only behind an explicit high-risk confirmation.
 */
const HIGH_RISK_PROCESS_NAMES: readonly string[] = [
  'dockerd',
  'docker',
  'com.docker.backend',
  'containerd-shim',
  'postgres',
  'postgresql',
  'mysqld',
  'mariadbd',
  'mongod',
  'redis-server',
  'nginx',
  'httpd',
  'apache2',
  'rabbitmq-server',
  'elasticsearch',
];

/** VS Code's own processes. Blocked separately so the message can be specific. */
const EDITOR_PROCESS_NAMES: readonly string[] = [
  'code',
  'code - insiders',
  'code helper',
  'electron',
  'codium',
  'vscodium',
  'cursor',
  'windsurf',
];

/**
 * Longest process name the Linux kernel stores in `/proc/<pid>/stat` (`TASK_COMM_LEN - 1`).
 * `systemd-resolved` arrives as `systemd-resolve`, so exact equality would never match.
 */
const LINUX_COMM_MAX = 15;

/**
 * Normalises a process name to the form the block lists are written in.
 *
 * Two transformations, both driven by what the platforms actually emit:
 *   - `.exe` is dropped, because Windows reports `lsass.exe` while the list says `lsass`.
 *   - A trailing parenthesised qualifier is dropped, because macOS reports
 *     `Code Helper (Plugin)` and `Code Helper (Renderer)` for what is one program.
 */
function normaliseName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const trimmed = name
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Matches an observed name against a block-list entry.
 *
 * On Linux the observed name may be the kernel's 15-character truncation of the real
 * one, so a truncated observation is accepted as a match for a longer list entry.
 */
function matchesName(observed: string, listed: string, platform: SupportedPlatform): boolean {
  if (observed === listed) {
    return true;
  }
  return (
    platform === 'linux' &&
    observed.length === LINUX_COMM_MAX &&
    listed.length > LINUX_COMM_MAX &&
    listed.startsWith(observed)
  );
}

function matchesAny(observed: string, listed: readonly string[], platform: SupportedPlatform): boolean {
  return listed.some((entry) => matchesName(observed, entry, platform));
}

/**
 * Decides whether a process may be terminated.
 *
 * This is the safety core of the extension and is exercised by unit tests directly.
 * It never performs I/O and never sends a signal — it only classifies.
 */
export function evaluateKill(process: ProcessInfo | undefined, context: KillGuardContext): KillDecision {
  const warnings: string[] = [];

  if (!process || !Number.isInteger(process.pid) || process.pid <= 0) {
    return {
      risk: 'blocked',
      blockedReason: 'The owning process of this port could not be identified, so there is nothing safe to terminate.',
      warnings,
    };
  }

  const { pid } = process;

  if (context.protectedPids.has(pid)) {
    return {
      risk: 'blocked',
      blockedReason: `Process ${pid} is VS Code itself (or one of its parents). Terminating it would close the editor.`,
      warnings,
    };
  }

  if (pid === 1 || (context.platform === 'win32' && (pid === 0 || pid === 4))) {
    return {
      risk: 'blocked',
      blockedReason: `Process ${pid} is a core operating system process.`,
      warnings,
    };
  }

  const name = normaliseName(process.name);
  const userProtected = context.userProtectedNames
    .map((entry) => normaliseName(entry))
    .filter((entry): entry is string => entry !== undefined);

  if (name && matchesAny(name, userProtected, context.platform)) {
    return {
      risk: 'blocked',
      blockedReason: `"${process.name}" is listed in \`portAuthority.protectedProcessNames\`.`,
      warnings,
    };
  }

  if (name && matchesAny(name, CRITICAL_PROCESS_NAMES[context.platform], context.platform)) {
    return {
      risk: 'blocked',
      blockedReason: `"${process.name}" is a system process on ${context.platform}. Terminating it can destabilise the machine.`,
      warnings,
    };
  }

  if (name && matchesAny(name, EDITOR_PROCESS_NAMES, context.platform)) {
    return {
      risk: 'blocked',
      blockedReason: `"${process.name}" looks like an editor process. Terminating it would close a window and lose unsaved work.`,
      warnings,
    };
  }

  let risk: KillRisk = 'normal';

  if (!name) {
    // An unidentifiable process is the case where the user has the *least* information,
    // so it must not be the case with the *weakest* confirmation. This happens whenever
    // the socket's owner belongs to another user, or `ss` ran without the privileges
    // needed to report a process name.
    risk = 'high';
    warnings.push(
      `The name of process ${pid} could not be read, usually because it belongs to another user. There is no way to confirm what it is before stopping it.`,
    );
  }

  if (name && matchesAny(name, HIGH_RISK_PROCESS_NAMES, context.platform)) {
    risk = 'high';
    warnings.push(
      `"${process.name}" is shared infrastructure. Other projects and containers may depend on it right now.`,
    );
  }

  if (context.currentUser && process.user && process.user !== context.currentUser) {
    risk = 'high';
    warnings.push(
      `This process runs as "${process.user}", not as you. Terminating it will most likely fail without elevated privileges, and it does not belong to your session.`,
    );
  }

  return { risk, warnings };
}
