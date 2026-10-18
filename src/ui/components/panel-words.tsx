import type { WidgetDef } from "../../shared/widgets";
import type { PanelLines } from "../panel-lines";

/** How a panel's lines are made, beside its title (17b): merged, split, or one metric. */
export function panelKindTag(widget: WidgetDef): string {
  if (widget.lines?.length) {
    return `${widget.lines.length + 1} metrics, merged`;
  }
  if (widget.metricSplit) {
    return `split by ${widget.metricSplit}`;
  }
  return "1 metric";
}

/** A title the panel was given, its unit and how its lines are made (17b). */
export function PanelTitle({ widget, unit }: { widget: WidgetDef; unit: string }) {
  if (!widget.title) {
    return null;
  }
  return (
    <div className="flex min-w-0 items-baseline gap-2 px-3 pt-2">
      <span className="min-w-0 truncate text-[14px] font-semibold" title={widget.title}>
        {widget.title}
      </span>
      {unit ? <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{unit}</span> : null}
      <span className="min-w-0 flex-1" />
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/70">{panelKindTag(widget)}</span>
    </div>
  );
}

/**
 * The panel's note, two lines at most and whole on hover (17d, 17h); or, on a
 * one-line panel with no note, the sender's description, marked as theirs (17f);
 * and a line for each merged metric now sent in another unit (17e).
 */
export function PanelNote({
  note,
  leftOff,
}: {
  note: { text: string; sender: boolean } | null;
  leftOff: PanelLines["leftOff"];
}) {
  if (!note && leftOff.length === 0) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 pt-1">
      {note ? (
        <p className="line-clamp-2 max-w-[88ch] text-[12px] leading-snug text-muted-foreground" title={note.text}>
          {note.sender ? (
            <span
              className="mr-1.5 inline-flex rounded-[4px] border border-white/16 px-1 align-[1px] font-mono text-[10px] text-muted-foreground"
              title="Written where the metric is made, not here"
            >
              sender
            </span>
          ) : null}
          {note.text}
        </p>
      ) : null}
      {leftOff.map((line) => (
        <p key={`${line.metric}|${line.name}`} className="text-[12px] leading-snug text-amber-200">
          {line.name} ({line.metric}) is now sent in {line.unit}, so it is left off. It draws again when it is in the
          panel&apos;s unit, or once it is removed.
        </p>
      ))}
    </div>
  );
}
