export interface EnvAssignment {
  readonly key: string;
  readonly value: string;
  /** 1-based line number, used to point the user at the source of an inference. */
  readonly line: number;
}

/**
 * Minimal `.env` reader.
 *
 * Deliberately does *not* expand `${VAR}` references: this parser only ever feeds port
 * inference, and a half-expanded value would produce a confidently wrong port number.
 * Values are returned verbatim to the caller, which must extract a port and discard the
 * rest — `.env` files hold credentials and none of this text may reach a log.
 */
export function parseDotEnv(content: string): EnvAssignment[] {
  const assignments: EnvAssignment[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) {
      return;
    }

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key)) {
      return;
    }

    let value = withoutExport.slice(separator + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const closing = value.indexOf(quote, 1);
      value = closing > 0 ? value.slice(1, closing) : value.slice(1);
    } else {
      // An unquoted value ends at an inline comment that is preceded by whitespace.
      const comment = value.search(/\s#/);
      if (comment >= 0) {
        value = value.slice(0, comment);
      }
      value = value.trim();
    }

    assignments.push({ key, value, line: index + 1 });
  });

  return assignments;
}
