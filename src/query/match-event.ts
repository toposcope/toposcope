import type { LogEvent } from "../shared/log-event";
import { compileQuery, isCoreField, matchNode } from "./compile";

function attrValue(event: LogEvent, key: string): string {
  const value = event.attrs?.[key];
  if (value === null || value === undefined) {
    return "";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Same filters as search: boolean AST, core/attr equality, prefix globs, numeric comparisons, message AND. */
export function eventMatchesQuery(event: LogEvent, q: string): boolean {
  const compiled = compileQuery(q);
  if (compiled.faults.length > 0) {
    return false;
  }
  return matchNode(compiled.ast, (key) => {
    if (key === "message") {
      return event.message;
    }
    if (isCoreField(key)) {
      if (key === "host") {
        return event.host ?? "";
      }
      return event[key];
    }
    return attrValue(event, key);
  });
}
