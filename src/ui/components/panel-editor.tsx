import { useMemo, useRef, useState } from "react";
import { Plus, Search, SlidersHorizontal, X } from "lucide-react";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { maxLineName, maxPanelLines, type MetricLine, type WidgetDef } from "../../shared/widgets";
import { printUnit } from "../metric-unit";
import { canJoin, withLine, withLineName, withoutLine } from "../panel-edit";
import { useSeriesCatalog } from "../series-catalog";
import { metricReading, type MetricEntry } from "../series-list";
import { useDraft } from "../use-draft";
import { splitPalette } from "./metric-spark";

type Props = {
  widget: WidgetDef;
  /** The unit the panel's own metric is in, as sent. */
  unit: string | null;
  /** A split's values as they draw now, to name them (17i). */
  splitValues: string[];
  /** While editing, the title and note are fields where they show (17d) and the lines open under the panel (17c). */
  editing: boolean;
  onEditing: (on: boolean) => void;
  onPatch: (patch: Partial<WidgetDef>) => void;
  /** Puts a metric of another unit on a panel of its own (17e); absent at six panels. */
  onNewPanel?: (metric: string) => void;
};

const fieldClass =
  "h-[28px] rounded-md border border-white/14 bg-[#0a0a0c] px-2 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus:border-plate/55";

/** A line's name as it is typed: the panel keeps it trimmed, the field keeps what was typed. */
function NameField({
  value,
  label,
  placeholder,
  onName,
  className,
}: {
  value: string;
  label: string;
  placeholder: string;
  onName: (name: string) => void;
  className: string;
}) {
  const [name, setName] = useDraft(value, onName);
  return (
    <input
      type="text"
      aria-label={label}
      value={name}
      maxLength={maxLineName}
      placeholder={placeholder}
      onChange={(e) => setName(e.target.value)}
      className={cn(fieldClass, className)}
    />
  );
}

/** The panel the editor belongs to: its cell on the canvas, marked `data-panel`. */
function panelOf(node: Element | null): HTMLElement | null {
  return node?.closest<HTMLElement>("[data-panel]") ?? null;
}

/**
 * A panel's lines while it is edited (#169, frames 17c, 17e, 17i): how they
 * are made, each line's name, metric, labels and reading, and adding a line of
 * the panel's unit. They open under the panel, as wide as it is; the title and
 * note are edited where they show (`PanelTitleField`, `PanelNoteField`).
 */
