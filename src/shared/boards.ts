import { isAttrIdent } from "./attrs";
import { isCoreField } from "../query/compile";

export const BOARD_MAX = 4;

export type BoardSlots = {
  keys: string[];
  win: boolean;
};

export function parseBoard(raw: unknown): BoardSlots | null {
  let value = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return null;
    }
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const rec = value as Record<string, unknown>;
  const keys: string[] = [];
  if (Array.isArray(rec.keys)) {
    for (const item of rec.keys) {
      if (typeof item !== "string") {
        continue;
      }
      const key = item.trim().toLowerCase();
      if (!isBoardFieldKey(key) || keys.includes(key)) {
        continue;
      }
      keys.push(key);
    }
  }
  const win = rec.win === true;
  if (keys.length === 0 && !win) {
    return null;
  }
  while (keys.length + (win ? 1 : 0) > BOARD_MAX) {
    keys.pop();
  }
  return { keys, win };
}

export function formatBoard(board: BoardSlots | null): string | null {
  if (!board) {
    return null;
  }
  return JSON.stringify({ keys: board.keys, win: board.win });
}

export function isBoardFieldKey(key: string): boolean {
  return isCoreField(key) || isAttrIdent(key);
}

export function boardSlotCount(board: BoardSlots): number {
  return board.keys.length + (board.win ? 1 : 0);
}

export function isBoardUnbound(
  board: BoardSlots,
  bind: Record<string, string>,
): boolean {
  return board.keys.some((key) => (bind[key] ?? "").trim().length === 0);
}

export function bindForBoard(
  candidates: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = candidates[key];
    if (value && value.trim().length > 0) {
      out[key] = value;
    }
  }
  return out;
}

export function boardWatchRefuse(saved: {
  query: string;
  range: string | null;
  board: BoardSlots | null;
}): string {
  const q = saved.query.trim() || "all logs";
  const range = saved.range ?? "the window";
  const holes =
    saved.board && saved.board.keys.length > 0
      ? saved.board.keys.join(" and ")
      : "its inputs";
  return `Boards cannot be watched — an alert would run ${q} over ${range} with ${holes} unset, which is wider than anything this board shows. Save it as a plain search first.`;
}
