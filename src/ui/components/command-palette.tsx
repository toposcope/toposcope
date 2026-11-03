import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, LayoutGrid, PanelTop, Search, Zap } from "lucide-react";
import { overlayMotion } from "@/components/ui/motion";
import { cn } from "@/lib/utils";

/**
 * The command palette (sheet 45, Command palette): ⌘K or Ctrl K on any page. Every row does what
 * a control on the page does, under the same name; it adds no verbs. Text that reads like a query
 * puts "Hunt for" first.
 */
export type PaletteItem = {
  group: "Saved hunts" | "Boards" | "Go to" | "Actions";
  label: string;
  /** Mono beside the label: a saved hunt's query, a board's panels and inputs. */
  detail?: string;
  run: () => void;
};

type Row = PaletteItem | { group: "Search"; label: "Hunt for"; detail: string; run: () => void; hunt: true };

const groupOrder = ["Search", "Saved hunts", "Boards", "Go to", "Actions"] as const;

/** `key:value` somewhere in it: a query, not a name. */
export function looksLikeQuery(text: string): boolean {
  return /[a-z_.]+:\S/i.test(text);
}

/** The rows for what is typed, in group order; "Hunt for" leads a query and closes anything else. */
export function paletteRows(items: PaletteItem[], typed: string, onHunt: (q: string) => void): Row[] {
  const q = typed.trim();
  const needle = q.toLowerCase();
  const hit = (item: PaletteItem) => !q || item.label.toLowerCase().includes(needle) || (item.detail ?? "").toLowerCase().includes(needle);
  const rows: Row[] = groupOrder.flatMap((group) => items.filter((item) => item.group === group && hit(item)));
  if (!q) {
    return rows;
  }
  const hunt: Row = { group: "Search", label: "Hunt for", detail: q, run: () => onHunt(q), hunt: true };
  return looksLikeQuery(q) ? [hunt, ...rows] : [...rows, hunt];
}

function Marked({ text, mark }: { text: string; mark: string }): ReactNode {
  const at = mark ? text.toLowerCase().indexOf(mark.toLowerCase()) : -1;
  if (at < 0) {
    return text;
  }
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-plate/25 text-foreground">{text.slice(at, at + mark.length)}</mark>
      {text.slice(at + mark.length)}
    </>
  );
}

const groupIcon = {
  Search: Search,
  "Saved hunts": PanelTop,
  Boards: LayoutGrid,
  "Go to": ArrowRight,
  Actions: Zap,
} as const;

export function CommandPalette({
  open,
  onOpenChange,
  items,
  onHunt,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PaletteItem[];
  onHunt: (q: string) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          aria-label="Command palette"
          aria-describedby={undefined}
          className={cn(
            "fixed top-[12vh] left-1/2 z-50 flex w-[min(620px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-white/12 bg-overlay shadow-[0_24px_60px_rgb(0_0_0/0.55)]",
            overlayMotion,
          )}
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          {open ? (
            <PaletteBody
              items={items}
              onHunt={onHunt}
              onRan={() => onOpenChange(false)}
            />
          ) : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PaletteBody({ items, onHunt, onRan }: { items: PaletteItem[]; onHunt: (q: string) => void; onRan: () => void }) {
  const [typed, setTyped] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => paletteRows(items, typed, onHunt), [items, typed, onHunt]);
  const at = Math.min(sel, Math.max(0, rows.length - 1));
  const q = typed.trim();

  function run(row: Row | undefined) {
    if (!row) {
      return;
    }
    // Close first so focus goes back where it was, then do what the control does.
    onRan();
    row.run();
  }

  function move(to: number) {
    const next = (to + rows.length) % Math.max(1, rows.length);
    setSel(next);
    listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(at + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(at - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[at]);
    }
  }

  let group: string | null = null;
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.08] px-3.5">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          autoFocus
          role="combobox"
          aria-label="Command"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={rows.length ? `palette-row-${at}` : undefined}
          spellCheck={false}
          autoComplete="off"
          placeholder="Go to, run, or type a query"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setSel(0);
          }}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-faint"
        />
        <kbd>esc</kbd>
      </div>
      <div ref={listRef} id="palette-list" role="listbox" aria-label="Commands" className="max-h-[360px] overflow-y-auto p-1.5">
        {rows.length === 0 ? <p className="m-0 px-2.5 py-4 text-sm text-muted-foreground">Nothing matches “{q}”.</p> : null}
        {rows.map((row, i) => {
          const head = row.group !== group ? row.group : null;
          group = row.group;
          const Icon = groupIcon[row.group];
          const hunt = "hunt" in row;
          return (
            <div key={`${row.group}:${row.label}:${i}`} role="presentation">
              {head ? (
                <div role="presentation" className="px-2 pt-2 pb-1 text-2xs font-semibold tracking-[0.06em] text-faint uppercase">
                  {head}
                </div>
              ) : null}
              <div
                id={`palette-row-${i}`}
                data-row={i}
                role="option"
                aria-selected={i === at}
                className={cn("flex h-8 min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm", i === at && "bg-control")}
                onMouseMove={() => i !== at && setSel(i)}
                onClick={() => run(row)}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 shrink-0 truncate">{hunt ? row.label : <Marked text={row.label} mark={q} />}</span>
                {row.detail ? (
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {hunt ? row.detail : <Marked text={row.detail} mark={q} />}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3.5 border-t border-white/[0.08] px-3 py-1.5 text-xs text-faint">
        <span className="inline-flex items-center gap-1">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd>↵</kbd> run
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd>esc</kbd> close
        </span>
        <span className="ml-auto">Toposcope</span>
      </div>
    </>
  );
}
