/** Hide while the 2s Live poll is still landing. */
export const liveUpdatedMinAgeMs = 3000;

export function formatLiveUpdatedAge(ageMs: number): string {
  const sec = Math.max(1, Math.round(ageMs / 1000));
  if (sec < 60) {
    return `${sec}s`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m`;
  }
  return `${Math.round(min / 60)}h`;
}

export function liveUpdatedLabel(
  fetchedAt: number | undefined,
  now: number,
): string | null {
  if (fetchedAt === undefined) {
    return null;
  }
  const age = now - fetchedAt;
  if (age < liveUpdatedMinAgeMs) {
    return null;
  }
  return formatLiveUpdatedAge(age);
}
