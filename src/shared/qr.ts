/**
 * A QR code for a short text (#309: the otpauth link two-step setup shows, 32b), as a square of
 * dark (true) and light modules. Byte mode, error correction M, versions 1 to 10, the mask with
 * the lowest penalty. No dependency: the image carries no third-party code for this.
 */

const eccPerBlockM = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const blocksM = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function rawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) {
      result -= 36;
    }
  }
  return result;
}

function dataCodewords(ver: number): number {
  return Math.floor(rawDataModules(ver) / 8) - eccPerBlockM[ver]! * blocksM[ver]!;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) {
        result[j]! ^= result[j + 1]!;
      }
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < divisor.length; i++) {
      result[i]! ^= gfMul(divisor[i]!, factor);
    }
  }
  return result;
}

function alignmentPositions(ver: number, size: number): number[] {
  if (ver === 1) {
    return [];
  }
  const count = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

function bit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

export function qrModules(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 10; ver++) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) {
      break;
    }
  }
  if (ver > 10) {
    throw new Error("Text too long for this QR encoder");
  }
  const size = ver * 4 + 17;
  const capacity = dataCodewords(ver) * 8;
  const bits: number[] = [];
  const put = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((value >>> i) & 1);
    }
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) {
    put(b, 8);
  }
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) {
    put(pad, 8);
  }
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i + j]!;
    }
    data.push(b);
  }

  // Blocks, error correction, interleave.
  const numBlocks = blocksM[ver]!;
  const eccLen = eccPerBlockM[ver]!;
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const len = shortLen - eccLen + (i < shortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) {
      dat.push(0);
    }
    blocks.push([...dat, ...ecc]);
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) {
        codewords.push(block[i]!);
      }
    });
  }

  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark;
    fixed[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    }
  }
  const align = alignmentPositions(ver, size);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const last = align.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  const drawFormat = (mask: number) => {
    const fmt = (0 << 3) | mask; // error correction M is 00
    let rem = fmt;
    for (let i = 0; i < 10; i++) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const f = ((fmt << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) {
      set(8, i, bit(f, i));
    }
    set(8, 7, bit(f, 6));
    set(8, 8, bit(f, 7));
    set(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) {
      set(14 - i, 8, bit(f, i));
    }
    for (let i = 0; i < 8; i++) {
      set(size - 1 - i, 8, bit(f, i));
    }
    for (let i = 8; i < 15; i++) {
      set(8, size - 15 + i, bit(f, i));
    }
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) {
      rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    }
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, bit(v, i));
      set(b, a, bit(v, i));
    }
  }

  // Codewords in the zigzag, around what is fixed.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = bit(codewords[i >>> 3]!, 7 - (i & 7));
          i++;
        }
      }
    }
  }

  const masked = (mask: number): boolean[][] => {
    const out = modules.map((row) => row.slice());
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (fixed[y]![x]) {
          continue;
        }
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask]!;
        if (flip) {
          out[y]![x] = !out[y]![x];
        }
      }
    }
    return out;
  };
  const penalty = (m: boolean[][]): number => {
    let score = 0;
    for (let a = 0; a < size; a++) {
      for (const line of [m[a]!, m.map((row) => row[a]!)]) {
        let run = 1;
        for (let k = 1; k <= size; k++) {
          if (k < size && line[k] === line[k - 1]) {
            run++;
          } else {
            if (run >= 5) {
              score += run - 2;
            }
            run = 1;
          }
        }
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const c = m[y]![x];
        if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) {
          score += 3;
        }
      }
    }
    const dark = m.reduce((n, row) => n + row.filter(Boolean).length, 0);
    score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return score;
  };
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask);
    const m = masked(mask);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best!;
}

/** The QR code as an SVG, with a quiet zone of four modules. */
export function qrSvg(text: string, px = 8): string {
  const m = qrModules(text);
  const size = m.length + 8;
  let path = "";
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) {
        path += `M${x + 4} ${y + 4}h1v1h-1z`;
      }
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * px}" height="${size * px}" role="img" aria-label="QR code for the authenticator app" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fafafa"/><path d="${path}" fill="#0d0d0f"/></svg>`;
}
