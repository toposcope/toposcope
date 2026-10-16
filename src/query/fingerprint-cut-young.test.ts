import { beforeAll, describe, expect, test } from "bun:test";
import { clickhouseInsertJsonEachRow, pingClickHouse, toClickHouseDateTime } from "../shared/clickhouse";
import { migrateStore } from "../shared/migrate";
import { parseChangeMark, type ChangeMark } from "../shared/change-mark";
import { fingerprintCutFirstSeen, searchFingerprintCut } from "./fingerprint-cut";
import { requireCompiled } from "./compile";
import { getChangeMarkById } from "./marks";

const minute = 60_000;
const hour = 60 * minute;
const iso = (ms: number) => new Date(ms).toISOString();

async function insertMark(mark: ChangeMark): Promise<void> {
  await clickhouseInsertJsonEachRow(
    JSON.stringify({
      tenant_id: "default",
      ts: toClickHouseDateTime(mark.ts),
      kind: mark.kind,
      service: mark.service,
      title: mark.title,
      attrs: mark.attrs,
      id: mark.id,
      end_ts: null,
    }),
    "change_marks",
  );
}

describe("a young deploy's cut ClickHouse (#111)", () => {
  beforeAll(async () => {
    process.env.CLICKHOUSE_USER ??= "default";
    process.env.CLICKHOUSE_PASSWORD ??= "toposcope";
    if (!(await pingClickHouse())) throw new Error("ClickHouse is required for the young-deploy cut");
    await migrateStore();
  });

  test(
    "compares 30 minutes with the hour before, holds Stopped, and names the later deploys",
    async () => {
      const service = `cutyoung${Date.now()}`;
      // The cut names every mark inside its sides, so stand clear of the marks other tests write near now:
      // a stretch of its own two to four days back, well inside any retention.
      const now = Math.floor(Date.now() / minute) * minute - 48 * hour - Math.floor(Math.random() * 400) * 7 * minute;
      const markTs = now - 30 * minute;
      const mark = parseChangeMark({ id: `mk_${service}_a`, kind: "deploy", service, title: "v0.9.1", ts: iso(markTs) });
      const second = parseChangeMark({ id: `mk_${service}_b`, kind: "deploy", service, title: "v0.9.2", ts: iso(now - 20 * minute) });
      const third = parseChangeMark({ id: `mk_${service}_c`, kind: "deploy", service, title: "v0.9.3", ts: iso(now - 10 * minute) });
      for (const m of [mark, second, third]) await insertMark(m);
      const rows: Array<[number, string]> = [
        // seen 40 minutes before the mark: inside the hour, so still here, not first seen
        [markTs - 40 * minute, "1111111111111111"],
        [markTs + 5 * minute, "1111111111111111"],
        // first after the third deploy
        [now - 8 * minute, "2222222222222222"],
        // first before the second deploy
        [markTs + 2 * minute, "3333333333333333"],
        // before only: Stopped waits, so it is not called
        [markTs - 10 * minute, "4444444444444444"],
      ];
      await clickhouseInsertJsonEachRow(
        rows
          .map(([ts, hex]) =>
            JSON.stringify({ tenant_id: "default", ts: toClickHouseDateTime(iso(ts)), service, host: "api-1", level: "error", message: `${service} ${hex}`, attrs: JSON.stringify({ e1: hex }), attr_map: { e1: hex }, trace_id: "" }),
          )
          .join("\n"),
      );
      let stored = await getChangeMarkById(mark.id);
      for (let i = 0; i < 20 && !stored; i++) {
        await Bun.sleep(50);
        stored = await getChangeMarkById(mark.id);
      }
      const run = () =>
        searchFingerprintCut({ mark: stored!, q: `service:${service}`, from: iso(now - 2 * hour), to: iso(now), opened: iso(now) });
      let result = await run();
      for (let i = 0; i < 20 && (result.windows.inside.filter((m) => m.id.startsWith(`mk_${service}`)).length < 2 || result.sets.length === 0); i++) {
        await Bun.sleep(50);
        result = await run();
      }
      const set = (id: string) => result.sets.find((s) => s.id === id);
      const hexes = (id: string) => (set(id)?.rows.map((r) => r.hex) ?? []).sort();

      expect(result.windows.sideMs).toBe(30 * minute);
      expect(result.windows.beforeMs).toBe(hour);
      expect(result.windows.beforeFrom).toBe(iso(markTs - hour));
      expect(result.windows.waiting).toBe(true);

      expect(hexes("first_seen")).toEqual(["2222222222222222", "3333333333333333"]);
      expect(set("first_seen")?.def).toBe("after the cut, not in the hour before");
      expect(hexes("still_here")).toEqual(["1111111111111111"]);
      expect(set("stopped")?.rows).toEqual([]);
      expect(set("stopped")?.waiting).toEqual({ haveMs: 30 * minute, needMs: hour });

      const follows = Object.fromEntries((set("first_seen")?.rows ?? []).map((r) => [r.hex, r.follows]));
      expect(follows["2222222222222222"]).toBe("after v0.9.3");
      expect(follows["3333333333333333"]).toBe("");

      const ours = result.windows.inside.filter((m) => m.id.startsWith(`mk_${service}`));
      expect(ours.map((m) => [m.title, m.side, m.label])).toEqual([
        ["v0.9.2", "after", `deployed: ${service} v0.9.2`],
        ["v0.9.3", "after", `deployed: ${service} v0.9.3`],
      ]);
      expect(result.notes.some((n) => n.startsWith("The sides differ until the after side has an hour: counts read 1h before → 30m after."))).toBe(true);

      // The first-seen alert (#107) reads the same windows, every row: the e1 seen in the hour
      // before the mark is not new.
      const forAlert = await fingerprintCutFirstSeen({ mark: stored!, compiled: requireCompiled(`service:${service}`), now });
      expect(forAlert.refused).toBeNull();
      expect(forAlert.windows.beforeMs).toBe(hour);
      expect(forAlert.firstSeen.map((r) => r.hex).sort()).toEqual(["2222222222222222", "3333333333333333"]);
    },
    { timeout: 15_000 },
  );
});
