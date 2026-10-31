import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { clockAt } from "../watch";

/**
 * Settings › Sign-in and roles (#310, frame 30d with 32g's Passwords card): one OIDC provider,
 * passwords and two-step, and the table of what each role may do, fixed in this edition.
 */
type Body = {
  oidc: { preset: string; label: string; issuer: string; client_id: string; allowed_domain: string | null; without_invite: "viewer" | "operator" | "none"; secret_set_at: number | null } | null;
  passwords: boolean;
  status: { last_sign_in_at: number | null; last_error: string | null; last_error_at: number | null };
  redirect_uri: string;
  two_step_for: "everyone" | "owners";
  remember_days_max?: 0 | 1 | 7 | 14 | 30;
};

const presets: Array<{ id: string; name: string; issuer: string }> = [
  { id: "google", name: "Google Workspace (OIDC)", issuer: "https://accounts.google.com" },
  { id: "entra", name: "Microsoft Entra", issuer: "https://login.microsoftonline.com/<tenant>/v2.0" },
  { id: "okta", name: "Okta", issuer: "https://<org>.okta.com" },
  { id: "keycloak", name: "Keycloak", issuer: "https://<host>/realms/<realm>" },
  { id: "authentik", name: "Authentik", issuer: "https://<host>/application/o/<app>/" },
  { id: "other", name: "Any OIDC provider", issuer: "" },
];
const shortName: Record<string, string> = { google: "Google", entra: "Microsoft", okta: "Okta", keycloak: "Keycloak", authentik: "Authentik", other: "OIDC" };

/** The role table (30d), as the server enforces it. */
export const roleTable: Array<{ what: string; viewer: boolean; operator: boolean }> = [
  { what: "Read Home, Hunt, Watch, traces, profiles", viewer: true, operator: true },
  { what: "Save their own hunts, pin them", viewer: true, operator: true },
  { what: "Export rows", viewer: true, operator: true },
  { what: "Write notes on the clock", viewer: false, operator: true },
  { what: "Make and change monitors, webhooks", viewer: false, operator: true },
  { what: "Change Fields roles and metric links", viewer: false, operator: true },
  { what: "Add panels to an existing share", viewer: false, operator: true },
  { what: "Invite people, change roles", viewer: false, operator: false },
  { what: "Make or revoke tokens, links, shares", viewer: false, operator: false },
  { what: "Retention, sign-in, instance settings", viewer: false, operator: false },
];

