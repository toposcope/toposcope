import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { formatCompactCount, formatFieldCount, setCountFormat, useCountFormat } from "@/count-format";
import { setTimestampFormat, useTimestampFormat } from "@/event-time";
import { fieldsCardFacts, namesLine, type FieldsCardFacts } from "../fields-card";
import type { FieldsResponse } from "../../shared/fields";
import { callHost } from "../watch";
import { FIELDS_RANGE } from "./fields-view";
import type { InstanceInfo } from "./instance-menu";
import { signedInUntil } from "./instance-menu";
import {
  draftsOf,
  longestKeptDays,
  maxRules,
  ruleFault,
  rulesOf,
  shortened,
  shortenedLine,
  type RetentionRule,
  type RuleDraft,
} from "../retention-rules";

/**
 * Settings as a page of cards (#268, frame 26n): what is left once Access took tokens, links and
 * shares. Each card is facts first, controls second. Nothing here is a secret.
 */
type SettingsBody = { retention_days: number; metrics_retention_days: number | null; retention_rules?: RetentionRule[]; instance_name: string | null; default_webhook_url: string | null };
type VersionBody = { running: string; latest: string; check: "on" | "off"; checked_at: string | null; error: string | null };
type SystemBody = { app: { mem_used: number | null; mem_limit: number | null }; clickhouse: { disk_used: number | null; disk_total: number | null; stored?: number | null; stored_system?: number | null; mem_used: number | null } };

