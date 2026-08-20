import { useState } from "react";
import { Bell, MoreHorizontal, Plus } from "lucide-react";
import { CountText } from "@/components/count-text";
import { FacetGroup } from "@/components/facet-group";
import { BoardInputs, type BoardFieldBind } from "@/components/board-inputs";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import type {
  AlertRule,
  FacetField,
  FacetValue,
  Facets,
  SavedSearch,
} from "@/types";
import { maxAttrFacets } from "../../shared/attrs";
import { boardWatchRefuse } from "../boards";

const facetFields: FacetField[] = ["level", "service", "host"];

type AttrKey = { k: string; n: number };

type Props = {
  saved: SavedSearch[];
  alerts: AlertRule[];
  counts: Record<string, number>;
  activeSavedId: string | null;
  elsewhere: Record<string, number>;
  facets: Facets;
  activeFacets: Partial<Record<string, string | string[]>>;
  facetsLoading: boolean;
  attrPins: string[];
  attrFacetValues: Record<string, FacetValue[]>;
  attrFacetsLoading: boolean;
  attrPrefixes: Record<string, string>;
  attrKeys: AttrKey[];
  attrKeysLoading: boolean;
  onToggleFacet: (field: string, value: string) => void;
  onOnlyFacet: (field: string, value: string) => void;
  onClearFacet: (field: string) => void;
  onAddAttrFacet: (key: string) => void;
  onRemoveAttrFacet: (key: string) => void;
  onAttrPrefix: (key: string, prefix: string) => void;
  onOpenAddFacet: () => void;
  onApplySaved: (item: SavedSearch) => void;
  onTest: (id: string) => void;
  onAlert: (item: SavedSearch) => void;
  onDeleteSaved: (id: string) => void;
  frozen?: boolean;
  frozenNote?: string;
  templateLocked?: boolean;
  board?: {
    capLabel: string;
    fields: BoardFieldBind[];
    windowLabel: string | null;
    onPick: (key: string, value: string) => void;
    onWindow: () => void;
  } | null;
};

