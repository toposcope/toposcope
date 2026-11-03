import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { Copy, House, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { stepIndex } from "@/keyboard";
import type { Workspace, WorkspaceKind } from "../workspaces";

type Props = {
  tabs: Workspace[];
  activeId: number;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onNew: () => void;
  onDuplicate: () => void;
};

function FollowGlyph() {
  return (
    <svg
      className="size-3 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M3 12h5" />
      <path d="M16 12h5" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function AroundGlyph() {
  return (
    <svg
      className="size-3 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M4 8h5" />
      <path d="M15 8h5" />
      <path d="M4 16h5" />
      <path d="M15 16h5" />
      <circle cx="12" cy="12" r="2.4" />
    </svg>
  );
}

function BoardGlyph() {
  return (
    <svg
      className="size-3 shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M4 7h9" />
      <path d="M17 7h3" />
      <path d="M4 17h3" />
      <path d="M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </svg>
  );
}

const kindWord: Record<WorkspaceKind, string> = {
  search: "Search",
  follow: "Follow",
  surroundings: "Surroundings",
};

export function WorkspaceStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onDuplicate,
}: Props) {
  const canClose = tabs.length > 1;
  const scrollerRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<number, HTMLElement>());
  const labelRefs = useRef(new Map<number, HTMLButtonElement>());

  useLayoutEffect(() => {
    const box = scrollerRef.current;
    const el = tabRefs.current.get(activeId);
    if (!box || !el) {
      return;
    }
    const b = box.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (e.right > b.right) {
      box.scrollLeft += e.right - b.right + 14;
    } else if (e.left < b.left) {
      box.scrollLeft -= b.left - e.left + 14;
    }
    if (box.contains(document.activeElement)) {
      labelRefs.current.get(activeId)?.focus();
    }
  }, [activeId, tabs.length]);

  function onTabKey(e: KeyboardEvent, tabId: number) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") {
      return;
    }
    e.preventDefault();
    const i = tabs.findIndex((tab) => tab.id === tabId);
    if (i < 0) {
      return;
    }
    const next = tabs[stepIndex(i, e.key === "ArrowRight" ? 1 : -1, tabs.length)];
    if (next && next.id !== tabId) {
      onSelect(next.id);
    }
  }

  return (
    <div className="-mb-px flex h-[33px] shrink-0 items-end gap-0.5 border-b bg-surface-1 px-2.5">
      <div
        ref={scrollerRef}
        data-kbd="tabs"
        className="ws-scroll flex h-[33px] min-w-0 flex-1 items-end gap-0.5 overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab) => {
          const on = tab.id === activeId;
          const kind = tab.board ? "Board" : kindWord[tab.kind];
          return (
            <span
              key={tab.id}
              ref={(node) => {
                if (node) {
                  tabRefs.current.set(tab.id, node);
                } else {
                  tabRefs.current.delete(tab.id);
                }
              }}
              title={`${kind} · ${tab.label}`}
              className={cn(
                "flex h-[30px] max-w-[230px] min-w-0 shrink-0 items-center gap-1.5 rounded-t-md py-0 pr-1 pl-2.5",
                on
                  ? "border border-b-0 border-white/12 bg-background text-foreground"
                  : "border border-transparent text-muted-foreground",
              )}
              onKeyDown={(e) => onTabKey(e, tab.id)}
            >
              {tab.kind === "follow" ? <FollowGlyph /> : null}
              {tab.kind === "surroundings" ? <AroundGlyph /> : null}
              {tab.board ? <BoardGlyph /> : null}
              {tab.home ? <House aria-label="Home" className="size-3 shrink-0" /> : null}
              <button
                type="button"
                ref={(node) => {
                  if (node) {
                    labelRefs.current.set(tab.id, node);
                  } else {
                    labelRefs.current.delete(tab.id);
                  }
                }}
                className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 pr-0.5 text-left font-mono text-xs text-inherit"
                onClick={() => onSelect(tab.id)}
              >
                {tab.label}
              </button>
              {canClose ? (
                <button
                  type="button"
                  title="Close tab"
                  aria-label="Close tab"
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm text-sm leading-none text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onClose(tab.id)}
                >
                  ×
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      {tabs.length > 5 ? (
        <span
          title={`${tabs.length} tabs open`}
          className="mb-2 shrink-0 font-mono text-2xs tabular-nums text-faint"
        >
          {tabs.length}
        </span>
      ) : null}
      <div className="mb-0.5 ml-1.5 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          title="Duplicate this tab as it stands now — query, window, columns, bindings and panels, without the open trace or profile tabs"
          aria-label="Duplicate this tab"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onDuplicate}
        >
          <Copy className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          title="New search tab"
          aria-label="New tab"
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onNew}
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
