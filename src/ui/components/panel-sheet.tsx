import { X } from "lucide-react";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { BoardPanel, PanelFields } from "../../shared/boards";
import type { PanelWindow } from "../board-panel-data";
import { draftProblem, fieldsOf, panelShows, volumeSplits, windowLine, type PanelDraft } from "../panel-draft";

const quickFixed = ["15m", "1h", "4h", "24h", "7d"] as const;
const label = "flex min-w-0 flex-col gap-1.5 text-xs text-muted-foreground";
const selectClass =
  "h-7.5 w-full min-w-0 rounded-md border border-input bg-overlay px-2 text-sm text-foreground focus-visible:border-foreground/40 focus-visible:outline-none";

/**
 * The panel sheet (sheet 49, 49f): one sheet from the right for Add panel and for a panel's Edit
 * panel. Name, query, what it shows, its split, its section and its window, with the panel drawn
 * as it will read. Open as hunt is for anything past these fields.
 */
export function PanelSheet(props: {
  mode: "add" | "edit";
  boardName: string;
  initial: PanelDraft;
  /** The panel being edited; null when adding. */
  base: BoardPanel | null;
  sections: Array<{ id: string; name: string }>;
  /** `24h`: the board's window, as the Window row names it. */
  boardWin: string;
  win: PanelWindow;
  renderPreview: (fields: PanelFields) => ReactNode;
  onCancel: () => void;
  onSubmit: (draft: PanelDraft, fields: PanelFields) => void;
  onOpenHunt: (fields: PanelFields) => void;
}) {
  const [draft, setDraft] = useState<PanelDraft>(props.initial);
  const [fixing, setFixing] = useState(Boolean(props.initial.fixed));
  const set = (patch: Partial<PanelDraft>) => setDraft((prev) => ({ ...prev, ...patch }));
  const fields = useMemo(() => fieldsOf(draft, props.base), [draft, props.base]);
  const problem = draftProblem(draft);
  const queryFault = draft.q.trim() && problem && problem !== "Pick a metric" && problem !== "Pick a field" ? problem : null;
  const names = useNames(draft.show, props.win);
  const ids = { split: useId(), section: useId(), metric: useId(), field: useId(), list: useId() };
  const submit = () => {
    if (!problem) {
      props.onSubmit(draft, fields);
    }
  };
  return (
    <Sheet side="right" label={props.mode === "add" ? "Add panel" : "Edit panel"} width={440} onClose={props.onCancel} className="overflow-hidden">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/[0.08] px-4">
        <h2 className="m-0 text-base font-semibold">{props.mode === "add" ? "Add panel" : "Edit panel"}</h2>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {props.mode === "add" ? "to" : "on"} {props.boardName}
        </span>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={props.onCancel}>
          <X aria-hidden />
        </Button>
      </div>
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          <label className={label}>
            Name
            <Input size="lg" autoFocus value={draft.name} maxLength={80} placeholder="Named for what it reads" onChange={(e) => set({ name: e.target.value })} />
          </label>
          <label className={label}>
            Query
            <Input
              size="lg"
              className="font-mono"
              value={draft.q}
              placeholder="all logs"
              spellCheck={false}
              aria-invalid={queryFault ? true : undefined}
              onChange={(e) => set({ q: e.target.value })}
            />
            {queryFault ? <span className="text-xs text-danger-fg">{queryFault}</span> : null}
          </label>
          {draft.show === null ? (
            <div className={label}>
              Show
              <span className="text-sm text-foreground">Events, newest first</span>
            </div>
          ) : (
            <div className={label}>
              <span id={`${ids.split}-show`}>Show</span>
              <div role="group" aria-labelledby={`${ids.split}-show`} className="flex h-7.5 self-start rounded-md border border-input p-0.5">
                {panelShows.map((item) => (
                  <button
                    key={item.show}
                    type="button"
                    aria-pressed={draft.show === item.show}
                    title={item.sub}
                    className={cn(
                      "rounded-sm px-2.5 text-sm font-medium focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                      draft.show === item.show ? "bg-control text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => set({ show: item.show })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="flex gap-3">
            {draft.show === "volume" ? (
              <label className={cn(label, "flex-1")} htmlFor={ids.split}>
                Split by
                <select id={ids.split} className={selectClass} value={draft.split} onChange={(e) => set({ split: e.target.value as PanelDraft["split"] })}>
                  {volumeSplits.map((item) => (
                    <option key={item.split} value={item.split}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : draft.show === "top" ? (
              <label className={cn(label, "flex-1")} htmlFor={ids.field}>
                Split by
                <Input id={ids.field} size="lg" className="font-mono" list={ids.list} value={draft.field} spellCheck={false} onChange={(e) => set({ field: e.target.value })} />
                <datalist id={ids.list}>
                  {names.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
            ) : draft.show === "metric" ? (
              <label className={cn(label, "flex-1")} htmlFor={ids.metric}>
                Metric
                <Input id={ids.metric} size="lg" className="font-mono" list={ids.list} value={draft.metric} placeholder="a series' name" spellCheck={false} onChange={(e) => set({ metric: e.target.value })} />
                <datalist id={ids.list}>
                  {names.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </label>
            ) : null}
            <label className={cn(label, "flex-1")} htmlFor={ids.section}>
              Section
              <select
                id={ids.section}
                className={selectClass}
                value={draft.section ?? ""}
                onChange={(e) => set({ section: e.target.value || null })}
              >
                <option value="">None</option>
                {props.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Window <span className="text-sm text-foreground">{windowLine(draft.fixed, props.boardWin)}</span>
              <span className="flex-1" />
              {draft.fixed ? (
                <button
                  type="button"
                  className="rounded-sm text-xs text-plate hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => {
                    set({ fixed: null });
                    setFixing(false);
                  }}
                >
                  Follow the board
                </button>
              ) : (
                <button
                  type="button"
                  aria-expanded={fixing}
                  className="rounded-sm text-xs text-plate hover:underline focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                  onClick={() => setFixing((on) => !on)}
                >
                  Fix a window…
                </button>
              )}
            </div>
            {fixing ? (
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Fixed window">
                {quickFixed.map((range) => (
                  <Button
                    key={range}
                    type="button"
                    variant="outline"
                    aria-pressed={draft.fixed === range}
                    className={cn("font-mono", draft.fixed === range && "border-foreground")}
                    onClick={() => set({ fixed: range })}
                  >
                    {range}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex h-[150px] shrink-0 flex-col" aria-label="Preview">
            {problem ? (
              <div className="flex flex-1 items-center justify-center rounded-lg border border-white/10 bg-surface-1 text-sm text-muted-foreground">{problem}</div>
            ) : (
              props.renderPreview(fields)
            )}
          </div>
        </div>
        <div className="flex h-14 shrink-0 items-center gap-2 border-t border-white/[0.08] px-4">
          <Button type="button" variant="ghost" className="px-0 hover:bg-transparent" disabled={Boolean(queryFault)} onClick={() => props.onOpenHunt(fields)}>
            Open as hunt ↗
          </Button>
          <span className="flex-1" />
          <Button type="button" variant="outline" size="lg" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="lg" className="bg-plate text-primary-foreground hover:bg-plate/90" disabled={Boolean(problem)}>
            {props.mode === "add" ? "Add panel" : "Update panel"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}

/** The names the Split by or Metric field offers: fields seen in the window, or metric names. */
function useNames(show: PanelDraft["show"], win: PanelWindow): string[] {
  const [fields, setFields] = useState<string[]>([]);
  const [metrics, setMetrics] = useState<string[]>([]);
  const winKey = JSON.stringify(win);
  const want = show === "metric" ? "metric" : show === "top" ? "field" : null;
  useEffect(() => {
    if (!want || (want === "field" ? fields.length : metrics.length) > 0) {
      return;
    }
    const ac = new AbortController();
    const params = new URLSearchParams("range" in win ? { range: win.range } : { from: win.from, to: win.to });
    const url = want === "metric" ? `/api/metric-names?${params.toString()}` : `/api/attr-keys?${params.toString()}`;
    void fetch(url, { signal: ac.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ keys?: Array<{ k: string }> }>) : { keys: [] }))
      .then((json) => {
        const keys = (json.keys ?? []).map((item) => item.k);
        if (want === "metric") {
          setMetrics(keys);
        } else {
          setFields(keys);
        }
      })
      .catch(() => undefined);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, winKey]);
  return want === "metric" ? metrics : want === "field" ? ["level", "service", "host", ...fields.filter((k) => !["level", "service", "host"].includes(k))] : [];
}
