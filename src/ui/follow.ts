import { formatFieldToken } from "./query-tokens";
import { FOLLOW_MS } from "../shared/ids";
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

export function followWindow(ts: string): { from: Date; to: Date } | null {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) {
    return null;
  }
  return { from: new Date(ms - FOLLOW_MS), to: new Date(ms + FOLLOW_MS) };
}

export function truncateFollowToken(token: string, max = 28): string {
  if (token.length <= max) {
    return token;
  }
  return `${token.slice(0, max - 1)}…`;
}
