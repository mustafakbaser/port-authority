import type { Ownership, ProcessInfo } from './types.js';
import { isPathInside, mentionsPath } from './util/paths.js';

export interface OwnershipContext {
  /** Absolute paths of the open workspace folders. */
  readonly workspaceFolders: readonly string[];
  readonly caseInsensitive: boolean;
}

/**
 * What the classification is based on.
 *
 * This matters beyond display: only `cwd` is direct evidence. The command-line heuristic
 * is a convenience for platforms that cannot report a working directory, and it must
 * never be strong enough to unlock the confirmation skip in the terminate flow.
 */
export type OwnershipBasis = 'cwd' | 'commandLine' | 'none';

export interface OwnershipVerdict {
  readonly ownership: Ownership;
  readonly basis: OwnershipBasis;
}

/**
 * Decides whether a process belongs to the open workspace.
 *
 * The contract is deliberately conservative: `foreign` is only returned when the working
 * directory is *known* and provably outside every workspace folder. A wrong "foreign
 * process" badge is the false positive that would make a user distrust the whole
 * extension, so anything less certain resolves to `unknown`.
 */
export function classifyOwnershipDetailed(
  process: ProcessInfo | undefined,
  context: OwnershipContext,
): OwnershipVerdict {
  if (!process || context.workspaceFolders.length === 0) {
    return { ownership: 'unknown', basis: 'none' };
  }

  if (process.cwd) {
    const inside = context.workspaceFolders.some((folder) =>
      isPathInside(process.cwd, folder, context.caseInsensitive),
    );
    return { ownership: inside ? 'workspace' : 'foreign', basis: 'cwd' };
  }

  // Windows exposes no cheap way to read another process's working directory, so fall
  // back to the command line: a dev server started from the workspace almost always
  // carries the folder path in `argv`. This can only ever *raise* confidence to
  // `workspace`; it never asserts `foreign`.
  const haystack = `${process.commandLine ?? ''} ${process.executablePath ?? ''}`.trim();
  if (haystack) {
    const matches = context.workspaceFolders.some((folder) =>
      mentionsPath(haystack, folder, context.caseInsensitive),
    );
    if (matches) {
      return { ownership: 'workspace', basis: 'commandLine' };
    }
  }

  return { ownership: 'unknown', basis: 'none' };
}

/** Convenience wrapper for callers that only need the verdict. */
export function classifyOwnership(
  process: ProcessInfo | undefined,
  context: OwnershipContext,
): Ownership {
  return classifyOwnershipDetailed(process, context).ownership;
}