export function bytes(n: number | null | undefined): string {
  if (n == null) {
    return "—";
  }
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function SettingsPage(props: { instance: InstanceInfo | null; onInstanceName: () => void; onRetentionDays: (days: number, windowDays: number) => void; onSignOut: () => void; onOpenFields: () => void; onOpenSignIn: () => void; onOpenRepositories: () => void; readOnly?: boolean; owners?: string[] }) {
  const [body, setBody] = useState<SettingsBody | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [metricsDays, setMetricsDays] = useState("");
  const [webhook, setWebhook] = useState("");
  const [drafts, setDrafts] = useState<RuleDraft[]>([]);
  const [adding, setAdding] = useState<{ days: string; services: { v: string; n: number }[] | null } | null>(null);
  const [cut, setCut] = useState<{ service: string; days: number }[] | null>(null);
  const [version, setVersion] = useState<VersionBody | null>(null);
  const [system, setSystem] = useState<SystemBody | null>(null);
  const [fields, setFields] = useState<FieldsCardFacts | null>(null);
  const [busy, setBusy] = useState(false);
  const countFormat = useCountFormat();
  const timestampFormat = useTimestampFormat();
  const endpoint = typeof window === "undefined" ? "/v1/logs" : `${window.location.origin}/v1/logs`;

  const load = useCallback(async () => {
    const [s, v, y, f] = await Promise.all([
      fetch("/api/settings"),
      fetch("/api/version"),
      fetch("/api/system"),
      fetch(`/api/fields?range=${FIELDS_RANGE}&wave=keys`),
    ]);
    if (f.ok) {
      setFields(fieldsCardFacts((await f.json()) as FieldsResponse));
    }
    if (s.ok) {
      const json = (await s.json()) as SettingsBody;
      setBody(json);
      setName(json.instance_name ?? "");
      setDays(String(json.retention_days));
      setMetricsDays(json.metrics_retention_days == null ? "" : String(json.metrics_retention_days));
      setDrafts(draftsOf(json.retention_rules));
      setWebhook(json.default_webhook_url ?? "");
    }
    if (v.ok) {
      setVersion((await v.json()) as VersionBody);
    }
    if (y.ok) {
      setSystem((await y.json()) as SystemBody);
    }
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  const savedRules = body?.retention_rules ?? [];
  const logsNow = Number(days);
  const fault = drafts.length > 0 && Number.isInteger(logsNow) ? ruleFault(drafts, logsNow) : null;

  async function openAdding() {
    setAdding({ days: "730", services: null });
    const res = await fetch("/api/facets?range=30d&limit=50&omit=0").catch(() => null);
    const json = res?.ok ? ((await res.json()) as { service?: { v: string; n: number }[] }) : null;
    setAdding((a) => (a ? { ...a, services: json?.service ?? [] } : a));
  }

  function addRule(service: string) {
    setDrafts((d) => [...d, { service, days: adding?.days ?? "730" }]);
    setAdding(null);
  }

  async function save(what: string, confirmed = false) {
    const retention = Number(days);
    const metrics = metricsDays.trim() === "" ? null : Number(metricsDays);
    if (!Number.isInteger(retention) || retention < 1 || retention > 365) {
      toast.error("Logs retention is 1–365 days");
      return;
    }
    if (metrics !== null && (!Number.isInteger(metrics) || metrics < 1 || metrics > 730)) {
      toast.error("Metrics retention is 1–730 days, or empty to follow logs");
      return;
    }
    if (ruleFault(drafts, retention)) {
      return;
    }
    const rules = rulesOf(drafts);
    // 46e: a save that shortens a service kept longer deletes its older rows, so it asks first.
    const willCut = shortened(savedRules, rules, retention);
    if (what === "Retention" && willCut.length > 0 && !confirmed) {
      setCut(willCut);
      return;
    }
    setCut(null);
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retention_days: retention, metrics_retention_days: metrics, retention_rules: rules, instance_name: name, default_webhook_url: webhook.trim() }),
      });
      const json = (await res.json().catch(() => null)) as (SettingsBody & { error?: string }) | null;
      if (!res.ok || !json) {
        toast.error(json?.error ?? `Save failed (${res.status})`);
        return;
      }
      if ((json.instance_name ?? null) !== (body?.instance_name ?? null)) {
        props.onInstanceName();
      }
      props.onRetentionDays(json.retention_days, longestKeptDays(json));
      setBody(json);
      setDrafts(draftsOf(json.retention_rules));
      toast.success(`${what} saved`);
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    const res = await fetch("/api/version/check", { method: "POST" });
    if (!res.ok) {
      toast.error(`Check failed (${res.status})`);
      return;
    }
    setVersion((await res.json()) as VersionBody);
  }

  const card = "flex flex-col gap-2 rounded-xl border border-white/10 bg-surface-2 px-4 py-3.5";
  const row = "flex items-center gap-3 text-sm";
  const k = "w-[110px] shrink-0 text-muted-foreground";
  const fk = "w-[140px] shrink-0 text-muted-foreground";
  const input = "h-8 min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-1 px-2.5 text-sm outline-none focus-visible:border-foreground/40";
  const session = props.instance?.session;

  return (
    <main className="min-h-0 flex-1 overflow-auto px-6 pt-6 pb-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">Settings</h1>
          <span className="text-sm text-muted-foreground">The instance itself, and what its log keys are for. Who may read or write is under Access; what to watch is under Watch.</span>
          {props.readOnly ? <span className="text-sm text-warn-fg">Only an Owner changes retention, delivery, the release or the name{props.owners?.length ? `: ${props.owners.join(", ")}` : ""}.</span> : null}
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          <section className={card}>
            <h2 className="m-0 text-base font-medium">This instance</h2>
            <div className={row}>
              <label htmlFor="instance-name" className={k}>
                Name
              </label>
              <input id="instance-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="unnamed" className={input} disabled={props.readOnly} />
            </div>
            <div className={row}>
              <span className={k}>Shown</span>
              <span className="text-muted-foreground">in the header, on sign-in, and on links as the source's name</span>
            </div>
            <div className={row}>
              <span className={k}>Address</span>
              <span className="truncate font-mono text-muted-foreground">{props.instance?.address ?? "—"}</span>
            </div>
            <div className={row}>
              <span className={k}>Signed in</span>
              <span className="text-muted-foreground">
                {session?.kind === "cookie" ? `this browser, until ${signedInUntil(session.expires_at)}` : "with a token on each request"} ·{" "}
                <button type="button" className="text-zinc-300 hover:text-foreground" onClick={props.onSignOut}>
                  sign out
                </button>
              </span>
            </div>
            <Button type="button" variant="outline" className="self-start" disabled={busy || props.readOnly} onClick={() => void save("Name")}>
              Save the name
            </Button>
          </section>
          <fieldset disabled={props.readOnly} className="contents">
          <section className={card}>
            <h2 className="m-0 text-base font-medium">Retention</h2>
            <div className={row}>
              <label htmlFor="ret-logs" className={k}>
                Logs
              </label>
              <input id="ret-logs" value={days} onChange={(e) => setDays(e.target.value)} className={`${input} max-w-[80px] text-right font-mono`} />
              <span className="text-muted-foreground">{drafts.length > 0 ? "days · every other service" : "days"}</span>
            </div>
            <div className={row}>
              <label htmlFor="ret-metrics" className={k}>
                Metrics
              </label>
              <input id="ret-metrics" value={metricsDays} onChange={(e) => setMetricsDays(e.target.value)} placeholder={days} className={`${input} max-w-[80px] text-right font-mono`} />
              <span className="text-muted-foreground">{metricsDays.trim() ? "days" : "days · empty follows logs"}</span>
            </div>
            {!props.readOnly || drafts.length > 0 ? (
              <div className="flex items-start gap-3 text-sm">
                <span className={`${k} leading-8`}>Kept longer</span>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  {drafts.map((d, i) => {
                    const bad = fault?.service === d.service;
                    return (
                      <div key={d.service} className="flex h-8 items-center gap-2.5">
                        <span className="w-24 truncate font-mono" title={d.service}>
                          {d.service}
                        </span>
                        {props.readOnly ? (
                          <span className="w-16 text-right font-mono">{d.days}</span>
                        ) : (
                          <input
                            aria-label={`Days for ${d.service}`}
                            value={d.days}
                            onChange={(e) => {
                              const value = e.target.value;
                              setCut(null);
                              setDrafts((all) => all.map((x, j) => (j === i ? { ...x, days: value } : x)));
                            }}
                            className={`${input} max-w-[64px] flex-none text-right font-mono ${bad ? "border-danger-fg" : ""}`}
                          />
                        )}
                        <span className="text-muted-foreground">days</span>
                        {props.readOnly ? null : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Stop keeping ${d.service} longer`}
                            className="ml-auto text-faint"
                            onClick={() => {
                              setCut(null);
                              setDrafts((all) => all.filter((_, j) => j !== i));
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                            </svg>
                          </Button>
                        )}
                      </div>
                    );
                  })}
                  {cut
                    ? cut
                        .filter((c) => !drafts.some((d) => d.service === c.service))
                        .map((c) => (
                          <div key={`gone-${c.service}`} className="flex h-8 items-center gap-2.5 text-faint">
                            <span className="w-24 truncate font-mono line-through">{c.service}</span>
                          </div>
                        ))
                    : null}
                  {fault ? <span className="text-danger-fg">{fault.message}</span> : null}
                  {adding ? (
                    <div className="flex h-8 items-center gap-2.5">
                      <DropdownMenu defaultOpen>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={`${input} flex max-w-[140px] items-center justify-between font-mono text-faint`}
                          >
                            service
                            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                              <path d="M2 3.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinecap="round" />
                            </svg>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-60 p-1">
                          <div className="px-2 py-1.5 text-xs text-faint">Sending in the last 30 days</div>
                          {adding.services === null ? (
                            <DropdownMenuItem disabled>…</DropdownMenuItem>
                          ) : (
                            (() => {
                              const open = adding.services.filter((sv) => !drafts.some((d) => d.service === sv.v));
                              return open.length === 0 ? (
                                <DropdownMenuItem disabled>No other service</DropdownMenuItem>
                              ) : (
                                open.map((sv) => (
                                  <DropdownMenuItem key={sv.v} className="justify-between font-mono" onSelect={() => addRule(sv.v)}>
                                    <span className="truncate">{sv.v}</span>
                                    <span className="text-xs text-faint">{formatCompactCount(sv.n)}</span>
                                  </DropdownMenuItem>
                                ))
                              );
                            })()
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <input
                        aria-label="Days"
                        value={adding.days}
                        onChange={(e) => {
                          const value = e.target.value;
                          setAdding((a) => (a ? { ...a, days: value } : a));
                        }}
                        className={`${input} max-w-[64px] flex-none text-right font-mono`}
                      />
                      <span className="text-muted-foreground">days</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Cancel"
                        className="ml-auto text-faint"
                        onClick={() => setAdding(null)}
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      </Button>
                    </div>
                  ) : null}
                  {!props.readOnly && !adding && drafts.length < maxRules ? (
                    <Button type="button" variant="ghost" className="self-start px-0 text-plate hover:bg-transparent hover:text-foreground" onClick={() => void openAdding()}>
                      <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                        <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                      Add a service
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <div className={row}>
              <span className={k}>Traces</span>
              <span className="text-muted-foreground">follow logs, and a service kept longer</span>
            </div>
            <div className={row}>
              <span className={k}>Profiles</span>
              <span className="text-muted-foreground">follow logs</span>
            </div>
            <div className={row}>
              <span className={k}>Marks</span>
              <span className="text-muted-foreground">kept for ever · newest 10 000 listed in a window</span>
            </div>
            {cut && cut.length > 0 ? (
              <div className="flex flex-col gap-2 rounded-lg border border-warn/35 bg-warn-soft px-3 py-2.5 text-sm" role="alert">
                <span className="text-warn-fg">
                  {cut.length === 1 ? <span className="font-mono">{cut[0]!.service}</span> : cut.map((c) => c.service).join(", ")} {shortenedLine(cut)}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="destructive" disabled={busy} onClick={() => void save("Retention", true)}>
                    Save and delete
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setCut(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {props.readOnly ? null : (
              <>
                <span className="text-sm text-muted-foreground">Shortening applies at the next sweep. Nothing comes back.</span>
                {cut && cut.length > 0 ? null : (
                  <Button type="button" variant="outline" className="self-start" disabled={busy || fault !== null} onClick={() => void save("Retention")}>
                    Save retention
                  </Button>
                )}
              </>
            )}
          </section>
          </fieldset>
          <section className={card}>
            <h2 className="m-0 text-base font-medium">Time</h2>
            <div className={row}>
              <span className={k}>Clock</span>
              <span className="text-muted-foreground">UTC · every window, mark and row</span>
            </div>
            <div className={row}>
              <label htmlFor="ts-format" className={k}>
                Timestamps
              </label>
              <select id="ts-format" value={timestampFormat} onChange={(e) => setTimestampFormat(e.target.value as "compact" | "full")} className={input}>
                <option value="compact">Compact · 13:23:19</option>
                <option value="full">Full · 2026-10-26 13:23:19.576</option>
              </select>
            </div>
            <div className={row}>
              <label htmlFor="count-format" className={k}>
                Counts
              </label>
              <select id="count-format" value={countFormat} onChange={(e) => setCountFormat(e.target.value as "human" | "raw")} className={input}>
                <option value="human">Compact · {formatCompactCount(1240)}</option>
                <option value="raw">Raw · {formatFieldCount(1240, "raw")}</option>
              </select>
            </div>
            <span className="text-sm text-muted-foreground">Timestamps and counts are kept in this browser.</span>
          </section>
          <fieldset disabled={props.readOnly} className="contents">
          <section className={card}>
            <h2 className="m-0 text-base font-medium">Delivery</h2>
            <div className={row}>
              <label htmlFor="default-webhook" className={k}>
                Default webhook
              </label>
              <input id="default-webhook" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://ntfy.sh/…" className={`${input} font-mono`} />
            </div>
            <span className="text-sm text-muted-foreground">
              {body?.default_webhook_url ? `Monitors without their own URL call ${callHost(body.default_webhook_url)}.` : "Monitors without their own URL call nothing until this is set."} Each monitor's last call is on Watch.
            </span>
            <Button type="button" variant="outline" className="self-start" disabled={busy} onClick={() => void save("Default webhook")}>
              Save the webhook
            </Button>
          </section>
          </fieldset>
          <fieldset disabled={props.readOnly} className="contents">
          <section className={card}>
            <h2 className="m-0 text-base font-medium">Release</h2>
            <div className={row}>
              <span className={k}>Running</span>
              <span className="font-mono">{version?.running ?? "—"}</span>
            </div>
            <div className={row}>
              <span className={k}>Available</span>
              <span className="font-mono">{version ? (version.latest === version.running ? "up to date" : version.latest) : "—"}</span>
            </div>
            <div className={row}>
              <span className={k}>Checks</span>
              <span className="text-muted-foreground">
                {version?.check === "off" ? "off" : `daily · last ${version?.checked_at ? version.checked_at.slice(11, 16) : "never"}`}
                {version?.check !== "off" ? (
                  <>
                    {" · "}
                    <button type="button" className="text-zinc-300 hover:text-foreground" onClick={() => void checkNow()}>
                      check now
                    </button>
                  </>
                ) : null}
              </span>
            </div>
            <span className="text-sm text-muted-foreground">
              Upgrade from the box: <span className="font-mono text-zinc-300">./upgrade.sh{version && version.latest !== version.running ? ` ${version.latest}` : ""}</span>. A backup runs first unless you skip it.
            </span>
          </section>
          </fieldset>
          <section className={card}>
            <h2 className="m-0 text-base font-medium">Storage</h2>
            <div className={row}>
              <span className={k}>ClickHouse</span>
              <span className="font-mono">
                {bytes(system?.clickhouse.stored)}
                {system?.clickhouse.stored_system ? ` (${bytes(system.clickhouse.stored_system)} its own logs)` : ""}
              </span>
            </div>
            <div className={row}>
              <span className={k}>Disk</span>
              <span className="font-mono">
                {bytes(system?.clickhouse.disk_used)} / {bytes(system?.clickhouse.disk_total)}
              </span>
            </div>
            <div className={row}>
              <span className={k}>App</span>
              <span className="font-mono">
                {bytes(system?.app.mem_used)}
                {system?.app.mem_limit ? ` / ${bytes(system.app.mem_limit)}` : ""}
              </span>
            </div>
            <div className={row}>
              <span className={k}>Ingest endpoint</span>
              <span className="truncate font-mono text-muted-foreground">{endpoint}</span>
              <button
                type="button"
                className="text-sm text-zinc-300 hover:text-foreground"
                onClick={() => void navigator.clipboard.writeText(endpoint).then(() => toast.success("Endpoint copied"))}
              >
                copy
              </button>
            </div>
          </section>
          {props.readOnly ? null : (
          <section className={card}>
              <h2 className="m-0 text-base font-medium">Sign-in and roles</h2>
              <span className="text-sm leading-[1.5] text-muted-foreground">
                Who signs in and how: one provider (Google, Entra, Okta, Keycloak, Authentik), passwords with two-step, and what an Owner, an Operator and a Viewer may do.
              </span>
              <div>
                <Button type="button" variant="outline" onClick={props.onOpenSignIn}>
                  Open sign-in →
                </Button>
              </div>
            </section>
          )}
          <section className={card}>
            <h2 className="m-0 text-base font-medium">Fields</h2>
            <div className={row}>
              <span className={fk}>Keys seen</span>
              <span className="font-mono">{fields ? fields.keys : "—"}</span>
              {fields ? (
                <span className="text-sm text-muted-foreground">
                  in the last 24 h · {fields.core} core, {fields.attrs} from attrs
                </span>
              ) : null}
            </div>
            <div className={row}>
              <span className={fk}>Roles</span>
              <span className="font-mono">
                {fields ? `${fields.roles.chart} chart · ${fields.roles.lookup} lookup · ${fields.roles.ignore} ignore` : "—"}
              </span>
            </div>
            <div className={row}>
              <span className={fk}>New, no role chosen</span>
              <span className="font-mono">{fields ? fields.unchosen.length : "—"}</span>
              {fields && fields.unchosen.length > 0 ? (
                <span className="text-sm text-muted-foreground">{namesLine(fields.unchosen)} · summarised as chart until chosen</span>
              ) : null}
            </div>
            <div className={row}>
              <span className={fk}>Metric links</span>
              <span className="font-mono">{fields ? fields.links.length : "—"}</span>
              {fields && fields.links.length > 0 ? (
                <span className="text-sm text-muted-foreground">{namesLine(fields.links)} · Compare and shares read them as one</span>
              ) : null}
            </div>
            <span className="text-sm text-muted-foreground">A role applies to new rows only.</span>
            <div>
              <Button type="button" variant="outline" onClick={props.onOpenFields}>
                Open fields →
              </Button>
            </div>
          </section>
          <section className={card}>
            <h2 className="m-0 text-base font-medium">Repositories</h2>
            <span className="text-sm leading-[1.5] text-muted-foreground">
              Where each service's code lives, so a deploy's sha and a stack frame open it on GitHub, GitLab, Gitea / Forgejo or Bitbucket. Links only: nothing is fetched, no token is kept.
            </span>
            <div>
              <Button type="button" variant="outline" onClick={props.onOpenRepositories}>
                Open repositories →
              </Button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
