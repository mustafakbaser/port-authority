/**
 * Turns the source artwork into the Marketplace icon.
 *
 *   node scripts/build-icon.mjs <source.png> [--size 256] [--fill 0.82] [--measure]
 *
 * Three things happen, in this order, and each exists for a reason:
 *
 *   1. **Trim.** Generated artwork is rarely composed to the frame — this source has
 *      ~12% dead space on one edge and ~16% on another. An icon that does not fill its
 *      tile looks smaller than its neighbours in the Marketplace grid and in the
 *      Extensions sidebar.
 *   2. **Recompose onto a square.** The content is centred on a fresh canvas painted with
 *      the artwork's own background colour, rather than cropped to the image bounds. That
 *      keeps the padding exactly symmetrical instead of whatever the edges allow.
 *   3. **Downsample by area average.** A box filter over the source pixels, not nearest
 *      neighbour: the diagonal edges of the beam and the cube alias badly otherwise, and
 *      aliasing is exactly what makes an icon look cheap at 32px.
 *
 * No image library is used. Everything here is plain zlib plus the PNG spec, which keeps
 * the toolchain free of a native dependency that would break on someone else's platform.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

// ---------------------------------------------------------------- decoding

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file');
  }

  let offset = 8;
  let header;
  let palette;
  let transparency;
  const idat = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      transparency = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!header) {
    throw new Error('PNG has no IHDR chunk');
  }
  if (header.bitDepth !== 8) {
    throw new Error(`Only 8-bit PNGs are supported (got ${header.bitDepth}-bit)`);
  }
  if (header.interlace !== 0) {
    throw new Error('Interlaced PNGs are not supported');
  }

  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (!channels) {
    throw new Error(`Unsupported PNG colour type ${header.colorType}`);
  }

  const raw = inflateSync(Buffer.concat(idat));
  const { width, height } = header;
  const stride = width * channels;
  const scanlines = Buffer.alloc(stride * height);

  // Undo the per-scanline filters. Each filter is defined relative to the byte `bpp`
  // positions back on this line and the same position on the previous line.
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const source = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const line = scanlines.subarray(y * stride, y * stride + stride);
    const previous = y > 0 ? scanlines.subarray((y - 1) * stride, (y - 1) * stride + stride) : undefined;

    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= channels ? previous[x - channels] : 0;
      const value = source[x];
      let restored;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + a; break;
        case 2: restored = value + b; break;
        case 3: restored = value + ((a + b) >> 1); break;
        case 4: restored = value + paeth(a, b, c); break;
        default: throw new Error(`Unknown PNG filter ${filter} on line ${y}`);
      }
      line[x] = restored & 0xff;
    }
  }

  // Normalise every colour type to RGBA so the rest of the script has one shape to think about.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const source = i * channels;
    const target = i * 4;
    let r;
    let g;
    let b;
    let alpha = 255;

    if (header.colorType === 0) {
      r = g = b = scanlines[source];
    } else if (header.colorType === 4) {
      r = g = b = scanlines[source];
      alpha = scanlines[source + 1];
    } else if (header.colorType === 3) {
      const index = scanlines[source];
      r = palette[index * 3];
      g = palette[index * 3 + 1];
      b = palette[index * 3 + 2];
      alpha = transparency && index < transparency.length ? transparency[index] : 255;
    } else {
      r = scanlines[source];
      g = scanlines[source + 1];
      b = scanlines[source + 2];
      if (header.colorType === 6) {
        alpha = scanlines[source + 3];
      }
    }

    rgba[target] = r;
    rgba[target + 1] = g;
    rgba[target + 2] = b;
    rgba[target + 3] = alpha;
  }

  return { width, height, rgba };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

// ---------------------------------------------------------------- encoding

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Chooses a filter per scanline using the minimum-sum-of-absolute-differences heuristic
 * from the PNG specification.
 *
 * Worth the twenty lines: a flat two-colour icon written with filter 0 on every line
 * compresses to roughly five times its necessary size, because deflate never sees the
 * long runs of zeroes that a Sub or Up filter produces across areas of constant colour.
 */
