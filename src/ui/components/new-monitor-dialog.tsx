import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { MonitorSource } from "../../shared/monitor";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A saved search to show in the examples, when there is one. */
  example: { name: string; query: string; range: string | null } | null;
  onPick: (source: MonitorSource) => void;
};

function FingerprintsIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
      <path d="M12 3v18" strokeDasharray="2.5 2.5" />
      <path d="M4 8h4" />
      <path d="M4 16h4" />
      <path d="M16 8h4" />
      <path d="M16 12h4" />
      <path d="M16 16h4" />
    </svg>
  );
}

function SourceCard({
  icon,
  title,
  about,
  example,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  about: string;
  example: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[170px] min-w-0 flex-col gap-2 rounded-lg border border-white/12 bg-[#141417] p-3.5 text-left outline-none hover:border-white/40 focus-visible:border-plate"
    >
      <span className="flex items-center gap-2.5">
        <span className="flex size-[26px] items-center justify-center rounded-[6px] bg-[#27272a] text-foreground">
          {icon}
        </span>
        <span className="text-[14px] font-medium">{title}</span>
      </span>
      <span className="text-[13px] leading-[1.45] text-muted-foreground">{about}</span>
      <span className="mt-auto truncate rounded-[6px] border border-white/10 bg-[#0f0f11] px-2.5 py-1.5 font-mono text-[12px]">
        {example}
      </span>
    </button>
  );
}

/**
 * Frame 18p: a new monitor starts by choosing where its results come from. HTTP(S), push and
 * TCP / certificate join these cards with their own issues (#177, #178, #180).
 */
export function NewMonitorDialog({ open, onOpenChange, example, onPick }: Props) {
  const q = example?.query.trim() || "service:api level:error";
  const slug = (example?.name ?? "api errors").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-32px)] max-w-[min(880px,calc(100vw-32px))] overflow-y-auto p-0">
        <div className="flex items-center gap-3 border-b px-[18px] py-3.5">
          <DialogTitle>New monitor</DialogTitle>
          <DialogDescription>Where do its results come from?</DialogDescription>
          <button
            type="button"
            aria-label="Close"
            className="ml-auto flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 p-[18px] sm:grid-cols-3">
          <SourceCard
            icon={<Search className="size-3.5" />}
            title="Saved search"
            about="A search that goes quiet or loud: at least, or fewer than, N lines in its window."
            example={`${q} · fewer than 1 · ${example?.range ?? "15m"}`}
            onClick={() => onPick("search")}
          />
          <SourceCard
            icon={<FingerprintsIcon />}
            title="New fingerprints"
            about="An error first seen after a deploy or a flag, for 24 hours after the mark."
            example={`${q} · after a deploy`}
            onClick={() => onPick("fingerprints")}
          />
          <div className="flex min-h-[170px] min-w-0 flex-col gap-2 rounded-lg border border-dashed border-white/20 p-3.5">
            <span className="text-[14px] font-medium">From a script or an agent</span>
            <span className="text-[13px] leading-[1.45] text-muted-foreground">
              Declare any of these without this dialog. The same name replaces it.
            </span>
            <span className="mt-auto flex min-w-0 flex-col rounded-[6px] border border-white/10 bg-[#0f0f11] px-2.5 py-1.5 font-mono text-[12px] leading-[18px]">
              {[
                `PUT /api/monitors/${slug || "api-errors"}`,
                `{ "source": "search", "threshold": 50,`,
                `  "saved_search": ${JSON.stringify(example?.name ?? "api errors")},`,
                `  "webhook_url": "https://ntfy.sh/…" }`,
              ].map((line) => (
                <span key={line} className="truncate whitespace-pre">
                  {line}
                </span>
              ))}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-end border-t px-[18px] py-3">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
