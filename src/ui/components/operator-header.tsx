import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { Menu, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { OperatorView } from "../search-url";
import { headerSuggestions, suggestionOrder } from "../header-search";
import type { SavedSearch } from "../types";

/** The header's tabs, in order (frames 26a and 26d, #258; Fields moved under Settings in 28a, #292; Links into Access in 29a, #295). Words, not icons. */
export const headerTabs: { view: OperatorView; label: string }[] = [
  { view: "home", label: "Home" },
  { view: "search", label: "Hunt" },
  { view: "watch", label: "Watch" },
];

/** Access stays lit on its own page and on `?view=links`, which is Access filtered to links (29a, #295). */
export function accessLit(view: OperatorView): boolean {
  return view === "access" || view === "links";
}

/** Settings stays lit on its own page and on Fields, Sign-in and Repositories, which live under it (28b, #292). */
export function settingsLit(view: OperatorView): boolean {
  return view === "settings" || view === "fields" || view === "sign-in" || view === "repositories";
}

/** What the header's field does with what was typed: Enter opens a hunt with it; empty Enter opens the hunt as it was. */
export function headerFieldQuery(raw: string): { q: string } | { q: null } {
  const q = raw.trim();
  return q ? { q } : { q: null };
}

export function HeaderTabs({
  view,
  watchOpen,
  onView,
}: {
  view: OperatorView;
  watchOpen: boolean;
  onView: (view: OperatorView) => void;
}) {
  const label = (tab: (typeof headerTabs)[number]) => (
    <span className="inline-flex items-center gap-1.5">
      {tab.label}
      {tab.view === "watch" && watchOpen ? <span className="size-1.5 rounded-full bg-danger" aria-label="open" /> : null}
    </span>
  );
  return (
    <>
      <nav className="hidden items-center gap-0.5 md:flex" aria-label="Pages">
        {headerTabs.map((tab) => (
          <Button
            key={tab.view}
            type="button"
            variant={view === tab.view ? "secondary" : "ghost"}
            aria-current={view === tab.view ? "page" : undefined}
            onClick={() => onView(tab.view)}
          >
            {label(tab)}
          </Button>
        ))}
      </nav>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="secondary" className="md:hidden" aria-label="Pages">
            <Menu className="size-4" />
            {headerTabs.find((tab) => tab.view === view)?.label ?? "Pages"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {headerTabs.map((tab) => (
            <DropdownMenuItem key={tab.view} onSelect={() => onView(tab.view)}>
              {label(tab)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

/**
 * The 360px field on every page but the hunt (frame 26a, 49b). Typing lists saved hunts and boards
 * by name; arrows and Enter open one. Enter with none highlighted opens a hunt with what was typed.
 */
export function HeaderField({
  onHunt,
  disabled,
  saved = [],
  onOpenSaved,
}: {
  onHunt: (q: string | null) => void;
  disabled?: boolean;
  saved?: readonly SavedSearch[];
  onOpenSaved?: (item: SavedSearch) => void;
}) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const found = onOpenSaved ? headerSuggestions(saved, value) : { hunts: [], boards: [] };
  const order = suggestionOrder(found);
  const shown = open && order.length > 0;
  const optionId = (i: number) => `${listId}-o${i}`;

  function reset() {
    setValue("");
    setOpen(false);
    setActive(-1);
  }
  function pick(item: SavedSearch) {
    onOpenSaved?.(item);
    reset();
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const chosen = shown && active >= 0 ? order[active] : undefined;
    if (chosen) {
      pick(chosen);
      return;
    }
    onHunt(headerFieldQuery(value).q);
    reset();
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (order.length === 0) {
        return;
      }
      e.preventDefault();
      setOpen(true);
      const step = e.key === "ArrowDown" ? 1 : -1;
      // -1 is the typed text itself: Enter there opens a hunt with it
      setActive((i) => {
        const next = i + step;
        return next < -1 ? order.length - 1 : next >= order.length ? -1 : next;
      });
    } else if (e.key === "Escape" && shown) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  }
  const group = (label: string, items: SavedSearch[], offset: number) =>
    items.length > 0 ? (
      <div role="group" aria-label={label} className="py-1">
        <div className="px-2 pb-0.5 text-xs text-faint">{label}</div>
        {items.map((item, j) => {
          const i = offset + j;
          return (
            <div
              key={item.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={cn("flex cursor-pointer items-center rounded-sm px-2 py-1 text-sm", i === active && "bg-control text-accent-foreground")}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(item)}
            >
              <span className="truncate">{item.name}</span>
            </div>
          );
        })}
      </div>
    ) : null;
  return (
    <form onSubmit={submit} className="relative hidden md:block">
      <label htmlFor="header-q" className="sr-only">
        Search
      </label>
      <div
        className={cn(
          "flex h-8 w-[360px] items-center gap-2 rounded-lg border border-white/10 bg-surface-2 px-3 focus-within:border-foreground/40",
          disabled && "opacity-50",
        )}
      >
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          id="header-q"
          value={value}
          disabled={disabled}
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
          placeholder={disabled ? "nothing to search yet" : "Search, or a hunt or board by name"}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
          className="min-w-0 flex-1 bg-transparent font-mono text-sm outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded-md border border-white/10 px-1 font-mono text-2xs text-muted-foreground">/</kbd>
      </div>
      {shown ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Saved hunts and boards"
          className="absolute top-full right-0 left-0 z-50 mt-1 rounded-lg border border-white/12 bg-overlay p-1 text-popover-foreground shadow-lg"
        >
          {group("Hunts", found.hunts, 0)}
          {group("Boards", found.boards, found.hunts.length)}
        </div>
      ) : null}
    </form>
  );
}
