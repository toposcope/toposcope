# Monitors

This page is for whoever sets up monitors on a Toposcope instance: the kinds of monitor, when each opens and calls, the body it sends, and how to be told when Toposcope itself stops.

## Kinds of monitor

| Kind | Made from | Opens when |
| --- | --- | --- |
| Saved search | **Watch → New monitor**, or **Watch this** on the hunt | Its saved search reads at or above its threshold, or [fewer than](#open-on-fewer-than) it |
| Push | Its first result, or a script | A result says fail, or no result comes in time |
| HTTP(S) | **New monitor → HTTP(S)** | A URL fails its conditions on 2 runs in a row (settable) |
| TCP | **New monitor → TCP · certificate** | A port fails its conditions on 2 runs in a row |
| Certificate | **New monitor → TCP · certificate** | A certificate fails its conditions on 2 runs in a row |

All of them are listed on Watch. A new-fingerprints monitor has fill-ins of its own: see [Monitor bodies](#monitor-bodies).

## Open, remind, resolve

A saved-search monitor reads its saved search every minute.

- At or above its threshold it **opens** and calls its webhook once.
- While it stays open it reminds: every 4h by default; off, once per window, 1h or 24h.
- When the search falls back it **resolves** and calls once more.
- A reading that is refused or fails changes nothing.

**Watch this** on the hunt saves an unsaved hunt first, and plots where the condition would have opened over the last 24 hours.

Each open-to-resolved stretch is kept with the calls sent during it, and Watch draws them on one clock. Silence stops the calls, not the record. An alert made before 0.6 is a monitor that reminds once per window, so it calls as often as it did.

## Open on fewer than

A monitor can open on **fewer than** its threshold, for a stream that must keep talking. `host:ci-box` over 15m, fewer than 1, opens when no line has come from the box for 15 minutes, and the next line resolves it.

Fewer than reads a count or a rate; no lines is a rate of 0. A p99 or an average over no lines has no value, so those are refused. So is a saved search with a fixed from/to.

Too few lines can also mean the lines are not here yet, so the monitor **stays shut while it can't tell**, and Watch says which:

- a refused or failed reading;
- the first window after Toposcope starts, since it may have missed lines while it was down;
- a linked source that could feed the search is behind or quiet, so the count is a floor.

Watch and the editor show when the search last matched a line ("last line 10:26:41, 37m ago").

## Push monitors

A **push monitor** takes results instead of reading a search. A cron job, a backup or a Nagios plugin says how it went, through `POST /v1/checks` with the ingest token, or its keyed URL `/ping/<key>` with none. A name not seen before creates the monitor.

It opens on a fail, or when no result has come for its `every` plus its grace, and the next ok resolves it. A warn shows on Watch and calls nobody. See [Check results](ingest.md#check-results-push-monitors).

`/ping/<key>` is the one route that takes no token, so a proxy in front of Toposcope must pass it through. Its key is printed only on the monitor's page and in its editor. Anyone holding it can post that monitor's results and nothing else.

To replace a leaked key, declare the monitor again (`PUT /api/monitors/<name>` with `"source": "push"`, its `every` and `grace`, and a new random UUID as `key`), or delete and recreate it.

## Default webhook

**Settings → Default webhook** is called by any monitor without a webhook of its own, such as one created by its first result. Leave it empty and such a monitor keeps its state and calls nobody.

## Declare a monitor from a script

A script or an agent can declare a monitor without the UI, by name; the same name replaces it. A save made with a token is previewed first:

1. `POST /api/monitors/preview` with the same body, and the monitor's name in it, says where it would have opened and resolved over the last 7 days.
2. For 10 minutes after that, the save of that same body goes through.

Without a preview, or with a body changed since, the save answers 428 with the sentence and the call to make.

| Save | Preview needed |
| --- | --- |
| In the app, with a browser session | No |
| A body with only `enabled`, `silence_for` or `silenced_until` (pauses or silences, keeping the other fields) | No |
| `POST /api/alert-rules` | Yes, with `"saves": "create"` in the body, since it may make a second monitor of a name |
| Any other save with a token | Yes |

The answer to a save carries `undo`, the call that takes it back: a delete for a new monitor, the body it had for a replaced one.

This previews and then saves a saved-search monitor, and saves a fewer-than monitor:

```bash
body='{"source": "search", "service": "api", "saved_search": "api errors", "threshold": 50, "webhook_url": "https://ntfy.sh/my-topic", "remind_every": "4h"}'
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X POST http://127.0.0.1:8080/api/monitors/preview \
  -H 'content-type: application/json' -d "$(echo "$body" | jq '. + {name: "api-errors"}')"
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/api-errors \
  -H 'content-type: application/json' -d "$body"
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/ci-box-went-quiet \
  -H 'content-type: application/json' \
  -d '{"source": "search", "saved_search": "ci-box lines", "opens_when": "fewer_than", "threshold": 1, "webhook_url": "https://ntfy.sh/my-topic"}'
```

## HTTP(S) monitors

An **HTTP(S) monitor** (**New monitor → HTTP(S)**) calls a URL from this node every 30s to 1h, with a 10s timeout. It sends GET, HEAD, or POST with a body, with headers of its own (an `Authorization` token, say).

It passes when all its conditions pass, one a line; with none, any 2xx passes. These are the lines it understands:

```text
status == 200
status in 200..299
time < 300ms   warn
body contains "ok"
$.db == "ok"
$.queue.depth < 100
header content-type contains json
cert > 14d
```

- `$.a.b[0]` is a restricted JSONPath into a JSON body: keys and indexes only, no filters, wildcards or scripts.
- A line that ends in `warn` warns when it does not hold instead of failing. A warn shows on Watch and calls nobody.
- A redirect is never followed, and fails the run.
- A certificate that is not trusted for the host fails the run, before any header is sent.

### When it opens and whom it calls

It opens after 2 failed runs in a row (settable, 1 to 10) and resolves on the next passing run. Without a webhook of its own it calls the default webhook in Settings; with neither it keeps its state and calls nobody.

A monitor says what this node can reach. There is no second place to confirm it from, so a network split between Toposcope and the target pages.

### Try it in the editor

In the editor, **Send** runs the request once from this node and shows what came back: where the time went, the certificate, the headers and the body. A value clicked becomes a line, and the footer says what the lines make of that response.

### Runs are log rows

Every run is a log row: `monitor:<name> status:ok|warn|fail source:http`, with `http.status`, `duration_ms`, the `line` that decided it and the `error`. So `monitor:api-health duration_ms:>300` is a search. A run that got an answer keeps its time as the metric `monitor_duration_ms` for the Series overlay.

### Headers

Headers are kept as webhook addresses are, in SQLite. They are sent, and never shown back, in Watch or in the editor; `Authorization: ••••` keeps the stored value. This declares one from a script:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/api-health \
  -H 'content-type: application/json' \
  -d '{"source": "http", "url": "https://api.example.com/health", "every": "30s", "conditions": ["status == 200", "$.db == \"ok\"", "time < 300ms warn"], "headers": {"Authorization": "Bearer …"}, "webhook_url": "https://ntfy.sh/my-topic"}'
```

## TCP and certificate monitors

A **TCP monitor** and a **certificate monitor** (**New monitor → TCP · certificate**) run from this node on the same clock as HTTP(S): every 30s to 1h, with a 10s timeout. ICMP, DNS and UDP are not checked; anything else is a push monitor.

### TCP

A TCP monitor connects to `host:port` and closes the connection; nothing is sent. Its lines are `connected` and `time < 200ms` (dns and connect). With none, connecting passes.

### Certificate

A certificate monitor does the TLS handshake at `host:port` and reads the certificate.

| Mode | Ports | Handshake |
| --- | --- | --- |
| **TLS** | 443, 465, 993, 995, a TLS-terminated port | From the first byte |
| **SMTP** | 25, 587 | After STARTTLS |
| **IMAP** | 143 | After STARTTLS |
| **POP3** | 110 | After STARTTLS |

| Line | Holds when |
| --- | --- |
| `cert > 14d` | The certificate has more than that many days left |
| `cert name == mail.example.com` | The certificate is for that name, as a client checks it: one of its names, `*.` standing for one label |
| `connected` | The connection was made |
| `time < 200ms` | The time to the certificate is under that |

With no lines, a trusted certificate for its host passes.

### What fails a certificate run

- A certificate this node would not trust (expired, self-signed, signed by a CA it does not know) fails the run, whatever its lines.
- So does one not for its host, unless a `cert name ==` line names the one it must be for (a target given by address, say).
- Not connecting, or a server that refuses STARTTLS, fails the run with what happened: `connect ECONNREFUSED`, `timeout after 10s`, `STARTTLS refused: 502 5.5.1 …`.

A certificate signed by a CA of your own is trusted once the app trusts it: mount the CA's PEM into the app container and set `NODE_EXTRA_CA_CERTS` to its path.

### Opening, the editor and log rows

Both open after 2 failed runs in a row, resolve on the next passing one, and call as an HTTP(S) monitor does. Their editor sends one run from this node and shows how it answered (`connected · TLS 1.3 via STARTTLS`), where the time went, and the certificate: when it expires, its name, its issuer. A chip clicked becomes a line.

Every run is a log row: `monitor:<name> status:ok|warn|fail source:tcp|cert`, with `target`, `duration_ms`, `line`, `error`, and for a certificate `starttls`, `cert.subject`, `cert.valid_to` and `cert.days_left`. A run that got as far as it goes keeps its time as `monitor_duration_ms`.

This declares a TCP monitor and a certificate monitor:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/db-port \
  -H 'content-type: application/json' \
  -d '{"source": "tcp", "target": "db.internal:5432", "conditions": ["connected", "time < 200ms warn"]}'
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/mail-certificate \
  -H 'content-type: application/json' \
  -d '{"source": "cert", "target": "smtp.example.com:587", "starttls": "smtp", "every": "1h", "conditions": ["cert > 14d", "cert name == smtp.example.com"]}'
```

## Monitor bodies

A monitor sends its default body unless it is given one of its own in the monitor dialog, under **Body**: **Text** (sent as `text/plain`) or **JSON** (sent as `application/json`).

The default is the JSON Toposcope always sent, with `state` (`open`, `reminder` or `resolved`), `opened_at` and `resolved_at`. For a `hooks.slack.com` address it is a Slack message that says when the monitor resolved and how long it lasted.

### Fill-ins

A body is written with fill-ins, listed beside it in the dialog. `{{link}}` is empty unless `TOPOSCOPE_PUBLIC_URL` is set ([Public address](operations.md#public-address)).

| Monitor | Fill-ins |
| --- | --- |
| Saved search | `{{alert.name}}`, `{{series}}`, `{{value}}`, `{{threshold}}`, `{{query}}`, `{{fired_at}}`, `{{link}}`, `{{state}}`, `{{opened_at}}`, `{{resolved_at}}`, `{{duration}}`, `{{message}}` (the result that opened it) |
| New fingerprints | `{{alert.name}}`, `{{query}}`, `{{mark.kind}}`, `{{mark.version}}`, `{{mark.at}}`, `{{fingerprints.count}}`, `{{fingerprints.first}}`, `{{fingerprints}}`, `{{more}}`, `{{link}}` |
| HTTP(S) | `{{alert.name}}`, `{{url}}`, `{{status}}`, `{{duration_ms}}`, `{{message}}`, `{{state}}`, `{{opened_at}}`, `{{resolved_at}}`, `{{duration}}`, `{{fired_at}}`, `{{link}}` |
| TCP, certificate | As HTTP(S), with `{{target}}` for `{{url}}` and no `{{status}}` |

In a JSON body every fill-in is a string, escaped to sit inside quotes, so it goes between `"…"`. A body that does not parse is refused with its line and column.

### The resolved body

A saved-search monitor with a body of its own sends a resolved call only when it is given a second body, **When it resolves**. Left empty, it sends none, so a message written for "it opened" never arrives when it ended.

### Send a test call

**Send a test call** sends the body now, filled in from the last evaluation (or the last mark the monitor watched), then the resolved body when there is one. It shows the status, the time and the reply's first 200 characters.

A body is kept as the webhook address is, in SQLite, and any Operator or Owner can read it in the dialog. Watch does not print it.

### Pushover and ntfy

Pushover takes JSON with its own fields, at `https://api.pushover.net/1/messages.json`. This body sends the new fingerprints with a link back:

```json
{
  "token": "[YOUR APP TOKEN]",
  "user": "[YOUR USER KEY]",
  "title": "{{alert.name}}",
  "message": "{{fingerprints.count}} new after {{mark.kind}} {{mark.version}}: {{fingerprints.first}}",
  "url": "{{link}}",
  "url_title": "Open in Toposcope"
}
```

ntfy takes the body as the notification, at `https://ntfy.sh/<topic>`, so a text body is enough:

```text
{{alert.name}}: {{fingerprints.count}} new after {{mark.kind}} {{mark.version}}
{{fingerprints}}
{{more}}
{{link}}
```

## Who watches Toposcope

Toposcope is one node. When the box, the app or its ClickHouse stops, every monitor stops with it, and that silence looks the same as all being well. So point it at something somewhere else: a watchdog URL, an outside check on `/api/health`, or both.

### The watchdog URL

Set `TOPOSCOPE_WATCHDOG_URL` in `.env` (Compose passes it through) to a check-in URL on another service. After each monitor pass, once a minute, Toposcope sends:

- `GET <url>` when the pass read its stores;
- `GET <url>/fail` when it could not: ClickHouse did not answer a query, or SQLite could not be read.

When the check-ins stop, or a `/fail` arrives, that service pages. Leave it unset and nothing is called. A value that is not an `http` or `https` address, or that has a `#`, stops the app at boot with that reason. The address is not logged.

| Service | Set up | Reads `/fail` |
| --- | --- | --- |
| **Healthchecks.io**, or a self-hosted Healthchecks | A check with period 1 minute and a grace of a few minutes; set `https://hc-ping.com/<uuid>` | Yes, pages at once |
| **Better Stack** | A heartbeat; set its URL | Yes, pages at once |
| **Uptime Kuma** or **Gatus** | A push monitor's URL; a missing check-in pages when its interval runs out | No: ClickHouse down is noticed when the check-ins stop instead |
| **A second Toposcope** | A push monitor's keyed URL there | Yes |

The check-in is sent at the end of the pass, not from a timer of its own, since a timer would keep checking in while the monitor loop is stuck. A pass still running when the next minute comes skips that minute, so a stuck pass sends nothing.

### An outside check on /api/health

`GET /api/health` is open (no password), and 200 only when the app is ready and both stores answer; otherwise 503 (see [Health and metrics](operations.md#health-and-metrics)). It needs `/api/health` reachable from where the check runs.

### What each one catches

| What stops | `TOPOSCOPE_WATCHDOG_URL` | Outside check on `/api/health` |
| --- | --- | --- |
| The box | check-ins stop | no answer |
| The app | check-ins stop | no answer |
| ClickHouse | `/fail` within two passes | 503 |
| The monitor loop, stuck | check-ins stop | still 200: not caught |
| A monitor's webhook target | not caught | not caught |

Neither notices a webhook target that is down: Toposcope does not page about itself through its own webhooks. Watch shows each monitor's failed calls (`failed 503 ×3`) on its rail and its stretches.
