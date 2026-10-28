import type { Context, Handler } from "hono";
import { getDb } from "./index";
import { getAlert, type AlertRule } from "./alerts";

/**
 * Every monitor names its service and its host (#335). The service is what it is about, required
 * on every save; the host is what it checks: an HTTP(S) monitor's defaults to its URL's host, a
 * TCP or certificate monitor's to its target's, and the operator can change either. A push
 * monitor's results carry the host that pushed; its own host stays empty unless one is given.
 */
export type MonitorPlace = { service: string; host: string };

export const serviceRequired = "A monitor names its service: the service it is about";

/** The host a monitor checks, from what it calls. */
export function defaultHost(rec: Record<string, unknown>, existing: AlertRule | null): string {
  const http = rec.http as { url?: unknown } | undefined;
  const url = typeof rec.url === "string" ? rec.url : typeof http?.url === "string" ? http.url : null;
  if (url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }
  const target = typeof rec.target === "string" ? rec.target : null;
  if (target) {
    return target.replace(/^\[|\](?=:\d+$)/g, "").replace(/:\d+$/, "");
  }
  return existing?.host ?? "";
}

/** Reads a save's service and host: given, kept from before, or the default. */
export function readPlace(rec: Record<string, unknown>, existing: AlertRule | null): MonitorPlace | { error: string } {
  const given = typeof rec.service === "string" ? rec.service.trim() : "";
  const service = given || existing?.service || "";
  if (!service) {
    return { error: serviceRequired };
  }
  if (service.length > 200) {
    return { error: "service is at most 200 characters" };
  }
  const host = typeof rec.host === "string" ? rec.host.trim() : existing?.host || defaultHost(rec, existing);
  return { service, host: host.slice(0, 255) };
}

export function savePlace(id: string, place: MonitorPlace): void {
  getDb().query("UPDATE alert_rules SET service = ?, host = ? WHERE id = ?").run(place.service, place.host, id);
}

/**
 * Wraps a route that saves a monitor: the service and host are read and checked before it runs,
 * kept once it has saved, and part of what it answers.
 */
export function withPlace(handler: Handler, existingOf: (c: Context) => AlertRule | null): Handler {
  return async (c, next) => {
    let rec: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = await c.req.raw.clone().json();
      rec = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      rec = null;
    }
    if (!rec) {
      return handler(c, next);
    }
    const place = readPlace(rec, existingOf(c));
    if ("error" in place) {
      return c.json({ error: place.error }, 400);
    }
    const res = (await handler(c, next)) as Response;
    if (res.status !== 200 && res.status !== 201) {
      return res;
    }
    const body = (await res.clone().json().catch(() => null)) as { id?: string } | null;
    if (!body?.id) {
      return res;
    }
    savePlace(body.id, place);
    const saved = getAlert(body.id);
    return c.json({ ...body, service: saved?.service ?? place.service, host: saved?.host ?? place.host }, res.status as 200 | 201);
  };
}
