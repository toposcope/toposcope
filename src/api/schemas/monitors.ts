import * as v from "valibot";
import { optionalText, q, window } from "./common";

function described<T extends v.GenericSchema>(schema: T, description: string) {
  return v.pipe(schema, v.description(description));
}

export const monitorsQuery = v.object({
  ...window,
  range: optionalText("Watch's clock: 24h (the default), 7d or 30d; from and to win over it, at most 366d apart."),
});

export const monitorPreviewQuery = v.object({
  q,
  agg: optionalText("The saved search's series, as search's agg takes it; counts rows when left out."),
  opens_when: optionalText("at_least (the default) or fewer_than."),
  threshold: optionalText("The value it opens at, a positive number."),
  window: optionalText("5m (the default), 15m or 1h."),
  measure: optionalText("series (the default), or share of all rows."),
});

const lines = v.union([v.string(), v.array(v.union([v.string(), v.number()]))]);

/** What an HTTP(S), TCP or certificate check calls: the monitor's own fields, and the editor's Send. */
const check = {
  url: v.optional(described(v.string(), "http: the URL it calls, http(s).")),
  method: v.optional(described(v.string(), "http: GET (the default), HEAD or POST.")),
  body: v.nullish(described(v.string(), "http: the body it sends, with POST only.")),
  headers: v.optional(
    described(
      v.union([v.record(v.string(), v.nullable(v.string())), v.array(v.array(v.nullable(v.string())))]),
      "http: headers, as { name: value } or [[name, value]]; a value of null keeps the one stored under that name.",
    ),
  ),
  conditions: v.optional(described(lines, "http, tcp, cert: what each run must show, one line each, as text or a list.")),
  target: v.optional(described(v.string(), "tcp, cert: where it connects, host:port.")),
  starttls: v.nullish(described(v.string(), "cert: smtp, imap or pop3 to start TLS after a greeting; null or none for TLS from the first byte.")),
};

/** Every field a monitor takes, of any source; each says which source reads it. A field left out keeps its value on an update. */
const monitor = {
  name: v.optional(described(v.string(), "The monitor's name; PUT /api/monitors/:name takes it from the path.")),
  source: v.optional(
    described(
      v.picklist(["search", "fingerprints", "push", "http", "tcp", "cert"], "source must be search, fingerprints, push, http, tcp or cert"),
      "What it watches: a saved search's series, its new fingerprints, a push, an HTTP(S) check, a TCP connect or a certificate. A monitor's source never changes.",
    ),
  ),
  kind: v.optional(described(v.string(), "search, fingerprints: threshold or first_seen, the older name of source.")),
  service: v.nullish(described(v.string(), "The service it is about, at most 200 characters; required when it is made.")),
  host: v.nullish(described(v.string(), "The host it is about; by default the host its URL or target names.")),
  saved_search_id: v.nullish(described(v.string(), "search, fingerprints: the saved search it reads.")),
  saved_search: v.optional(described(v.string(), "search, fingerprints: the saved search it reads, by name, when saved_search_id is left out.")),
  threshold: v.optional(described(v.union([v.number(), v.string()]), "search: the value it opens at, a number above 0.")),
  opens_when: v.optional(described(v.string(), "search: at_least (the default) or fewer_than.")),
  measure: v.optional(described(v.string(), "search: series (the default), or share of all rows.")),
  webhook_url: v.nullish(described(v.string(), "Where it calls, http(s); push, http, tcp and cert take null for the default in Settings.")),
  webhook_urls: v.nullish(described(v.array(v.string()), "search, fingerprints: 1 to 5 targets, each an http(s) URL or default for the webhook in Settings.")),
  body_kind: v.optional(described(v.string(), "The call's body: default, text or json.")),
  body_template: v.nullish(described(v.string(), "The call's body when body_kind is text or json.")),
  resolved_body: v.nullish(described(v.string(), "The call's body when it closes, when body_kind is text or json.")),
  remind_every: v.optional(described(v.string(), "Call again while open: off, window (search, fingerprints), 1h, 4h or 24h.")),
  every: v.nullish(described(v.string(), "push: how often a result is due, 30s to 365d (5m, 1h, 1d); http, tcp, cert: how often it runs, 30s, 1m, 5m, 15m, 30m or 1h.")),
  grace: v.nullish(described(v.string(), "push: how long past due before it opens, up to 365d, or 0.")),
  key: v.nullish(described(v.string(), "push: the ping URL's key, a random UUID; made for it when left out.")),
  fail_after: v.optional(described(v.number(), "http, tcp, cert: how many failed runs in a row open it, a whole number.")),
  ...check,
  silence_for: v.nullish(described(v.string(), "Silence it for 1h, 4h or 24h from now.")),
  silenced_until: v.nullish(described(v.number(), "Silence it until this epoch ms; null ends a silence.")),
  enabled: v.optional(described(v.union([v.boolean(), v.number()]), "false or 0 pauses it, true or 1 resumes it.")),
};

export const monitorBody = v.object(monitor);

export const testCallBody = v.object({
  ...monitor,
  id: v.nullish(described(v.string(), "The monitor the draft is of, when it has been saved.")),
  run: v.nullish(
    described(
      v.object({
        status: v.nullish(v.number()),
        duration_ms: v.nullish(v.number()),
        why: v.nullish(v.string()),
      }),
      "http, tcp, cert: the editor's last Send, to fill the call in from: status, duration_ms, why.",
    ),
  ),
});

export const sendBody = v.object({
  ...check,
  source: v.optional(described(v.string(), "http (the default), tcp or cert.")),
  id: v.optional(described(v.string(), "An HTTP(S) monitor whose stored headers a header given as null keeps.")),
});
