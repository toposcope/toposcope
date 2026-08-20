import { maxAttrKeys } from "../shared/attrs";
import {
  FIELD_TOP_N,
  applyFieldValues,
  cheapSuggestKeys,
  coreFieldRows,
  emptyFieldsCatalog,
  isLinkableKey,
  isRoleableKey,
  pickOverlapLink,
  suggestRolesFromKeys,
  type FieldCatalogRow,
  type FieldValuesKind,
  type FieldsCatalog,
  type FieldsSuggestPayload,
} from "../shared/fields";
import { clickhouseQuery } from "../shared/clickhouse";
import { InvalidRangeError, resolveRange } from "./relative";

export { FIELD_TOP_CARD } from "../shared/fields";

const catalogSettings = "SETTINGS max_execution_time = 8";

type WhereClause = {
  sql: string;
  params: Record<string, string>;
};

type CatalogFilters = {
  from?: string;
  to?: string;
  range?: string;
};

function asCount(n: string | number | undefined): number {
  if (n === undefined) {
    return 0;
  }
  return typeof n === "number" ? n : Number(n);
}

function minuteWindow(from?: string, to?: string): WhereClause {
  const params: Record<string, string> = { tenant_id: "default" };
  const where = ["tenant_id = {tenant_id:String}"];
  if (from) {
    where.push(
      "minute >= toStartOfMinute(parseDateTime64BestEffort({from:String}))",
    );
    params.from = from;
  }
  if (to) {
    where.push(
      "minute <= toStartOfMinute(parseDateTime64BestEffort({to:String}))",
    );
    params.to = to;
  }
  return { sql: where.join(" AND "), params };
}

function metricWindow(from?: string, to?: string): WhereClause {
  const params: Record<string, string> = { tenant_id: "default" };
  const where = ["tenant_id = {tenant_id:String}"];
  if (from) {
    where.push("ts >= parseDateTime64BestEffort({from:String})");
    params.from = from;
  }
  if (to) {
    where.push("ts <= parseDateTime64BestEffort({to:String})");
    params.to = to;
  }
  return { sql: where.join(" AND "), params };
}

export function fieldsCatalogSql(window: WhereClause): {
  core: string;
  attrKeys: string;
  values: string;
  numeric: string;
  coreTops: string;
  metricLabels: string;
} {
  return {
    core: `
      SELECT
        countMerge(n) AS events,
        uniqExact(service) AS services,
        uniqExactIf(host, host != '') AS hosts,
        uniqExact(level) AS levels
      FROM logs_by_minute
      WHERE ${window.sql}
      ${catalogSettings}
    `,
    attrKeys: `
      SELECT key, countMerge(n) AS events
      FROM logs_attr_keys_by_minute
      WHERE ${window.sql} AND key != ''
      GROUP BY key
      ORDER BY events DESC, key ASC
      LIMIT ${maxAttrKeys}
      ${catalogSettings}
    `,
    values: `
      SELECT key, uniqHLL12(value) AS dv
      FROM logs_attr_values_by_minute
      WHERE ${window.sql}
      GROUP BY key
      ${catalogSettings}
    `,
    numeric: `
      SELECT key, countMerge(n) AS n
      FROM logs_attr_numeric_by_minute
      WHERE ${window.sql}
      GROUP BY key
      ${catalogSettings}
    `,
    coreTops: `
      SELECT * FROM (
        SELECT 'service' AS key, service AS value, countMerge(n) AS n
        FROM logs_by_minute
        WHERE ${window.sql} AND service != ''
        GROUP BY value
        ORDER BY n DESC
        LIMIT ${FIELD_TOP_N}
      )
      UNION ALL
      SELECT * FROM (
        SELECT 'host' AS key, host AS value, countMerge(n) AS n
        FROM logs_by_minute
        WHERE ${window.sql} AND host != ''
        GROUP BY value
        ORDER BY n DESC
        LIMIT ${FIELD_TOP_N}
      )
      ${catalogSettings}
    `,
    metricLabels: `
      SELECT key, value, count() AS n
      FROM metrics
      ARRAY JOIN mapKeys(labels) AS key, mapValues(labels) AS value
      WHERE ${window.sql} AND value != ''
      GROUP BY key, value
      ORDER BY n DESC
      LIMIT ${FIELD_TOP_N} BY key
      ${catalogSettings}
    `,
  };
}

export function fieldsCatalogLogTopsSql(
  window: WhereClause,
  keys: string[],
): { sql: string; params: Record<string, string> } | null {
  if (keys.length === 0) {
    return null;
  }
  const params = { ...window.params };
  const inList = keys.map((key, i) => {
    params[`ltk${i}`] = key;
    return `{ltk${i}:String}`;
  });
  return {
    params,
    sql: `
      SELECT key, value, countMerge(n) AS n
      FROM logs_attr_values_by_minute
      WHERE ${window.sql} AND value != '' AND key IN (${inList.join(", ")})
      GROUP BY key, value
      ORDER BY n DESC
      LIMIT ${FIELD_TOP_N} BY key
      ${catalogSettings}
    `,
  };
}

const logsTableScan = /(?:FROM|JOIN)\s+logs(?:\s|$)/i;

export function fieldsCatalogScansLogs(sql: string): boolean {
  return logsTableScan.test(sql);
}

function resolveWindow(filters: CatalogFilters): { from?: string; to?: string } {
  if (filters.range) {
    const window = resolveRange(filters.range);
    if (!window) {
      throw new InvalidRangeError(filters.range);
    }
    return window;
  }
  return { from: filters.from, to: filters.to };
}