export function OperatorSidebar({
  saved,
  alerts,
  counts,
  activeSavedId,
  elsewhere,
  facets,
  activeFacets,
  facetsLoading,
  attrPins,
  attrFacetValues,
  attrFacetsLoading,
  attrPrefixes,
  attrKeys,
  attrKeysLoading,
  onToggleFacet,
  onOnlyFacet,
  onClearFacet,
  onAddAttrFacet,
  onRemoveAttrFacet,
  onAttrPrefix,
  onOpenAddFacet,
  onApplySaved,
  onTest,
  onAlert,
  onDeleteSaved,
  frozen = false,
  frozenNote,
  templateLocked = false,
  board = null,
}: Props) {
  const [keyFilter, setKeyFilter] = useState("");
  const pinned = new Set(attrPins);
  const addable = attrKeys.filter((item) => {
    if (pinned.has(item.k)) {
      return false;
    }
    if (!keyFilter.trim()) {
      return true;
    }
    return item.k.includes(keyFilter.trim().toLowerCase());
  });
  const facetsLocked = frozen || templateLocked;

  return (
    <div className="flex min-w-0 flex-col">
        {board ? (
          <BoardInputs
            capLabel={board.capLabel}
            fields={board.fields}
            windowLabel={board.windowLabel}
            onPick={board.onPick}
            onWindow={board.onWindow}
          />
        ) : null}
        {frozen ? (
          <div className="flex flex-col gap-0.5 border-b bg-white/[0.03] px-3 py-2.5">
            <span className="text-[12px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Frozen scope
            </span>
            <span className="text-[11.5px] leading-snug text-pretty text-muted-foreground/85">
              {frozenNote ??
                "Carried in from the tab this was opened from. The facets below report it; Saved still opens a new Search tab."}
            </span>
          </div>
        ) : null}
        <div className="p-3">
          <div className="mb-1.5 flex items-center justify-between">
            <h2 className="text-[12px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Saved
            </h2>
            <span className="font-mono text-[11px] text-muted-foreground/60">
              {saved.length}
            </span>
          </div>
          {saved.length === 0 ? (
            <p className="text-xs text-muted-foreground">Save a search from the bar.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {saved.map((item) => {
                const watched = alerts.some((rule) => rule.saved_search_id === item.id);
                const count = counts[item.id];
                const isBoard = Boolean(item.board);
                const other = elsewhere[item.id] ?? 0;
                const slots = item.board
                  ? `${item.board.keys.join(", ")}${item.board.win ? " + window" : ""}`
                  : "";
                const rowTitle = isBoard
                  ? `Board · ${slots} — opens locked, only its inputs change. Opens a new tab · this one stays as it is.`
                  : `${item.query || "all logs"} · ${item.range ?? "custom"} — opens a new tab · this one stays as it is.`;
                const refuse = isBoard
                  ? boardWatchRefuse({
                      query: item.query,
                      range: item.range,
                      board: item.board ?? null,
                    })
                  : null;
                return (
                  <li
                    key={item.id}
                    className={`flex min-w-0 items-center gap-0.5 rounded-md ${
                      activeSavedId === item.id ? "bg-accent" : "hover:bg-accent/60"
                    }`}
                  >
                    <button
                      type="button"
                      title={rowTitle}
                      className="flex min-w-0 flex-1 items-center gap-1.5 py-[5px] pr-0 pl-1.5 text-left"
                      onClick={() => onApplySaved(item)}
                    >
                      {isBoard ? (
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          className="shrink-0 text-muted-foreground"
                        >
                          <path d="M4 7h9" />
                          <path d="M17 7h3" />
                          <path d="M4 17h3" />
                          <path d="M11 17h9" />
                          <circle cx="15" cy="7" r="2" />
                          <circle cx="9" cy="17" r="2" />
                        </svg>
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[13px]">{item.name}</span>
                      {other > 0 ? (
                        <span
                          title={`Also open in ${other} other tab${other === 1 ? "" : "s"}`}
                          className="flex shrink-0 items-center gap-0.5 font-mono text-[10px] text-muted-foreground/70"
                        >
                          <svg
                            width="9"
                            height="9"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.4"
                          >
                            <rect x="9" y="9" width="12" height="12" rx="2" />
                            <path d="M5 15V5a2 2 0 0 1 2-2h8" />
                          </svg>
                          {other}
                        </span>
                      ) : null}
                      {watched ? (
                        <Bell className="size-3 shrink-0 text-muted-foreground" />
                      ) : null}
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {count === undefined ? "—" : <CountText n={count} />}
                      </span>
                    </button>
                    {isBoard ? (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title={refuse ?? undefined}
                        className="mr-0.5 size-6 cursor-default opacity-35"
                      >
                        <MoreHorizontal />
                      </Button>
                    ) : (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button type="button" size="icon" variant="ghost" className="mr-0.5 size-6">
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => onTest(item.id)}>
                            Test
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => onAlert(item)}>
                            Alert on this
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => onDeleteSaved(item.id)}>
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className={`mx-3 h-px bg-border ${facetsLocked ? "pointer-events-none opacity-50" : ""}`} />
        <div className={facetsLocked ? "pointer-events-none opacity-50" : ""}>
        {facetFields.map((field) => (
          <div key={field} className="p-3">
            <FacetGroup
              field={field}
              values={facets[field]}
              active={activeFacets[field]}
              loading={facetsLoading}
              onToggle={onToggleFacet}
              onOnly={onOnlyFacet}
              onClear={onClearFacet}
            />
          </div>
        ))}
        {attrPins.map((field) => (
          <div key={field} className="p-3">
            <FacetGroup
              field={field}
              values={attrFacetValues[field] ?? []}
              active={activeFacets[field]}
              loading={attrFacetsLoading && !attrFacetValues[field]}
              onToggle={onToggleFacet}
              onOnly={onOnlyFacet}
              onClear={onClearFacet}
              onRemove={() => onRemoveAttrFacet(field)}
              prefix={attrPrefixes[field] ?? ""}
              onPrefixChange={(value) => onAttrPrefix(field, value)}
            />
          </div>
        ))}
        <div className="p-3">
          <DropdownMenu
            onOpenChange={(open) => {
              if (open) {
                onOpenAddFacet();
              }
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                disabled={attrPins.length >= maxAttrFacets}
              >
                <Plus className="size-3" />
                Add facet
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <div className="p-1">
                <Input
                  className="h-7 font-mono text-[11px]"
                  placeholder="filter keys…"
                  value={keyFilter}
                  onChange={(e) => setKeyFilter(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
              {attrKeysLoading && addable.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading keys…</p>
              ) : addable.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No attr keys in this window.</p>
              ) : (
                addable.slice(0, 40).map((item) => (
                  <DropdownMenuItem
                    key={item.k}
                    className="font-mono text-[12px]"
                    onSelect={() => onAddAttrFacet(item.k)}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.k}</span>
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      <CountText n={item.n} />
                    </span>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        </div>
      </div>
  );
}
