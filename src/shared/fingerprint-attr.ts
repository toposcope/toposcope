/**
 * A fingerprint's key says which rules made it (#142): `e1` the first; when the hash inputs
 * change, new rows carry `e2`. Search key: `e1:<hex>`. Safe in the browser (no `node:crypto`).
 */
export const fingerprintRevision = 1;
export const fingerprintAttr = "e1";
export const fingerprintHexLength = 16;

/** `e1`, `e2`, … — any revision, including ones newer than this instance (a pulled row keeps its own). */
export function isFingerprintKey(key: string): boolean {
  return /^e[1-9][0-9]*$/.test(key);
}
