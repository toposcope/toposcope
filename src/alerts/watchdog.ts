type Env = Record<string, string | undefined>;

/**
 * Who watches Toposcope (#179). Toposcope is one node: when the app, its ClickHouse or the box
 * stops, every monitor stops with it, and that silence looks like all is well. So after each
 * monitor pass it checks in somewhere else, at `TOPOSCOPE_WATCHDOG_URL` (Healthchecks.io, a Better
 * Stack heartbeat, an Uptime Kuma or Gatus push monitor, a push monitor on a second Toposcope):
 * a GET when the pass read its stores, `<url>/fail` when it could not. When the pings stop or
 * fail, that service pages. Pinged from the end of the pass, not a timer of its own, because the
 * end of the pass is the one place that proves monitors are being read.
 */

/** The check-in address, or null when it is unset or not an http or https address. */
export function watchdogUrl(env: Env = process.env): string | null {
  const raw = (env.TOPOSCOPE_WATCHDOG_URL ?? "").trim();
  if (raw.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hash) {
    return null;
  }
  return url.toString();
}

/** Why `TOPOSCOPE_WATCHDOG_URL` cannot be used, or null when it is unset or fine. */
export function watchdogUrlError(env: Env = process.env): string | null {
  const raw = (env.TOPOSCOPE_WATCHDOG_URL ?? "").trim();
  if (raw.length === 0 || watchdogUrl(env) !== null) {
    return null;
  }
  return "TOPOSCOPE_WATCHDOG_URL must be an http or https address to check in at, with no #fragment";
}

export function requireWatchdogUrl(): void {
  const error = watchdogUrlError();
  if (error) {
    console.error(error);
    process.exit(1);
  }
}

/** `<url>/fail`, Healthchecks' shape: the path gains `/fail`, a query stays where it was. */
export function watchdogFailUrl(url: string): string {
  const u = new URL(url);
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/fail`;
  return u.toString();
}

const pingTimeoutMs = 10_000;

/**
 * One check-in: the URL when the pass read its stores, `<url>/fail` when it could not. Nothing
 * when the setting is unset. A check-in that does not go through is logged, never thrown: the
 * outside service notices the missing ping. The address is not logged, as it is the secret.
 */
export async function pingWatchdog(
  ok: boolean,
  url: string | null = watchdogUrl(),
  send: typeof fetch = fetch,
): Promise<{ status: string } | null> {
  if (!url) {
    return null;
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), pingTimeoutMs);
  try {
    const res = await send(ok ? url : watchdogFailUrl(url), { method: "GET", signal: ac.signal });
    if (!res.ok) {
      console.warn(`watchdog check-in answered ${res.status}`);
    }
    return { status: String(res.status) };
  } catch (err) {
    const status = ac.signal.aborted ? "timeout" : "error";
    const code = (err as { code?: unknown } | null)?.code;
    console.warn(`watchdog check-in failed: ${status === "timeout" ? "timed out" : typeof code === "string" ? code : "no answer"}`);
    return { status };
  } finally {
    clearTimeout(timer);
  }
}
