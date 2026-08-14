/**
 * Secret scrubbing for anything on its way to the log.
 *
 * The values this extension handles — process command lines and text scraped from a
 * terminal — routinely embed credentials (`node server.js --token=…`,
 * `psql postgres://user:pass@host/db`). The log is a file the user will paste into a bug
 * report, so scrubbing has to happen at the sink rather than by remembering to do it at
 * every call site.
 *
 * This lives in `core` so it can be unit tested directly: it is a security control, and
 * a security control that is only reachable through the editor API is a security control
 * that never gets tested.
 */
const REDACTIONS: readonly [RegExp, string][] = [
  // Credentials embedded in a URL: scheme://user:password@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1<redacted>@'],
  // `Bearer <jwt>` must be handled *before* the key/value rule below. Otherwise
  // `Authorization: Bearer eyJ…` matches as key=`Authorization`, value=`Bearer`, and the
  // rule helpfully redacts the word "Bearer" while leaving the actual token in the log.
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 <redacted>'],
  // --token=…, --password …, API_KEY=…, secret: …
  [
    /\b((?:--)?[a-z0-9_.-]*(?:pass(?:word)?|passwd|secret|token|api[_-]?key|auth|credential)[a-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|(?!<redacted>)\S+)/gi,
    '$1=<redacted>',
  ],
];

/** Exported for unit tests: this is a security control, so it is tested like one. */
export function redact(value: string): string {
  return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}


