import { formatFieldToken } from "./query-tokens";
import { FOLLOW_MS } from "../shared/ids";
import type { FollowOpened } from "../shared/follow-span";
import type { RangeMode } from "./search-url";

export { FOLLOW_MS };

export type FollowOrigin = {
  q: string;
  range: RangeMode;
  from: string;
  to: string;
  live: boolean;
  saved: string | null;
};

export type FollowState = {
  key: string;
  value: string;
  origin: FollowOrigin;
};

export function followQuery(key: string, value: string): string {
  return formatFieldToken(key, value);
}

export function truncateFollowToken(token: string, max = 28): string {
  if (token.length <= max) {
    return token;
  }
  return `${token.slice(0, max - 1)}…`;
}

/** True while the tab's clock is still the window Follow opened on. */
export function followOnOpened(
  opened: FollowOpened,
  clock: { range: string; from: string; to: string; live: boolean; explored: boolean },
): boolean {
  return (
    clock.range === "custom" &&
    !clock.live &&
    !clock.explored &&
    Date.parse(clock.from) === opened.fromMs &&
    Date.parse(clock.to) === opened.toMs
  );
}
