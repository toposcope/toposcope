import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** `GET /api/me` (#305). */
export type Me = {
  id: string;
  kind: "person" | "service";
  name: string;
  email: string | null;
  role: "viewer" | "operator" | "owner";
  via: "session" | "token";
  initials: string;
};

const roleWords: Record<Me["role"], string> = { viewer: "Viewer", operator: "Operator", owner: "Owner" };

/** The person's initials at the header's right end (30a), with who they are and Sign out (30e). */
export function MeMenu({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="ml-1 inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-[#27272a] text-[11px] font-semibold text-foreground hover:bg-[#3f3f46]"
          aria-label={`${me.name} · ${roleWords[me.role]}`}
          title={`${me.name} · ${roleWords[me.role]}`}
        >
          {me.initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[248px] p-1">
        <div className="flex flex-col gap-[3px] border-b border-white/[0.08] px-2 pt-2 pb-2.5">
          <span className="truncate text-[13px] font-semibold">{me.name}</span>
          {me.email ? <span className="truncate font-mono text-[11.5px] text-muted-foreground">{me.email}</span> : null}
          <span className="text-[11.5px] text-muted-foreground">{roleWords[me.role]}</span>
        </div>
        {me.via === "session" ? (
          <DropdownMenuItem className="mt-1 h-8 text-[13px]" onSelect={onSignOut}>
            Sign out
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
