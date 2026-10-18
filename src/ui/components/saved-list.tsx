import { useEffect, useMemo, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bell, ChevronRight, House, MoreHorizontal, Search, X } from "lucide-react";
import { CountText } from "@/components/count-text";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AlertRule, SavedSearch } from "@/types";
import { boardWatchRefuse } from "../boards";
import {
  filterPast,
  filterSaved,
  groupOpen,
  groupSaved,
  kindCounts,
  kindWords,
  matchIn,
  narrowedNote,
  noMatchLine,
  savedKind,
  type SavedEntry,
  type SavedKind,
  type SavedRow,
} from "../saved-list";

type Props = {
  saved: SavedSearch[];
  alerts: AlertRule[];
  counts: Record<string, number>;
  activeSavedId: string | null;
  homeId: string | null;
  elsewhere: Record<string, number>;
  savedFloor?: (item: SavedSearch) => boolean;
  onApplySaved: (item: SavedSearch) => void;
  onTest: (id: string) => void;
  onAlert: (item: SavedSearch) => void;
  onSetHome: (id: string | null) => void;
  onDeleteSaved: (id: string) => void;
};

const openKey = "toposcope.savedGroups";

function readOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(openKey);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function writeOpen(value: Record<string, boolean>): void {
  try {
    localStorage.setItem(openKey, JSON.stringify(value));
  } catch {
    // A browser that keeps nothing still shows the list; groups just start as their default.
  }
}

function SlidersIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}

function SquaresIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className={className} aria-hidden="true">
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h8" />
    </svg>
  );
}

const kindIcon: Record<SavedKind, { icon: (cls: string) => ReactNode; label: string }> = {
  watched: { icon: (cls) => <Bell className={cls} aria-hidden="true" />, label: "An alert watches it" },
  board: { icon: (cls) => <SlidersIcon className={cls} />, label: "A board" },
  panels: { icon: (cls) => <SquaresIcon className={cls} />, label: "Kept for its panels" },
};

/** The text with the filter's match marked (16d). */
function Marked({ text, find }: { text: string; find: string }) {
  const at = matchIn(text, find);
  if (!at) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, at.start)}
      <mark className="rounded-[2px] bg-plate/25 text-foreground">{text.slice(at.start, at.end)}</mark>
      {text.slice(at.end)}
    </>
  );
}

type Card = { item: SavedSearch; top: number; left: number };

/** The metrics a search kept for its panels draws, for its card (16h). */
function panelMetrics(item: SavedSearch): string[] {
  const names = (item.widgets?.widgets ?? []).map((w) => w.metric).filter((m): m is string => Boolean(m));
  return [...new Set(names)];
}

