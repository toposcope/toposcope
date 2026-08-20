export type QualifierMenuKind = "field" | "value" | "history" | null;

export function caretWord(
  value: string,
  caret: number,
): {
  word: string;
  start: number;
  colonAt: number;
  openQuote: boolean;
} {
  const pos = Math.max(0, Math.min(caret, value.length));
  const head = value.slice(0, pos);
  const start = head.search(/[^\s()]*$/);
  const word = head.slice(start);
  return {
    word,
    start,
    colonAt: word.indexOf(":"),
    openQuote: (head.split('"').length - 1) % 2 === 1,
  };
}

export function qualifierMenuKind(input: {
  focus: boolean;
  muted: boolean;
  openQuote: boolean;
  word: string;
  colonAt: number;
  forceFields: boolean;
  wantHistory: boolean;
  hasHistory: boolean;
}): QualifierMenuKind {
  if (!input.focus || input.muted || input.openQuote) {
    return null;
  }
  if (input.wantHistory && input.hasHistory) {
    return "history";
  }
  if (input.colonAt >= 0) {
    return "value";
  }
  if (input.word.length > 0 || input.forceFields) {
    return "field";
  }
  return null;
}

/** ↑ opens history when no row is highlighted (value/field menus open with none). */
export function arrowUpOpensHistory(input: {
  openQuote: boolean;
  hasHistory: boolean;
  menuSel: number;
  menuKind: QualifierMenuKind;
}): boolean {
  if (input.openQuote || !input.hasHistory) {
    return false;
  }
  if (input.menuKind === "history") {
    return false;
  }
  return input.menuSel < 0;
}

/** Prefer the previous query, not the one still in the bar. */
export function historyHighlight(history: string[], current: string): number {
  const i = history.findIndex((item) => item !== current);
  return i < 0 ? 0 : i;
}
