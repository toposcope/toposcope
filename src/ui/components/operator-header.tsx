import { type FormEvent, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { OperatorView } from "../search-url";

/** The header's tabs, in order (frames 26a and 26d, #258). Words, not icons. */
export const headerTabs: { view: OperatorView; label: string }[] = [
  { view: "home", label: "Home" },
  { view: "search", label: "Hunt" },
  { view: "watch", label: "Watch" },
  { view: "fields", label: "Fields" },
  { view: "links", label: "Links" },
];

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
      {tab.view === "watch" && watchOpen ? <span className="size-1.5 rounded-full bg-red-500" aria-label="open" /> : null}
    </span>
  );
  return (
    <>
      <nav className="hidden items-center gap-0.5 md:flex" aria-label="Pages">
        {headerTabs.map((tab) => (
          <Button
            key={tab.view}
            type="button"
            size="sm"
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
          <Button type="button" size="sm" variant="secondary" className="md:hidden" aria-label="Pages">
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

/** The 360px `key:value … opens a hunt` field on every page but the hunt (frame 26a). */
export function HeaderField({ onHunt, disabled }: { onHunt: (q: string | null) => void; disabled?: boolean }) {
  const [value, setValue] = useState("");
  function submit(e: FormEvent) {
    e.preventDefault();
    onHunt(headerFieldQuery(value).q);
    setValue("");
  }
  return (
    <form onSubmit={submit} className="hidden md:block">
      <label htmlFor="header-q" className="sr-only">
        Search
      </label>
      <div
        className={cn(
          "flex h-8 w-[360px] items-center gap-2 rounded-[6.4px] border border-white/10 bg-[#141416] px-3",
          disabled && "opacity-50",
        )}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="text-muted-foreground">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          id="header-q"
          value={value}
          disabled={disabled}
          placeholder={disabled ? "nothing to search yet" : "key:value … opens a hunt"}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 bg-transparent font-mono text-[12.5px] outline-none placeholder:text-muted-foreground"
        />
        <kbd className="rounded border border-white/10 px-[5px] font-mono text-[10.5px] text-muted-foreground">/</kbd>
      </div>
    </form>
  );
}
