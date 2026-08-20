import { setFieldToken, stripSlotKeys } from "./query-tokens";

export {
  BOARD_MAX,
  bindForBoard,
  boardSlotCount,
  boardWatchRefuse,
  formatBoard,
  isBoardFieldKey,
  isBoardUnbound,
  parseBoard,
  type BoardSlots,
} from "../shared/boards";

export { queryFieldKeys, stripSlotKeys } from "./query-tokens";

export function boundQuery(
  template: string,
  bind: Record<string, string>,
): string {
  let q = template.trim();
  for (const [key, value] of Object.entries(bind)) {
    if (value.trim().length === 0) {
      continue;
    }
    q = setFieldToken(q, key, value);
  }
  return q;
}

export function storedBoardQuery(
  q: string,
  keys: string[],
): string {
  return stripSlotKeys(q, keys).trim();
}