function collectTops(
  rows: Array<{ key: string; value: string }>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const row of rows) {
    const list = out[row.key] ?? [];
    if (list.length < FIELD_TOP_N) {
      list.push(row.value);
      out[row.key] = list;
    }
  }
  return out;
}

async function querySoft<T>(
  sql: string,
  params: Record<string, string>,
): Promise<T[]> {
  try {
    return await clickhouseQuery<T>(sql, params);
  } catch (err) {
    console.error(err);
    return [];
  }
}

export async function fieldsCatalogKeys(
  filters: CatalogFilters,
): Promise<{ keys: FieldCatalogRow[]; events: number }> {
  const resolved = resolveWindow(filters);
  const minute = minuteWindow(resolved.from, resolved.to);
  const sql = fieldsCatalogSql(minute);
  const [coreRows, keyRows] = await Promise.all([
    clickhouseQuery<{
      events: string | number;
      services: string | number;
      hosts: string | number;
      levels: string | number;
    }>(sql.core, minute.params),
    clickhouseQuery<{ key: string; events: string | number }>(
      sql.attrKeys,
      minute.params,
    ),
  ]);

  const core = coreRows[0];
  const events = asCount(core?.events);
  if (events <= 0) {
    return { keys: [], events: 0 };
  }

  const keys: FieldCatalogRow[] = [
    ...coreFieldRows(events, {
      service: asCount(core?.services),
      host: asCount(core?.hosts),
      level: asCount(core?.levels),
    }),
  ];
  for (const row of keyRows) {
    const key = String(row.key);
    if (!isRoleableKey(key) && !isLinkableKey(key)) {
      continue;
    }
    keys.push({
      key,
      kind: "attr",
      events: asCount(row.events),
      values: null,
      roleable: isRoleableKey(key),
      linkable: isLinkableKey(key),
    });
  }
  return { keys, events };
}

export async function fieldsCatalogValues(
  filters: CatalogFilters,
): Promise<Record<string, FieldValuesKind>> {
  const resolved = resolveWindow(filters);
  const minute = minuteWindow(resolved.from, resolved.to);
  const sql = fieldsCatalogSql(minute);
  const [valueRows, numericRows] = await Promise.all([
    querySoft<{ key: string; dv: string | number }>(sql.values, minute.params),
    querySoft<{ key: string; n: string | number }>(sql.numeric, minute.params),
  ]);
  const distinct = new Map<string, number>();
  for (const row of valueRows) {
    distinct.set(row.key, asCount(row.dv));
  }
  const numeric = new Set(numericRows.map((row) => row.key));
  const out: Record<string, FieldValuesKind> = {};
  for (const key of new Set([...distinct.keys(), ...numeric])) {
    out[key] = valuesKind(key, numeric, distinct);
  }
  return out;
}

export async function fieldsCatalogSuggest(
  filters: CatalogFilters,
  cheapKeys: string[],
): Promise<FieldsSuggestPayload> {
  const resolved = resolveWindow(filters);
  const minute = minuteWindow(resolved.from, resolved.to);
  const metric = metricWindow(resolved.from, resolved.to);
  const sql = fieldsCatalogSql(minute);
  const metricSql = fieldsCatalogSql(metric).metricLabels;
  const logTopsQuery = fieldsCatalogLogTopsSql(minute, cheapKeys);
  const [coreTopRows, metricRows, logTopRows] = await Promise.all([
    querySoft<{ key: string; value: string }>(sql.coreTops, minute.params),
    querySoft<{ key: string; value: string; n: string | number }>(
      metricSql,
      metric.params,
    ),
    logTopsQuery
      ? querySoft<{ key: string; value: string }>(
          logTopsQuery.sql,
          logTopsQuery.params,
        )
      : Promise.resolve([]),
  ]);

  const logTops = collectTops([...coreTopRows, ...logTopRows]);
  const labelTops = collectTops(metricRows);
  const labelScore = new Map<string, number>();
  for (const row of metricRows) {
    labelScore.set(row.key, (labelScore.get(row.key) ?? 0) + asCount(row.n));
  }
  const metricLabels = [...labelScore.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key]) => key);

  const suggestLinks: Record<string, string> = {};
  for (const key of new Set([...Object.keys(logTops), ...cheapKeys])) {
    if (!isLinkableKey(key)) {
      continue;
    }
    const overlap = pickOverlapLink(logTops[key] ?? [], labelTops);
    if (overlap) {
      suggestLinks[key] = overlap;
    }
  }

  return { metricLabels, suggestRoles: {}, suggestLinks };
}

export async function fieldsCatalog(filters: CatalogFilters): Promise<FieldsCatalog> {
  const keyed = await fieldsCatalogKeys(filters);
  if (keyed.events <= 0) {
    return emptyFieldsCatalog();
  }
  const values = await fieldsCatalogValues(filters);
  const keys = applyFieldValues(keyed.keys, values);
  const suggest = await fieldsCatalogSuggest(filters, cheapSuggestKeys(keys));
  return {
    keys,
    events: keyed.events,
    metricLabels: suggest.metricLabels,
    suggestRoles: suggestRolesFromKeys(keys),
    suggestLinks: suggest.suggestLinks,
  };
}

function valuesKind(
  key: string,
  numeric: Set<string>,
  distinct: Map<string, number>,
): FieldValuesKind {
  if (numeric.has(key)) {
    return "numeric";
  }
  const dv = distinct.get(key);
  return dv === undefined ? null : dv;
}
