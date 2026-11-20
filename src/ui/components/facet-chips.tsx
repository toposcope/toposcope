import { useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { CountText } from "@/components/count-text";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { FacetField, FacetValue, Facets } from "@/types";
import { maxAttrFacets } from "../../shared/attrs";
import { levelHex } from "@/level";
import type { LogLevel } from "../types";
import { Skeleton } from "@/components/ui/states";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * The slice as one row of chips under the clock (frame 26d, #260): level · service · host, then
 * the loudest fingerprints as `e1:<hex>` chips, then each pinned attr facet, then + facet.
 * A chip toggles membership in its field's OR group, as the sidebar's rows did.
 * In Live the row leads with the counts' age, its own group (frame 36c).
 */
const coreFields: FacetField[] = ["level", "service", "host"];
const chipsPerField = 6;
/** Sheet 47b: one line of chips; level shows all, other fields their top three, e1 its top one. */
const lineChips = 3;
const lineE1Chips = 1;

type AttrKey = { k: string; n: number };

type Props = {
  facets: Facets & { e1?: FacetValue[] };
  activeFacets: Partial<Record<string, string | string[]>>;
  loading: boolean;
  attrPins: string[];
  attrFacetValues: Record<string, FacetValue[]>;
  attrKeys: AttrKey[];
  attrKeysLoading: boolean;
  onToggle: (field: string, value: string) => void;
  onAddAttrFacet: (key: string) => void;
  onRemoveAttrFacet: (key: string) => void;
  onOpenAddFacet: () => void;
  /** A facet value's count a short source could feed (#139). */
  floorFor?: (field: string, value: string) => boolean;
  locked?: boolean;
  /** Live only: the counts' age, drawn as the first group (36c). */
  age?: ReactNode;
  /** The query a click on a value would run; shown on the values a named field can add (48c). */
  previewToggle?: (field: string, value: string) => string;
};

function activeList(active: string | string[] | undefined): string[] {
  return active === undefined ? [] : Array.isArray(active) ? active : [active];
}

export function FacetChips(props: Props) {
  const [keyFilter, setKeyFilter] = useState("");
  const [more, setMore] = useState<Record<string, boolean>>({});
  const pinned = new Set(props.attrPins);
  const addable = props.attrKeys.filter((item) => !pinned.has(item.k) && (!keyFilter.trim() || item.k.includes(keyFilter.trim().toLowerCase())));

  const wrapped = Object.values(more).some(Boolean);
  const group = (field: string, values: FacetValue[], cap: number, remove?: () => void) => {
    const selected = activeList(props.activeFacets[field]);
    const shown = more[field] ? values : values.slice(0, cap);
    const rest = values.length - shown.length;
    if (values.length === 0 && selected.length === 0) {
      return null;
    }
    return (
      <div key={field} className="flex shrink-0 items-center gap-1.5" data-facet-field={field}>
        <span className="pr-0.5 text-xs text-faint">{field === "toposcope" ? "from" : field}</span>
        {shown.map((item) => {
          const on = selected.some((v) => v.toLowerCase() === item.v.toLowerCase());
          // Sheet 48b: once the query names a value of this field, that value is filled and the
          // field's other values read as "add", so their counts are not mistaken for results.
          const addable = !on && selected.length > 0;
          const border = field === "level" && !on && !addable ? levelHex[item.v as LogLevel] : undefined;
          const chip = (
            <Chip
              key={item.v}
              size="md"
              aria-pressed={on}
              data-facet-value=""
              data-facet-add={addable ? "" : undefined}
              title={addable ? undefined : `${field}:${item.v}`}
              className={cn(
                "max-w-[260px] font-normal",
                on ? "border-plate bg-plate/15 text-foreground aria-pressed:border-plate" : addable ? "border-dashed border-white/20 bg-transparent text-muted-foreground" : "text-zinc-300",
              )}
              style={border ? { borderColor: `${border}99` } : undefined}
              onClick={() => props.onToggle(field, item.v)}
            >
              {addable ? <span className="-mr-1 font-mono text-faint" aria-hidden="true">+</span> : null}
              <span className="truncate font-mono">{field === "e1" ? `e1:${item.v}` : field === "toposcope" ? `from ${item.v}` : item.v}</span>
              <b className={cn("font-mono text-xs font-medium", on ? "text-plate" : addable ? "text-faint" : "text-muted-foreground")}>
                <CountText n={item.n} floor={props.floorFor?.(field, item.v) ?? false} />
              </b>
            </Chip>
          );
          if (!addable) {
            return chip;
          }
          return (
            <Tooltip key={item.v}>
              <TooltipTrigger asChild>{chip}</TooltipTrigger>
              <TooltipContent side="bottom" className="border border-white/15 bg-popover text-popover-foreground">
                Add to the query
                {props.previewToggle ? <span className="ml-1.5 font-mono text-muted-foreground">{props.previewToggle(field, item.v)}</span> : null}
              </TooltipContent>
            </Tooltip>
          );
        })}
        {rest > 0 ? (
          <Chip size="md" className="bg-transparent" onClick={() => setMore((p) => ({ ...p, [field]: true }))}>
            +{rest}
          </Chip>
        ) : more[field] && values.length > cap ? (
          <Chip size="md" className="border-transparent bg-transparent px-1.5" onClick={() => setMore((p) => ({ ...p, [field]: false }))}>
            fewer
          </Chip>
        ) : null}
        {remove ? (
          <button type="button" className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground" title={`Remove ${field} facet`} onClick={remove}>
            <X className="size-3" />
          </button>
        ) : null}
      </div>
    );
  };

  const groups = [
    group("toposcope", props.facets.toposcope ?? [], lineChips),
    ...coreFields.map((f) => group(f, props.facets[f] ?? [], f === "level" ? chipsPerField : lineChips)),
    group("e1", props.facets.e1 ?? [], lineE1Chips),
    ...props.attrPins.map((f) => group(f, props.attrFacetValues[f] ?? [], lineChips, () => props.onRemoveAttrFacet(f))),
  ].filter(Boolean);
  const lead = props.age ? [props.age, ...groups] : groups;

  return (
    <TooltipProvider>
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 px-3 pt-2.5",
        // One line that scrolls sideways until someone asks a field for more; then it wraps.
        wrapped ? "flex-wrap" : "flex-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        props.locked && "pointer-events-none opacity-50",
      )}
      data-kbd="facet"
    >
      {lead.map((g, i) => (
        <span key={i} className="contents">
          {i > 0 ? <span className="mx-1 h-[18px] w-px bg-white/10" aria-hidden="true" /> : null}
          {g}
        </span>
      ))}
      {props.loading && groups.length === 0 ? <Skeleton kind="block" className="h-6.5 w-24 rounded-md" /> : null}
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            props.onOpenAddFacet();
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" className="border border-dashed border-white/15 px-2 text-sm text-muted-foreground" disabled={props.attrPins.length >= maxAttrFacets}>
            <Plus className="size-3" />
            facet
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <div className="p-1">
            <Input className="h-7 font-mono text-xs" placeholder="filter keys…" value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          {props.attrKeysLoading && addable.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading keys…</p>
          ) : addable.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No attr keys in this window.</p>
          ) : (
            addable.slice(0, 40).map((item) => (
              <DropdownMenuItem key={item.k} className="font-mono text-sm" onSelect={() => props.onAddAttrFacet(item.k)}>
                <span className="min-w-0 flex-1 truncate">{item.k}</span>
                <span className="font-mono text-xs text-muted-foreground tabular-nums">
                  <CountText n={item.n} />
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    </TooltipProvider>
  );
}
