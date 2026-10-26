import { useState } from "react";
import { Plus, X } from "lucide-react";
import { CountText } from "@/components/count-text";
import { Button } from "@/components/ui/button";
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
import { levelHex } from "../histogram-series";
import type { LogLevel } from "../types";

/**
 * The slice as one row of chips under the clock (frame 26d, #260): level · service · host, then
 * the loudest fingerprints as `e1:<hex>` chips, then each pinned attr facet, then + facet.
 * A chip toggles membership in its field's OR group, as the sidebar's rows did.
 */
const coreFields: FacetField[] = ["level", "service", "host"];
const chipsPerField = 6;
const e1Chips = 3;

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
};

function activeList(active: string | string[] | undefined): string[] {
  return active === undefined ? [] : Array.isArray(active) ? active : [active];
}

export function FacetChips(props: Props) {
  const [keyFilter, setKeyFilter] = useState("");
  const [more, setMore] = useState<Record<string, boolean>>({});
  const pinned = new Set(props.attrPins);
  const addable = props.attrKeys.filter((item) => !pinned.has(item.k) && (!keyFilter.trim() || item.k.includes(keyFilter.trim().toLowerCase())));

  const group = (field: string, values: FacetValue[], cap: number, remove?: () => void) => {
    const selected = activeList(props.activeFacets[field]);
    const shown = more[field] ? values : values.slice(0, cap);
    const rest = values.length - shown.length;
    if (values.length === 0 && selected.length === 0) {
      return null;
    }
    return (
      <div key={field} className="flex items-center gap-1.5" data-facet-field={field}>
        {shown.map((item) => {
          const on = selected.some((v) => v.toLowerCase() === item.v.toLowerCase());
          const border = field === "level" ? levelHex[item.v as LogLevel] : undefined;
          return (
            <button
              key={item.v}
              type="button"
              aria-pressed={on}
              data-facet-value=""
              title={`${field}:${item.v}`}
              className={cn(
                "inline-flex h-[26px] max-w-[260px] items-center gap-1.5 whitespace-nowrap rounded-[6.4px] border bg-[#141416] px-[9px] text-[12px] text-zinc-300 hover:text-foreground",
                on ? "border-zinc-400 text-foreground" : "border-white/10",
              )}
              style={border && !on ? { borderColor: `${border}99` } : border ? { borderColor: border } : undefined}
              onClick={() => props.onToggle(field, item.v)}
            >
              <span className="truncate font-mono">{field === "e1" ? `e1:${item.v}` : field === "toposcope" ? `from ${item.v}` : item.v}</span>
              <b className="font-mono text-[11.5px] font-medium text-muted-foreground">
                <CountText n={item.n} floor={props.floorFor?.(field, item.v) ?? false} />
              </b>
            </button>
          );
        })}
        {rest > 0 ? (
          <button type="button" className="h-[26px] rounded-[6.4px] border border-white/10 px-[9px] text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setMore((p) => ({ ...p, [field]: true }))}>
            + {rest} {field === "e1" ? "e1" : field}
          </button>
        ) : more[field] && values.length > cap ? (
          <button type="button" className="h-[26px] rounded-[6.4px] px-[6px] text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setMore((p) => ({ ...p, [field]: false }))}>
            fewer
          </button>
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
    group("toposcope", props.facets.toposcope ?? [], chipsPerField),
    ...coreFields.map((f) => group(f, props.facets[f] ?? [], chipsPerField)),
    group("e1", props.facets.e1 ?? [], e1Chips),
    ...props.attrPins.map((f) => group(f, props.attrFacetValues[f] ?? [], chipsPerField, () => props.onRemoveAttrFacet(f))),
  ].filter(Boolean);

  return (
    <div className={cn("flex flex-wrap items-center gap-2 px-3 pt-2.5", props.locked && "pointer-events-none opacity-50")} data-kbd="facet">
      {groups.map((g, i) => (
        <span key={i} className="contents">
          {i > 0 ? <span className="mx-1 h-[18px] w-px bg-white/10" aria-hidden="true" /> : null}
          {g}
        </span>
      ))}
      {props.loading && groups.length === 0 ? <span className="h-[26px] w-24 animate-pulse rounded-[6.4px] bg-muted" /> : null}
      <DropdownMenu
        onOpenChange={(open) => {
          if (open) {
            props.onOpenAddFacet();
          }
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="ghost" className="h-[26px] border border-dashed border-white/15 px-[9px] text-[12px] text-muted-foreground" disabled={props.attrPins.length >= maxAttrFacets}>
            <Plus className="size-3" />
            facet
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <div className="p-1">
            <Input className="h-7 font-mono text-[11px]" placeholder="filter keys…" value={keyFilter} onChange={(e) => setKeyFilter(e.target.value)} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          {props.attrKeysLoading && addable.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading keys…</p>
          ) : addable.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No attr keys in this window.</p>
          ) : (
            addable.slice(0, 40).map((item) => (
              <DropdownMenuItem key={item.k} className="font-mono text-[12px]" onSelect={() => props.onAddAttrFacet(item.k)}>
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
  );
}
