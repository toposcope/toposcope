import { describe, expect, test } from "bun:test";
import { LogsScanBudgetError } from "../query/agg";
import { readingMessage } from "./payload";
import { evaluateShareSeries } from "./series";
import { opensWhenWords } from "../shared/monitor";

const saved = { query: "service:billing level:error", range: "5m", from_ts: null, to_ts: null };

describe("a monitor on a share of all rows (#279)", () => {
  test("its search's rows over every row in the window, in percent", async () => {
    const counts = async (f: { q: string }) => (f.q ? 48 : 1000);
    expect(await evaluateShareSeries(saved, counts)).toEqual({ expr: "share", count: 48, value: 4.8, refused: false });
  });
  test("a window with no rows at all is no reading, not 0 %", async () => {
    const r = await evaluateShareSeries(saved, async () => 0);
    expect(r.refused).toBe(true);
    expect(r.reason).toBe("no rows at all in the window");
  });
  test("a refused scan is no reading", async () => {
    const r = await evaluateShareSeries(saved, async () => {
      throw new LogsScanBudgetError("over the read budget");
    });
    expect(r.refused).toBe(true);
  });
  test("its reading and its sentence say percent", () => {
    expect(readingMessage("share", 4.8, 2)).toBe("share of all rows 4.8% ≥ 2%");
    expect(opensWhenWords("at_least", null, 2, "share")).toBe("at least 2% of all rows");
  });
});

import { beforeAll } from "bun:test";
let fields: Record<string, unknown>;
beforeAll(() => {
  // A child process keeps this SQLite out of the other tests.
  const script = `
    const root = ${JSON.stringify(import.meta.dir)} + "/..";
    const { getDb } = await import(root + "/control/index.ts");
    const { readMonitorFields, insertMonitor, getAlert } = await import(root + "/control/alerts.ts");
    const ins = getDb().query("INSERT INTO saved_searches (id, name, query, range, agg, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    ins.run("rows", "Errors on billing", "service:billing level:error", "5m", null, 1);
    ins.run("p99", "Latency", "service:api", "5m", "p99:duration_ms", 1);
    const base = { name: "x", threshold: 2, webhook_url: "https://ntfy.sh/x", measure: "share" };
    const ok = readMonitorFields({ ...base, saved_search_id: "rows" }, null);
    const refused = readMonitorFields({ ...base, saved_search_id: "p99" }, null);
    const bad = readMonitorFields({ ...base, saved_search_id: "rows", measure: "median" }, null);
    const made = insertMonitor(ok);
    console.log(JSON.stringify({ ok: ok.measure, refused, bad, stored: getAlert(made.id).measure }));
  `;
  const child = Bun.spawnSync([process.execPath, "--eval", script], { env: { ...process.env, SQLITE_PATH: ":memory:" }, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) {
    throw new Error(child.stderr.toString());
  }
  fields = JSON.parse(child.stdout.toString().trim().split("\n").at(-1)!);
});

describe("POST /api/alert-rules with a measure (#279)", () => {
  test("share is stored on a search that counts rows, refused on one that plots a series", () => {
    expect(fields.ok).toBe("share");
    expect(fields.stored).toBe("share");
    expect(fields.refused).toEqual({ error: "a share of all rows counts rows: its saved search must count rows, with no series", status: 400 });
    expect(fields.bad).toEqual({ error: "measure must be series or share", status: 400 });
  });
});
