import * as path from 'node:path';

/**
 * File-name case sensitivity is a per-platform correctness issue, not polish:
 * `/Users/me/Project` and `/users/me/project` are the same folder on macOS and Windows.
 */
export function isCaseInsensitivePlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin';
}

function normalise(p: string, caseInsensitive: boolean): string {
  // `path.resolve` collapses `.`/`..` and normalises separators for the host platform.
  const resolved = path.resolve(p);
  return caseInsensitive ? resolved.toLowerCase() : resolved;
}

/**
 * True when `child` is `parent` or lives underneath it.
 *
 * Uses a path-segment comparison, not `startsWith`: `/app-backup` must not count as
 * being inside `/app`. Symlinks are not resolved — doing so needs I/O, and a wrong
 * "foreign process" label is worse than an honest `unknown`.
 */
export function isPathInside(
  child: string | undefined,
  parent: string,
  caseInsensitive = isCaseInsensitivePlatform(),
): boolean {
  if (!child) {
    return false;
  }
  const a = normalise(child, caseInsensitive);
  const b = normalise(parent, caseInsensitive);
  if (a === b) {
    return true;
  }
  const relative = path.relative(b, a);
  return (
    relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
  );
}

/**
 * True when `text` mentions `folder` as a path, not merely as a substring.
 *
 * Used for the command-line ownership fallback. A plain `includes` check would treat
 * `/Users/me/app-backup/server.js` as living inside `/Users/me/app`, which is exactly
 * the bug `isPathInside` exists to prevent — the same rule has to hold here.
 *
 * A folder with fewer than two path segments (`/`, `C:\`) is rejected outright: matching
 * it would classify every process on the machine as workspace-owned.
 */
export function mentionsPath(text: string, folder: string, caseInsensitive: boolean): boolean {
  const resolved = path.resolve(folder);
  const segments = resolved.split(/[\\/]/).filter(Boolean);
  if (segments.length < 2) {
    return false;
  }

  // Separators are normalised on both sides before comparing. On Windows a command line
  // can carry either slash — `node C:/Users/me/app/server.js` from a Git Bash or npm
  // script, `C:\Users\me\app` from the workspace folder — and those describe the same
  // directory.
  const canonical = (value: string): string => {
    const normalised = value.replace(/[\\/]+/g, '/');
    return caseInsensitive ? normalised.toLowerCase() : normalised;
  };

  const haystack = canonical(text);
  const target = canonical(resolved);

  let index = haystack.indexOf(target);
  while (index >= 0) {
    // The match must end at a path boundary, so `/app` does not match inside `/app-backup`.
    const next = haystack[index + target.length];
    if (next === undefined || next === '/' || next === ' ' || next === '"' || next === "'") {
      return true;
    }
    index = haystack.indexOf(target, index + 1);
  }
  return false;
}

/** Shortens an absolute path for display: `/Users/me/proj/api` → `~/proj/api`. */
export function tildify(absolute: string | undefined, home: string | undefined): string | undefined {
  if (!absolute) {
    return undefined;
  }
  if (home && isPathInside(absolute, home)) {
    const relative = path.relative(home, absolute);
    return relative ? `~${path.sep}${relative}` : '~';
  }
  return absolute;
}
