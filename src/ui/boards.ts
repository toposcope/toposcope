import { formatFieldToken } from "./query-tokens";
import { setInputs } from "../shared/boards";

export {
  BOARD_MAX,
  BOARD_PANEL_MAX,
  addBoardPanel,
  bindForBoard,
  boardWatchRefuse,
  defaultPanelName,
  duplicateBoardPanel,
  formatBoard,
  isBoardFieldKey,
  panelViewOf,
  panelWhat,
  parseBoard,
  patchBoardPanel,
  removeBoardPanel,
  setInputs,
  type BoardPanel,
  type BoardPanelView,
  type BoardSlots,
} from "../shared/boards";

/** `key:value` for each set input, as the panel's query line shows them after its own (39c). */
export function inputTokens(keys: string[], bind: Record<string, string>): string {
  return setInputs(keys, bind)
    .map(([key, value]) => formatFieldToken(key, value))
    .join(" ");
}

/**
 * A panel's query with the set inputs ANDed on (#410). A query with an OR at its top is put in
 * parentheses first, so `a OR b` and `region:eu` reads `(a OR b) region:eu`.
 */
export function panelQuery(q: string, keys: string[], bind: Record<string, string>): string {
  const own = q.trim();
  const inputs = inputTokens(keys, bind);
  if (!inputs) {
    return own;
  }
  if (!own) {
    return inputs;
  }
  return `${topLevelOr(own) ? `(${own})` : own} ${inputs}`;
}

function topLevelOr(q: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < q.length; i++) {
    const ch = q[i]!;
    if (ch === '"' && q[i - 1] !== "\\") {
      quoted = !quoted;
    } else if (quoted) {
      continue;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && /\s/.test(q[i - 1] ?? "") && /^or(\s|$)/i.test(q.slice(i, i + 3))) {
      return true;
    }
  }
  return false;
}