/** Beside the sidebar, over the plot, never over the list (16g). */
function SavedCard({
  card,
  kind,
  alerts,
  count,
  floor,
  other,
  home,
}: {
  card: Card;
  kind: SavedKind | null;
  alerts: AlertRule[];
  count: number | undefined;
  floor: boolean;
  other: number;
  home: boolean;
}) {
  const { item } = card;
  const watching = alerts.filter((rule) => rule.saved_search_id === item.id);
  const metrics = kind === "panels" ? panelMetrics(item) : [];
  const facts: Array<[string, string]> = [];
  if (item.board) {
    facts.push(["Board", `inputs ${item.board.keys.join(", ")}${item.board.win ? " and the window" : ""}`]);
    facts.push(["Opens", "locked; only its inputs change"]);
  } else {
    const matching = count === undefined || kind === "panels" ? "" : ` · ${floor ? "≥" : ""}${Math.round(count).toLocaleString("en-US")} matching`;
    facts.push(["Range", `${item.range ? `Last ${item.range}` : "custom"}${matching}`]);
    if (metrics.length > 0) {
      facts.push(["Panels", metrics.join(", ")]);
    }
  }
  if (watching.length > 0) {
    facts.push([
      "Watched by",
      watching
        .map((rule) => (rule.kind === "first_seen" ? `${rule.name} · new fingerprints` : `${rule.name} · at or above ${rule.threshold}`))
        .join("; "),
    ]);
  }
  if (other > 0) {
    facts.push(["Also open", `in ${other} other tab${other === 1 ? "" : "s"}`]);
  }
  if (home) {
    facts.push(["Home", "the bare address opens on it"]);
  }
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 flex w-[300px] flex-col gap-2.5 rounded-lg border border-white/14 bg-[#18181b] px-3.5 py-3 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]"
      style={{ top: card.top, left: card.left }}
    >
      <div className="text-[13.5px] leading-snug font-semibold [overflow-wrap:anywhere]">{item.name}</div>
      {!item.board && item.query ? (
        <div className="rounded-md border border-white/10 bg-[#0a0a0c] px-2 py-1.5 font-mono text-[12px] leading-snug [overflow-wrap:anywhere]">
          {item.query}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5 text-[12px] leading-snug">
        {facts.map(([k, v]) => (
          <div key={k} className="flex gap-2.5">
            <span className="w-[74px] shrink-0 text-muted-foreground">{k}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">{v}</span>
          </div>
        ))}
      </div>
      <div className="h-px bg-white/8" />
      <div className="text-[11.5px] text-muted-foreground">Opens a new tab · this one stays as it is</div>
    </div>,
    document.body,
  );
}

export function SavedList({
  saved,
  alerts,
  counts,
  activeSavedId,
  homeId,
  elsewhere,
  savedFloor,
  onApplySaved,
  onTest,
  onAlert,
  onSetHome,
  onDeleteSaved,
}: Props) {
  const [find, setFind] = useState("");
  const [only, setOnly] = useState<SavedKind | null>(null);
  const [opened, setOpened] = useState<Record<string, boolean>>(readOpen);
  const [card, setCard] = useState<Card | null>(null);

  const kindOf = useMemo(() => {
    const kinds = new Map(saved.map((item) => [item.id, savedKind(item, alerts)]));
    return (item: SavedSearch) => kinds.get(item.id) ?? null;
  }, [saved, alerts]);
  const kinds = useMemo(() => kindCounts(saved, kindOf), [saved, kindOf]);
  const showFilter = saved.length > filterPast;
  const narrowing = showFilter && (find.trim() !== "" || only !== null);
  const shown = useMemo(
    () => (narrowing ? filterSaved(saved, find, only, kindOf) : saved),
    [narrowing, saved, find, only, kindOf],
  );
  // Groups come from the whole list, so a filter that leaves one row of a group keeps it under its line (16d).
  const whole = useMemo(() => groupSaved(saved), [saved]);
  const entries = useMemo(() => {
    if (!narrowing) {
      return whole;
    }
    const keep = new Set(shown.map((item) => item.id));
    return whole.flatMap((entry): SavedEntry[] => {
      if (entry.type === "row") {
        return keep.has(entry.row.item.id) ? [entry] : [];
      }
      const rows = entry.rows.filter((row) => keep.has(row.item.id));
      return rows.length > 0 ? [{ ...entry, rows }] : [];
    });
  }, [whole, narrowing, shown]);
  const groupSizes = useMemo(() => {
    const sizes = new Map<string, number>();
    for (const entry of whole) {
      if (entry.type === "group") {
        sizes.set(entry.prefix, entry.rows.length);
      }
    }
    return sizes;
  }, [whole]);
  const slot = kinds.length > 0;
  // With nothing left, the no-match lines say it instead (16e).
  const note = showFilter && shown.length > 0 ? narrowedNote(shown.length, saved.length, only, find) : null;

  useEffect(() => {
    if (only && !kinds.some((k) => k.kind === only)) {
      setOnly(null);
    }
  }, [kinds, only]);

  const toggleGroup = (prefix: string, open: boolean) => {
    const next = { ...opened, [prefix]: !open };
    setOpened(next);
    writeOpen(next);
  };

  const showCard = (item: SavedSearch) => (event: MouseEvent<HTMLElement> | FocusEvent<HTMLElement>) => {
    const row = event.currentTarget.getBoundingClientRect();
    const aside = event.currentTarget.closest("aside")?.getBoundingClientRect();
    const top = Math.max(8, Math.min(row.top - 4, window.innerHeight - 260));
    setCard({ item, top, left: (aside?.right ?? row.right) + 8 });
  };
  const hideCard = () => setCard(null);

  const onRowKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      hideCard();
    }
  };

  const renderRow = ({ item, text }: SavedRow) => {
    const kind = kindOf(item);
    const count = counts[item.id];
    const other = elsewhere[item.id] ?? 0;
    const refuse = item.board
      ? boardWatchRefuse({ query: item.query, range: item.range, board: item.board ?? null })
      : null;
    const countless = Boolean(item.board) || kind === "panels";
    return (
      <li
        key={item.id}
        className={`group relative flex min-w-0 items-start rounded-md ${
          activeSavedId === item.id ? "bg-accent" : "hover:bg-accent/60"
        } focus-within:ring-1 focus-within:ring-plate/70`}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-1.5 py-[5px] pr-1 pl-1.5 text-left outline-none"
          onClick={() => onApplySaved(item)}
          onMouseEnter={showCard(item)}
          onMouseLeave={hideCard}
          onFocus={showCard(item)}
          onBlur={hideCard}
          onKeyDown={onRowKey}
        >
          {slot ? (
            <span className="flex h-4 w-3 shrink-0 items-center justify-center text-muted-foreground">
              {kind ? (
                <span role="img" aria-label={kindIcon[kind].label} className="flex">
                  {kindIcon[kind].icon("size-3")}
                </span>
              ) : null}
            </span>
          ) : null}
          {homeId === item.id ? (
            <span className="flex h-4 shrink-0 items-center">
              <House aria-label="Home" className="size-3 text-plate" />
            </span>
          ) : null}
          <span className="line-clamp-2 min-w-0 flex-1 text-[13px] leading-4 [overflow-wrap:anywhere]">
            <Marked text={text} find={narrowing ? find : ""} />
          </span>
          {other > 0 ? (
            <span className="flex h-4 shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground/70 group-focus-within:invisible group-hover:invisible">
              <CopyIcon />
              {other}
            </span>
          ) : null}
          <span className="flex h-4 min-w-6 shrink-0 items-center justify-end font-mono text-[11px] tabular-nums text-muted-foreground group-focus-within:invisible group-hover:invisible">
            {countless || count === undefined ? null : <CountText n={count} floor={savedFloor?.(item) ?? false} />}
          </span>
        </button>
        <span className="absolute top-0.5 right-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
          {item.board ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              title={refuse ?? undefined}
              aria-label={`More for ${item.name}`}
              className="size-6 cursor-default opacity-35"
            >
              <MoreHorizontal />
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" size="icon" variant="ghost" aria-label={`More for ${item.name}`} className="size-6">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onTest(item.id)}>Test</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onAlert(item)}>Alert on this</DropdownMenuItem>
                <DropdownMenuItem
                  className="h-auto flex-col items-start gap-0.5 py-1.5"
                  onSelect={() => onSetHome(homeId === item.id ? null : item.id)}
                >
                  <span className="flex items-center gap-1.5">
                    <House className="size-3.5 text-plate" />
                    {homeId === item.id ? "Unset Home" : "Set as Home"}
                  </span>
                  <span className="pl-5 text-[11.5px] text-muted-foreground">
                    {homeId === item.id ? "The bare address opens on All logs" : "The bare address opens on this search"}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onDeleteSaved(item.id)}>Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </li>
    );
  };

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[12px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">Saved</h2>
        <span className="font-mono text-[11px] text-muted-foreground/60">{saved.length}</span>
      </div>
      {saved.length === 0 ? <p className="text-xs text-muted-foreground">Save a search from the bar.</p> : null}
      {showFilter ? (
        <div className="mb-1 flex gap-1">
          <label
            className={`flex h-[26px] min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-[#0a0a0c] pr-1 pl-2 ${
              find.trim() ? "border-plate/55" : "border-white/12"
            }`}
          >
            <Search className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            <input
              type="text"
              value={find}
              onChange={(event) => setFind(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFind("");
                }
              }}
              aria-label="Filter saved searches by name"
              placeholder={`Filter ${only ? shown.length : saved.length} by name`}
              className="min-w-0 flex-1 bg-transparent p-0 text-[12.5px] outline-none placeholder:text-muted-foreground/70"
            />
            {find ? (
              <button
                type="button"
                aria-label="Clear the filter"
                className="flex size-[18px] shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => setFind("")}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </label>
          {kinds.map(({ kind, n }) => (
            <button
              key={kind}
              type="button"
              aria-pressed={only === kind}
              aria-label={kindWords[kind].only(n)}
              title={kindWords[kind].only(n)}
              onClick={() => setOnly(only === kind ? null : kind)}
              className={`flex h-[26px] shrink-0 items-center gap-[3px] rounded-md border px-1.5 font-mono text-[11px] ${
                only === kind ? "border-plate/55 bg-plate/14 text-plate" : "border-white/12 bg-[#0a0a0c] text-muted-foreground"
              }`}
            >
              {kindIcon[kind].icon("size-[11px]")}
              {n}
            </button>
          ))}
        </div>
      ) : null}
      {note ? <div className="px-1.5 pt-1 pb-0.5 text-[11.5px] leading-snug text-muted-foreground">{note}</div> : null}
      {narrowing && shown.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-1.5 pt-2.5 pb-1">
          <p className="text-[12.5px] leading-snug text-foreground/85">{noMatchLine(find, only)}</p>
          {find.trim() ? <p className="text-[11.5px] leading-snug text-muted-foreground">The filter reads names, not queries.</p> : null}
          <button
            type="button"
            className="h-[26px] rounded-md border border-white/14 bg-[#18181b] px-2.5 text-[12px]"
            onClick={() => {
              setFind("");
              setOnly(null);
            }}
          >
            Clear filter
          </button>
        </div>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {entries.map((entry) => {
          if (entry.type === "row") {
            return renderRow(entry.row);
          }
          const open = narrowing || groupOpen(entry.prefix, saved.length, opened);
          const bells = entry.rows.filter((row) => kindOf(row.item) === "watched").length;
          const size = groupSizes.get(entry.prefix) ?? entry.rows.length;
          return (
            <li key={`group:${entry.prefix}`} className="mt-1.5 flex flex-col gap-0.5">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => toggleGroup(entry.prefix, open)}
                className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] text-muted-foreground hover:bg-accent/60"
              >
                <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-foreground/80">
                  <Marked text={entry.prefix} find={narrowing ? find : ""} />
                </span>
                {bells > 0 ? (
                  <span className="flex shrink-0 items-center gap-0.5 font-mono text-[10.5px]" title={`${bells} watched by an alert`}>
                    <Bell className="size-2.5" aria-hidden="true" />
                    {bells}
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">
                  {entry.rows.length === size ? size : `${entry.rows.length} of ${size}`}
                </span>
              </button>
              {open ? <ul className="flex flex-col gap-0.5">{entry.rows.map(renderRow)}</ul> : null}
            </li>
          );
        })}
      </ul>
      {card ? (
        <SavedCard
          card={card}
          kind={kindOf(card.item)}
          alerts={alerts}
          count={counts[card.item.id]}
          floor={savedFloor?.(card.item) ?? false}
          other={elsewhere[card.item.id] ?? 0}
          home={homeId === card.item.id}
        />
      ) : null}
    </div>
  );
}
