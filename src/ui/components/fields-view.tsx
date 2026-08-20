import { CountText } from "@/components/count-text";
import { TimeRangePicker } from "@/components/time-range-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { parseRangeMs } from "../../query/relative";
import {
  LINK_CAP,
  coreRoleLabel,
  fieldRoleHelp,
  fieldRoles,
  type FieldCatalogRow,
  type FieldRole,
  type FieldsResponse,
  type FieldsWave,
} from "../../shared/fields";
import { rangeDurationMs } from "../fill-histogram";
import {
  fieldsCatalogSlow,
  fieldsSlowAdvice,
  fieldsWaveLabel,
} from "../fields-load";
import type { RangeMode } from "../search-url";
import { formatSearchElapsed, scanningRangeLabel } from "../time-range";

const grid =
  "grid grid-cols-[minmax(120px,1.1fr)_72px_92px_minmax(196px,1fr)_minmax(200px,1.2fr)] items-center gap-2";

type WriteState = "writing" | "failed" | null;

type Props = {
  catalog: FieldsResponse | null;
  wave: FieldsWave | null;
  warm: boolean;
  elapsedMs: number;
  failed: boolean;
  range: RangeMode;
  from: string;
  to: string;
  liveWindowMs: number;
  onRangeChange: (range: RangeMode) => void;
  onStop: () => void;
  onSave: (
    roles: Record<string, FieldRole>,
    links: Record<string, string>,
  ) => Promise<void>;
};

