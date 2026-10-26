import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatCompactCount, formatFieldCount, setCountFormat, useCountFormat } from "@/count-format";
import { setTimestampFormat, useTimestampFormat } from "@/event-time";
import { fieldsCardFacts, namesLine, type FieldsCardFacts } from "../fields-card";
import type { FieldsResponse } from "../../shared/fields";
import { callHost } from "../watch";
import { FIELDS_RANGE } from "./fields-view";
import type { InstanceInfo } from "./instance-menu";
import { signedInUntil } from "./instance-menu";

/**
 * Settings as a page of cards (#268, frame 26n): what is left once Access took tokens, links and
 * shares. Each card is facts first, controls second. Nothing here is a secret.
 */
type SettingsBody = { retention_days: number; metrics_retention_days: number | null; instance_name: string | null; default_webhook_url: string | null };
type VersionBody = { running: string; latest: string; check: "on" | "off"; checked_at: string | null; error: string | null };
type SystemBody = { app: { mem_used: number | null; mem_limit: number | null }; clickhouse: { disk_used: number | null; disk_total: number | null; mem_used: number | null } };

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

export function SettingsPage(props: { instance: InstanceInfo | null; onInstanceName: () => void; onRetentionDays: (days: number) => void; onSignOut: () => void; onOpenFields: () => void }) {
  const [body, setBody] = useState<SettingsBody | null>(null);
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [metricsDays, setMetricsDays] = useState("");
  const [webhook, setWebhook] = useState("");
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

  async function save(what: string) {
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
    setBusy(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retention_days: retention, metrics_retention_days: metrics, instance_name: name, default_webhook_url: webhook.trim() }),
      });
      const json = (await res.json().catch(() => null)) as (SettingsBody & { error?: string }) | null;
      if (!res.ok || !json) {
        toast.error(json?.error ?? `Save failed (${res.status})`);
        return;
      }
      if ((json.instance_name ?? null) !== (body?.instance_name ?? null)) {
        props.onInstanceName();
      }
      props.onRetentionDays(json.retention_days);
      setBody(json);
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

  const card = "flex flex-col gap-2.5 rounded-[10px] border border-white/10 bg-[#131316] px-4 py-3.5";
  const row = "flex items-center gap-3 text-[12.5px]";
  const k = "w-[110px] shrink-0 text-muted-foreground";
  const fk = "w-[140px] shrink-0 text-muted-foreground";
  const input = "h-8 min-w-0 flex-1 rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 text-[12.5px] outline-none";
  const session = props.instance?.session;

  return (
    <main className="min-h-0 flex-1 overflow-auto px-6 pt-[22px] pb-6">
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-baseline gap-3.5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Settings</h1>
          <span className="text-[12px] text-muted-foreground">The instance itself, and what its log keys are for. Who may read or write is under Access; what to watch is under Watch.</span>
        </div>
        <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-2 xl:grid-cols-3">
          <section className={card}>
            <h2 className="m-0 text-[13.5px] font-medium">This instance</h2>
            <div className={row}>
              <label htmlFor="instance-name" className={k}>
                Name
              </label>
              <input id="instance-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="unnamed" className={input} />
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
                {session?.kind === "cookie" ? `this browser, until ${signedInUntil(session.expires_at)}` : "with the password on each request"} ·{" "}
                <button type="button" className="text-zinc-300 hover:text-foreground" onClick={props.onSignOut}>
                  sign out
                </button>
              </span>
            </div>
            <Button type="button" size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void save("Name")}>
              Save the name
            </Button>
          </section>
          <section className={card}>
            <h2 className="m-0 text-[13.5px] font-medium">Retention</h2>
            <div className={row}>
              <label htmlFor="ret-logs" className={k}>
                Logs
              </label>
              <input id="ret-logs" value={days} onChange={(e) => setDays(e.target.value)} className={`${input} max-w-[80px] text-right font-mono`} />
              <span className="text-muted-foreground">days</span>
            </div>
            <div className={row}>
              <label htmlFor="ret-metrics" className={k}>
                Metrics
              </label>
              <input id="ret-metrics" value={metricsDays} onChange={(e) => setMetricsDays(e.target.value)} placeholder={days} className={`${input} max-w-[80px] text-right font-mono`} />
              <span className="text-muted-foreground">{metricsDays.trim() ? "days" : "days · empty follows logs"}</span>
            </div>
            <div className={row}>
              <span className={k}>Traces, profiles</span>
              <span className="text-muted-foreground">follow logs</span>
            </div>
            <div className={row}>
              <span className={k}>Marks</span>
              <span className="text-muted-foreground">kept for ever · newest 10 000 listed in a window</span>
            </div>
            <span className="text-[12px] text-muted-foreground">Shortening applies at the next sweep. Nothing comes back.</span>
            <Button type="button" size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void save("Retention")}>
              Save retention
            </Button>
          </section>
          <section className={card}>
            <h2 className="m-0 text-[13.5px] font-medium">Time</h2>
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
            <span className="text-[12px] text-muted-foreground">Timestamps and counts are kept in this browser.</span>
          </section>
          <section className={card}>
            <h2 className="m-0 text-[13.5px] font-medium">Delivery</h2>
            <div className={row}>
              <label htmlFor="default-webhook" className={k}>
                Default webhook
              </label>
              <input id="default-webhook" value={webhook} onChange={(e) => setWebhook(e.target.value)} placeholder="https://ntfy.sh/…" className={`${input} font-mono`} />
            </div>
            <span className="text-[12px] text-muted-foreground">
              {body?.default_webhook_url ? `Monitors without their own URL call ${callHost(body.default_webhook_url)}.` : "Monitors without their own URL call nothing until this is set."} Each monitor's last call is on Watch.
            </span>
            <Button type="button" size="sm" variant="outline" className="self-start" disabled={busy} onClick={() => void save("Default webhook")}>
              Save the webhook
            </Button>
          </section>
          <section className={card}>
            <h2 className="m-0 text-[13.5px] font-medium">Release</h2>
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
            <span className="text-[12px] text-muted-foreground">
              Upgrade from the box: <span className="font-mono text-zinc-300">./upgrade.sh{version && version.latest !== version.running ? ` ${version.latest}` : ""}</span>. A backup runs first unless you skip it.
            </span>
          </section>
          <section className={card}>
            <h2 className="m-0 text-[13.5px] font-medium">Storage</h2>
            <div className={row}>
              <span className={k}>ClickHouse</span>
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
                className="text-[12px] text-zinc-300 hover:text-foreground"
                onClick={() => void navigator.clipboard.writeText(endpoint).then(() => toast.success("Endpoint copied"))}
              >
                copy
              </button>
            </div>
          </section>
          <section className={card}>
            <h2 className="m-0 text-[13.5px] font-medium">Fields</h2>
            <div className={row}>
              <span className={fk}>Keys seen</span>
              <span className="font-mono">{fields ? fields.keys : "—"}</span>
              {fields ? (
                <span className="text-[12px] text-muted-foreground">
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
                <span className="text-[12px] text-muted-foreground">{namesLine(fields.unchosen)} · summarised as chart until chosen</span>
              ) : null}
            </div>
            <div className={row}>
              <span className={fk}>Metric links</span>
              <span className="font-mono">{fields ? fields.links.length : "—"}</span>
              {fields && fields.links.length > 0 ? (
                <span className="text-[12px] text-muted-foreground">{namesLine(fields.links)} · Compare and shares read them as one</span>
              ) : null}
            </div>
            <span className="text-[12px] text-muted-foreground">A role applies to new rows only.</span>
            <div>
              <Button type="button" size="sm" variant="outline" onClick={props.onOpenFields}>
                Open fields →
              </Button>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
