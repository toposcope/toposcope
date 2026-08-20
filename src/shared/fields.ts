import { isAttrIdent } from "./attrs";
import { isMetricIdent } from "./metric";

export const fieldRoles = ["chart", "lookup", "ignore"] as const;
export type FieldRole = (typeof fieldRoles)[number];

export const LINK_CAP = 8;
export const FIELD_TOP_N = 20;
/** Skip per-value GROUP BY above this HLL distinct — request_id is ~80M. */
export const FIELD_TOP_CARD = 1000;
export const CHEAP_KEY_CAP = 32;

export const fieldWaves = ["keys", "values", "suggest"] as const;
export type FieldsWave = (typeof fieldWaves)[number];

export const fieldRoleHelp: Record<FieldRole, string> = {
  chart: "roll up for Top-N and facets",
  lookup: "unique ids — skip chart summaries",
  ignore: "skip summaries; still on the log line",
};

export type FieldValuesKind = number | "numeric" | null;

export type FieldCatalogRow = {
  key: string;
  kind: "core" | "attr";
  events: number;
  values: FieldValuesKind;
  roleable: boolean;
  linkable: boolean;
};

export type FieldsConfig = {
  roles: Record<string, FieldRole>;
  links: Record<string, string>;
};

export type FieldsCatalog = {
  keys: FieldCatalogRow[];
  metricLabels: string[];
  suggestRoles: Record<string, FieldRole>;
  suggestLinks: Record<string, string>;
  events: number;
};

export type FieldsResponse = FieldsConfig & FieldsCatalog;

export type FieldsValuesPayload = {
  values: Record<string, FieldValuesKind>;
};

export type FieldsSuggestPayload = {
  metricLabels: string[];
  suggestRoles: Record<string, FieldRole>;
  suggestLinks: Record<string, string>;
};

export function emptyFieldsCatalog(): FieldsCatalog {
  return {
    keys: [],
    metricLabels: [],
    suggestRoles: {},
    suggestLinks: {},
    events: 0,
  };
}

export function isFieldsWave(value: string): value is FieldsWave {
  return (fieldWaves as readonly string[]).includes(value);
}

export function parseFieldsWave(
  raw: string | undefined,
): FieldsWave | null | { error: string } {
  if (raw === undefined || raw === "") {
    return null;
  }
  if (!isFieldsWave(raw)) {
    return { error: "wave must be keys, values, or suggest" };
  }
  return raw;
}

export function parseCheapKeys(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim().toLowerCase();
    if (!key || !isLinkableKey(key)) {
      continue;
    }
    if (!out.includes(key)) {
      out.push(key);
    }
    if (out.length >= CHEAP_KEY_CAP) {
      break;
    }
  }
  return out;
}

export function applyFieldValues(
  keys: FieldCatalogRow[],
  values: Record<string, FieldValuesKind>,
): FieldCatalogRow[] {
  return keys.map((row) => {
    if (row.kind === "core") {
      return row;
    }
    const next = values[row.key];
    return { ...row, values: next === undefined ? null : next };
  });
}

export function cheapSuggestKeys(keys: FieldCatalogRow[]): string[] {
  return keys
    .filter((row) => {
      if (!row.linkable || typeof row.values !== "number") {
        return false;
      }
      return row.values > 0 && row.values <= FIELD_TOP_CARD;
    })
    .map((row) => row.key)
    .slice(0, CHEAP_KEY_CAP);
}

export function suggestRolesFromKeys(
  keys: FieldCatalogRow[],
): Record<string, FieldRole> {
  const out: Record<string, FieldRole> = {};
  for (const row of keys) {
    if (!row.roleable) {
      continue;
    }
    const suggest = suggestFieldRole(row.values, row.events);
    if (suggest) {
      out[row.key] = suggest;
    }
  }
  return out;
}

export function isFieldRole(value: string): value is FieldRole {
  return (fieldRoles as readonly string[]).includes(value);
}

export function isRoleableKey(key: string): boolean {
  return isAttrIdent(key);
}

export function isLinkableKey(key: string): boolean {
  return key === "service" || key === "host" || isAttrIdent(key);
}