export function FieldsView({
  catalog,
  wave,
  warm,
  elapsedMs,
  failed,
  range,
  from,
  to,
  liveWindowMs,
  onRangeChange,
  onStop,
  onSave,
}: Props) {
  const [roles, setRoles] = useState(catalog?.roles ?? {});
  const [links, setLinks] = useState(catalog?.links ?? {});
  const [writes, setWrites] = useState<Record<string, WriteState>>({});

  useEffect(() => {
    setRoles(catalog?.roles ?? {});
    setLinks(catalog?.links ?? {});
  }, [catalog?.roles, catalog?.links]);

  const keys = catalog?.keys ?? [];
  const linkCount = Object.keys(links).length;
  const atCap = linkCount >= LINK_CAP;
  const attrCount = keys.filter((row) => row.kind === "attr").length;
  const emptyEvents =
    !wave && catalog !== null && catalog.events <= 0 && keys.length === 0;
  const emptyKeys =
    !wave && !emptyEvents && !failed && attrCount === 0 && keys.length > 0;
  const rangeLabel = scanningRangeLabel(range);
  const spanMs =
    range === "custom"
      ? rangeDurationMs(from, to)
      : (parseRangeMs(range) ?? liveWindowMs);
  const slow = fieldsCatalogSlow(spanMs, elapsedMs, wave);
  const fresh = Boolean(wave) && !warm;
  const skel = fresh && wave === "keys";
  const valuesPending = wave === "keys" || wave === "values";
  const suggestPending = wave !== null;
  const elapsed =
    wave && elapsedMs >= 100 ? ` ${formatSearchElapsed(elapsedMs)}` : "";

  async function commit(
    key: string,
    nextRoles: Record<string, FieldRole>,
    nextLinks: Record<string, string>,
    prev: { roles: Record<string, FieldRole>; links: Record<string, string> },
  ) {
    setRoles(nextRoles);
    setLinks(nextLinks);
    setWrites((cur) => ({ ...cur, [key]: "writing" }));
    try {
      await onSave(nextRoles, nextLinks);
      setWrites((cur) => {
        const next = { ...cur };
        delete next[key];
        return next;
      });
    } catch {
      setRoles(prev.roles);
      setLinks(prev.links);
      setWrites((cur) => ({ ...cur, [key]: "failed" }));
      window.setTimeout(() => {
        setWrites((cur) => {
          if (cur[key] !== "failed") {
            return cur;
          }
          const next = { ...cur };
          delete next[key];
          return next;
        });
      }, 2800);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
      <div className="mx-auto w-full max-w-[1040px]">
        <div className="mb-3 flex items-end justify-between gap-2">
          <div>
            <h1 className="text-sm font-semibold">Fields</h1>
            <p className="text-xs text-muted-foreground">
              What each log field is for, and which log field is the same entity
              as a metric label. Suggestions are never written on their own.
            </p>
          </div>
          <TimeRangePicker
            range={range}
            from={from}
            to={to}
            live={false}
            liveWindowMs={liveWindowMs}
            hideAbsolute
            onRangeChange={onRangeChange}
          />
        </div>

        {failed && !catalog ? (
          <div className="rounded-lg border bg-card px-3 py-8 text-center">
            <p className="text-sm">Could not load fields for this window.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Same window as Search — try a shorter range.
            </p>
          </div>
        ) : emptyEvents && !skel ? (
          <div className="rounded-lg border bg-card px-3 py-8 text-center">
            <p className="text-sm">No events in this range.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Same window as Search.
            </p>
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-2.5">
              {wave ? (
                <div
                  className={cn(
                    "flex h-[26px] min-w-0 items-center gap-2 rounded-md border py-0 pr-1 pl-2.5",
                    slow
                      ? "border-amber-400/45 bg-amber-400/10"
                      : "border-input",
                  )}
                >
                  <span className="size-[11px] shrink-0 animate-spin rounded-full border-[1.5px] border-white/25 border-t-foreground" />
                  <span className="shrink-0 text-[11.5px] whitespace-nowrap">
                    {fieldsWaveLabel(wave)}…{elapsed}
                  </span>
                  {slow ? (
                    <span className="min-w-0 truncate border-l border-white/12 pl-2 text-[11.5px] text-amber-400">
                      {fieldsSlowAdvice(rangeLabel, keys.length)}
                    </span>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-5 shrink-0 rounded-sm px-2 text-[11.5px]"
                    onClick={onStop}
                  >
                    Stop
                  </Button>
                </div>
              ) : (
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  {keys.length} keys · {rangeLabel}
                </span>
              )}
              <div className="min-w-0 flex-1" />
              <span
                className={cn(
                  "inline-flex h-[22px] items-center rounded-md border px-2 text-[11.5px] whitespace-nowrap",
                  atCap
                    ? "border-amber-400 text-amber-400"
                    : "border-input text-muted-foreground",
                )}
              >
                {atCap
                  ? `${LINK_CAP} of ${LINK_CAP} links · unlink one to add another`
                  : `${linkCount} of ${LINK_CAP} links`}
              </span>
            </div>
            {emptyKeys ? (
              <p className="mb-2 text-[11.5px] text-muted-foreground">
                No attr keys in this range.
              </p>
            ) : null}
            <div
              className={cn(
                "relative overflow-hidden rounded-lg border bg-card transition-opacity duration-100",
                warm && wave
                  ? "pointer-events-none opacity-45"
                  : "opacity-100",
              )}
            >
              {wave ? (
                <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-white/[0.06]">
                  <div className="h-full w-1/3 animate-toposcope-indeterminate rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" />
                </div>
              ) : null}
              <div
                className={`${grid} border-b px-3 py-1.5 text-[11px] text-muted-foreground`}
              >
                <span>Key</span>
                <span>Events</span>
                <span>Values</span>
                <span>Role</span>
                <span>Metric link</span>
              </div>
              {skel ? (
                Array.from({ length: 12 }, (_, i) => (
                  <FieldSkeleton key={i} i={i} />
                ))
              ) : (
                keys.map((row) => (
                  <FieldRow
                    key={row.key}
                    row={row}
                    role={roles[row.key] ?? "chart"}
                    link={links[row.key] ?? null}
                    suggestRole={
                      suggestPending
                        ? null
                        : (catalog?.suggestRoles[row.key] ?? null)
                    }
                    suggestLink={
                      suggestPending
                        ? null
                        : (catalog?.suggestLinks[row.key] ?? null)
                    }
                    metricLabels={catalog?.metricLabels ?? []}
                    atCap={atCap}
                    valuesPending={valuesPending}
                    write={writes[row.key] ?? null}
                    onRole={(next) =>
                      void commit(
                        row.key,
                        withRole(roles, row.key, next),
                        links,
                        { roles, links },
                      )
                    }
                    onLink={(label) =>
                      void commit(
                        row.key,
                        roles,
                        withLink(links, row.key, label),
                        { roles, links },
                      )
                    }
                    onUnlink={() =>
                      void commit(
                        row.key,
                        roles,
                        withoutLink(links, row.key),
                        { roles, links },
                      )
                    }
                  />
                ))
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Roles apply to new ingest only — old chart summaries age out with
              retention.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function FieldSkeleton({ i }: { i: number }) {
  return (
    <div
      className={`${grid} h-[38px] animate-toposcope-shimmer border-b border-white/[0.07] px-3`}
    >
      <div
        className="h-2 rounded-[2.4px] bg-white/10"
        style={{ width: `${34 + ((i * 37) % 44)}%` }}
      />
      <div className="ml-auto h-2 w-[62%] rounded-[2.4px] bg-white/10" />
      <div
        className="ml-auto h-2 rounded-[2.4px] bg-white/10"
        style={{ width: `${40 + ((i * 23) % 38)}%` }}
      />
      <div className="h-[22px] w-full rounded-md bg-white/[0.07]" />
      <div
        className="h-[22px] rounded-md bg-white/[0.07]"
        style={{ width: `${i % 3 === 0 ? 46 : 30}%` }}
      />
    </div>
  );
}

function FieldRow({
  row,
  role,
  link,
  suggestRole,
  suggestLink,
  metricLabels,
  atCap,
  valuesPending,
  write,
  onRole,
  onLink,
  onUnlink,
}: {
  row: FieldCatalogRow;
  role: FieldRole;
  link: string | null;
  suggestRole: FieldRole | null;
  suggestLink: string | null;
  metricLabels: string[];
  atCap: boolean;
  valuesPending: boolean;
  write: WriteState;
  onRole: (role: FieldRole) => void;
  onLink: (label: string) => void;
  onUnlink: () => void;
}) {
  const pendingRole = Boolean(suggestRole && suggestRole !== role);
  const pendingLink = Boolean(suggestLink && !link);
  const pending = pendingRole || pendingLink;
  const none = row.roleable ? null : coreRoleLabel(row.key);
  const canAddLink = row.linkable && !link && !atCap;
  const rail =
    write === "failed"
      ? "bg-destructive"
      : write === "writing"
        ? "animate-toposcope-shimmer bg-white/50"
        : pending
          ? "bg-amber-400"
          : "bg-transparent";
  const railTitle =
    write === "writing"
      ? "Saving…"
      : write === "failed"
        ? "Couldn't save — reverted"
        : pending
          ? "Suggestion pending — nothing is applied yet"
          : undefined;

  return (
    <div
      className={cn(
        `${grid} border-b border-white/[0.06] px-3 py-1.5 last:border-0`,
        write === "failed" && "bg-destructive/10",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span
          title={railTitle}
          className={cn("h-[15px] w-0.5 shrink-0 rounded-full", rail)}
        />
        <span className="truncate font-mono text-[12.5px]">{row.key}</span>
      </span>
      <CountText n={row.events} className="font-mono text-[12.5px] tabular-nums" />
      {valuesPending && row.kind !== "core" ? (
        <span
          className="ml-auto block h-2 animate-toposcope-shimmer rounded-[2.4px] bg-white/10"
          style={{ width: `${34 + ((row.key.length * 13) % 46)}%` }}
        />
      ) : (
        <ValuesCell row={row} />
      )}
      <div
        className={cn(
          "min-w-0 transition-opacity duration-100",
          write === "writing" && "opacity-50",
        )}
      >
        {row.roleable ? (
          <div className="inline-flex h-[26px] items-center rounded-md border border-input p-0.5">
            {fieldRoles.map((item) => {
              const on = role === item;
              const suggested = suggestRole === item && !on;
              return (
                <button
                  key={item}
                  type="button"
                  title={
                    suggested
                      ? `Suggested — ${fieldRoleHelp[item]}`
                      : fieldRoleHelp[item]
                  }
                  className={cn(
                    "h-[22px] rounded-sm px-2 text-[11.5px]",
                    on
                      ? "bg-accent text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                    suggested && "text-amber-400",
                  )}
                  onClick={() => onRole(item)}
                >
                  {item}
                </button>
              );
            })}
          </div>
        ) : (
          <span
            className="text-[11.5px] text-muted-foreground"
            title={none?.title}
          >
            {none?.label}
          </span>
        )}
      </div>
      <div
        className={cn(
          "flex min-w-0 items-center gap-1.5 transition-opacity duration-100",
          write === "writing" && "opacity-50",
        )}
      >
        {!row.linkable ? (
          <span className="text-[11.5px] text-muted-foreground">—</span>
        ) : link ? (
          <span className="inline-flex h-[22px] max-w-full items-center gap-1 rounded-md border border-input bg-secondary px-1.5 font-mono text-[11.5px]">
            <span className="truncate">→ {link}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              title="Unlink"
              aria-label={`Unlink ${row.key}`}
              onClick={onUnlink}
            >
              ×
            </button>
          </span>
        ) : (
          <>
            {suggestLink ? (
              <button
                type="button"
                disabled={atCap}
                title={
                  atCap
                    ? `${LINK_CAP} links is the cap — unlink one to add another`
                    : `Top values of ${row.key} overlap ${suggestLink} in this window — click to link`
                }
                className="inline-flex h-[22px] items-center rounded-md border border-dashed border-amber-400/80 px-1.5 font-mono text-[11.5px] text-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => onLink(suggestLink)}
              >
                → {suggestLink}?
              </button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={!canAddLink || metricLabels.length === 0}
                  title={
                    atCap
                      ? `${LINK_CAP} links is the cap — unlink one to add another`
                      : "Link this field to a metric label"
                  }
                  className="h-[22px] px-1.5 text-[11.5px] text-muted-foreground"
                >
                  Link…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[8rem] p-1">
                {metricLabels.map((label) => (
                  <DropdownMenuItem key={label} onSelect={() => onLink(label)}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}

function ValuesCell({ row }: { row: FieldCatalogRow }) {
  if (row.kind === "core" && row.values === null) {
    return <span className="text-[12.5px] text-muted-foreground">—</span>;
  }
  if (row.values === "numeric") {
    return <span className="text-[12.5px] text-muted-foreground">numeric</span>;
  }
  if (row.values === null) {
    return <span className="text-[12.5px] text-muted-foreground">not charted</span>;
  }
  return (
    <CountText n={row.values} className="font-mono text-[12.5px] tabular-nums" />
  );
}

function withRole(
  roles: Record<string, FieldRole>,
  key: string,
  role: FieldRole,
): Record<string, FieldRole> {
  const next = { ...roles };
  if (role === "chart") {
    delete next[key];
  } else {
    next[key] = role;
  }
  return next;
}

function withLink(
  links: Record<string, string>,
  key: string,
  label: string,
): Record<string, string> {
  if (Object.keys(links).length >= LINK_CAP && !(key in links)) {
    return links;
  }
  return { ...links, [key]: label };
}

function withoutLink(
  links: Record<string, string>,
  key: string,
): Record<string, string> {
  const next = { ...links };
  delete next[key];
  return next;
}
