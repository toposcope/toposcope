import { ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** `GET /api/instance`. */
export type InstanceInfo = {
  id: string;
  name: string | null;
  address: string;
  session: { kind: "token" } | { kind: "cookie"; expires_at: number };
};

/** The browser tab says which instance this is: `agental-prod · toposcope` (frame 12e). */
export function instanceTitle(info: InstanceInfo | null): string {
  if (!info) {
    return "toposcope";
  }
  return `${info.name ?? info.address} · toposcope`;
}

/** "15 Nov": when this browser's sign-in ends. */
export function signedInUntil(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Frames 12f and 12g: the name beside the wordmark, and Sign out from it. */
export function InstanceMenu({
  info,
  onRename,
  onSignOut,
}: {
  info: InstanceInfo;
  onRename: () => void;
  onSignOut: () => void;
}) {
  const label = info.name ?? info.address;
  return (
    <>
      <span aria-hidden="true" className="text-[14px] text-zinc-600">
        /
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={info.name ? `${info.name} · ${info.address}` : info.address}
            className="inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-[6.4px] border border-white/10 px-2 text-[13px] text-zinc-200 hover:bg-accent data-[state=open]:border-white/15 data-[state=open]:bg-accent"
          >
            <span className={`truncate ${info.name ? "" : "font-mono text-[12.5px]"}`}>{label}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[248px] p-1">
          <div className="flex flex-col gap-[3px] border-b border-white/[0.08] px-2 pt-2 pb-2.5">
            <span className={`truncate text-[13px] font-semibold ${info.name ? "" : "font-mono"}`}>{label}</span>
            {info.name ? (
              <span className="truncate font-mono text-[11.5px] text-muted-foreground">{info.address}</span>
            ) : null}
            {info.session.kind === "cookie" ? (
              <span className="text-[11.5px] text-muted-foreground">
                Signed in on this browser until {signedInUntil(info.session.expires_at)}
              </span>
            ) : null}
          </div>
          <DropdownMenuItem className="mt-1 h-8 text-[13px]" onSelect={onRename}>
            {info.name ? "Rename in Settings…" : "Name it in Settings…"}
          </DropdownMenuItem>
          {info.session.kind === "cookie" ? (
            <DropdownMenuItem className="h-8 text-[13px]" onSelect={onSignOut}>
              Sign out
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
