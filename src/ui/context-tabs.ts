import { eventKey } from "./event-key";
import type { LogEvent } from "./types";

export const maxContextTabs = 5;

export function upsertContextTab(tabs: LogEvent[], event: LogEvent): LogEvent[] {
  const key = eventKey(event);
  return [...tabs.filter((tab) => eventKey(tab) !== key), event].slice(
    -maxContextTabs,
  );
}

/** Replace the active tab in place. An already-open tab is a switch, not a spawn. */
export function reAnchorContextTab(
  tabs: LogEvent[],
  current: LogEvent | null,
  event: LogEvent,
): LogEvent[] {
  const nextKey = eventKey(event);
  const dupe = tabs.findIndex((tab) => eventKey(tab) === nextKey);
  const at = current
    ? tabs.findIndex((tab) => eventKey(tab) === eventKey(current))
    : -1;
  if (dupe !== -1 && dupe !== at) {
    return tabs;
  }
  if (at === -1) {
    return upsertContextTab(tabs, event);
  }
  const next = tabs.slice();
  next[at] = event;
  return next;
}

export function contextTabLabel(event: LogEvent): string {
  return `${event.ts.slice(11, 19)} · ${event.service}`;
}
