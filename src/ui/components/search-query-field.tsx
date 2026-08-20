import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { Search, X } from "lucide-react";
import { compileQuery, tokenizeQuery, type HighlightToken } from "../../query/compile";
import { QueryErrorChip } from "@/components/query-error-chip";
import { cn } from "@/lib/utils";
import {
  arrowUpOpensHistory,
  caretWord,
  historyHighlight,
  qualifierMenuKind,
} from "../search-menu";

const CORE = ["level", "service", "host"] as const;
const MAX_ROWS = 10;
const TOKEN_COLOR: Record<HighlightToken["t"], string> = {
  key: "oklch(0.705 0.015 286.067)",
  val: "oklch(0.985 0 0)",
  op: "#a78bfa",
  str: "#34d399",
  glob: "#fbbf24",
  ws: "oklch(0.985 0 0)",
  text: "oklch(0.985 0 0)",
};

export type MenuSuggestion = {
  label: string;
  insert: string;
  meta: string;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onClear: () => void;
  showFaults: boolean;
  onShowFaults: (show: boolean) => void;
  chipInField: boolean;
  onChipInField: (inField: boolean) => void;
  fields: Array<{ name: string; kind: "field" | "attr" }>;
  loadValues: (field: string, prefix: string) => Promise<MenuSuggestion[]>;
  history: string[];
  onNeedKeys?: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  locked?: boolean;
};

