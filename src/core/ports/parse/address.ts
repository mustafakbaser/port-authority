import type { BindScope } from '../../types.js';

export interface ParsedAddress {
  readonly address: string;
  readonly port: number;
  readonly family: 'ipv4' | 'ipv6';
  readonly scope: BindScope;
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;
/** `::ffff:127.0.0.1` and its hex form `::ffff:7f00:1` both mean IPv4 loopback. */
const MAPPED_V4_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;

/**
 * Reduces an IPv6 address to the IPv4 address it wraps, if it wraps one.
 *
 * Dual-stack servers (JVM, .NET, many Python frameworks) bind through an IPv6 socket, so
 * on Linux a plain `127.0.0.1` bind is reported only in `/proc/net/tcp6` as
 * `::ffff:7f00:1`. Without this, those ports are classified `specific` and hidden by
 * default — the panel would be silently missing exactly the server the user is hunting.
 */
function unwrapMappedV4(address: string): string | undefined {
  if (/^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/i.test(address)) {
    return address.slice('::ffff:'.length);
  }
  const hex = MAPPED_V4_HEX.exec(address);
  if (!hex) {
    return undefined;
  }
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) {
    return undefined;
  }
  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
}

export function classifyScope(address: string): BindScope {
  // Strip brackets and any `%eth0` zone index before comparing.
  const bare = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const canonical = unwrapMappedV4(bare) ?? bare;

  if (canonical === '*' || canonical === '0.0.0.0' || canonical === '::' || canonical === '') {
    return 'any';
  }
  if (canonical === '::1' || canonical === 'localhost' || LOOPBACK_V4.test(canonical)) {
    return 'loopback';
  }
  return 'specific';
}

/**
 * Parses the `address:port` shapes every platform tool emits:
 * `*:3000`, `127.0.0.1:3000`, `[::1]:3000`, `::1.3000` (lsof IPv6), `0.0.0.0:3000`.
 * Returns undefined when no valid port can be extracted — callers must skip the row
 * rather than guess.
 */
export function parseAddressPort(raw: string): ParsedAddress | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  let address: string;
  let portText: string;

  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0 || value[close + 1] !== ':') {
      return undefined;
    }
    address = value.slice(1, close);
    portText = value.slice(close + 2);
  } else {
    // lsof separates an IPv6 address from its port with the last colon too, but bare
    // IPv6 addresses contain colons — split on the last one and validate what remains.
    const separator = value.lastIndexOf(':');
    if (separator < 0) {
      return undefined;
    }
    address = value.slice(0, separator);
    portText = value.slice(separator + 1);
  }

  if (!/^\d{1,5}$/.test(portText)) {
    return undefined;
  }
  const port = Number(portText);
  if (port < 1 || port > 65535) {
    return undefined;
  }

  const normalisedAddress = address === '' ? '*' : address;
  const family: 'ipv4' | 'ipv6' = normalisedAddress.includes(':') ? 'ipv6' : 'ipv4';
  return {
    address: normalisedAddress,
    port,
    family,
    scope: classifyScope(normalisedAddress),
  };
}

/** Parses the hex `0100007F:1F90` form used by `/proc/net/tcp`. */
export function parseProcNetAddress(hex: string): ParsedAddress | undefined {
  const [addressHex, portHex] = hex.split(':');
  if (!addressHex || !portHex) {
    return undefined;
  }
  const port = Number.parseInt(portHex, 16);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }

  if (addressHex.length === 8) {
    // Little-endian, byte reversed.
    const bytes = [6, 4, 2, 0].map((offset) => Number.parseInt(addressHex.slice(offset, offset + 2), 16));
    if (bytes.some((b) => Number.isNaN(b))) {
      return undefined;
    }
    const address = bytes.join('.');
    return { address, port, family: 'ipv4', scope: classifyScope(address) };
  }

  if (addressHex.length === 32) {
    // Four little-endian 32-bit words.
    const words: string[] = [];
    for (let word = 0; word < 4; word += 1) {
      const chunk = addressHex.slice(word * 8, word * 8 + 8);
      const reversed =
        chunk.slice(6, 8) + chunk.slice(4, 6) + chunk.slice(2, 4) + chunk.slice(0, 2);
      words.push(reversed.slice(0, 4), reversed.slice(4, 8));
    }
    const groups = words.map((group) => group.replace(/^0+(?=.)/, '').toLowerCase());
    const address = compressIpv6(groups);
    return { address, port, family: 'ipv6', scope: classifyScope(address) };
  }

  return undefined;
}

function compressIpv6(groups: readonly string[]): string {
  if (groups.every((g) => g === '0')) {
    return '::';
  }
  if (groups.slice(0, 7).every((g) => g === '0') && groups[7] === '1') {
    return '::1';
  }
  // IPv4-mapped (::ffff:a.b.c.d) shows up for dual-stack binds; keep the plain form,
  // display precision beyond this is not worth the parsing risk.
  let bestStart = -1;
  let bestLength = 0;
  let currentStart = -1;
  let currentLength = 0;
  groups.forEach((group, index) => {
    if (group === '0') {
      if (currentStart < 0) {
        currentStart = index;
        currentLength = 0;
      }
      currentLength += 1;
      if (currentLength > bestLength) {
        bestStart = currentStart;
        bestLength = currentLength;
      }
    } else {
      currentStart = -1;
      currentLength = 0;
    }
  });
  if (bestLength < 2) {
    return groups.join(':');
  }
  const head = groups.slice(0, bestStart).join(':');
  const tail = groups.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}
