import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { parseChangeMark } from "../shared/change-mark";
import { withFingerprint } from "../shared/fingerprint";
import { compileQuery } from "./compile";
import { cutFingerprintKey, fingerprintCutScans, searchFingerprintCut, withoutFingerprintTerms } from "./fingerprint-cut";
import { search } from "./index";

describe("a fingerprint says which rules made it (#142)", () => {
  test("a sender's e1, e2, … are dropped: only the store's rules make an id", () => {
    const out = withFingerprint("error", "TypeError: x", { e1: "sender", E2: "sender", e10: "sender", e: "kept", e1x: "kept" });
    expect(out?.e1).not.toBe("sender");
    expect(out && "E2" in out).toBe(false);
    expect(out && "e10" in out).toBe(false);
    expect(out?.e).toBe("kept");
    expect(out?.e1x).toBe("kept");
  });

  test("the hunt asks which keys its rows carry without its own id terms", () => {
    const stripped = withoutFingerprintTerms(compileQuery("service:billing (e1:aaaa OR e2:bbbb)"));
    expect(stripped.ast).toEqual(compileQuery("service:billing").ast);
  });

  test("one key reads under it; more than one waits", async () => {
    const w = { beforeFrom: 0, afterFrom: 3_600_000, afterTo: 7_200_000 };
    const keys = (before: string[], after: string[]) => ({ keys: async () => ({ before, after }) });
    expect(await cutFingerprintKey(w, compileQuery(""), keys([], []))).toEqual({ key: "e1" });
    expect(await cutFingerprintKey(w, compileQuery(""), keys(["e2"], ["e2"]))).toEqual({ key: "e2" });
    expect(await cutFingerprintKey(w, compileQuery(""), keys(["e1"], ["e2"]))).toEqual({ revisions: { before: ["e1"], after: ["e2"] } });
    expect(await cutFingerprintKey(w, compileQuery(""), keys(["e1", "e2"], ["e1", "e2"]))).toEqual({
      revisions: { before: ["e1", "e2"], after: ["e1", "e2"] },
    });
  });
});

describe("rows made by two sets of rules, in ClickHouse (#142)", () => {
  const tag = `rev${Date.now().toString(36)}`;
  const service = `billing-${tag}`;
  const now = Date.now();
  const markTs = now - 70 * 60_000;

  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required");
    await migrateStore();
    const row = (ago: number, key: string, hex: string) => ({
      tenant_id: "default",
      ts: toClickHouseDateTime(new Date(now - ago * 60_000).toISOString()),
      service,
      host: "bill-1",
      level: "error",
      message: "TypeError: tax is undefined",
      attrs: JSON.stringify({ [key]: hex }),
      attr_map: { [key]: hex },
      trace_id: "",
    });
    // The same error: e1 before the deploy (an older source), e2 after it (a newer one).
    await clickhouseInsertJsonEachRow(
      [100, 90, 80, 75].map((m) => row(m, "e1", "aaaaaaaaaaaaaaaa"))
        .concat([60, 40, 20, 5].map((m) => row(m, "e2", "bbbbbbbbbbbbbbbb")))
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
  });

  test("never files the same error as both stopped and first seen: the cut waits and says why", async () => {
    const mark = parseChangeMark({ kind: "deploy", title: "v2", service, ts: new Date(markTs).toISOString(), id: `deploy-${tag}` });
    for (const q of [`service:${service}`, `service:${service} e1:aaaaaaaaaaaaaaaa`]) {
      const cut = await searchFingerprintCut({ mark, range: "3h", q, now });
      expect(cut.revisions).toEqual({ before: ["e1"], after: ["e2"] });
      expect(cut.sets).toEqual([]);
    }
  });

  test("the bar finds either id", async () => {
    for (const [key, hex, n] of [["e1", "aaaaaaaaaaaaaaaa", 4], ["e2", "bbbbbbbbbbbbbbbb", 4]] as const) {
      const res = await search({ q: `service:${service} ${key}:${hex}`, range: "3h" } as Parameters<typeof search>[0]);
      expect(res.total).toBe(n);
    }
  });

  test("a side made by one set of rules reads under its key", async () => {
    const sides = await fingerprintCutScans.keys(
      new Date(now - 65 * 60_000).toISOString(),
      new Date(now - 30 * 60_000).toISOString(),
      new Date(now).toISOString(),
      compileQuery(`service:${service}`),
    );
    expect(sides).toEqual({ before: ["e2"], after: ["e2"] });
  });
});
