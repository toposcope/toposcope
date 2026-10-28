import { HeldPill } from "@/components/held-tells";
import { cn } from "@/lib/utils";
import { maxPanelNote, maxPanelTitle, type WidgetDef } from "../../shared/widgets";
import type { PanelLines } from "../panel-lines";
import { useDraft } from "../use-draft";

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

/**
 * What a metric panel says about its sources (#331, 33e): the pill naming a source short inside
 * the window, as Search's counts carry it, and the one grey line when its points came in more than
 * one unit or kind. Grey, as the scope chip is: nothing is missing, it is split.
 */
export function PanelTells({ held, units }: { held: string | null; units: string | null }) {
  if (!held && !units) {
    return null;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 pt-1.5">
      {held ? <HeldPill text={held} /> : null}
      {units ? <UnitsSay text={units} /> : null}
    </div>
  );
}

/** The one line a metric says when its points came in more than one unit or kind (#331, 33e), on a panel or the pinned plot. */
export function UnitsSay({ text }: { text: string }) {
  return (
    <span
      className="inline-flex items-center rounded-[4px] border border-white/12 px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground"
      title="One name, sent with more than one unit or kind: split and said, never summed or converted."
    >
      {text}
    </span>
  );
}

const panelFieldClass =
  "rounded-md border border-white/14 bg-[#0a0a0c] px-2 outline-none placeholder:text-muted-foreground/60 focus:border-plate/55";

/**
 * The title while the panel is edited, where it shows (17d): its placeholder is
 * the title the panel makes for itself, and left blank it makes that one again.
 */
export function PanelTitleField({
  widget,
  madeTitle,
  onTitle,
  compact = false,
}: {
  widget: WidgetDef;
  madeTitle: string;
  onTitle: (title: string) => void;
  /** In an extra panel's head, where the title shares a row with its buttons. */
  compact?: boolean;
}) {
  const [title, setTitle] = useDraft(widget.title ?? "", onTitle);
  return (
    <input
      type="text"
      aria-label="Panel title"
      value={title}
      maxLength={maxPanelTitle}
      placeholder={madeTitle}
      onChange={(e) => setTitle(e.target.value)}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        panelFieldClass,
        "min-w-0 font-semibold",
        compact ? "my-[2px] h-[24px] flex-1 text-[12.5px]" : "h-[30px] w-full text-[14px]",
      )}
    />
  );
}

/** The note while the panel is edited, where it shows (17d): plain text, 160 characters, and the count. */
export function PanelNoteField({ widget, onNote }: { widget: WidgetDef; onNote: (note: string) => void }) {
  const [note, setNote] = useDraft(widget.note ?? "", onNote);
  const length = note.length;
  const full = length >= maxPanelNote;
  return (
    <label className="flex min-w-0 items-start gap-2 px-3 pt-1.5">
      <textarea
        aria-label="Panel note"
        value={note}
        maxLength={maxPanelNote}
        rows={2}
        placeholder="Note: what the panel is for, and what normal looks like. Plain text; two lines show."
        onChange={(e) => setNote(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(panelFieldClass, "min-w-0 flex-1 resize-none py-1 text-[12px] leading-snug", full && "border-amber-400/80")}
      />
      <span className={cn("shrink-0 pt-1 font-mono text-[11px] text-muted-foreground", full && "text-amber-400")}>
        {length} / {maxPanelNote}
        {full ? <span className="block">the note is full</span> : null}
      </span>
    </label>
  );
}
