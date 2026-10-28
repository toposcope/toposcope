# Operations

Toposcope is a single-node deployment: one app instance plus one ClickHouse. It does not provide high availability.

Auth is required except `GET /api/health` and `GET /api/metrics`. There is no shared password: people sign in as themselves with one of three roles, scripts send a personal or service account token, and machines that send logs use ingest tokens. [People and roles](people.md) covers the first Owner, invites, two-step, the provider and tokens.

The packaged image is pinned to `ghcr.io/toposcope/toposcope:0.10.0` and should not be replaced with `:latest`. Images from 0.4.11 are published for `linux/amd64` and `linux/arm64`. 0.4.10 and earlier are amd64 only: on an arm64 host Docker will not pull one unless the `app` service names `platform: linux/amd64`, and it then runs emulated.

For the initial deployment and first searchable event, follow the [README quick start](../README.md#quick-start). This guide covers the ongoing operation of that packaged stack.

## Sign in

A browser signs in on a page that names the instance, so two instances are never confused: with an email and a password and then the six digits from an authenticator app, or with the provider when one is set up. A new instance has no Owner until `./toposcope.sh owner-link <email>` on the host makes one. Forgot a password: an Owner resets your two-step, or sends a new invite; a locked-out Owner runs `owner-link` again. See [People and roles](people.md).

## TLS

Terminate TLS on a reverse proxy you already run, such as Caddy, nginx, or Traefik on the host.

Proxy to `http://127.0.0.1:8080` and pass `Authorization`. The packaged Compose file does not include a reverse proxy and keeps the application bound to loopback; do not publish it on `0.0.0.0:8080`.

Example:

```text
toposcope.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

OTLP over gRPC is a second listener, on `127.0.0.1:4319`, speaking HTTP/2 without TLS. An exporter that sends gRPC to an `https://` address needs the proxy to terminate TLS and pass HTTP/2 through to it, on a name or a port of its own:

```text
otlp.toposcope.example.com {
  reverse_proxy h2c://127.0.0.1:4319
}
```

In nginx that is `grpc_pass grpc://127.0.0.1:4319;` in a `server` block that listens with `http2 on;`.

Set `TOPOSCOPE_PUBLIC_URL` in `.env` to the address people open, such as `https://toposcope.example.com`, so a monitor's webhook can link back to the search that opened it. Toposcope cannot work it out itself: calls are sent from a timer, and behind a proxy or a tunnel the address it listens on is not the one people open. Leave it unset and calls carry no link. A path is kept, for a proxy that serves Toposcope under a prefix; a value that is not an `http` or `https` address, or that has a query or a `#`, stops the app at boot with that reason.

## Monitors

A monitor (**Watch → New monitor**, or **Watch this** on the hunt, which saves an unsaved hunt first and plots where the condition would have opened over the last 24 hours) reads its saved search every minute. At or above its threshold it **opens**: it calls its webhook once, then reminds while it stays open (every 4h by default; off, once per window, 1h or 24h), and when the search falls back it **resolves** and calls once more. A reading that is refused or fails changes nothing. Each open-to-resolved stretch is kept with the calls sent during it, and Watch draws them on one clock. Silence stops the calls, not the record. Alerts made before 0.6 are monitors that remind once per window, so they call as often as they did.

A monitor can also open on **fewer than** its threshold, for a stream that must keep talking: `host:ci-box` over 15m, fewer than 1, opens when no line has come from the box for 15 minutes, and the next line resolves it. Fewer than reads a count or a rate (no lines is a rate of 0); a p99 or an average over no lines has no value, so those are refused, and so is a saved search with a fixed from/to. Too few lines can also mean the lines are not here yet, so it **stays shut while it can't tell**, and Watch says which: a refused or failed reading; the first window after Toposcope starts (it may have missed lines while it was down); or a linked source that could feed the search is behind or quiet, so the count is a floor. Watch and the editor show when the search last matched a line ("last line 10:26:41, 37m ago").

A **push monitor** takes results instead of reading a search: a cron job, a backup or a Nagios plugin says how it went, through `POST /v1/checks` with the ingest token or its keyed URL `/ping/<key>` with none, and a name not seen before creates it. It opens on a fail, or when no result has come for its `every` plus its grace, and the next ok resolves it; a warn shows on Watch and calls nobody. See [Check results](ingest.md#check-results-push-monitors).

**Settings → Default webhook** is called by any monitor without its own, such as one created by its first result. Leave it empty and such a monitor keeps its state and calls nobody.

`/ping/<key>` is the one route that takes no token, so a proxy in front of Toposcope must pass it through. Its key is printed only on the monitor's page and in its editor; anyone holding it can post that monitor's results and nothing else. Replace a leaked key by declaring the monitor again (`PUT /api/monitors/<name>` with `"source": "push"`, its `every` and `grace`, and a new random UUID as `key`), or delete and recreate it.

A script or an agent can declare one without the UI, by name; the same name replaces it:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/api-errors \
  -H 'content-type: application/json' \
  -d '{"source": "search", "saved_search": "api errors", "threshold": 50, "webhook_url": "https://ntfy.sh/my-topic", "remind_every": "4h"}'
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/ci-box-went-quiet \
  -H 'content-type: application/json' \
  -d '{"source": "search", "saved_search": "ci-box lines", "opens_when": "fewer_than", "threshold": 1, "webhook_url": "https://ntfy.sh/my-topic"}'
```

An **HTTP(S) monitor** (**New monitor → HTTP(S)**) calls a URL from this node every 30s to 1h: GET, HEAD, or POST with a body, with headers of its own (an `Authorization` token, say), and a 10s timeout. It passes when all its conditions pass, one a line; with none, any 2xx passes:

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

`$.a.b[0]` is a restricted JSONPath into a JSON body: keys and indexes only, no filters, wildcards or scripts. A line that ends in `warn` warns when it does not hold instead of failing: a warn shows on Watch and calls nobody. It opens after 2 failed runs in a row (settable, 1 to 10) and resolves on the next passing run. Without a webhook of its own it calls the default webhook in Settings; with neither it keeps its state and calls nobody. A redirect is never followed, and fails the run; so does a certificate that is not trusted for the host, before any header is sent. In the editor (18r) **Send** runs the request once from this node and shows what came back, where the time went, the certificate, the headers and the body; a value clicked becomes a line, and the footer says what the lines make of that response. Every run is a log row (`monitor:<name> status:ok|warn|fail source:http`, with `http.status`, `duration_ms`, the `line` that decided it and the `error`), so `monitor:api-health duration_ms:>300` is a search, and a run that got an answer keeps its time as the metric `monitor_duration_ms` for the Series overlay. A monitor says what this node can reach: there is no second place to confirm it from, so a network split between Toposcope and the target pages.

Headers are kept as webhook addresses are, in SQLite; they are sent, and never shown back, in Watch or in the editor (`Authorization: ••••` keeps the stored value). Declare one from a script:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/api-health \
  -H 'content-type: application/json' \
  -d '{"source": "http", "url": "https://api.example.com/health", "every": "30s", "conditions": ["status == 200", "$.db == \"ok\"", "time < 300ms warn"], "headers": {"Authorization": "Bearer …"}, "webhook_url": "https://ntfy.sh/my-topic"}'
```

A **TCP monitor** and a **certificate monitor** (**New monitor → TCP · certificate**) run from this node on the same clock, every 30s to 1h, with a 10s timeout. A TCP monitor connects to `host:port` and closes the connection; nothing is sent. Its lines are `connected` and `time < 200ms` (dns and connect); with none, connecting passes. A certificate monitor does the TLS handshake at `host:port` and reads the certificate: from the first byte (**TLS**: 443, 465, 993, 995, a TLS-terminated port), or after STARTTLS on **SMTP** (25, 587), **IMAP** (143) or **POP3** (110). Its lines are `cert > 14d` (days left) and `cert name == mail.example.com` (the certificate is for that name, as a client checks it: one of its names, `*.` standing for one label), and `connected` and `time < 200ms` as a TCP monitor's (the time to the certificate); with none, a trusted certificate for its host passes. A certificate this node would not trust (expired, self-signed, signed by a CA it does not know) fails the run, whatever its lines, and so does one not for its host, unless a `cert name ==` line names the one it must be for (a target given by address, say). A certificate signed by a CA of your own is trusted once the app is: mount the CA's PEM into the app container and set `NODE_EXTRA_CA_CERTS` to its path. Not connecting, or a server that refuses STARTTLS, fails the run with what happened (`connect ECONNREFUSED`, `timeout after 10s`, `STARTTLS refused: 502 5.5.1 …`). Both open after 2 failed runs in a row and resolve on the next passing one, call as an HTTP(S) monitor does, and their editor sends one run from this node and shows how it answered (`connected · TLS 1.3 via STARTTLS`), where the time went, and the certificate (when it expires, its name, its issuer), a chip clicked becoming a line. Every run is a log row (`monitor:<name> status:ok|warn|fail source:tcp|cert`, with `target`, `duration_ms`, `line`, `error`, and for a certificate `starttls`, `cert.subject`, `cert.valid_to` and `cert.days_left`), and a run that got as far as it goes keeps its time as `monitor_duration_ms`. ICMP, DNS and UDP are not checked; anything else is a push monitor.

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/db-port \
  -H 'content-type: application/json' \
  -d '{"source": "tcp", "target": "db.internal:5432", "conditions": ["connected", "time < 200ms warn"]}'
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT http://127.0.0.1:8080/api/monitors/mail-certificate \
  -H 'content-type: application/json' \
  -d '{"source": "cert", "target": "smtp.example.com:587", "starttls": "smtp", "every": "1h", "conditions": ["cert > 14d", "cert name == smtp.example.com"]}'
```

## Monitor bodies

A monitor sends its default body unless it is given one of its own in the monitor dialog, under **Body**: **Text** (sent as `text/plain`) or **JSON** (sent as `application/json`). The default is the JSON Toposcope always sent, with `state` (`open`, `reminder` or `resolved`), `opened_at` and `resolved_at`, or a Slack message for a `hooks.slack.com` address that says when it resolved and how long it lasted.

A body is written with fill-ins, listed beside it in the dialog: `{{alert.name}}`, `{{series}}`, `{{value}}`, `{{threshold}}`, `{{query}}`, `{{fired_at}}`, `{{link}}`, `{{state}}`, `{{opened_at}}`, `{{resolved_at}}`, `{{duration}}` and `{{message}}` (the result that opened it) for a saved-search monitor; `{{alert.name}}`, `{{query}}`, `{{mark.kind}}`, `{{mark.version}}`, `{{mark.at}}`, `{{fingerprints.count}}`, `{{fingerprints.first}}`, `{{fingerprints}}`, `{{more}}` and `{{link}}` for a new-fingerprints one; `{{alert.name}}`, `{{url}}`, `{{status}}`, `{{duration_ms}}`, `{{message}}`, `{{state}}`, `{{opened_at}}`, `{{resolved_at}}`, `{{duration}}`, `{{fired_at}}` and `{{link}}` for an HTTP(S) one; the same with `{{target}}` for `{{url}}` and no `{{status}}` for a TCP or certificate one. `{{link}}` is empty unless `TOPOSCOPE_PUBLIC_URL` is set. In a JSON body every fill-in is a string, escaped to sit inside quotes, so it goes between `"…"`; a body that does not parse is refused with its line and column. A saved-search monitor with a body of its own sends a resolved call only when it is given a second body, **When it resolves**; left empty, it sends none, so a message written for “it opened” never arrives when it ended. **Send a test call** sends the body now, filled in from the last evaluation (or the last mark the monitor watched), then the resolved body when there is one, and shows the status, the time and the reply's first 200 characters.

A body is kept as the webhook address is, in SQLite, and any Operator or Owner can read it in the dialog; Watch does not print it.

Pushover takes JSON with its own fields, at `https://api.pushover.net/1/messages.json`:

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

Toposcope is one node. When the box, the app or its ClickHouse stops, every monitor stops with it, and that silence looks the same as all being well. So point it at something somewhere else.

**`TOPOSCOPE_WATCHDOG_URL`.** Set it in `.env` (Compose passes it through) to a check-in URL on another service. After each monitor pass, once a minute, Toposcope sends `GET <url>` when the pass read its stores, and `GET <url>/fail` when it could not: ClickHouse did not answer a query, or SQLite could not be read. When the check-ins stop, or a `/fail` arrives, that service pages. Leave it unset and nothing is called; a value that is not an `http` or `https` address, or that has a `#`, stops the app at boot with that reason. The address is not logged.

- **Healthchecks.io** (or a self-hosted Healthchecks): a check with period 1 minute and a grace of a few minutes; set `https://hc-ping.com/<uuid>`. `/fail` pages at once.
- **Better Stack**: a heartbeat; set its URL. `/fail` pages at once.
- **Uptime Kuma** or **Gatus**: a push monitor's URL; a missing check-in pages when its interval runs out. They do not read `/fail`, so ClickHouse down is noticed when the check-ins stop instead.
- **A second Toposcope**: a push monitor's keyed URL there, which reads `/fail`.

The check-in goes from the end of the pass, not from a timer of its own: a timer would keep checking in while the monitor loop is stuck. A pass that is still running when the next minute comes skips that minute, so a stuck pass sends nothing.

**An outside check on `GET /api/health`.** It is open (no password), and 200 only when the app is ready and both stores answer; otherwise 503 (see [Health and metrics](#health-and-metrics)). It needs `/api/health` reachable from where the check runs.

| What stops | `TOPOSCOPE_WATCHDOG_URL` | Outside check on `/api/health` |
| --- | --- | --- |
| The box | check-ins stop | no answer |
| The app | check-ins stop | no answer |
| ClickHouse | `/fail` within two passes | 503 |
| The monitor loop, stuck | check-ins stop | still 200: not caught |
| A monitor's webhook target | not caught | not caught |

Neither notices a webhook target that is down: Toposcope does not page about itself through its own webhooks. Watch shows each monitor's failed calls (`failed 503 ×3`) on its rail and its stretches.

## Links

A link is one instance pulling rows from another, made from **Access › Let someone in › Link** and listed under **Links** on Access, with **Paste a link key** on that group; a link pulled by this instance reads *we copy from*, one pulled by the other side *copies from us*, and a key not yet pasted *key not used yet*. Each link has a page from its Access row (Access › its name): which way rows move, its scope, its position, how far behind, its last pull, its rate over a day with any gap drawn as a floor, **Pause** (the link and its place stay; nothing is pulled or served) and, where rows leave this instance, **Change scope**. The instance the other can reach mints a key; the other pastes it, and the side that pasted connects. **Offer rows from here** mints a single-use key for one filter: whoever pastes it pulls the rows that match. **Invite a source here** mints a key that lets this instance pull from whoever pastes it, once or for many until a date (30 days at most). A key carries this instance's address, its name, a short id, the filter, the kinds and a secret; it starts `tsl2_`, is shown once and stored hashed. A `tsl1_` key, from before 0.10, is refused at paste: mint a new one on the other side. On the first paste the two instances swap it for a secret of their own, and that secret reads the link's feed and nothing else.

A link carries every kind: logs, change marks, traces (spans), metrics (points and histogram buckets), profiles and monitors. **Let someone in › Link** has a box per kind, all ticked by default, and says before the key is made which kinds its scope cannot send and why. The side rows leave from decides the set; the side that pastes sees it and cannot widen it. On that side, **Change scope** can untick a kind but never add one: to send a kind the key left out, make a new key. A refused change saves nothing, and unticking keeps the link and its place.

The filter runs on each kind by the fields it has. `service`, `host`, `toposcope` and any other `key:value` apply to spans (`service`, the `host.name` attribute, the span's attributes) and to metric points and buckets (their `service` and `host` labels, then any label). Monitors are decided by service, host and `toposcope`. A filter that names a field a kind lacks sends none of that kind, and the link's page says why: `level` and words in the message rule out spans, metrics, profiles and monitors, and any other key rules out monitors. A profile goes with its span: it goes when the span it belongs to went, in this range or before; a profile with no span goes by `service` alone, and not when the filter names anything else. An empty filter sends every kind whole.

A link's page draws a line per kind on its one position: caught up, behind, a hole, not sent and why, paused, or unticked at the source, each with its rows and bytes over the last day, counted on the side that moved them. Both sides see the counts, so the side rows leave from can untick a kind that costs too much.

Both sides of a link must speak the same link protocol and schema. Every contact under `/link/v1/` sends both, with the release, and a side that speaks another answers 409. The link then stops where it stands and names the side to upgrade ("edge-1 is on 0.11.0, this instance on 0.12.0: upgrade edge-1."); no row is stored while they differ, and it carries on from its place once they match. There is no conversion between versions. A feed reply is one body: a JSON header with the log rows, the marks and each other kind's hole or reason, then one zstd-compressed ClickHouse Native block per kind, which ClickHouse writes at the source and reads at the puller.

The address in a key is `TOPOSCOPE_PUBLIC_URL` when it is set, else the address the browser opened. The other instance has to reach `/link/v1/` there: behind a reverse proxy, forward it like the rest of the app. Those routes do not take a person's sign-in; each proves a key's or a link's secret. No one's sign-in travels between instances.

The puller asks every 5 seconds for what arrived after where it stands, stores the rows as they were (the source's `e1`, its `toposcope` name) and keeps its position, so a restart of either side picks up where it stopped. A row is never stored twice, across retries, links with overlapping filters, or a row that left and came back. Pulled rows follow this instance's retention. Removing a link stops it and deletes nothing.

Links chain: edge → region → centre. A pulled row of any kind takes a position here and keeps where it first entered, so an instance that pulls can be pulled from, and the centre shows the edge's rows under the edge's name, never the region's. A row is stored once however it comes, two ways included (an edge linked to both the region and the centre). A source short two hops away is short at the centre too. Each feed reply says where the source's own sources stand, as its Search would tell them, and the centre adds that to its own link: while the edge is behind at the region, or the region has not reached it, the centre's tells name the edge, behind or not answering since when, and its held group adds "through region"; its link opens the region's link. A source's own sources a link's filter rules out by `toposcope` are not told. A direct link that takes every row speaks for its source alone, so an edge also linked straight to the centre is short there only when that link is. The region's link from the edge says how far behind it is in time, and its link to the centre and the centre's link from the region list the sources further away with where each stands.

A source's monitors show on Watch at the collecting instance, read-only, under the source's name. Their results travel as a kind; on the page that catches a link up, the source also sends the monitors the filter lets through, with their stretches open now or resolved within 30 days, and the monitors that came to it over its own links. Watch groups Here and one group per source, with how far the source is read and a link to its link's page; a short source's lanes are hatched, never green. A source's monitor opens with its definition, results and stretches, and no Edit, Pause, Silence or Delete. Nothing is judged or called again at the collecting instance.

Change marks come with a link, so Fingerprints and Compare at the collecting instance have the source's deploys to cut against. A mark is not a log line, so a filter like `level:error` does not apply to it: a link brings every mark whose `service` its filter does not rule out by a plain mismatch. A pulled mark keeps its kind, service, title and attributes, and its id gains the instance it was posted at — `deploy-api-v1.4@edge-fra` — so two sources that both post `deploy-api-v1.4` stay two marks on the lane, each cutting its own window. An incident the source closes later closes here too. A pulled mark is not edited or deleted here, and nothing is written back to the source. Marks posted before 0.5.5 stay where they were posted.

The side that pasted connects. An invite is pasted by the source, so a source behind NAT — a customer site, a laptop — feeds a reachable instance with no inbound port: it calls out every 5 seconds, asks where the puller stands, reads its own rows from there and hands them over. It is still a pull: the puller keeps the position and the source's own store is the buffer, so a dropped connection resumes where it stopped. The list says who connects — “we call them” or “they call us” — and a quiet link reads “not answering since” or “has not called since” to match.

Search says what this instance holds. Once anything is linked, a `from <instance>` chip group leads the slice under the plot: each source as named on its side, with its count in the hunt; the link's page says its filter and where it stands — behind and read to when, not answering (or not called) since when, or a hole, closed at both ends. Ticking a source writes `toposcope:<name>` in the bar, as ticking a level does. Under 30 seconds behind reads as caught up. While a source is short inside the window, every count it could feed is a floor (`≥`): the strip with one pill naming the source, the table footer, the facets, Stat counts, Top-N bars and saved-search badges over their own spans. The plot hatches the span its rows are not here for, and the table has one hatched row at its read position. A count stays plain when the hunt names other sources (`toposcope:prod-us`), or when the short source's filter rules it out by a plain `key:value` mismatch. A percentile, rate or average keeps its number and says it is over what is here. When part of a count came through a link's filter that the hunt does not already imply, a grey scope beside it says so. An instance that pulls from no one shows none of this. Fingerprints and Compare judge across a gap with floors. While a source that could feed the hunt is short inside either window, the cut keeps its three sets, counted by source on both sides: a line no short source fed is judged as ever; a line also fed by a caught-up source is filed as its counts read, with the short side's count a floor and a note that it is partly from the short source; a line whose every row came from a short source reads `131 → ?` or `? → 64` and is filed as can't tell — never stopped, never first seen. The head note says where the source stands and which side misses its rows. The Compare fold keeps each short side as a floor and shows no delta and no percent. Both are frozen at open: close and reopen once the source has caught up. A new-fingerprints alert pages only what it can tell is new.

The other kinds say the same on their own screens. A trace's waterfall names where each span entered, and while a source is short inside the trace one amber line names it and its missing span is a hatched row. A metric panel hatches a short source's span with a pill naming it; a sum or count Stat reads `≥`, and an average or percentile is named partial. A name whose points came in two units or kinds is split, never summed, and the panel says so ("two units: ms (edge-1), s (here)"); two units draw as two stacked plots for now. A profile names where it entered, and says when its profile is not here yet.

Both sides behind NAT is for the operator's VPN; Toposcope runs no relay.

## Runtime ports and network

- App: `127.0.0.1:8080`
- ClickHouse: stays on the Docker network and is not published
- Syslog UDP: `127.0.0.1:5514`
- OTLP over gRPC: `127.0.0.1:4319` (`OTLP_GRPC_PORT`; `0` turns it off), for logs, traces, metrics and profiles, with the same ingest token
- OTLP JSON and protobuf: the existing HTTP port on `/v1/logs`, `/v1/traces`, and `/v1/profiles`
- Metric points: `POST /v1/metrics` on the same port and ingest token
- Change marks: `POST /v1/marks` on the same port and ingest token; `GET /api/marks` lists them. Search / Follow draw them on the hunt histogram. GitHub Actions and GitLab CI samples in the [ingest guide](ingest.md) POST a deploy mark on release with a stable `id`.
- Probes: `POST /v1/probes` on the same port and ingest token; `GET /api/probes` lists `up` samples. Hunt overlays `metric=up`. A failed pull stores `up=0`. GitHub Actions sample in the [ingest guide](ingest.md).
- `GET /api/metrics`: Prometheus text, unauthenticated

## Memory

An instance that is doing nothing still takes memory, and almost all of it is ClickHouse: it fills its own caches and system tables whether or not anything arrives, then levels off. Plan for about 2 GB for an idle instance.

Measured with `docker stats` on an empty 0.4.10 instance, with no ingest and no searches:

| Minutes since ready | 0 | 5 | 10 | 15 | 20 | 30 | 40 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ClickHouse, GiB | 0.66 | 1.25 | 1.51 | 1.70 | 1.70 | 1.60 | 1.75 |

The app stayed near 30 MiB throughout. A second run, stopped at ten minutes, climbed more slowly: 0.25 GiB at ready and 0.71 GiB at ten minutes. Both ran arm64 images on Docker Desktop.

The packaged Compose file lets ClickHouse use up to 4 GB and the app up to 512 MB.

## What Toposcope calls out to

Toposcope calls out only where this list says. Everything but the first item is something you set up.

- **The release check**, on by default. Once a day, and a few minutes after it starts, the app reads GitHub's public list of releases, `GET https://api.github.com/repos/toposcope/toposcope/releases?per_page=30`, with `User-Agent: toposcope` and nothing else: no version, no instance name, no address. GitHub sees the box's IP. A failed check is noted quietly and tried again the next day. **Check now** in the footer's version popover, or signed-in `POST /api/version/check`, runs the same check at once, at most once every 30 seconds; it does not move the daily one. The footer shows what it found, signed-in `GET /api/version` returns it, and the first sight of a new version writes one row (see Paging on a new release below). Set `TOPOSCOPE_UPDATE_CHECK=off` in `.env` and restart to stop it; then nothing is called. It honours `HTTPS_PROXY`.
- **Webhooks**: each monitor's own, and the default in Settings.
- **HTTP(S), TCP and certificate monitors**: the addresses and ports they check, from this node.
- **Links**: the instances this one pulls from or serves, as each link says.
- **`TOPOSCOPE_WATCHDOG_URL`**: the check-in after each monitor pass, when it is set.

**Paging on a new release.** The first time the check sees a version newer than the running one, Toposcope writes one row, `service:toposcope event:update_available`, with `running`, `latest`, `step` (`patch`, `minor` or `major`), `behind` and `url`. It writes one row per version, never again for the same one. To be paged:
1. Save a search for `service:toposcope event:update_available` over 1 day.
2. Give it a monitor that opens at **at least 1**, with reminders off.
3. Add `step:minor OR step:major` to the search to page only on the bigger steps.

A monitor with the default body sends a resolved call a day later, when the row leaves its window. Give it a body of its own with an empty resolved body to send none.

## Upgrade and retention

### With upgrade.sh

From 0.6.1 every release ships `upgrade.sh`, the operator's script for upgrading a packaged install. Run it on the host, in the directory that holds `compose.yml` and `.env`. It is not the agent skill's `toposcope.sh`: that one never removes data.

```bash
./upgrade.sh                # to the latest stable release
./upgrade.sh 0.6.2          # to a given release
./upgrade.sh 0.6.2 --no-backup
```

In order, it:

1. Checks that Toposcope answers as healthy. It refuses a release that is not newer than the running one.
2. Downloads the release's files into `releases/X.Y.Z/` and checks each against its `SHA256SUMS`. If one does not match, nothing else happens.
3. Prints each newer release's Before you upgrade.
4. Pulls the new image while the old one still runs.
5. Checks the free disk, stops the stack, and backs up both volumes into `backups/<UTC time>-<from version>/`, with the `compose.yml` in use. It says where the backup went and how big it is, and keeps the last 3. Ingest is refused while the stack is stopped. The packaged Vector buffers on disk and sends when the app is back, OTLP exporters retry or drop according to their own settings, and syslog over UDP is lost. Every run prints how long the stop lasted.
6. Swaps `compose.yml`, keeping `.env` and `compose.override.yml`. An edited `vector.yaml` is kept, with the new one beside it as `vector.yaml.new`. Any setting the new `env.example` has that `.env` lacks is named.
7. Starts the stack and waits up to 10 minutes (`--wait <minutes>`) for `/api/health` to report the new version.
8. Posts a deploy change mark, `Toposcope 0.6.1 → 0.6.2`.

If the new version does not come up, it prints the app's last log lines, starts the old version with its own `compose.yml`, and marks that. If the old version will not open its data either, it restores both volumes from the backup first.

- **`./upgrade.sh backup`** takes the same backup on its own, then starts the stack again.
- **`./upgrade.sh rollback --yes`** goes back to the last backup: its `compose.yml` and both volumes. Everything stored since that backup is lost, so without `--yes` it only says which backup and when it was taken.

### From the app

From 0.6.3 the footer's version popover can upgrade too, once the host allows it. The app still never touches Docker: its **Upgrade** button only writes the release asked for into `upgrade/request.json` in the app's own volume, and the host runs `upgrade.sh`. Turn it on once, as root, in the install's directory (Linux with systemd):

```bash
sudo ./upgrade.sh enable-ui
```

That installs `toposcope-upgrade-<project>.path`, which watches the request file, and `toposcope-upgrade-<project>.service`, which runs `./upgrade.sh ui-run` here, as root. The volume is the app's to write, so `ui-run` never opens a path in it: every read and write there runs in a throwaway container that mounts only that volume, with no network, so a link the app put there cannot name a host path. `ui-run` takes the request first, accepts only a bare `X.Y.Z`, and runs `./upgrade.sh X.Y.Z` exactly as above, backup and way back included; it writes how it went to `upgrade/status.json` and the output to `upgrade/last.log`, both in the app's volume, and the popover shows them. Only a release the release check knows as newer can be asked for, one at a time, and a request the host has not taken within 2 minutes is dropped. Any Owner can then start an upgrade to a published release; rollback stays on the host. `sudo ./upgrade.sh disable-ui` removes both units.

### By hand

Boot is idempotent. No volume wipe is required for a normal upgrade. The process listens on `:8080` before migrate; `/api/health` is **503** with `phase` (`starting` / `schema` / `repair` / `ready`) until ingest and search are safe, then **200**. Packaged Compose healthchecks that URL.

On `docker compose stop`, an upgrade or a host shutdown the app finishes the requests in flight and the syslog queue, turns anything new away with **503**, and exits 0. Images up to 0.4.11 ignore the signal: Docker waits ten seconds and kills them, and a request that was still inserting is cut.

Back up both stores first ([Backup and restore](#backup-and-restore)). Then update the application image pin in `compose.yml`, pull and restart:

```bash
docker compose pull
docker compose up -d
```

`curl -fsS http://127.0.0.1:8080/api/health` prints `version`, so the new pin can be confirmed once it is up.

- ClickHouse tables such as `logs_by_minute` and `logs_attr_values_by_minute` are created on boot, and missing day partitions are backfilled from `logs`.
- SQLite adds new tables and columns on boot.
- Retention follows `PUT /api/settings` with `{ "retention_days": 30 }` and requires an integer from 1 to 365. Invalid values return **400** before any SQLite write or TTL change. A valid lower retention can delete older data as ClickHouse applies TTL.
- Metrics can keep longer than logs: `PUT /api/settings` with `{ "metrics_retention_days": 400 }` (1 to 730) sets `metrics`, `metric_buckets` and their minute rollups alone; `null` puts them back on `retention_days`, which they follow until set. Logs, spans, profiles and marks keep `retention_days`. A year of metrics is small next to logs, and they carry no addresses, so a 30-day privacy line on logs can stay where it is.
- TTL is always `toDate(ts) + INTERVAL n DAY`, never `TTL ts + …`.
- The `ALTER` does not wait for `MATERIALIZE TTL` (`alter_sync = 0`), and SQLite is written first.
- `spans`, `profile_samples`, and `change_marks` are created on boot.

ClickHouse 26.3 is the supported LTS line. A too-old-server boot error selects `compose.yml` for a packaged install and `compose.dev.yml` for local development. Back up both stores before upgrading, then pull and restart ClickHouse with that Compose file. Do not remove the data volumes. If an older ClickHouse data directory refuses to start after a 24.8 → 26.3 migration, restore the data instead of pinning a different tag.

Version 0.4.9 changes fingerprint hash inputs for normalized paths and parsed stacks. Existing rows keep their stored ids, so affected errors can receive a new id once when upgraded. Later events use the corrected inputs; see [exception fingerprints](ingest.md#exception-fingerprints).

Version 0.4.11 does the same for three stack shapes: a Python traceback deeper than 50 frames, a Node `at async <path>` frame, and a PHP closure frame named with its file and line. Errors with one of those can receive a new id once when upgraded.

Version 0.5.0 answers an OTLP protobuf request in protobuf, as the protocol says; every reply was JSON before. A script that read `ingested` from the reply to a protobuf request has to send JSON instead. Boot adds one ClickHouse table, `metric_kinds`, which holds whether a metric name is a gauge or a counter. Rolling back to 0.4.12 leaves it in place and unused, and a counter then draws as an average again.

Version 0.5.2 publishes one more loopback port from the packaged `compose.yml`: `127.0.0.1:4319`, for OTLP over gRPC. The app container does not start if something on the host already has that port; change the host side of that mapping in `compose.yml`, or remove it. Boot adds two ClickHouse tables, `metric_buckets` and `metric_buckets_by_minute`, which hold histogram buckets. A histogram stored before the upgrade has no buckets, so its percentiles start with the first export afterwards; its count, sum and average read from the start. Rolling back to 0.5.1 leaves the tables in place and unused: a histogram is listed as its `.count` and `.sum` again, and a saved search or link that carries a reading (`metric=p99:…`) is refused there. `vector.yaml` now also listens for OTLP on ports 4317 and 4318 and keeps its buffers under `VECTOR_DATA_DIR`, so the quick start’s Vector step sets that directory and Vector keeps running after its three smoke events.

Version 0.5.4 adds one ClickHouse table at boot, `metric_units`, which keeps the unit each metric name was last sent with. SQLite gains a `sessions` table for browser sign-ins, an `alert_sent_fingerprints` table, and new columns on alert rules (`kind`, `last_mark`, `body_kind`, `body_template`). A browser now gets a sign-in page instead of the password prompt. Its session lasts 30 days and ends on Sign out or when `TOPOSCOPE_PASSWORD` changes. Scripts and agents that send Basic auth or the ingest token are unchanged. `TOPOSCOPE_PUBLIC_URL` is optional and only adds links to alerts.

Rolling back to 0.5.3 leaves the new table and columns in place and unused: metric units are no longer shown, sign-in falls back to the browser's prompt, and the bare address opens a plain search instead of Home. 0.5.3 reads every alert rule as a threshold alert, so before rolling back, delete or silence new-fingerprints alerts. Otherwise each one pages whenever its saved search has at least its N events in the window. An alert with a body of its own goes back to the default body.

Version 0.5.5 adds links. Boot adds to `logs` the columns `seq` and `src_seq` (each with a minmax index), `toposcope`, `arrived` and `src_id`, and adds `toposcope` to the end of each minute rollup's key; it adds `seq` and `toposcope` to `change_marks`, and one ClickHouse table, `arrival_seq`, the counter that orders rows by arrival. The first feed read adds a projection ordered by arrival to `logs`. SQLite gains `feeds`, `link_keys` and `links`. Every row and rollup already stored is kept; rows stored before have no arrival position, so a link does not carry them. A link needs `/link/v1/` reachable at the address in its key: see “Links” above.

Rolling back to 0.5.4 leaves the new columns, table and projection in place and unused: links stop, Search draws no toposcope group, and rows already pulled stay as ordinary rows. 0.5.4 stores new rows without an arrival position or an instance name, so after rolling forward again a link does not carry rows stored in between.

Version 0.5.6 changes what panel titles, the Alerts list and Search draw, and nothing at boot: rolling back to 0.5.5 is the pin alone.

Version 0.5.7 adds one ClickHouse table at boot, `metric_descriptions`, which keeps the description each metric was sent with. Rolling back to 0.5.6 leaves it in place and unused, and descriptions are no longer shown. A panel there draws only its own metric: its merged lines, line names, title and note are not read, and a saved search saved again there loses them. A link made on 0.5.7 that carries them can open that panel with its Replace and log-scale switches wrong.

Version 0.6.0 turns alerts into monitors, and changes nothing in ClickHouse at boot. SQLite gains columns on `alert_rules` and the tables `monitor_stretches`, `monitor_calls`, `monitor_results` and `monitor_http`. Every alert becomes a monitor that keeps calling once per window while it is open, and now also sends one resolved call when it closes. An alert with a body of its own sends no resolved call until it is given a resolved body. The Alerts view is now Watch, and an old `?view=alerts` link lands there. Push monitors (`POST /v1/checks`, `/ping/<key>`) and HTTP(S) monitors are new, and so are a Settings default webhook and `TOPOSCOPE_WATCHDOG_URL` (see “Who watches Toposcope” above).

Rolling back to 0.5.7 leaves the new columns and tables in place and unused: every rule goes back to calling once per window, with no resolved call, and push and HTTP(S) monitors do not run there; nor does a monitor that relies on the default webhook. Before rolling back, pause or delete every fewer-than monitor: 0.5.7 reads it as at least and calls whenever its search has its N lines, that is, all the time while the stream is healthy. A monitor paused in 0.6.0 stays skipped.

Version 0.6.1 changes nothing in ClickHouse at boot. SQLite gains one table, `monitor_net`, for TCP and certificate monitors, and two `settings` rows, `update_check` and `update_announced`. From this version Toposcope reads GitHub's public releases list once a day (see [What Toposcope calls out to](#what-toposcope-calls-out-to)); `TOPOSCOPE_UPDATE_CHECK=off` stops it. Rolling back to 0.6.0 leaves the table and rows in place and unused: TCP and certificate monitors do not run there, and the footer shows no version. Upgrades from 0.6.1 on can use `upgrade.sh`, which 0.6.1 is the first release to ship.

Version 0.6.2 adds one optional `settings` row, `metrics_retention_days`, and changes nothing until it is set: metrics follow `retention_days` as before. Once set, boot and every save apply it to `metrics`, `metric_buckets` and their minute rollups. Rolling back to 0.6.1 applies `retention_days` to those tables again at boot, so metrics older than that are deleted as ClickHouse applies TTL; set metrics back to follow logs, or take a backup, first.

Version 0.6.3 changes nothing in ClickHouse or SQLite at boot. **Check now** and the upgrade button are new in the version popover; upgrading from the app stays off until the host runs `sudo ./upgrade.sh enable-ui`, and it writes only `upgrade/` in the app's volume. Before rolling back to 0.6.2, run `sudo ./upgrade.sh disable-ui` if it was turned on: 0.6.2's `upgrade.sh` has no `ui-run`, so the unit would fail on a click that 0.6.2's popover can no longer make.

Version 0.7.0 adds shares (see `docs/shares.md`) and changes nothing in ClickHouse at boot. SQLite gains one table, `shares`; a share's use is written as `service:toposcope` rows in `logs`. Every page now sends `Content-Security-Policy: frame-ancestors 'none'`, so a page that framed Toposcope stops showing it; embed a share's panel instead. Rolling back to 0.6.3 leaves the table in place and unread: share reads, tickets and embeds answer as unknown paths there, and framing is allowed again.

Version 0.7.1 changes nothing in ClickHouse or SQLite. A panel's chart pick and a Top-N donut are saved in its `w=` token and saved-search JSON. Rolled back to 0.7.0, bars and stacked bars draw as lines, but a donut panel's link reads as a Top-N of an attr that does not exist (switch it back to Bars before rolling back, or pick its key again after), and a heatmap panel draws nothing. `/embed` may now be framed by Toposcope itself, for the Share dialog's preview.

### Upgrading from 0.9

0.10 carries every kind over a link, and links do not carry across the upgrade. ClickHouse gains `monitor_results` and columns on `spans`, `metrics`, `metric_buckets` and `profile_samples`; SQLite gains `link_volume`, `pulled_monitors` and columns on `links`, `link_keys` and `alert_rules`. No table or column is dropped; monitors made before 0.10 are removed.

1. Upgrade as usual, on both sides of each link. When 0.10 first starts it stops every link made before 0.10 (removed, as Revoke does, with its record kept), since those links cannot carry this release's tables.
2. Once both sides run 0.10, make each link again: **Make a link key** on the side that mints, with its scope and kinds, and **Paste a link key** on the other. A `tsl1_` key is refused. A new link reads the source from its start; log rows pulled before are not stored twice.
3. Make each monitor again, naming its service. Every monitor names the service it is about, and monitors made before 0.10 name none, so they are not kept: each start removes every monitor with no service, with its stretches, calls and silences, and logs one line saying how many. Note the monitors you have in Watch before you upgrade.
4. Make every script that creates monitors over the API send `service` (`POST /api/alert-rules`, `PUT /api/monitors/:name`); a monitor saved without one answers 400, and a save that leaves it out of a monitor that has one keeps it.

What is lost:

- Monitors made before 0.10, with their stretches and calls. Their results in ClickHouse are not read and age out with retention.
- Monitor results kept in SQLite are not copied to ClickHouse, so Watch's strips start again at the upgrade. Stretches and calls stay in SQLite and are kept.
- Spans, metric points, histogram buckets and profile samples stored before 0.10 have no position and never travel over a link.
- `metric_kinds`, `metric_units` and `metric_descriptions` are no longer read. A name's kind, unit and description come off its newest point that has one, so a name not sent since the upgrade reads as a gauge, with no unit or description, until its next point.

A link carries a kind's full projection ordered by `seq` (`by_seq_full`), built on the source's table once a link carries that kind. It costs disk: about 90 % more on `spans` and 130 % more on `metrics`, measured on synthetic data.

To go back to 0.9.0, `./upgrade.sh rollback --yes` restores the backup it took before the upgrade, links and monitors made before 0.10 included, and loses what came in since. Pinning 0.9.0 by hand ([Rollback](#rollback)) keeps the data: 0.9.0 runs on the new tables and columns and leaves them unread. Links stopped at the upgrade stay stopped, and monitors removed at the upgrade stay removed. Links made under 0.10 are not for 0.9: a `tsl2_` key cannot be pasted there, and a 0.10 side refuses a 0.9 one, so revoke them and make links again on 0.9. Monitor results written under 0.10 are in ClickHouse, where 0.9 does not read them, so Watch's strips show a gap for that time. A metric name first sent under 0.10 has no kind or unit on 0.9 until it is sent again there, and a counter reads as an average meanwhile. Rows already pulled stay as ordinary rows.

## Backup and restore

Stop the stack, then copy both volumes: ClickHouse `ch_data` and SQLite `app_data`.

```bash
docker compose down
docker run --rm -v toposcope_ch_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/ch_data.tgz -C /data .
docker run --rm -v toposcope_app_data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/app_data.tgz -C /data .
```

Restore onto empty volumes with the same compose project name so the volume names match:

```bash
docker compose down
docker volume create toposcope_ch_data
docker volume create toposcope_app_data
docker run --rm -v toposcope_ch_data:/data -v "$(pwd)":/backup alpine \
  tar xzf /backup/ch_data.tgz -C /data
docker run --rm -v toposcope_app_data:/data -v "$(pwd)":/backup alpine \
  tar xzf /backup/app_data.tgz -C /data
docker compose up -d
```

Compose may warn that `toposcope_ch_data` already exists and was not created by Compose. That is the restore. Do not set `external: true` on packaged `compose.yml`.

## Rollback

From 0.6.1, `./upgrade.sh rollback --yes` goes back to the last backup the script took (see [With upgrade.sh](#with-upgradesh)). By hand: to roll back a packaged install, pin a previous published image tag in `compose.yml` and run `docker compose up -d`.

0.10 adds tables and columns only, and stops links made before it (see [Upgrading from 0.9](#upgrading-from-09)). Pinning 0.9.0 again leaves them unread; links stopped at the upgrade stay stopped, and links made under 0.10 do not work there.

0.9 replaces the shared password with people (see [Upgrading from 0.8](people.md#upgrading-from-08)). Pinning 0.8.0 again needs `TOPOSCOPE_PASSWORD` back in `.env`; 0.8.0 ignores `people`, `person_tokens`, `invites`, `owner_links`, `oidc_states` and the new columns, and nobody can sign in there as a person. Ingest tokens made or imported on 0.9 keep working on 0.8.0, since they live in `api_tokens`.

`0.3.14` is the first public pin. Pin `0.9.0` to roll back application code from `0.10.0`. Pin `0.8.0` to roll back application code from `0.9.0`, with `TOPOSCOPE_PASSWORD` back in `.env` as the paragraph above says. Pin `0.7.3` to roll back from `0.8.0`. 0.8.0 adds columns only: `saved_searches.pinned`, `alert_rules.measure` and `webhook_urls`, `api_tokens.last_used_at`, `links.paused`, and `shares.panels` and `raw_params`. 0.7.3 leaves them unread: a pin is not Home on 0.7.3, a monitor calls only its first webhook and compares its series (a share-of-all-rows monitor reads as a count), a paused link pulls again, and a share serves its scope with raw params whatever its panels. Pinning 0.8.0 again picks them up where they were.

SQLite migrations are add-column. Extra columns on a downgrade are unused, not a wipe. 0.6.0 also adds tables (`monitor_stretches`, `monitor_calls`, `monitor_http` and `monitor_results`); 0.5.7 ignores them, and a push or HTTP(S) monitor's rule, which has no saved search, does not run there. Pinning 0.6.0 again picks them up where they were. TCP and certificate monitors add `monitor_net`; a release before them ignores it, and does not run them (Watch lists each as a search monitor with no search, and one that was open stays open until they run again).

If a ClickHouse data directory from an older release refuses to start after the migration, use a restore rather than a tag pin.

## Health and metrics

`GET /api/health` and `GET /api/metrics` are open endpoints.

`GET /api/health` is **200** only when `phase` is `ready` and both stores ping; otherwise **503** with `phase`. Either way the body carries `version`, the running release — the same string as the image tag.

`GET /api/metrics` returns Prometheus text.

```bash
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/metrics
```
