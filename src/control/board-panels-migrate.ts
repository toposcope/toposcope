import type { Database } from "bun:sqlite";
import { formatBoard, parseBoard } from "../shared/boards";
import { parseSavedLayout } from "../shared/widgets";
import { isRelativeRange } from "../query/relative";

/**
 * #410: a board saved before 0.14 held a template query and inputs. It becomes panels on that
 * query, one per widget it had (the pinned plot, its extras, the event table); its inputs stay,
 * and its window becomes the board's window (a relative range; `1h` when it had none).
 */
export function migrateBoardPanels(db: Database): void {
  const rows = db
    .query("SELECT id, query, range, agg, widgets, board FROM saved_searches WHERE board IS NOT NULL AND board != ''")
    .all() as Array<{ id: string; query: string; range: string | null; agg: string | null; widgets: string | null; board: string }>;
  for (const row of rows) {
    let raw: unknown;
    try {
      raw = JSON.parse(row.board) as unknown;
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray((raw as { panels?: unknown }).panels)) {
      continue;
    }
    const board = parseBoard(raw, { query: row.query, widgets: parseSavedLayout(row.widgets), agg: row.agg });
    if (!board) {
      continue;
    }
    const range = row.range && isRelativeRange(row.range) ? row.range : "1h";
    db.query("UPDATE saved_searches SET board = ?, range = ?, from_ts = NULL, to_ts = NULL WHERE id = ?").run(formatBoard(board), range, row.id);
  }
}
