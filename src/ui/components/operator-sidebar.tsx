import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { CountText } from "@/components/count-text";
import { FacetGroup } from "@/components/facet-group";
import { SavedList } from "@/components/saved-list";
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

const facetFields: FacetField[] = ["level", "service", "host"];

type AttrKey = { k: string; n: number };

type Props = {
  saved: SavedSearch[];
  alerts: AlertRule[];
  counts: Record<string, number>;
  activeSavedId: string | null;
  /** The saved search the bare address opens on (#109). */
  homeId: string | null;
  onSetHome: (id: string | null) => void;
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
  /** What this instance holds (#139): the toposcope group, second only to the view's own scope. */
  toposcope?: ReactNode;
  /** A facet value's count a short source could feed (#139). */
  facetFloor?: (field: string, value: string) => boolean;
  /** A saved search's badge over its own span a short source could feed (#139). */
  savedFloor?: (item: SavedSearch) => boolean;
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
  homeId,
  onSetHome,
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
  toposcope = null,
  facetFloor,
  savedFloor,
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
        {toposcope}
        <SavedList
          saved={saved}
          alerts={alerts}
          counts={counts}
          activeSavedId={activeSavedId}
          homeId={homeId}
          elsewhere={elsewhere}
          savedFloor={savedFloor}
          onApplySaved={onApplySaved}
          onTest={onTest}
          onAlert={onAlert}
          onSetHome={onSetHome}
          onDeleteSaved={onDeleteSaved}
        />
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
              floorFor={facetFloor ? (value) => facetFloor(field, value) : undefined}
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
              floorFor={facetFloor ? (value) => facetFloor(field, value) : undefined}
              prefix={attrPrefixes[field] ?? ""}
              onPrefixChange={(value) => onAttrPrefix(field, value)}
            />
          </div>
        ))}
        {floorNote(facetFloor, facets, attrPins, attrFacetValues) ? (
          <p className="px-3 text-[11.5px] leading-snug text-muted-foreground/85">
            ≥ on every value a short source could feed.
          </p>
        ) : null}
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

function floorNote(
  facetFloor: ((field: string, value: string) => boolean) | undefined,
  facets: Facets,
  attrPins: string[],
  attrFacetValues: Record<string, FacetValue[]>,
): boolean {
  if (!facetFloor) {
    return false;
  }
  return (
    facetFields.some((field) => facets[field].some((item) => facetFloor(field, item.v))) ||
    attrPins.some((field) => (attrFacetValues[field] ?? []).some((item) => facetFloor(field, item.v)))
  );
}
