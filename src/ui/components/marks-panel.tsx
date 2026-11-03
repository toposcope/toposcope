import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { changeMarkKinds, type ChangeMark, type ChangeMarkKind } from "../../shared/change-mark";
import { formatChangeMarkLabel } from "../change-marks";
import { hhmmUtc, markGlyph } from "../home-since";
import { attrLine, inWindow, markFrom, panelRows, utcDayStart } from "../marks-panel";
import { commitUrl, compareUrl } from "../../shared/code-links";
import { deployName, shortSha, useCode } from "../code-links";

/**
 * The marks panel (#262, frame 26f): every mark of the day from the rail's `marks · N` chip, in
 * the event panel's slot. Compare, Fingerprints, Focus in logs and Hide are words on the selected
 * mark; a note is written here and on Home, nowhere else.
 */
export function MarksPanel(props: {
  fromMs: number;
  toMs: number;
  selectedId: string | null;
  offKinds: ChangeMarkKind[];
  onToggleKind: (kind: ChangeMarkKind) => void;
  onSelect: (mark: ChangeMark) => void;
  onCompare: (mark: ChangeMark) => void;
  onFingerprints: (mark: ChangeMark) => void;
  onFocusLogs: (mark: ChangeMark) => void;
  onHide: (mark: ChangeMark) => void;
  onClose: () => void;
  /** A Viewer reads every mark but writes no note (30e). */
  canWrite?: boolean;
  /** A note was written: the rail reads its marks again. */
  onWritten: () => void;
}) {
  const [daysBack, setDaysBack] = useState(0);
  const [marks, setMarks] = useState<ChangeMark[] | null>(null);
  const [older, setOlder] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<string | null>(props.selectedId);

  const load = useCallback(async () => {
    const now = Date.now();
    const from = utcDayStart(now, daysBack);
    const params = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(now + 60_000).toISOString() });
    const prev = new URLSearchParams({ from: new Date(from - 24 * 60 * 60_000).toISOString(), to: new Date(from).toISOString() });
    const [res, res2] = await Promise.all([fetch(`/api/marks?${params}`), fetch(`/api/marks?${prev}`)]);
    if (res.ok) {
      setMarks(((await res.json()) as { marks: ChangeMark[] }).marks);
    }
    if (res2.ok) {
      setOlder(((await res2.json()) as { marks: ChangeMark[] }).marks.length);
    }
  }, [daysBack]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  useEffect(() => {
    setPicked(props.selectedId);
  }, [props.selectedId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) {
        props.onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  async function addNote() {
    const label = note.trim();
    if (!label) {
      return;
    }
    const res = await fetch("/v1/marks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "note", label }) });
    if (!res.ok) {
      toast.error(`The note was not written (${res.status})`);
      return;
    }
    setNote("");
    toast.success("Note mark written at now");
    await load().catch(() => undefined);
    props.onWritten();
  }

  const rows = marks ? panelRows(marks, props.offKinds) : [];
  return (
    <aside aria-label="Marks" className="my-2 mr-3 ml-1 flex w-[560px] max-w-[40%] shrink-0 flex-col overflow-hidden rounded-xl border border-white/10 bg-surface-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="text-base font-medium">Marks · {daysBack === 0 ? "today" : `${daysBack + 1} days`}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {marks ? `${marks.length} · ${inWindow(marks, props.fromMs, props.toMs)} in the window` : "…"}
        </span>
        <div className="flex-1" />
        {changeMarkKinds.map((kind) => {
          const on = !props.offKinds.includes(kind);
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              className={cn("inline-flex h-6 items-center gap-1 rounded-lg border px-2 text-xs", on ? "border-white/15 text-zinc-200" : "border-white/[0.06] text-muted-foreground line-through")}
              onClick={() => props.onToggleKind(kind)}
            >
              <span style={{ color: markGlyph[kind].color }}>{markGlyph[kind].glyph}</span>
              {kind}
            </button>
          );
        })}
        <Button size="icon" type="button" variant="ghost" aria-label="Close the marks panel" title="Close · Esc" onClick={props.onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {marks && rows.length === 0 ? <p className="px-4 py-3 text-sm text-muted-foreground">No marks today{props.offKinds.length ? " of the kinds shown" : ""}.</p> : null}
        {rows.map((m) => {
          const on = m.id === picked;
          const from = markFrom(m);
          return (
            <div key={m.id} className={cn("border-b border-white/[0.06] px-4", on && "bg-white/[0.03]")}>
              <button
                type="button"
                className="grid w-full grid-cols-[44px_18px_minmax(0,1fr)_auto] items-center gap-2 py-2.5 text-left text-sm"
                onClick={() => {
                  setPicked(on ? null : m.id);
                  if (!on) {
                    props.onSelect(m);
                  }
                }}
              >
                <span className="font-mono text-xs text-muted-foreground">{hhmmUtc(m.ts)}</span>
                <span style={{ color: markGlyph[m.kind].color }}>{markGlyph[m.kind].glyph}</span>
                <span className={cn("truncate", on && "text-foreground")}>
                  {formatChangeMarkLabel(m)}
                  {m.end_ts ? <span className="text-muted-foreground"> · {Math.round((Date.parse(m.end_ts) - Date.parse(m.ts)) / 60_000)} min</span> : null}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{from}</span>
              </button>
              {on ? (
                <div className="flex flex-col gap-2.5 pb-3 pl-[70px]">
                  {attrLine(m) ? <span className="font-mono text-xs text-muted-foreground">{attrLine(m)}</span> : null}
                  {m.kind === "deploy" ? <CodeRow markId={m.id} /> : null}
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" onClick={() => props.onCompare(m)}>
                      Compare around it
                    </Button>
                    <Button type="button" variant="outline" onClick={() => props.onFingerprints(m)}>
                      Fingerprints since it
                    </Button>
                    <Button type="button" variant="outline" onClick={() => props.onFocusLogs(m)}>
                      Focus in logs
                    </Button>
                    <Button type="button" variant="ghost" className="text-muted-foreground" onClick={() => props.onHide(m)}>
                      Hide for this hunt
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
        {older !== null && older > 0 ? (
          <div className="px-4 py-2.5 text-sm text-muted-foreground">
            {daysBack === 0 ? "Yesterday" : "The day before"} · {older} mark{older === 1 ? "" : "s"} ·{" "}
            <button type="button" className="text-zinc-300 hover:text-foreground" onClick={() => setDaysBack((d) => d + 1)}>
              show
            </button>
          </div>
        ) : null}
      </div>
      {props.canWrite === false ? (
        <p className="m-0 shrink-0 border-t border-white/[0.06] px-4 py-3 text-sm text-muted-foreground">A Viewer reads every mark and who made it, but writes no note.</p>
      ) : (
      <form
        className="flex shrink-0 flex-col gap-2 border-t border-white/[0.06] px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void addNote();
        }}
      >
        <label htmlFor="marks-note" className="text-sm text-muted-foreground">
          Write a note mark at now
        </label>
        <div className="flex gap-2">
          <input
            id="marks-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="what you did, in one line"
            className="h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-1 px-2.5 text-sm outline-none"
          />
          <Button type="submit" variant="outline" disabled={!note.trim()}>
            ○ Add
          </Button>
        </div>
      </form>
      )}
    </aside>
  );
}

/**
 * A deploy's code (#393, frame 37g): its commit and what changed since the previous deploy of the
 * same service, on the service's git host. With no repository known, no row.
 */
function CodeRow({ markId }: { markId: string }) {
  const code = useCode(`mark=${encodeURIComponent(markId)}`);
  const repo = code?.repository;
  const sha = code?.mark?.sha;
  if (!repo || !sha) {
    return null;
  }
  const prev = code.previous?.sha ? code.previous : null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
      <span className="w-[40px] shrink-0 font-mono text-xs text-muted-foreground">code</span>
      <a href={commitUrl(repo, sha)} target="_blank" rel="noreferrer noopener" className="font-mono text-xs text-zinc-200 hover:text-foreground">
        {repo.name} @ {shortSha(sha)} ↗
      </a>
      {prev ? (
        <a href={compareUrl(repo, prev.sha!, sha)} target="_blank" rel="noreferrer noopener" className="text-zinc-200 hover:text-foreground">
          changes since {deployName(prev)} ↗
        </a>
      ) : null}
    </div>
  );
}
