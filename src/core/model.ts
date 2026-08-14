import { classifyOwnershipDetailed, type OwnershipBasis, type OwnershipContext } from './ownership.js';
import type { PortEntry } from './ports/scanner.js';
import type { Ownership, PortExpectation } from './types.js';

export type ExpectationStatus =
  /** Listening, held by a process that runs from inside this workspace. */
  | 'held-by-workspace'
  /** Listening, held by a process that provably runs from somewhere else. */
  | 'held-by-foreign'
  /** Listening, but ownership could not be established. */
  | 'held-by-unknown'
  /** Nothing is listening on the port. */
  | 'free';

export interface ExpectationRow {
  readonly expectation: PortExpectation;
  readonly entry?: PortEntry;
  readonly ownership: Ownership;
  /** What the ownership verdict rests on. Only `cwd` is direct evidence. */
  readonly basis: OwnershipBasis;
  readonly status: ExpectationStatus;
}

export interface PortRow {
  readonly entry: PortEntry;
  readonly ownership: Ownership;
  readonly basis: OwnershipBasis;
  /** Set when this port is also an expectation of the workspace. */
  readonly expectation?: PortExpectation;
}

export interface PortModel {
  /** One row per expected port, per workspace folder, ordered by port. */
  readonly expectations: readonly ExpectationRow[];
  /** Every listening port, including the expected ones. */
  readonly all: readonly PortRow[];
}

/**
 * Joins a scan result with the workspace's expectations.
 *
 * Pure on purpose: this is the logic that decides whether a user sees "yours" or
 * "FOREIGN" next to a port, and it deserves direct unit tests rather than being
 * reachable only through a tree view.
 */
export function buildModel(
  entries: readonly PortEntry[],
  expectations: readonly PortExpectation[],
  context: OwnershipContext,
): PortModel {
  const verdicts = new Map<PortEntry, { ownership: Ownership; basis: OwnershipBasis }>();
  for (const entry of entries) {
    verdicts.set(entry, classifyOwnershipDetailed(entry.process, context));
  }

  const expectationByPort = new Map<number, PortExpectation>();
  for (const expectation of expectations) {
    if (!expectationByPort.has(expectation.port)) {
      expectationByPort.set(expectation.port, expectation);
    }
  }

  const expectationRows: ExpectationRow[] = expectations.map((expectation) => {
    // When several processes share a port, the workspace-owned one is the relevant answer.
    const candidates = entries.filter((entry) => entry.port === expectation.port);
    const entry =
      candidates.find((candidate) => verdicts.get(candidate)?.ownership === 'workspace') ?? candidates[0];
    const verdict = entry ? verdicts.get(entry) : undefined;
    const ownership = verdict?.ownership ?? 'unknown';
    return {
      expectation,
      ...(entry ? { entry } : {}),
      ownership,
      basis: verdict?.basis ?? 'none',
      status: !entry
        ? 'free'
        : ownership === 'workspace'
          ? 'held-by-workspace'
          : ownership === 'foreign'
            ? 'held-by-foreign'
            : 'held-by-unknown',
    };
  });

  const rows: PortRow[] = entries.map((entry) => {
    const expectation = expectationByPort.get(entry.port);
    const verdict = verdicts.get(entry);
    return {
      entry,
      ownership: verdict?.ownership ?? 'unknown',
      basis: verdict?.basis ?? 'none',
      ...(expectation ? { expectation } : {}),
    };
  });

  return { expectations: expectationRows, all: rows };
}
