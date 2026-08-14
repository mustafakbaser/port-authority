/** Formats an age as the coarse, human phrase a notification needs: `6 hours ago`. */
export function formatAge(startedAt: number | undefined, now: number): string | undefined {
  if (startedAt === undefined || !Number.isFinite(startedAt)) {
    return undefined;
  }
  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  if (seconds < 45) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Parses the POSIX `ps -o etime` format into milliseconds.
 * Accepted shapes: `SS`, `MM:SS`, `HH:MM:SS`, `DD-HH:MM:SS`.
 * Returns undefined for anything else — a wrong start time is worse than none.
 */
export function parseElapsedTime(value: string): number | undefined {
  const trimmed = value.trim();
  const match = /^(?:(\d+)-)?(?:(\d+):)?(?:(\d+):)?(\d+)$/.exec(trimmed);
  if (!match) {
    return undefined;
  }
  const [, days, first, second, last] = match;
  // With three colon-separated groups the layout is HH:MM:SS, with two it is MM:SS.
  const hours = second !== undefined ? Number(first) : 0;
  const minutes = second !== undefined ? Number(second) : first !== undefined ? Number(first) : 0;
  const seconds = Number(last);
  const totalSeconds =
    (days ? Number(days) * 86_400 : 0) + hours * 3_600 + minutes * 60 + seconds;
  return Number.isFinite(totalSeconds) ? totalSeconds * 1000 : undefined;
}
