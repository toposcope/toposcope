const SECOND_SLOTS = 60;

export class ReceivedRing {
  private readonly sec = new Float64Array(SECOND_SLOTS);
  private secT: number;

  constructor(now = Date.now()) {
    this.secT = Math.floor(now / 1000);
  }

  add(n: number, now = Date.now()): void {
    if (n <= 0) {
      return;
    }
    this.advance(now);
    addToSlot(this.sec, 0, n);
  }

  count(windowSeconds: number, now = Date.now()): number {
    this.advance(now);
    return sumSlots(this.sec, Math.max(1, Math.ceil(windowSeconds)));
  }

  private advance(now: number): void {
    const s = Math.floor(now / 1000);
    const secGap = s - this.secT;
    if (secGap > 0) {
      shiftOlder(this.sec, secGap);
      this.secT = s;
    }
  }
}

const receivedRing = new ReceivedRing();

export function recordReceived(n: number, now = Date.now()): void {
  receivedRing.add(n, now);
}

export function receivedCount(windowSeconds: number, now = Date.now()): number {
  return receivedRing.count(windowSeconds, now);
}

function addToSlot(buf: Float64Array, i: number, n: number): void {
  const cur = buf[i] ?? 0;
  buf[i] = cur + n;
}

function shiftOlder(buf: Float64Array, gap: number): void {
  if (gap >= buf.length) {
    buf.fill(0);
    return;
  }
  buf.copyWithin(gap, 0);
  buf.fill(0, 0, gap);
}

function sumSlots(buf: Float64Array, take: number): number {
  const n = Math.min(take, buf.length);
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += buf[i] ?? 0;
  }
  return total;
}