function filterScanline(line, previous, bpp, output) {
  const candidates = [];
  for (let type = 0; type <= 4; type += 1) {
    const buffer = Buffer.alloc(line.length);
    let score = 0;
    for (let x = 0; x < line.length; x += 1) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = previous ? previous[x] : 0;
      const c = previous && x >= bpp ? previous[x - bpp] : 0;
      let value;
      switch (type) {
        case 0: value = line[x]; break;
        case 1: value = line[x] - a; break;
        case 2: value = line[x] - b; break;
        case 3: value = line[x] - ((a + b) >> 1); break;
        default: value = line[x] - paeth(a, b, c); break;
      }
      buffer[x] = value & 0xff;
      // Signed interpretation: bytes near zero are what deflate compresses well.
      score += buffer[x] < 128 ? buffer[x] : 256 - buffer[x];
    }
    candidates.push({ type, buffer, score });
  }

  const best = candidates.reduce((a, b) => (b.score < a.score ? b : a));
  output[0] = best.type;
  best.buffer.copy(output, 1);
}

function encodePng(width, height, rgba) {
  // An icon with a solid background has no transparency, and a constant alpha channel is
  // a quarter of the file spent on the byte 255 repeated 65,536 times. Drop it when it
  // carries no information.
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }

  const channels = opaque ? 3 : 4;
  const pixels = opaque ? new Uint8Array((rgba.length / 4) * 3) : rgba;
  if (opaque) {
    for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
      pixels[o] = rgba[i];
      pixels[o + 1] = rgba[i + 1];
      pixels[o + 2] = rgba[i + 2];
    }
  }

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const line = Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride);
    const previous =
      y > 0 ? Buffer.from(pixels.buffer, pixels.byteOffset + (y - 1) * stride, stride) : undefined;
    filterScanline(line, previous, channels, raw.subarray(y * (stride + 1), (y + 1) * (stride + 1)));
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = opaque ? 2 : 6; // truecolour, with alpha only when it is actually used
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- processing

/** Colour distance that counts as "not the background", tolerant of antialiased edges. */
const BACKGROUND_TOLERANCE = 48;

function contentBounds({ width, height, rgba }, background) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const distance =
        Math.abs(rgba[i] - background[0]) +
        Math.abs(rgba[i + 1] - background[1]) +
        Math.abs(rgba[i + 2] - background[2]);
      if (rgba[i + 3] > 8 && distance > BACKGROUND_TOLERANCE) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    throw new Error('The source image looks like a single flat colour');
  }
  return { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Area-average downsample from an arbitrary source rectangle onto a square canvas. */
function resample(image, rect, size, background) {
  const out = new Uint8Array(size * size * 4);
  const scale = rect.size / size;

  for (let ty = 0; ty < size; ty += 1) {
    for (let tx = 0; tx < size; tx += 1) {
      const x0 = rect.x + tx * scale;
      const y0 = rect.y + ty * scale;
      const x1 = x0 + scale;
      const y1 = y0 + scale;

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;

      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          count += 1;
          if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
            // Outside the artwork: the padding we added, painted with its own background.
            r += background[0];
            g += background[1];
            b += background[2];
            a += 255;
            continue;
          }
          const i = (sy * image.width + sx) * 4;
          r += image.rgba[i];
          g += image.rgba[i + 1];
          b += image.rgba[i + 2];
          a += image.rgba[i + 3];
        }
      }

      const t = (ty * size + tx) * 4;
      out[t] = Math.round(r / count);
      out[t + 1] = Math.round(g / count);
      out[t + 2] = Math.round(b / count);
      out[t + 3] = Math.round(a / count);
    }
  }

  return out;
}

/**
 * Snaps near-uniform regions back to the exact colours the artwork was designed in.
 *
 * Generated artwork carries grain: this source measures 26 distinct colours inside areas
 * that are supposed to be a single flat fill, drifting about three levels per channel.
 * That grain costs nothing visually at full size but does two things at icon size — it
 * defeats PNG's filters, and it makes the flats look faintly dirty once downsampled.
 *
 * Only pixels already within `tolerance` of a dominant colour are moved, so genuine
 * antialiasing along the edges is left untouched and the shapes stay smooth. If the
 * artwork turns out not to be a flat two-colour design, nothing is changed.
 */