export function SignInSettings(props: { onSettings: () => void }) {
  const [body, setBody] = useState<Body | null>(null);
  const [preset, setPreset] = useState("google");
  const [issuer, setIssuer] = useState("https://accounts.google.com");
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [domain, setDomain] = useState("");
  const [without, setWithout] = useState<"viewer" | "operator" | "none">("viewer");
  const [busy, setBusy] = useState(false);
  const [passwordPeople, setPasswordPeople] = useState(0);
  const nowMs = Date.now();
  useEffect(() => {
    void fetch("/api/people")
      .then(async (res) => {
        if (res.ok) {
          const b = (await res.json()) as { people: Array<{ signs_in_with: string }> };
          setPasswordPeople(b.people.filter((p) => p.signs_in_with === "password").length);
        }
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/sign-in-settings");
    if (!res.ok) {
      return;
    }
    const b = (await res.json()) as Body;
    setBody(b);
    if (b.oidc) {
      setPreset(b.oidc.preset);
      setIssuer(b.oidc.issuer);
      setClientId(b.oidc.client_id);
      setDomain(b.oidc.allowed_domain ?? "");
      setWithout(b.oidc.without_invite);
    }
  }, []);
  useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  async function put(patch: Record<string, unknown>, done: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/sign-in-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
      const out = (await res.json().catch(() => null)) as (Body & { error?: string }) | null;
      if (!res.ok || !out || out.error) {
        toast.error(out?.error ?? `Not saved (${res.status})`);
        return;
      }
      setBody(out);
      setSecret("");
      toast.success(done);
    } finally {
      setBusy(false);
    }
  }

  const card = "flex flex-col gap-3 rounded-[10px] border border-white/10 bg-[#131316] px-[18px] py-4";
  const row = "grid grid-cols-[150px_minmax(0,1fr)] items-center gap-3 text-[13px]";
  const k = "text-muted-foreground";
  const input = "h-8 rounded-[7px] border border-white/10 bg-[#0d0d0f] px-2.5 text-[12.5px] outline-none";
  const status = body?.status;
  const working = body?.oidc && status?.last_sign_in_at && (!status.last_error_at || status.last_sign_in_at > status.last_error_at);

  return (
    <main className="min-h-0 flex-1 overflow-auto px-6 pt-3.5 pb-6">
      <nav aria-label="Breadcrumb" className="mb-4 flex items-center gap-2 text-[13px]">
        <button type="button" className="text-[#8a8a93] hover:text-foreground" onClick={props.onSettings}>
          Settings
        </button>
        <span className="text-[#3f3f46]">›</span>
        <span className="font-medium text-foreground" aria-current="page">
          Sign-in and roles
        </span>
      </nav>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[520px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <section className={card}>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="m-0 text-[14px] font-medium">Sign in with a provider</h2>
              {body?.oidc ? (
                working ? (
                  <span className="text-[12px] text-emerald-300">● working · last sign-in {clockAt(status!.last_sign_in_at!, nowMs)}</span>
                ) : status?.last_error ? (
                  <span className="truncate text-[12px] text-red-300" title={status.last_error}>● {status.last_error}</span>
                ) : (
                  <span className="text-[12px] text-muted-foreground">set up · nobody has signed in with it yet</span>
                )
              ) : null}
            </div>
            <label className={row}>
              <span className={k}>Provider</span>
              <select
                className={input}
                value={preset}
                onChange={(e) => {
                  setPreset(e.target.value);
                  const p = presets.find((x) => x.id === e.target.value);
                  if (p && !body?.oidc) {
                    setIssuer(p.issuer);
                  }
                }}
              >
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={row}>
              <span className={k}>Issuer</span>
              <input className={cn(input, "font-mono")} value={issuer} onChange={(e) => setIssuer(e.target.value)} />
            </label>
            <label className={row}>
              <span className={k}>Client id</span>
              <input className={cn(input, "font-mono")} value={clientId} onChange={(e) => setClientId(e.target.value)} />
            </label>
            <label className={row}>
              <span className={k}>Client secret</span>
              <input
                className={cn(input, "font-mono")}
                type="password"
                value={secret}
                placeholder={body?.oidc?.secret_set_at ? `•••••••••••• · set ${clockAt(body.oidc.secret_set_at, nowMs)} · type to replace` : ""}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className={row}>
              <span className={k}>Allowed domain</span>
              <input className={cn(input, "font-mono")} value={domain} placeholder="any" onChange={(e) => setDomain(e.target.value)} />
            </label>
            <label className={row}>
              <span className={k}>Without an invite</span>
              <select className={input} value={without} onChange={(e) => setWithout(e.target.value as typeof without)}>
                <option value="viewer">Join as Viewer</option>
                <option value="operator">Join as Operator</option>
                <option value="none">Not allowed: invite first</option>
              </select>
            </label>
            <span className="text-[12px] text-muted-foreground">
              Any OIDC provider works: Google, Entra, Okta, Keycloak, Authentik. Redirect URL: <span className="font-mono text-zinc-300">{body?.redirect_uri ?? "…/auth/callback"}</span>
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                disabled={busy || !issuer.trim() || !clientId.trim() || (!secret.trim() && !body?.oidc?.secret_set_at)}
                onClick={() =>
                  void put(
                    { oidc: { preset, label: shortName[preset] ?? "OIDC", issuer, client_id: clientId, client_secret: secret || undefined, allowed_domain: domain, without_invite: without } },
                    "Provider saved",
                  )
                }
              >
                {body?.oidc ? "Save the provider" : "Turn on sign-in with a provider"}
              </Button>
              {body?.oidc ? (
                <Button type="button" size="sm" variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => void put({ oidc: null }, "Provider removed")}>
                  Remove
                </Button>
              ) : null}
            </div>
          </section>

          <section className={card}>
            <h2 className="m-0 text-[14px] font-medium">Passwords and two-step</h2>
            <div className={row}>
              <span className={k}>Passwords</span>
              <label className="inline-flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" checked={body?.passwords ?? true} disabled={busy || !body} onChange={(e) => void put({ passwords: e.target.checked }, e.target.checked ? "Passwords on" : "Passwords off")} />
                {body?.passwords === false ? "off · the provider only" : `on · ${passwordPeople} ${passwordPeople === 1 ? "person uses" : "people use"} one`}
              </label>
            </div>
            <label className={row}>
              <span className={k}>Two-step is required for</span>
              <select className={input} value={body?.two_step_for ?? "everyone"} disabled={busy || !body} onChange={(e) => void put({ two_step_for: e.target.value }, "Saved")}>
                <option value="everyone">everyone with a password</option>
                <option value="owners">Owners only</option>
              </select>
            </label>
            <label className={row}>
              <span className={k}>Remember a browser</span>
              <span className="flex flex-wrap items-center gap-3">
                <select className={input} value={body?.remember_days_max ?? 30} disabled={busy || !body} onChange={(e) => void put({ remember_days_max: Number(e.target.value) }, "Saved")}>
                  <option value={30}>up to 30 days</option>
                  <option value={14}>up to 14 days</option>
                  <option value={7}>up to 7 days</option>
                  <option value={1}>up to 1 day</option>
                  <option value={0}>never: a code at every sign-in</option>
                </select>
                <span className="text-[12px] text-muted-foreground">
                  The sign-in slider stops here. Lowering it shortens browsers already remembered; <span className="font-mono text-zinc-300">never</span> forgets them all.
                </span>
              </span>
            </label>
            <div className={row}>
              <span className={k}>Rules</span>
              <span className="text-[12px] text-muted-foreground">12 characters or more · slows down after misses, never locks · sessions last 30 days</span>
            </div>
            <div className={row}>
              <span className={k}>Lost an Owner?</span>
              <span className="text-[12px] text-muted-foreground">
                A host command makes a new one: <span className="font-mono text-zinc-300">toposcope.sh owner-link</span>
              </span>
            </div>
            <span className="text-[12px] leading-[1.5] text-muted-foreground">Turning passwords off leaves the provider only. It is refused while an Owner has no other way in.</span>
          </section>
        </div>

        <section className={card}>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="m-0 text-[14px] font-medium">What each role may do</h2>
            <span className="text-[12px] text-muted-foreground">fixed in this edition</span>
          </div>
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-[11px] tracking-[0.04em] text-muted-foreground uppercase">
                <th className="border-b border-white/10 px-2 py-1.5 text-left font-medium" />
                <th className="w-[84px] border-b border-white/10 px-2 py-1.5 text-center font-medium">Viewer</th>
                <th className="w-[84px] border-b border-white/10 px-2 py-1.5 text-center font-medium">Operator</th>
                <th className="w-[84px] border-b border-white/10 px-2 py-1.5 text-center font-medium">Owner</th>
              </tr>
            </thead>
            <tbody>
              {roleTable.map((r) => (
                <tr key={r.what}>
                  <td className="border-b border-white/[0.06] px-2 py-[7px] text-zinc-300">{r.what}</td>
                  <td className={cn("border-b border-white/[0.06] px-2 text-center", r.viewer ? "text-emerald-300" : "text-zinc-600")}>{r.viewer ? "✓" : "—"}</td>
                  <td className={cn("border-b border-white/[0.06] px-2 text-center", r.operator ? "text-emerald-300" : "text-zinc-600")}>{r.operator ? "✓" : "—"}</td>
                  <td className="border-b border-white/[0.06] px-2 text-center text-emerald-300">✓</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="text-[12px] text-muted-foreground">Every write in the right-hand two columns is recorded with the person who made it.</span>
        </section>
      </div>
    </main>
  );
}