export function PanelEditor({ widget, unit, splitValues, editing, onEditing, onPatch, onNewPanel }: Props) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef({ getBoundingClientRect: () => (panelOf(button.current) ?? document.body).getBoundingClientRect() });
  const [adding, setAdding] = useState(false);
  const [find, setFind] = useState("");
  const [refused, setRefused] = useState<MetricEntry | null>(null);
  const catalog = useSeriesCatalog();
  const names = widget.names ?? {};
  const merging = !widget.metricSplit;
  const all: MetricLine[] = widget.metric ? [{ metric: widget.metric, labels: widget.metricLabels }, ...(widget.lines ?? [])] : [];
  const onPanel = new Set(all.map((line) => line.metric));
  const printed = printUnit(unit) || unit || "";
  const kindOf = (metric: string) => catalog.metrics.find((m) => m.name === metric)?.kind ?? "gauge";

  const choices = useMemo(() => {
    const typed = find.trim().toLowerCase();
    const metrics = catalog.metrics.filter((m) => !typed || m.name.toLowerCase().includes(typed));
    const fits = (m: MetricEntry) => canJoin(unit, m.unit);
    return { fit: metrics.filter(fits).slice(0, 30), other: metrics.filter((m) => !fits(m)).slice(0, 12) };
  }, [catalog.metrics, find, unit]);

  const closePicker = () => {
    setAdding(false);
    setRefused(null);
    setFind("");
  };

  const setName = (key: string, value: string) => onPatch({ names: withLineName(names, key, value) });

  const addLine = (entry: MetricEntry) => {
    if (!canJoin(unit, entry.unit)) {
      setRefused(entry);
      return;
    }
    onPatch(withLine(widget, entry.name));
    closePicker();
  };

  const done = (
    <button
      type="button"
      className="h-[26px] shrink-0 rounded-md px-2 text-[12px] text-muted-foreground hover:text-foreground"
      onClick={() => onEditing(false)}
    >
      Done
    </button>
  );

  return (
    <Popover
      open={editing}
      onOpenChange={(next) => {
        onEditing(next);
        if (!next) {
          closePicker();
        }
      }}
    >
      <PopoverAnchor virtualRef={panel} />
      <button
        ref={button}
        type="button"
        aria-label="Edit this panel: its lines, title and note"
        aria-pressed={editing}
        // Keeps a hover-only footer showing while its panel is edited.
        data-state={editing ? "open" : "closed"}
        title={editing ? "Done editing" : "Lines, title and note"}
        className={cn(
          "flex h-[22px] shrink-0 items-center justify-center gap-1 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
          editing ? "bg-accent px-1.5 text-foreground" : "w-[22px]",
        )}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onEditing(!editing)}
      >
        <SlidersHorizontal className="size-3.5" />
        {editing ? <span className="font-mono text-[11px]">editing</span> : null}
      </button>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        className="w-(--radix-popper-anchor-width) min-w-[360px] bg-card p-3"
        onPointerDown={(e) => e.stopPropagation()}
        // The title and note are edited in the panel itself: working in them keeps the lines open.
        onInteractOutside={(e) => {
          if (panelOf(button.current)?.contains(e.target as Node)) {
            e.preventDefault();
          }
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">Lines</span>
            <div role="group" aria-label="How the lines are made" className="inline-flex overflow-hidden rounded-md border border-white/14 text-[12px]">
              <button
                type="button"
                aria-pressed={merging}
                className={cn("px-2 py-[3px] whitespace-nowrap", merging ? "bg-accent text-foreground" : "text-muted-foreground")}
                // Names given to a split's values mean nothing once it merges.
                onClick={() => (widget.metricSplit ? onPatch({ metricSplit: null, names: {} }) : undefined)}
              >
                Merge metrics
              </button>
              <button
                type="button"
                aria-pressed={!merging}
                disabled={merging}
                title={merging ? "Pick a label to split by under the chart; a panel merges or splits, never both." : undefined}
                className={cn("px-2 py-[3px] whitespace-nowrap disabled:opacity-50", !merging ? "bg-accent text-foreground" : "text-muted-foreground")}
              >
                Split one by a label
              </button>
            </div>
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-muted-foreground">
              {merging ? `${all.length} of ${maxPanelLines}` : `split by ${widget.metricSplit}`}
              {printed ? ` · one unit: ${printed}` : ""}
            </span>
          </div>

          {merging ? (
            <div className="flex flex-col gap-1.5">
              {all.map((line, index) => (
                <div key={`${line.metric}|${index}`} className="flex items-center gap-2">
                  <span className="h-[3px] w-3.5 shrink-0 rounded" style={{ background: splitPalette[index % splitPalette.length] }} />
                  <NameField
                    label={`Name for ${line.metric}`}
                    value={names[String(index)] ?? ""}
                    placeholder="Name"
                    onName={(name) => setName(String(index), name)}
                    className="w-[130px] shrink-0"
                  />
                  <span
                    className="flex h-[28px] min-w-0 flex-1 items-center truncate rounded-md border border-white/10 px-2 font-mono text-[12px] text-foreground/85"
                    title={line.metric}
                  >
                    {line.metric}
                  </span>
                  {Object.entries(line.labels).map(([k, v]) => (
                    <span
                      key={k}
                      className="inline-flex h-5 shrink-0 items-center rounded-[4px] border border-violet-400/50 px-1.5 font-mono text-[10.5px] text-violet-300"
                    >
                      {k}:{v}
                    </span>
                  ))}
                  <span className="w-[34px] shrink-0 font-mono text-[11px] text-muted-foreground">
                    {metricReading(kindOf(line.metric), "", true)}
                  </span>
                  {index > 0 ? (
                    <button
                      type="button"
                      aria-label={`Remove the line ${names[String(index)] ?? line.metric}`}
                      className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                      onClick={() => onPatch(withoutLine(widget, index))}
                    >
                      <X className="size-3" />
                    </button>
                  ) : (
                    <span className="size-6 shrink-0" />
                  )}
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <Popover open={adding} onOpenChange={(next) => (next ? setAdding(true) : closePicker())}>
                  <PopoverAnchor asChild>
                    <button
                      type="button"
                      disabled={all.length >= maxPanelLines}
                      title={all.length >= maxPanelLines ? "Up to 4 lines a panel; split one metric by a label for more." : undefined}
                      onClick={() => setAdding(!adding)}
                      className="inline-flex h-[28px] shrink-0 items-center gap-1.5 rounded-md border border-white/16 bg-[#18181b] px-2.5 text-[12.5px] disabled:opacity-50"
                    >
                      <Plus className="size-3" />
                      Add a line
                    </button>
                  </PopoverAnchor>
                  <PopoverContent
                    side="right"
                    align="end"
                    sideOffset={8}
                    className="w-[400px] bg-[#18181b] p-2"
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <label className="flex h-[30px] items-center gap-1.5 rounded-md border border-white/14 bg-[#0a0a0c] px-2">
                      <Search className="size-3 text-muted-foreground" aria-hidden="true" />
                      <input
                        type="text"
                        autoFocus
                        aria-label="Find a metric"
                        value={find}
                        onChange={(e) => {
                          setFind(e.target.value);
                          setRefused(null);
                        }}
                        className="min-w-0 flex-1 bg-transparent font-mono text-[12px] outline-none"
                      />
                    </label>
                    {refused ? (
                      <div role="alert" className="mt-2 flex flex-col gap-1.5 rounded-md border border-amber-500/60 bg-amber-500/6 p-2">
                        <p className="text-[12.5px] leading-snug text-amber-200">
                          {refused.name} is counted in {printUnit(refused.unit) || refused.unit}, and this panel in {printed}. A panel draws one
                          unit on one axis.
                        </p>
                        <div className="flex gap-2">
                          {onNewPanel ? (
                            <button
                              type="button"
                              className="h-[26px] rounded-md border border-white/16 bg-[#18181b] px-2.5 text-[12px]"
                              onClick={() => {
                                onNewPanel(refused.name);
                                closePicker();
                              }}
                            >
                              Put it on a new panel
                            </button>
                          ) : null}
                          <button type="button" className="h-[26px] px-2 text-[12px] text-muted-foreground" onClick={() => setRefused(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : null}
                    <div className="mt-1 max-h-[320px] overflow-y-auto">
                      <div className="px-1.5 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                        {printed ? `${printed} — can join this panel` : "Can join this panel"}
                      </div>
                      {choices.fit.map((entry) => (
                        <button
                          key={entry.name}
                          type="button"
                          disabled={onPanel.has(entry.name)}
                          onClick={() => addLine(entry)}
                          className="flex w-full flex-col items-start gap-0.5 rounded px-1.5 py-1 text-left hover:bg-white/5 disabled:opacity-55"
                        >
                          <span className="flex w-full gap-2">
                            <span className="min-w-0 truncate font-mono text-[12px]">{entry.name}</span>
                            <span className="flex-1" />
                            <span className="shrink-0 text-[11px] text-muted-foreground">{onPanel.has(entry.name) ? "on this panel" : ""}</span>
                          </span>
                          {entry.description ? (
                            <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{entry.description}</span>
                          ) : null}
                        </button>
                      ))}
                      {choices.other.length > 0 ? (
                        <div className="px-1.5 pt-2 pb-0.5 text-[11px] font-semibold tracking-[0.04em] text-muted-foreground/70 uppercase">
                          Other units
                        </div>
                      ) : null}
                      {choices.other.map((entry) => (
                        <button
                          key={entry.name}
                          type="button"
                          onClick={() => addLine(entry)}
                          className="flex w-full gap-2 rounded px-1.5 py-1 text-left opacity-50 hover:opacity-80"
                        >
                          <span className="min-w-0 truncate font-mono text-[12px]">{entry.name}</span>
                          <span className="flex-1" />
                          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{printUnit(entry.unit) || entry.unit}</span>
                        </button>
                      ))}
                    </div>
                  </PopoverContent>
                </Popover>
                <span className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">Up to 4. The name is what the legend and the readout say.</span>
                {done}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {splitValues.map((value, index) => (
                <div key={value} className="flex items-center gap-2">
                  <span className="h-[3px] w-3.5 shrink-0 rounded" style={{ background: splitPalette[index % splitPalette.length] }} />
                  <span className="w-[120px] shrink-0 truncate font-mono text-[12px] text-muted-foreground" title={value}>
                    {widget.metricSplit}:{value}
                  </span>
                  <span className="text-[11px] text-muted-foreground/70">shows as</span>
                  <NameField
                    label={`Name for ${value}`}
                    value={names[value] ?? ""}
                    placeholder={value}
                    onName={(name) => setName(value, name)}
                    className="w-[160px]"
                  />
                </div>
              ))}
              {splitValues.length === 0 ? <p className="text-[12px] text-muted-foreground">No values in this window yet.</p> : null}
              <div className="flex items-center gap-2 pt-1">
                <span className="min-w-0 flex-1 text-[11.5px] text-muted-foreground">
                  The name is what the legend says; the value stays one hover away.
                </span>
                {done}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