function flattenFills(image, tolerance = 14) {
  const histogram = new Map();
  for (let i = 0; i < image.rgba.length; i += 4) {
    const key = (image.rgba[i] << 16) | (image.rgba[i + 1] << 8) | image.rgba[i + 2];
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  const total = image.rgba.length / 4;
  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1]);
  const dominant = [];
  for (const [key, count] of ranked) {
    const colour = [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    const isNew = dominant.every(
      (existing) =>
        Math.abs(existing.colour[0] - colour[0]) +
          Math.abs(existing.colour[1] - colour[1]) +
          Math.abs(existing.colour[2] - colour[2]) >
        tolerance * 4,
    );
    if (isNew) {
      dominant.push({ colour, count });
    }
    if (dominant.length === 2) {
      break;
    }
  }

  if (dominant.length < 2) {
    return { flattened: 0, dominant };
  }

  // Count everything that sits near either dominant colour, not just exact matches.
  let near = 0;
  for (let i = 0; i < image.rgba.length; i += 4) {
    for (const entry of dominant) {
      if (
        Math.abs(image.rgba[i] - entry.colour[0]) +
          Math.abs(image.rgba[i + 1] - entry.colour[1]) +
          Math.abs(image.rgba[i + 2] - entry.colour[2]) <=
        tolerance
      ) {
        near += 1;
        break;
      }
    }
  }

  if (near / total < 0.9) {
    return { flattened: 0, dominant }; // Not a flat two-colour design; leave it alone.
  }

  let flattened = 0;
  for (let i = 0; i < image.rgba.length; i += 4) {
    for (const entry of dominant) {
      const distance =
        Math.abs(image.rgba[i] - entry.colour[0]) +
        Math.abs(image.rgba[i + 1] - entry.colour[1]) +
        Math.abs(image.rgba[i + 2] - entry.colour[2]);
      if (distance > 0 && distance <= tolerance) {
        image.rgba[i] = entry.colour[0];
        image.rgba[i + 1] = entry.colour[1];
        image.rgba[i + 2] = entry.colour[2];
        flattened += 1;
        break;
      }
    }
  }

  return { flattened, dominant };
}

// ---------------------------------------------------------------- entry point

const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith('--'));
if (!source) {
  console.error('Usage: node scripts/build-icon.mjs <source.png> [--size 256] [--fill 0.82] [--measure]');
  process.exit(1);
}

const readOption = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};

const size = readOption('size', 256);
const fill = readOption('fill', 0.82);
const measureOnly = args.includes('--measure');

const image = decodePng(readFileSync(source));
const flatten = flattenFills(image);
const background = [image.rgba[0], image.rgba[1], image.rgba[2]];
const bounds = contentBounds(image, background);

// The square the content should occupy, expanded so the content fills `fill` of it.
const contentSize = Math.max(bounds.width, bounds.height);
const canvasSize = contentSize / fill;
const rect = {
  x: bounds.minX + bounds.width / 2 - canvasSize / 2,
  y: bounds.minY + bounds.height / 2 - canvasSize / 2,
  size: canvasSize,
};

const percent = (value, total) => `${((value / total) * 100).toFixed(1)}%`;
console.log(`source        ${basename(source)} ${image.width}x${image.height}`);
console.log(`background    rgb(${background.join(', ')})`);
console.log(
  `content bbox  x ${bounds.minX}..${bounds.maxX}  y ${bounds.minY}..${bounds.maxY}  (${bounds.width}x${bounds.height})`,
);
console.log(
  `dead margins  left ${percent(bounds.minX, image.width)}  right ${percent(image.width - 1 - bounds.maxX, image.width)}  top ${percent(bounds.minY, image.height)}  bottom ${percent(image.height - 1 - bounds.maxY, image.height)}`,
);
console.log(`content fill  ${percent(contentSize, image.width)} of the source frame → ${percent(fill, 1)} of the output`);
console.log(
  flatten.flattened > 0
    ? `flattened     ${flatten.flattened.toLocaleString('en-US')} grainy pixels onto ${flatten.dominant
        .map((entry) => `rgb(${entry.colour.join(', ')})`)
        .join(' and ')}`
    : 'flattened     skipped — the artwork is not a flat two-colour design',
);

if (measureOnly) {
  process.exit(0);
}

const output = 'media/icon.png';
writeFileSync(output, encodePng(size, size, resample(image, rect, size, background)));
console.log(`wrote         ${output} ${size}x${size}`);
