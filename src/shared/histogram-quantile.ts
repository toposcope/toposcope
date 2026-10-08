/** Bucket counts summed by upper bound, bounds rising. The bound above them all is Infinity. */
export type BucketSums = { le: number[]; n: number[] };

/** Bounds and the counts under them, as ClickHouse returns them: in any order, the bound above them all as null. */
export function bucketSums(bounds: unknown, counts: unknown): BucketSums {
  const les = Array.isArray(bounds) ? bounds : [];
  const ns = Array.isArray(counts) ? counts : [];
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < les.length; i++) {
    const bound = les[i] === null ? Number.POSITIVE_INFINITY : Number(les[i]);
    const count = Number(ns[i] ?? 0);
    if (!Number.isNaN(bound)) {
      pairs.push([bound, Number.isFinite(count) && count > 0 ? count : 0]);
    }
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return { le: pairs.map(([bound]) => bound), n: pairs.map(([, count]) => count) };
}

/**
 * The value that `q` of the observations fall at or below, read off bucket
 * counts: the bucket the rank lands in, and a straight line across it. A bucket
 * starts where the bound before it ends; the first starts at zero when its
 * bound is above zero. Past the highest bound nothing is known, so the answer
 * there is that bound: at least this much.
 */
export function bucketQuantile(q: number, sums: BucketSums): number | null {
  const total = sums.n.reduce((sum, count) => sum + count, 0);
  if (!(total > 0) || !(q >= 0 && q <= 1)) {
    return null;
  }
  const rank = q * total;
  let below = 0;
  for (let i = 0; i < sums.le.length; i++) {
    const count = sums.n[i] ?? 0;
    if (count <= 0 || below + count < rank) {
      below += count;
      continue;
    }
    const upper = sums.le[i]!;
    const before = i > 0 ? sums.le[i - 1]! : null;
    if (!Number.isFinite(upper)) {
      return before;
    }
    const lower = before ?? (upper > 0 ? 0 : upper);
    return lower + (upper - lower) * ((rank - below) / count);
  }
  return null;
}