/** Core catalog rows. `message` is display-only — no role picker, no metric link, no distinct scan. */
export function coreFieldRows(
  events: number,
  distinct: { service: number; host: number; level: number },
): FieldCatalogRow[] {
  return [
    {
      key: "service",
      kind: "core",
      events,
      values: distinct.service,
      roleable: false,
      linkable: true,
    },
    {
      key: "host",
      kind: "core",
      events,
      values: distinct.host,
      roleable: false,
      linkable: true,
    },
    {
      key: "level",
      kind: "core",
      events,
      values: distinct.level,
      roleable: false,
      linkable: false,
    },
    {
      key: "message",
      kind: "core",
      events,
      values: null,
      roleable: false,
      linkable: false,
    },
  ];
}

export function coreRoleLabel(key: string): { label: string; title: string } {
  if (key === "message") {
    return {
      label: "text",
      title:
        "Bare words in the bar search this column as tokens, not a substring. Not a role.",
    };
  }
  if (key === "level") {
    return {
      label: "—",
      title: "level is neither charted as an attr nor linkable",
    };
  }
  return {
    label: "core column",
    title: "Always rolled up — core columns have no role",
  };
}

export function skipKeysFromRoles(roles: Record<string, FieldRole>): string[] {
  return Object.entries(roles)
    .filter(([, role]) => role === "lookup" || role === "ignore")
    .map(([key]) => key)
    .sort();
}

/** Chart (default) keys may be Add-facet / Top-N targets; lookup and ignore may not. */
export function isChartSummaryKey(
  key: string,
  roles: Record<string, FieldRole>,
): boolean {
  const role = roles[key];
  return role !== "lookup" && role !== "ignore";
}

export function parseFieldRoles(
  raw: unknown,
): Record<string, FieldRole> | { error: string } {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "roles must be an object" };
  }
  const out: Record<string, FieldRole> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase();
    if (!isRoleableKey(key)) {
      return { error: `Invalid role key "${rawKey}"` };
    }
    if (typeof value !== "string" || !isFieldRole(value)) {
      return { error: `Invalid role for "${key}"` };
    }
    if (value !== "chart") {
      out[key] = value;
    }
  }
  return out;
}

export function parseFieldLinks(
  raw: unknown,
): Record<string, string> | { error: string } {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "links must be an object" };
  }
  const out: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase();
    if (!isLinkableKey(key)) {
      return { error: `Invalid link key "${rawKey}"` };
    }
    if (typeof value !== "string") {
      return { error: `Invalid link for "${key}"` };
    }
    const label = value.trim().toLowerCase();
    if (!isMetricIdent(label)) {
      return { error: `Invalid metric label "${value}"` };
    }
    out[key] = label;
    if (Object.keys(out).length > LINK_CAP) {
      return { error: `At most ${LINK_CAP} links` };
    }
  }
  return out;
}

/** Same rules as the attr-value minute MV (length, JSON, UUID-like). */
export function isChartableAttrValue(value: string): boolean {
  if (value.length === 0 || value.length > 64) {
    return false;
  }
  if (value.startsWith("{") || value.startsWith("[")) {
    return false;
  }
  if (/^[0-9a-fA-F]{32}$/.test(value)) {
    return false;
  }
  if (
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  ) {
    return false;
  }
  return true;
}

export function shouldRollupAttrValue(value: string, role: FieldRole): boolean {
  if (role === "lookup" || role === "ignore") {
    return false;
  }
  return isChartableAttrValue(value);
}

export function suggestFieldRole(
  values: FieldValuesKind,
  events: number,
): FieldRole | null {
  if (values === "numeric") {
    return null;
  }
  if (values === null) {
    return "lookup";
  }
  if (events <= 0) {
    return null;
  }
  if (values >= 1000 || values / events >= 0.5) {
    return "lookup";
  }
  if (values <= 32) {
    return "chart";
  }
  return null;
}

export function pickOverlapLink(
  logTops: string[],
  labelTops: Record<string, string[]>,
): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [label, values] of Object.entries(labelTops)) {
    const set = new Set(values);
    const n = logTops.filter((v) => set.has(v)).length;
    if (n > bestN) {
      bestN = n;
      best = label;
    }
  }
  return bestN > 0 ? best : null;
}

export function graphMetricLabels(
  links: Record<string, string>,
  logKey: string,
  value: string,
): Record<string, string> | null {
  const label = links[logKey];
  if (!label || value.length === 0) {
    return null;
  }
  return { [label]: value };
}
