import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateControlDb } from "./index";
import { parseBoard } from "../shared/boards";

describe("#410: a board saved before 0.14 becomes panels", () => {
  test("one panel per widget on the template query; inputs stay; its window becomes the board's", () => {
    const db = new Database(":memory:");
    migrateControlDb(db);
    const widgets = JSON.stringify({
      logs: true,
      widgets: [
        { id: "a", kind: "timeseries", x: 0, y: 0, w: 8, h: 4, split: "level" },
        { id: "b", kind: "stat", x: 8, y: 0, w: 4, h: 4, agg: "p99:duration_ms" },
        { id: "c", kind: "hbar", x: 0, y: 4, w: 6, h: 4, attr: "status", n: 5 },
      ],
    });
    db.query("INSERT INTO saved_searches (id, name, query, range, widgets, board, created_at) VALUES ('b1', 'Checkout board', 'service:checkout', '4h', ?, ?, 1)").run(
      widgets,
      JSON.stringify({ keys: ["host"], win: true }),
    );
    db.query("INSERT INTO saved_searches (id, name, query, from_ts, to_ts, board, created_at) VALUES ('b2', 'Old', 'level:error', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', ?, 2)").run(
      JSON.stringify({ keys: ["service"], win: false }),
    );
    db.query("INSERT INTO saved_searches (id, name, query, created_at) VALUES ('h1', 'A hunt', 'service:api', 3)").run();
    migrateControlDb(db);
    const rows = db.query("SELECT id, range, from_ts, board FROM saved_searches ORDER BY id").all() as Array<{ id: string; range: string | null; from_ts: string | null; board: string | null }>;
    const b1 = parseBoard(rows[0]!.board)!;
    expect(rows[0]!.range).toBe("4h");
    expect(b1.keys).toEqual(["host"]);
    expect(b1.panels.map((p) => [p.view, p.q, p.widget.x, p.widget.y, p.widget.w])).toEqual([
      ["histogram", "service:checkout", 0, 0, 8],
      ["stat", "service:checkout", 8, 0, 4],
      ["top", "service:checkout", 0, 4, 6],
      ["events", "service:checkout", 0, 8, 12],
    ]);
    expect(rows[1]!.range).toBe("1h");
    expect(rows[1]!.from_ts).toBeNull();
    expect(parseBoard(rows[1]!.board)!.panels.map((p) => p.view)).toEqual(["histogram", "events"]);
    expect(rows[2]!.board).toBeNull();
    // A second boot leaves it as it is.
    const before = rows[0]!.board;
    migrateControlDb(db);
    expect((db.query("SELECT board FROM saved_searches WHERE id = 'b1'").get() as { board: string }).board).toBe(before!);
  });
});
