import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CountText } from "@/components/count-text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatAggStat } from "@/fill-histogram";
import type { AlertRule, SavedSearch } from "@/types";
import { seriesLabel } from "../../query/agg";

const grid = "grid grid-cols-[1.1fr_0.9fr_minmax(220px,1.2fr)_120px_minmax(120px,1fr)_minmax(148px,auto)] items-center gap-2";

export type AlertSeriesView = {
  value: number;
  refused: boolean;
};

type Props = {
  alerts: AlertRule[];
  saved: SavedSearch[];
  series: Record<string, AlertSeriesView>;
  onOpenSearch: (item: SavedSearch) => void;
  onEdit: (rule: AlertRule) => void;
  onCreate: () => void;
  onSilence: (rule: AlertRule, forId: "1h" | "4h" | "24h" | null) => void;
};

function formatThreshold(n: number): string {
  if (Number.isInteger(n)) {
    return n.toLocaleString("en-US");
  }
  return String(n);
}

function webhookHost(url: string | null): string {
  if (!url) {
    return "—";
  }
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function firedLabel(at: number | null): string {
  if (!at) {
    return "never";
  }
  return new Date(at).toISOString().slice(0, 16).replace("T", " ") + "Z";
}

function webhookFail(rule: AlertRule): { label: string; title: string } | null {
  const status = rule.last_status ?? "error";
  const when = rule.last_attempt_at ? firedLabel(rule.last_attempt_at) : null;
  const title = [rule.last_error, when].filter(Boolean).join(" · ");
  if ((rule.consecutive_failures ?? 0) >= 1) {
    const label =
      rule.consecutive_failures === 1
        ? `failed ${status}`
        : `failed ${status} ×${rule.consecutive_failures}`;
    return { label, title };
  }
  if (status === "refused") {
    return { label: "refused", title };
  }
  if (status === "error") {
    return { label: "failed error", title };
  }
  return null;
}

export function AlertsView({
  alerts,
  saved,
  series,
  onOpenSearch,
  onEdit,
  onCreate,
  onSilence,
}: Props) {
  const byId = new Map(saved.map((item) => [item.id, item]));

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
      <div className="mx-auto w-full max-w-[1040px]">
        <div className="mb-3 flex items-end justify-between gap-2">
          <div>
            <h1 className="text-sm font-semibold">Alerts</h1>
            <p className="text-xs text-muted-foreground">
              Watchlist. Create from a saved search — sidebar Alert on this.
            </p>
          </div>
          <Button type="button" size="sm" onClick={onCreate}>
            New alert
          </Button>
        </div>
      {alerts.length === 0 ? (
        <div className="rounded-lg border bg-card px-3 py-8 text-center">
          <p className="text-sm">
            {saved.length === 0
              ? "Save a search, then Alert on this from the sidebar."
              : "No alert rules yet."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            An alert pages when that search’s series is at or above the threshold.
          </p>
          {saved.length > 0 ? (
            <Button type="button" size="sm" className="mt-3" onClick={onCreate}>
              New alert
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div
            className={`${grid} border-b px-3 py-1.5 text-[11px] text-muted-foreground`}
          >
            <span>Name</span>
            <span>Search</span>
            <span>Value / threshold</span>
            <span>Last fired</span>
            <span>Webhook</span>
            <span />
          </div>
          {alerts.map((rule) => {
            const item = rule.saved_search_id
              ? byId.get(rule.saved_search_id)
              : undefined;
            const point = rule.saved_search_id
              ? series[rule.saved_search_id]
              : undefined;
            const firing =
              point !== undefined &&
              !point.refused &&
              point.value >= rule.threshold;
            const pct =
              point !== undefined && !point.refused && rule.threshold > 0
                ? Math.min(100, (point.value / rule.threshold) * 100)
                : 0;
            const fail = webhookFail(rule);
            const silenced =
              typeof rule.silenced_until === "number" &&
              rule.silenced_until > Date.now();
            return (
              <div
                key={rule.id}
                className={`relative ${grid} border-b px-3 py-1.5 text-xs last:border-0 hover:bg-accent/40`}
              >
                <span
                  className={`absolute inset-y-0 left-0 w-0.5 ${
                    firing ? "bg-red-500/80" : "bg-transparent"
                  }`}
                />
                <button
                  type="button"
                  className="truncate text-left hover:underline disabled:no-underline"
                  title={
                    item
                      ? `Open ${item.name} · opens a new tab · this one stays as it is`
                      : undefined
                  }
                  disabled={!item}
                  onClick={() => {
                    if (item) {
                      onOpenSearch(item);
                    }
                  }}
                >
                  {rule.name}
                </button>
                <span className="truncate text-muted-foreground">
                  {item?.name ?? "—"}
                </span>
                <span className="flex items-center gap-2">
                  <span className="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
                    <span
                      className={`absolute inset-y-0 left-0 ${
                        firing ? "bg-red-500" : "bg-sky-500"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                  <span className="font-mono whitespace-nowrap tabular-nums">
                    {point?.refused ? (
                      "—"
                    ) : typeof point?.value === "number" ? (
                      <>
                        <span className="text-muted-foreground">
                          {seriesLabel(item?.agg ?? null)}{" "}
                        </span>
                        {item?.agg ? (
                          formatAggStat(point.value)
                        ) : (
                          <CountText n={point.value} />
                        )}
                      </>
                    ) : (
                      "—"
                    )}{" "}
                    / {formatThreshold(rule.threshold)}
                  </span>
                  {firing ? <Badge variant="error">firing</Badge> : null}
                  {silenced ? <Badge variant="secondary">silenced</Badge> : null}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {firedLabel(rule.last_fired_at)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {webhookHost(rule.webhook_url)}
                  </span>
                  {fail ? (
                    <span
                      className="mt-0.5 block truncate text-[11px] text-destructive"
                      title={fail.title || undefined}
                    >
                      {fail.label}
                    </span>
                  ) : null}
                </span>
                <span className="flex justify-end gap-1">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" size="sm" variant="ghost">
                        Silence
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => onSilence(rule, "1h")}>
                        1 hour
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onSilence(rule, "4h")}>
                        4 hours
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => onSilence(rule, "24h")}>
                        24 hours
                      </DropdownMenuItem>
                      {silenced ? (
                        <DropdownMenuItem onSelect={() => onSilence(rule, null)}>
                          Clear silence
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(rule)}
                  >
                    Edit
                  </Button>
                </span>
              </div>
            );
          })}
        </div>
      )}
      </div>
    </div>
  );
}
