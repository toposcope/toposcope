import { getDb } from "../control/index";
import { getDefaultWebhook } from "../control/settings";

/**
 * A webhook's URL is its credential: whoever has a Slack or Discord URL can post to that channel.
 * MCP never shows one whole (#361). A tool's answer gives each `webhook_url` and `webhook_urls`
 * entry as its scheme and host and a handle, `https://hooks.slack.com/… kept:3f9a2c1b7d4e`, and
 * any other place a stored webhook's URL appears (a refusal, a call record) as its scheme and host.
 * A handle given back in a tool's arguments, by the caller it was shown to, is the URL again before
 * the route reads them, so an undo puts back the webhook it replaced and a preview and its save
 * match, without the agent ever holding the URL. Handles are kept in the process, as previews are:
 * after a restart a handle is refused, and the webhook is given again in Watch.
 */

type Kept = { url: string; person: string };
const byHandle = new Map<string, Kept>();
const byUrl = new Map<string, string>();
/** The handles kept at most; the oldest go first. */
const mostKept = 10_000;
const keptPattern = / kept:([0-9a-f]{12})$/;
const webhookKeys = new Set(["webhook_url", "webhook_urls"]);

export class KeptRefused extends Error {}

/** A URL as MCP shows it: its scheme and host. */
export function redactedUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "…";
  }
}

function handleFor(person: string, url: string): string {
  const key = `${person}\n${url}`;
  const had = byUrl.get(key);
  if (had) {
    return had;
  }
  const handle = Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString("hex");
  byHandle.set(handle, { url, person });
  byUrl.set(key, handle);
  if (byHandle.size > mostKept) {
    const [oldest, kept] = byHandle.entries().next().value as [string, Kept];
    byHandle.delete(oldest);
    byUrl.delete(`${kept.person}\n${kept.url}`);
  }
  return handle;
}

/** A webhook's URL as a tool shows it to this caller: its scheme and host, and its handle. */
export function shownWebhook(url: string, person: string): string {
  return `${redactedUrl(url)} kept:${handleFor(person, url)}`;
}

function isUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** Every webhook URL this instance stores: each monitor's, and the default in Settings. */
function storedWebhooks(): string[] {
  const out = new Set<string>();
  const rows = getDb().query("SELECT webhook_url, webhook_urls FROM alert_rules").all() as Array<{ webhook_url: string | null; webhook_urls: string | null }>;
  for (const row of rows) {
    if (isUrl(row.webhook_url)) {
      out.add(row.webhook_url);
    }
    try {
      const list = row.webhook_urls ? (JSON.parse(row.webhook_urls) as unknown) : null;
      for (const t of Array.isArray(list) ? list : []) {
        if (isUrl(t)) {
          out.add(t);
        }
      }
    } catch {
      // A list that does not parse holds no URL to hide.
    }
  }
  const fallback = getDefaultWebhook();
  if (isUrl(fallback)) {
    out.add(fallback);
  }
  return [...out];
}

function hideIn(text: string, stored: string[]): string {
  let out = text;
  // Longest first, so a URL that holds another is hidden whole.
  for (const url of [...stored].sort((a, b) => b.length - a.length)) {
    if (out.includes(url)) {
      out = out.split(url).join(redactedUrl(url));
    }
  }
  return out;
}

/** A tool's answer with every webhook URL in it hidden from this caller. */
export function hideWebhooks(json: unknown, person: string, stored: string[] = storedWebhooks()): unknown {
  const walk = (value: unknown, key: string | null): unknown => {
    if (key !== null && webhookKeys.has(key)) {
      if (isUrl(value)) {
        return shownWebhook(value, person);
      }
      if (Array.isArray(value)) {
        return value.map((t) => (isUrl(t) ? shownWebhook(t, person) : walk(t, null)));
      }
    }
    if (typeof value === "string") {
      return hideIn(value, stored);
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, null));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  return walk(json, null);
}

/** Text a tool answers with that is not JSON, a refusal say, with every stored webhook URL hidden. */
export function hideWebhooksInText(text: string): string {
  return hideIn(text, storedWebhooks());
}

function resolveOne(value: string, person: string): string {
  const found = value.match(keptPattern);
  if (!found) {
    return value;
  }
  const kept = byHandle.get(found[1]!);
  if (!kept || kept.person !== person) {
    throw new KeptRefused(`${value} is a webhook this instance no longer keeps for this token (it keeps them until it restarts): give the webhook again in Watch, or the URL in full`);
  }
  return kept.url;
}

/** A tool's arguments with each webhook handle this caller was shown turned back into its URL. */
export function keptWebhooks(args: unknown, person: string): unknown {
  const walk = (value: unknown, key: string | null): unknown => {
    if (key !== null && webhookKeys.has(key)) {
      if (typeof value === "string") {
        return resolveOne(value, person);
      }
      if (Array.isArray(value)) {
        return value.map((t) => (typeof t === "string" ? resolveOne(t, person) : t));
      }
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, null));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };
  return walk(args, null);
}