export function SearchQueryField({
  value,
  onChange,
  onCommit,
  onClear,
  showFaults,
  onShowFaults,
  chipInField,
  onChipInField,
  fields,
  loadValues,
  history,
  onNeedKeys,
  inputRef,
  locked = false,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const [scroll, setScroll] = useState(0);
  const [menuSel, setMenuSel] = useState(-1);
  const [menuMuted, setMenuMuted] = useState(false);
  const [menuForce, setMenuForce] = useState(false);
  const [menuHist, setMenuHist] = useState(false);
  const [valueRows, setValueRows] = useState<MenuSuggestion[]>([]);
  const caretTo = useRef<number | null>(null);

  const compiled = compileQuery(value);
  const faults = compiled.faults;
  const faultAt = new Set(faults.map((f) => f.at));
  const tokens = tokenizeQuery(value);
  const qErr = showFaults && faults.length > 0;

  const { word, start: wordStart, colonAt, openQuote } = caretWord(value, caret);
  const menuKind = qualifierMenuKind({
    focus,
    muted: menuMuted,
    openQuote,
    word,
    colonAt,
    forceFields: menuForce,
    wantHistory: menuHist,
    hasHistory: history.length > 0,
  });
  let menuField = "";
  let menuFrom = wordStart;
  let cand: MenuSuggestion[] = [];
  if (menuKind === "history") {
    menuFrom = 0;
    cand = history.map((h) => ({ label: h, insert: h, meta: "" }));
  } else if (menuKind === "value") {
    menuField = word.slice(0, colonAt);
    menuFrom = wordStart + colonAt + 1;
    cand = valueRows;
  } else if (menuKind === "field") {
    const pre = word.toLowerCase();
    cand = fields
      .filter((f) => f.name.startsWith(pre))
      .map((f) => ({ label: `${f.name}:`, insert: `${f.name}:`, meta: f.kind }));
  }
  const rows = cand.slice(0, MAX_ROWS);
  const menuOpen = !locked && menuKind !== null && cand.length > 0;

  const prevMenuKind = useRef(menuKind);
  useEffect(() => {
    if (menuKind === "field" && prevMenuKind.current !== "field") {
      onNeedKeys?.();
    }
    prevMenuKind.current = menuKind;
  }, [menuKind, onNeedKeys]);

  useEffect(() => {
    if (menuKind !== "value" || !menuField) {
      setValueRows([]);
      return;
    }
    const prefix = word.slice(colonAt + 1);
    let cancelled = false;
    void loadValues(menuField, prefix).then((next) => {
      if (!cancelled) {
        setValueRows(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [menuKind, menuField, word, colonAt, loadValues]);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) {
      return;
    }
    const measure = () => {
      const room = el.clientWidth - 180;
      onChipInField(room >= 150);
    };
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, [onChipInField]);

  useLayoutEffect(() => {
    if (caretTo.current == null || !inputRef.current) {
      return;
    }
    const pos = Math.min(caretTo.current, inputRef.current.value.length);
    caretTo.current = null;
    try {
      inputRef.current.setSelectionRange(pos, pos);
    } catch {
      // detached
    }
  });

  function takeAt(i: number): void {
    const row = rows[i];
    if (!row) {
      return;
    }
    const text =
      menuKind === "history"
        ? row.insert
        : value.slice(0, menuFrom) + row.insert + value.slice(caret);
    const pos = menuKind === "history" ? row.insert.length : menuFrom + row.insert.length;
    caretTo.current = pos;
    onChange(text);
    setCaret(pos);
    setMenuSel(-1);
    onShowFaults(false);
    setMenuForce(false);
    setMenuHist(false);
  }

  function openHistory(): void {
    setMenuHist(true);
    setMenuMuted(false);
    setMenuForce(false);
    setFocus(true);
    setMenuSel(historyHighlight(history, value));
  }

  function commit(): void {
    if (compileQuery(value).faults.length > 0) {
      onShowFaults(true);
      setMenuSel(-1);
      setMenuMuted(true);
      return;
    }
    onShowFaults(false);
    setMenuMuted(true);
    setMenuForce(false);
    setMenuHist(false);
    setMenuSel(-1);
    onCommit();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>): void {
    if (locked) {
      e.preventDefault();
      return;
    }
    const n = rows.length;
    if (e.key === "Escape") {
      if (menuOpen) {
        e.preventDefault();
        e.stopPropagation();
        setMenuMuted(true);
        setMenuSel(-1);
        setMenuForce(false);
        setMenuHist(false);
      }
      return;
    }
    const forceFields = () => {
      e.preventDefault();
      setMenuForce(true);
      setMenuMuted(false);
      setMenuHist(false);
      setFocus(true);
      setMenuSel(-1);
      setCaret(e.currentTarget.selectionStart ?? 0);
      onNeedKeys?.();
    };
    if ((e.key === " " || e.code === "Space") && (e.ctrlKey || e.altKey)) {
      forceFields();
      return;
    }
    if (!menuOpen && e.key === "ArrowDown" && word.length === 0) {
      forceFields();
      return;
    }
    if (
      e.key === "ArrowUp" &&
      arrowUpOpensHistory({
        openQuote,
        hasHistory: history.length > 0,
        menuSel,
        menuKind,
      })
    ) {
      e.preventDefault();
      openHistory();
      return;
    }
    if (menuOpen && e.key === "ArrowDown") {
      e.preventDefault();
      setMenuSel((menuSel + 1) % n);
      return;
    }
    if (menuOpen && e.key === "ArrowUp") {
      e.preventDefault();
      setMenuSel(menuSel <= 0 ? n - 1 : menuSel - 1);
      return;
    }
    if (menuOpen && e.key === "Tab") {
      e.preventDefault();
      takeAt(menuSel < 0 ? 0 : menuSel);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (menuOpen && menuSel >= 0) {
        takeAt(menuSel);
      } else {
        commit();
      }
    }
  }

  const menuLeft = Math.max(12, Math.min(40 + menuFrom * 7.8 - scroll, 420));
  const coreValue = (CORE as readonly string[]).includes(menuField);

  return (
    <div
      ref={wrapRef}
      className={cn(
        "relative flex h-8 min-w-[200px] flex-1 items-center gap-1.5 rounded-md border bg-transparent py-0 pr-1.5 pl-2.5",
        qErr
          ? "border-red-500"
          : focus
            ? "border-ring ring-1 ring-ring/35"
            : "border-input",
        locked && "opacity-50",
      )}
    >
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <div className="relative min-w-0 flex-1 self-stretch overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 flex items-center font-mono text-[13px] whitespace-pre"
          style={{ transform: `translateX(${-scroll}px)` }}
        >
          {tokens.map((token, i) => (
            <span
              key={`${token.at}:${i}`}
              style={{
                color: TOKEN_COLOR[token.t],
                textDecoration:
                  qErr && faultAt.has(token.at) ? "underline wavy #ef4444" : undefined,
                textDecorationThickness: qErr && faultAt.has(token.at) ? 1 : undefined,
                textUnderlineOffset: qErr && faultAt.has(token.at) ? 3 : undefined,
              }}
            >
              {token.text}
            </span>
          ))}
        </div>
        {value ? null : (
          <span className="pointer-events-none absolute inset-0 flex items-center font-mono text-[13px] text-muted-foreground/65">
            level:error OR level:fatal status:5*
          </span>
        )}
        <input
          id="search"
          ref={inputRef}
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label="Search query"
          readOnly={locked}
          className="absolute inset-0 m-0 h-full w-full border-none bg-transparent p-0 font-mono text-[13px] text-transparent caret-foreground outline-none"
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setMenuSel(-1);
            setMenuMuted(false);
            onShowFaults(false);
            setFocus(true);
            setMenuForce(false);
            setMenuHist(false);
          }}
          onKeyDown={onKey}
          onKeyUp={(e) => setCaret(e.currentTarget.selectionStart ?? caret)}
          onClick={(e) => setCaret(e.currentTarget.selectionStart ?? caret)}
          onFocus={(e) => {
            setFocus(true);
            setCaret(e.currentTarget.selectionStart ?? value.length);
          }}
          onBlur={() => setFocus(false)}
          onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}
        />
      </div>
      {value || focus || locked ? null : (
        <kbd className="shrink-0 rounded border px-1 font-mono text-[10px] text-muted-foreground">
          /
        </kbd>
      )}
      {qErr && chipInField ? <QueryErrorChip faults={faults} /> : null}
      {value && !locked ? (
        <button
          type="button"
          title="Clear query"
          className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-white/10 text-muted-foreground hover:text-foreground"
          onClick={() => {
            caretTo.current = 0;
            onChange("");
            onShowFaults(false);
            setMenuSel(-1);
            setMenuMuted(false);
            setMenuHist(false);
            inputRef.current?.focus();
            onClear();
          }}
        >
          <X className="size-2.5" strokeWidth={3} />
        </button>
      ) : null}
      {menuOpen ? (
        <div
          className="absolute top-full z-40 mt-1 overflow-hidden rounded-lg border border-white/14 bg-card shadow-xl"
          style={{ left: menuLeft, width: menuKind === "history" ? 420 : 296 }}
        >
          <div className="flex items-center justify-between gap-2 border-b px-2.5 py-1.5">
            <span className="text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              {menuKind === "value"
                ? `${menuField} — values in window`
                : menuKind === "history"
                  ? "recent queries"
                  : "fields"}
            </span>
            <span className="font-mono text-[10.5px] text-muted-foreground/70">
              {menuKind === "value"
                ? coreValue
                  ? "facets"
                  : "attr-values"
                : menuKind === "history"
                  ? "this session"
                  : "attr-keys"}
            </span>
          </div>
          <div className="flex flex-col p-0.5">
            {rows.map((row, i) => (
              <div
                key={`${row.label}:${i}`}
                className={cn(
                  "flex h-[26px] cursor-pointer items-center gap-2 rounded-sm px-1.5 font-mono text-[12.5px]",
                  i === menuSel ? "bg-accent" : "",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  takeAt(i);
                }}
                onMouseEnter={() => setMenuSel(i)}
              >
                <span className="min-w-0 flex-1 truncate">{row.label}</span>
                <span className="shrink-0 text-muted-foreground">{row.meta}</span>
              </div>
            ))}
            {cand.length > MAX_ROWS ? (
              <span className="flex h-6 items-center px-1.5 text-[11.5px] text-muted-foreground/70">
                +{cand.length - MAX_ROWS} more — keep typing to filter
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2.5 border-t px-2.5 py-1 text-[11px] text-muted-foreground">
            <span>
              <span className="font-mono text-foreground">Tab</span> insert
            </span>
            <span>
              <span className="font-mono text-foreground">↑↓</span> move
            </span>
            <span>
              <span className="font-mono text-foreground">Esc</span> dismiss
            </span>
            <span className="ml-auto">
              <span className="font-mono text-foreground">Enter</span>{" "}
              {menuSel >= 0 ? "accept" : "search"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
