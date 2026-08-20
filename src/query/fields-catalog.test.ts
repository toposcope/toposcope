import { describe, expect, test } from "bun:test";
import {
  FIELD_TOP_CARD,
  fieldsCatalogLogTopsSql,
  fieldsCatalogScansLogs,
  fieldsCatalogSql,
} from "./fields-catalog";

const window = {
  sql: "tenant_id = {tenant_id:String}",
  params: { tenant_id: "default" },
};

describe("fields catalog SQL", () => {
  test("reads rollups and metrics, never scans logs", () => {
    const sql = fieldsCatalogSql(window);
    const all = Object.values(sql);
    expect(all.length).toBeGreaterThan(0);
    for (const query of all) {
      expect(fieldsCatalogScansLogs(query)).toBe(false);
      expect(query).not.toContain("uniqExact(attr_map");
    }
    expect(sql.core).toContain("logs_by_minute");
    expect(sql.attrKeys).toContain("logs_attr_keys_by_minute");
    expect(sql.values).toContain("logs_attr_values_by_minute");
    expect(sql.values).toContain("uniqHLL12");
    expect(sql.values).not.toContain("uniqExact(value)");
    expect(sql.numeric).toContain("logs_attr_numeric_by_minute");
    expect(sql.metricLabels).toContain("FROM metrics");
  });

  test("value tops are scoped to low-cardinality keys", () => {
    expect(fieldsCatalogLogTopsSql(window, [])).toBeNull();
    const scoped = fieldsCatalogLogTopsSql(window, ["status", "path"]);
    expect(scoped).not.toBeNull();
    expect(fieldsCatalogScansLogs(scoped!.sql)).toBe(false);
    expect(scoped!.sql).toContain("key IN");
    expect(scoped!.params.ltk0).toBe("status");
    expect(scoped!.params.ltk1).toBe("path");
    expect(FIELD_TOP_CARD).toBe(1000);
  });
});
