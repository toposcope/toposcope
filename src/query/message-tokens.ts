/** ClickHouse `splitByNonAlpha` after `lowerUTF8` — ASCII alphanumeric tokens. */
export function messageTokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^0-9a-z]+/)
    .filter((part) => part.length > 0);
}

function hasConsecutive(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      return true;
    }
  }
  return false;
}

/** Same predicate as `hasToken` / consecutive `hasSubstr(splitByNonAlpha)` on `lowerUTF8(message)`. */
export function messageMatchesText(haystack: string, needle: string): boolean {
  const want = messageTokens(needle);
  if (want.length === 0) {
    return false;
  }
  const have = messageTokens(haystack);
  if (want.length === 1) {
    return have.includes(want[0]!);
  }
  return hasConsecutive(have, want);
}
