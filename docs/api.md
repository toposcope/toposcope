# API

<!-- Written by `bun run api-docs` from src/api/routes.ts. Do not edit by hand. -->

Every `/api` route a personal or service account token may call, from the same table the app registers its routes from. `GET /api/openapi.json` is this page as OpenAPI 3.1.

Send the token as `Authorization: Bearer <token>`; a browser's session works too. Each route names the least role that may call it ([People and roles](people.md)). A query value is text; a body is JSON.

A refusal is one shape, with the route's status: `{ "error": "<sentence>", "field": "<path>" }`, `field` only when the sentence is about one input. A query or a body the route does not take is a 400 and the route does not run. A role refusal is a 403 that also names the role it needs, `need`.

## Elsewhere

These keep their own pages and are not in the spec:

- **Sign-in** ([people.md](people.md)): A person signs in with a browser, by password or the provider, sets up the second step, and joins by invite or owner link; a token never calls these. `POST /api/sign-in`, `POST /api/sign-out`, `POST /api/setup`, `POST /api/join`, `POST /api/two-step/verify`, `POST /api/two-step/setup`, `POST /api/two-step/finish`, `GET /auth/start`, `GET /auth/callback`.
- **Ingest** ([ingest.md](ingest.md)): Senders write logs, metrics, traces, profiles, marks and check results with an ingest token, over OTLP or Toposcope's own JSON. `POST /api/ingest`, `POST /v1/logs`, `POST /v1/metrics`, `POST /v1/traces`, `POST /v1/profiles`, `POST /v1/marks`, `POST /v1/probes`, `POST /v1/checks`, `GET /ping/{key}`.
- **Links between instances** ([access.md](access.md#links)): Another Toposcope pulls rows with a link's own secret, never a person's token. `POST /link/v1/lookup`, `POST /link/v1/claim`, `GET /link/v1/feed`, `POST /link/v1/remove`, `POST /link/v1/ask`, `POST /link/v1/rows`.
- **Shares, public side** ([shares.md](shares.md)): A page or an app reads a share's counts and series with the share's secret or a ticket. `POST /share/v1/tickets`, `GET /share/v1/series`, `GET /share/v1/top`, `GET /share/v1/names`, `GET /share/v1/panels/{name}`.
- **Open** ([operations.md](operations.md)): Health and Prometheus metrics answer without signing in. `GET /api/health`, `GET /api/metrics`.

## Instance

### GET /api/me

Who the caller is: their person, role and initials, and the Owners to ask.

Role: **Viewer** · `me`

### GET /api/instance

This instance's id, name and address, and how the caller's session ends.

Role: **Viewer** · `instance`

### GET /api/openapi.json

This API as OpenAPI 3.1, built from the same table as the routes.

Role: **Viewer** · `openapi`

### GET /api/system

The app's and ClickHouse's memory, CPU and disk now.

Role: **Viewer** · `system`

### GET /api/throughput

Rows received a second now, and a histogram of the last hour.

Role: **Viewer** · `throughput`

### GET /api/version

The running version, newer releases the daily check knows, and whether upgrading from here is on.

Role: **Viewer** · `version`

### POST /api/version/check

Check for newer releases now, on top of the daily check.

Role: **Owner** · `version_check`

### POST /api/version/upgrade

Ask the host to upgrade to a newer release the check knows.

Role: **Owner** · `version_upgrade`

Body, optional:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `version` | string |  | The release to upgrade to, one GET /api/version lists. |

## Search

### GET /api/search

Rows that match a query in a window, newest first, with a histogram or a metric's series.

Role: **Viewer** · `search`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |
| `cursor` | string |  | The cursor of the last page, for the next page of events. |
| `since` | string |  | The newest event's time the caller has: only newer rows and the current bar come back. |
| `limit` | string |  | How many to return at most, a whole number. |
| `split` | string |  | Split the histogram by level (the default), service, host or none. |
| `step` | string |  | Pin the histogram's bar width: 1ms, 10ms, 100ms, 1s, 10s, 1m, 5m, 15m, 1h, 4h, 1d or 7d. |
| `agg` | string |  | A series derived from the rows: rate, or p99, avg, min, max or sum of a numeric attribute (p99:duration_ms). |
| `metric` | string |  | An ingested metric to plot instead, a histogram's with its reading first (p99:http.server.request.duration). |
| `ml` | string |  | The metric's label matchers, key:value separated by spaces, at most 4. |
| `msplit` | string |  | A metric label key to split the metric's series by. |
| `events` | string |  | 0 skips the page of events. |
| `keep` | string[] |  | Series keys to keep in a split, besides other. |
| `exact` | string |  | 1 reads the stored rows rather than the rollups. |
| `other` | string |  | 1 folds the series past the cap into other. |

### GET /api/traces/{trace_id}

One trace's spans, the slowest branches when it is large.

Role: **Viewer** · `traces_get`

Path: `trace_id`.

### GET /api/marks

Change marks in a window: deploys, flags, incidents and notes.

Role: **Viewer** · `marks`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `kind` | "deploy" \| "flag" \| "incident" \| "note" |  | Only marks of this kind. |
| `service` | string |  | Only marks for this service. |

### GET /api/probes

Probe samples in a window.

Role: **Viewer** · `probes`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `service` | string |  | Only probes of this service. |

### GET /api/profiles

The profile samples one span carries, as a flame graph.

Role: **Viewer** · `profiles`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `trace_id` | string | yes | The trace, 32 hex characters. |
| `span_id` | string | yes | The span, 16 hex characters. |

### GET /api/search/context

The rows either side of one row, from the same service and host.

Role: **Viewer** · `search_context`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `ts` | string | yes | The row's time, an ISO time. |
| `service` | string | yes | The row's service. |
| `host` | string |  | The row's host. |
| `n` | string |  | How many rows either side, a whole number. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |

### GET /api/search/around

The rows that match a query either side of a time.

Role: **Viewer** · `search_around`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `ts` | string | yes | The time to read either side of, an ISO time. |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `n` | string |  | How many rows either side, a whole number. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |

### GET /api/search/cut

Compare a query's fingerprints before and after a change mark.

Role: **Viewer** · `search_cut`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `mark` | string | yes | The change mark's id. |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |
| `opened` | string |  | The fingerprint whose row is open, kept in the answer. |
| `live` | string |  | 1 or true: the after side ends now. |

### GET /api/search/revisions

Which fingerprint keys a query's rows carry before and after a point.

Role: **Viewer** · `search_revisions`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |
| `from` | string | yes | Where the before side starts, an ISO time. |
| `after` | string | yes | The point between before and after, an ISO time. |
| `to` | string | yes | Where the after side ends, an ISO time. |

### GET /api/search/follow-span

How many rows carry one key:value within a day of a time, and their first and last.

Role: **Viewer** · `search_follow_span`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `q` | string | yes | The key:value to follow. |
| `at` | string | yes | The time to read a day either side of, an ISO time. |

### GET /api/fingerprints/{hex}

When one fingerprint was first and last seen, and how often, in a window.

Role: **Viewer** · `fingerprint_seen`

Path: `hex`.

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time; the last 7 days by default. |
| `to` | string |  | Where the window ends, an ISO time; now by default. |

### GET /api/facets

The top values of service, host, level and fingerprint among a query's rows.

Role: **Viewer** · `facets`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |
| `limit` | string |  | How many to return at most, a whole number. |
| `omit` | string |  | 0 or false counts each facet over the whole query; by default a facet leaves its own field out of it. |
| `fields` | string |  | toposcope adds the instance each row entered at as a facet. |

### GET /api/attr-keys

The attribute keys a query's rows carry.

Role: **Viewer** · `attr_keys`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |

### GET /api/attr-facets

The top values of some attribute keys among a query's rows.

Role: **Viewer** · `attr_facets`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |
| `attrs` | string |  | The attribute keys to count, separated by commas. |
| `limit` | string |  | How many to return at most, a whole number. |
| `omit` | string |  | 0 or false counts each facet over the whole query; by default a facet leaves its own field out of it. |

### GET /api/attr-values

The values of one attribute key that start with a prefix.

Role: **Viewer** · `attr_values`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |
| `key` | string |  | The attribute key. |
| `prefix` | string |  | What the values start with. |

### GET /api/numeric-keys

The attribute keys with numbers among a query's rows, to sum or average.

Role: **Viewer** · `numeric_keys`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |

### GET /api/metric-names

The metric names with points in a window.

Role: **Viewer** · `metric_names`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `find` | string |  | Only names that contain this. |
| `picked` | string |  | Names to list whatever the cap, separated by commas. |

### GET /api/metric-labels

The label keys one metric's points carry in a window, with how many values each.

Role: **Viewer** · `metric_labels`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `name` | string | yes | The metric's name. |

## Saved searches

### GET /api/home

The saved search marked Home, if any.

Role: **Viewer** · `home`

### GET /api/home/since

What changed since a mark or in the last hour: new fingerprints, monitors that opened, marks.

Role: **Viewer** · `home_since`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `mark` | string |  | A change mark's id: what changed since it. |
| `since` | string |  | hour: what changed in the last hour. |

### PUT /api/home

Mark a saved search Home, or unmark it.

Role: **Operator** · `home_set`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `saved_id` | string \| null | yes | The saved search to mark Home; null unmarks it. |

### GET /api/saved-searches

The saved searches the caller may see, with their pins.

Role: **Viewer** · `saved_searches`

### POST /api/saved-searches

Save a search: a Viewer's is their own, an Operator's is shared.

Role: **Viewer** · `saved_search_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string | yes | Its name. |
| `query` | string |  | The query, in the query language. |
| `range` | string \| null |  | A window that ends now, as search's range takes it; null for from_ts and to_ts. |
| `from_ts` | string \| null |  | Where a fixed window starts, an ISO time; read only when range is null. |
| `to_ts` | string \| null |  | Where a fixed window ends, an ISO time; read only when range is null. |
| `agg` | string \| null |  | The series it reads, as search's agg takes it; null counts rows. |
| `widgets` | any \| null |  | The canvas: its widgets and their places, as the app saves them. |
| `board` | any \| null |  | A board's slots and window, as the app saves them; null makes it a plain hunt. |
| `cols` | string \| string[] \| null |  | Attribute keys shown as columns, a list or separated by commas. |
| `pinned` | boolean |  | Pinned for the caller; each person pins their own. |
| `shared` | any |  | true or false: shared with everyone, or the caller's own; a Viewer's is their own. |

### PUT /api/saved-searches/{id}

Change a saved search, or pin or unpin it; a field left out keeps its value.

Role: **Viewer** · `saved_search_update`

Path: `id`.

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string |  | Its name. |
| `query` | string |  | The query, in the query language. |
| `range` | string \| null |  | A window that ends now, as search's range takes it; null for from_ts and to_ts. |
| `from_ts` | string \| null |  | Where a fixed window starts, an ISO time; read only when range is null. |
| `to_ts` | string \| null |  | Where a fixed window ends, an ISO time; read only when range is null. |
| `agg` | string \| null |  | The series it reads, as search's agg takes it; null counts rows. |
| `widgets` | any \| null |  | The canvas: its widgets and their places, as the app saves them. |
| `board` | any \| null |  | A board's slots and window, as the app saves them; null makes it a plain hunt. |
| `cols` | string \| string[] \| null |  | Attribute keys shown as columns, a list or separated by commas. |
| `pinned` | boolean |  | Pinned for the caller; each person pins their own. |
| `shared` | any |  | true or false: shared with everyone, or the caller's own; a Viewer's is their own. |

### DELETE /api/saved-searches/{id}

Delete a saved search.

Role: **Viewer** · `saved_search_delete`

Path: `id`.

### GET /api/saved-searches/{id}/run

Run a saved search over its own window: its rows' count and its series' value.

Role: **Viewer** · `saved_search_run`

Path: `id`.

### POST /api/saved-searches/{id}/test

Read a saved search as a monitor would now: its value, a sample of rows, and when it last matched.

Role: **Operator** · `saved_search_test`

Path: `id`.

## Monitors

### GET /api/alert-rules

Every monitor as a rule, and whether a call can link back here.

Role: **Viewer** · `alert_rules`

### POST /api/alert-rules/test-call

Send a test call for a monitor as drafted, filled in from its last evaluation.

Role: **Operator** · `alert_rule_test_call`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string |  | The monitor's name; PUT /api/monitors/:name takes it from the path. |
| `source` | "search" \| "fingerprints" \| "push" \| "http" \| "tcp" \| "cert" |  | What it watches: a saved search's series, its new fingerprints, a push, an HTTP(S) check, a TCP connect or a certificate. A monitor's source never changes. |
| `kind` | string |  | search, fingerprints: threshold or first_seen, the older name of source. |
| `service` | string \| null |  | The service it is about, at most 200 characters; required when it is made. |
| `host` | string \| null |  | The host it is about; by default the host its URL or target names. |
| `saved_search_id` | string \| null |  | search, fingerprints: the saved search it reads. |
| `saved_search` | string |  | search, fingerprints: the saved search it reads, by name, when saved_search_id is left out. |
| `threshold` | number \| string |  | search: the value it opens at, a number above 0. |
| `opens_when` | string |  | search: at_least (the default) or fewer_than. |
| `measure` | string |  | search: series (the default), or share of all rows. |
| `webhook_url` | string \| null |  | Where it calls, http(s); push, http, tcp and cert take null for the default in Settings. |
| `webhook_urls` | string[] \| null |  | search, fingerprints: 1 to 5 targets, each an http(s) URL or default for the webhook in Settings. |
| `body_kind` | string |  | The call's body: default, text or json. |
| `body_template` | string \| null |  | The call's body when body_kind is text or json. |
| `resolved_body` | string \| null |  | The call's body when it closes, when body_kind is text or json. |
| `remind_every` | string |  | Call again while open: off, window (search, fingerprints), 1h, 4h or 24h. |
| `every` | string \| null |  | push: how often a result is due, 30s to 365d (5m, 1h, 1d); http, tcp, cert: how often it runs, 30s, 1m, 5m, 15m, 30m or 1h. |
| `grace` | string \| null |  | push: how long past due before it opens, up to 365d, or 0. |
| `key` | string \| null |  | push: the ping URL's key, a random UUID; made for it when left out. |
| `fail_after` | number |  | http, tcp, cert: how many failed runs in a row open it, a whole number. |
| `url` | string |  | http: the URL it calls, http(s). |
| `method` | string |  | http: GET (the default), HEAD or POST. |
| `body` | string \| null |  | http: the body it sends, with POST only. |
| `headers` | { [key]: string \| null } \| ((string \| null)[])[] |  | http: headers, as { name: value } or [[name, value]]; a value of null keeps the one stored under that name. |
| `conditions` | string \| (string \| number)[] |  | http, tcp, cert: what each run must show, one line each, as text or a list. |
| `target` | string |  | tcp, cert: where it connects, host:port. |
| `starttls` | string \| null |  | cert: smtp, imap or pop3 to start TLS after a greeting; null or none for TLS from the first byte. |
| `silence_for` | string \| null |  | Silence it for 1h, 4h or 24h from now. |
| `silenced_until` | number \| null |  | Silence it until this epoch ms; null ends a silence. |
| `enabled` | boolean \| number |  | false or 0 pauses it, true or 1 resumes it. |
| `id` | string \| null |  | The monitor the draft is of, when it has been saved. |
| `run` | object \| null |  | http, tcp, cert: the editor's last Send, to fill the call in from: status, duration_ms, why. |
| `run.status` | number \| null |  | http: the status that came back. |
| `run.duration_ms` | number \| null |  | How long the run took, in ms. |
| `run.why` | string \| null |  | What the conditions made of it, as the editor shows it. |

### POST /api/alert-rules

Make a monitor on a saved search.

Role: **Operator** · `alert_rule_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string |  | The monitor's name; PUT /api/monitors/:name takes it from the path. |
| `source` | "search" \| "fingerprints" \| "push" \| "http" \| "tcp" \| "cert" |  | What it watches: a saved search's series, its new fingerprints, a push, an HTTP(S) check, a TCP connect or a certificate. A monitor's source never changes. |
| `kind` | string |  | search, fingerprints: threshold or first_seen, the older name of source. |
| `service` | string \| null |  | The service it is about, at most 200 characters; required when it is made. |
| `host` | string \| null |  | The host it is about; by default the host its URL or target names. |
| `saved_search_id` | string \| null |  | search, fingerprints: the saved search it reads. |
| `saved_search` | string |  | search, fingerprints: the saved search it reads, by name, when saved_search_id is left out. |
| `threshold` | number \| string |  | search: the value it opens at, a number above 0. |
| `opens_when` | string |  | search: at_least (the default) or fewer_than. |
| `measure` | string |  | search: series (the default), or share of all rows. |
| `webhook_url` | string \| null |  | Where it calls, http(s); push, http, tcp and cert take null for the default in Settings. |
| `webhook_urls` | string[] \| null |  | search, fingerprints: 1 to 5 targets, each an http(s) URL or default for the webhook in Settings. |
| `body_kind` | string |  | The call's body: default, text or json. |
| `body_template` | string \| null |  | The call's body when body_kind is text or json. |
| `resolved_body` | string \| null |  | The call's body when it closes, when body_kind is text or json. |
| `remind_every` | string |  | Call again while open: off, window (search, fingerprints), 1h, 4h or 24h. |
| `every` | string \| null |  | push: how often a result is due, 30s to 365d (5m, 1h, 1d); http, tcp, cert: how often it runs, 30s, 1m, 5m, 15m, 30m or 1h. |
| `grace` | string \| null |  | push: how long past due before it opens, up to 365d, or 0. |
| `key` | string \| null |  | push: the ping URL's key, a random UUID; made for it when left out. |
| `fail_after` | number |  | http, tcp, cert: how many failed runs in a row open it, a whole number. |
| `url` | string |  | http: the URL it calls, http(s). |
| `method` | string |  | http: GET (the default), HEAD or POST. |
| `body` | string \| null |  | http: the body it sends, with POST only. |
| `headers` | { [key]: string \| null } \| ((string \| null)[])[] |  | http: headers, as { name: value } or [[name, value]]; a value of null keeps the one stored under that name. |
| `conditions` | string \| (string \| number)[] |  | http, tcp, cert: what each run must show, one line each, as text or a list. |
| `target` | string |  | tcp, cert: where it connects, host:port. |
| `starttls` | string \| null |  | cert: smtp, imap or pop3 to start TLS after a greeting; null or none for TLS from the first byte. |
| `silence_for` | string \| null |  | Silence it for 1h, 4h or 24h from now. |
| `silenced_until` | number \| null |  | Silence it until this epoch ms; null ends a silence. |
| `enabled` | boolean \| number |  | false or 0 pauses it, true or 1 resumes it. |

### PUT /api/alert-rules/{id}

Change a monitor by id; a field left out keeps its value.

Role: **Operator** · `alert_rule_update`

Path: `id`.

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string |  | The monitor's name; PUT /api/monitors/:name takes it from the path. |
| `source` | "search" \| "fingerprints" \| "push" \| "http" \| "tcp" \| "cert" |  | What it watches: a saved search's series, its new fingerprints, a push, an HTTP(S) check, a TCP connect or a certificate. A monitor's source never changes. |
| `kind` | string |  | search, fingerprints: threshold or first_seen, the older name of source. |
| `service` | string \| null |  | The service it is about, at most 200 characters; required when it is made. |
| `host` | string \| null |  | The host it is about; by default the host its URL or target names. |
| `saved_search_id` | string \| null |  | search, fingerprints: the saved search it reads. |
| `saved_search` | string |  | search, fingerprints: the saved search it reads, by name, when saved_search_id is left out. |
| `threshold` | number \| string |  | search: the value it opens at, a number above 0. |
| `opens_when` | string |  | search: at_least (the default) or fewer_than. |
| `measure` | string |  | search: series (the default), or share of all rows. |
| `webhook_url` | string \| null |  | Where it calls, http(s); push, http, tcp and cert take null for the default in Settings. |
| `webhook_urls` | string[] \| null |  | search, fingerprints: 1 to 5 targets, each an http(s) URL or default for the webhook in Settings. |
| `body_kind` | string |  | The call's body: default, text or json. |
| `body_template` | string \| null |  | The call's body when body_kind is text or json. |
| `resolved_body` | string \| null |  | The call's body when it closes, when body_kind is text or json. |
| `remind_every` | string |  | Call again while open: off, window (search, fingerprints), 1h, 4h or 24h. |
| `every` | string \| null |  | push: how often a result is due, 30s to 365d (5m, 1h, 1d); http, tcp, cert: how often it runs, 30s, 1m, 5m, 15m, 30m or 1h. |
| `grace` | string \| null |  | push: how long past due before it opens, up to 365d, or 0. |
| `key` | string \| null |  | push: the ping URL's key, a random UUID; made for it when left out. |
| `fail_after` | number |  | http, tcp, cert: how many failed runs in a row open it, a whole number. |
| `url` | string |  | http: the URL it calls, http(s). |
| `method` | string |  | http: GET (the default), HEAD or POST. |
| `body` | string \| null |  | http: the body it sends, with POST only. |
| `headers` | { [key]: string \| null } \| ((string \| null)[])[] |  | http: headers, as { name: value } or [[name, value]]; a value of null keeps the one stored under that name. |
| `conditions` | string \| (string \| number)[] |  | http, tcp, cert: what each run must show, one line each, as text or a list. |
| `target` | string |  | tcp, cert: where it connects, host:port. |
| `starttls` | string \| null |  | cert: smtp, imap or pop3 to start TLS after a greeting; null or none for TLS from the first byte. |
| `silence_for` | string \| null |  | Silence it for 1h, 4h or 24h from now. |
| `silenced_until` | number \| null |  | Silence it until this epoch ms; null ends a silence. |
| `enabled` | boolean \| number |  | false or 0 pauses it, true or 1 resumes it. |

### DELETE /api/alert-rules/{id}

Delete a monitor by id, and its record.

Role: **Operator** · `alert_rule_delete`

Path: `id`.

### GET /api/monitors

Every monitor with its state and the stretches, calls and results in a window.

Role: **Viewer** · `monitors`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | Watch's clock: 24h (the default), 7d or 30d; from and to win over it, at most 366d apart. |

### GET /api/monitors/preview

Where a monitor on a query would have opened over the last 24 hours.

Role: **Viewer** · `monitor_preview`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `q` | string |  | A query in Toposcope's query language (docs/query.md); empty matches every row. |
| `agg` | string |  | The saved search's series, as search's agg takes it; counts rows when left out. |
| `opens_when` | string |  | at_least (the default) or fewer_than. |
| `threshold` | string |  | The value it opens at, a positive number. |
| `window` | string |  | 5m (the default), 15m or 1h. |
| `measure` | string |  | series (the default), or share of all rows. |

### POST /api/monitors/send

Run an HTTP(S), TCP or certificate check once from here and say what came back; nothing is stored.

Role: **Operator** · `monitor_send`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `url` | string |  | http: the URL it calls, http(s). |
| `method` | string |  | http: GET (the default), HEAD or POST. |
| `body` | string \| null |  | http: the body it sends, with POST only. |
| `headers` | { [key]: string \| null } \| ((string \| null)[])[] |  | http: headers, as { name: value } or [[name, value]]; a value of null keeps the one stored under that name. |
| `conditions` | string \| (string \| number)[] |  | http, tcp, cert: what each run must show, one line each, as text or a list. |
| `target` | string |  | tcp, cert: where it connects, host:port. |
| `starttls` | string \| null |  | cert: smtp, imap or pop3 to start TLS after a greeting; null or none for TLS from the first byte. |
| `source` | string |  | http (the default), tcp or cert. |
| `id` | string |  | An HTTP(S) monitor whose stored headers a header given as null keeps. |

### GET /api/monitors/{name}

One monitor by name, with its last 200 stretches and their calls.

Role: **Viewer** · `monitor_get`

Path: `name`.

### PUT /api/monitors/{name}

Make or replace the monitor of that name; what is left out takes its default.

Role: **Operator** · `monitor_put`

Path: `name`.

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string |  | The monitor's name; PUT /api/monitors/:name takes it from the path. |
| `source` | "search" \| "fingerprints" \| "push" \| "http" \| "tcp" \| "cert" |  | What it watches: a saved search's series, its new fingerprints, a push, an HTTP(S) check, a TCP connect or a certificate. A monitor's source never changes. |
| `kind` | string |  | search, fingerprints: threshold or first_seen, the older name of source. |
| `service` | string \| null |  | The service it is about, at most 200 characters; required when it is made. |
| `host` | string \| null |  | The host it is about; by default the host its URL or target names. |
| `saved_search_id` | string \| null |  | search, fingerprints: the saved search it reads. |
| `saved_search` | string |  | search, fingerprints: the saved search it reads, by name, when saved_search_id is left out. |
| `threshold` | number \| string |  | search: the value it opens at, a number above 0. |
| `opens_when` | string |  | search: at_least (the default) or fewer_than. |
| `measure` | string |  | search: series (the default), or share of all rows. |
| `webhook_url` | string \| null |  | Where it calls, http(s); push, http, tcp and cert take null for the default in Settings. |
| `webhook_urls` | string[] \| null |  | search, fingerprints: 1 to 5 targets, each an http(s) URL or default for the webhook in Settings. |
| `body_kind` | string |  | The call's body: default, text or json. |
| `body_template` | string \| null |  | The call's body when body_kind is text or json. |
| `resolved_body` | string \| null |  | The call's body when it closes, when body_kind is text or json. |
| `remind_every` | string |  | Call again while open: off, window (search, fingerprints), 1h, 4h or 24h. |
| `every` | string \| null |  | push: how often a result is due, 30s to 365d (5m, 1h, 1d); http, tcp, cert: how often it runs, 30s, 1m, 5m, 15m, 30m or 1h. |
| `grace` | string \| null |  | push: how long past due before it opens, up to 365d, or 0. |
| `key` | string \| null |  | push: the ping URL's key, a random UUID; made for it when left out. |
| `fail_after` | number |  | http, tcp, cert: how many failed runs in a row open it, a whole number. |
| `url` | string |  | http: the URL it calls, http(s). |
| `method` | string |  | http: GET (the default), HEAD or POST. |
| `body` | string \| null |  | http: the body it sends, with POST only. |
| `headers` | { [key]: string \| null } \| ((string \| null)[])[] |  | http: headers, as { name: value } or [[name, value]]; a value of null keeps the one stored under that name. |
| `conditions` | string \| (string \| number)[] |  | http, tcp, cert: what each run must show, one line each, as text or a list. |
| `target` | string |  | tcp, cert: where it connects, host:port. |
| `starttls` | string \| null |  | cert: smtp, imap or pop3 to start TLS after a greeting; null or none for TLS from the first byte. |
| `silence_for` | string \| null |  | Silence it for 1h, 4h or 24h from now. |
| `silenced_until` | number \| null |  | Silence it until this epoch ms; null ends a silence. |
| `enabled` | boolean \| number |  | false or 0 pauses it, true or 1 resumes it. |

### DELETE /api/monitors/{name}

Delete a monitor by name, and its record.

Role: **Operator** · `monitor_delete`

Path: `name`.

## Fields

### GET /api/fields

The fields rows carry, their roles, and the metric links.

Role: **Viewer** · `fields`

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `from` | string |  | Where the window starts, an ISO time. |
| `to` | string |  | Where the window ends, an ISO time. |
| `range` | string |  | A window that ends now, as 15m, 1h, 24h, 7d or any \d+(ms\|s\|m\|h\|d\|w) up to 365d; it wins over from and to. |
| `wave` | "keys" \| "values" \| "suggest" |  | One slice of the catalog: keys, values or suggest; all of it when left out. |
| `cheap` | string |  | With wave=suggest: keys to suggest from cheaply, separated by commas. |

### PUT /api/fields

Set fields' roles and the metric links.

Role: **Operator** · `fields_set`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `roles` | { [key]: string } \| null |  | Each field's role: chart, lookup, ignore; a field left out is chart. Replaces every role. |
| `links` | { [key]: string } \| null |  | Each field's metric label, so Graph opens its metric; replaces every link. |

## Shares

### GET /api/shares

Every share, live ones first, with its panels and use.

Role: **Operator** · `shares`

### POST /api/shares

Make a share; its secret is in this answer and never again.

Role: **Owner** · `share_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string | yes | The share's name, in its URL and its use rows: lower-case letters, digits, . _ -, up to 64. |
| `panels` | object[] \| null |  | Named panels, at most 24; the fence is derived from them. Left out, a share keeps its panels. |
| `panels[].name` | string | yes | The panel's name, as a page's data-panel= names it: lower-case letters, digits, . _ -, up to 48. |
| `panels[].params` | { [key]: string \| number } | yes | The embed tag's params: chart (line, bars, stacked, stat, top or donut; line by default), metric, reading, ml, split, agg, key (a top or donut panel needs one), n, range, step, title. |
| `panels[].from` | string \| null |  | Where the panel was made, kept as a note. |
| `logs` | string \| null |  | With panels and no scope: the q ANDed onto every log read. |
| `scope` | object |  | What the share can ever read; left out, it is derived from the panels. It must cover them. |
| `scope.metric_names` | string \| string[] \| null |  | Metric names the share may read, exact or a prefix glob (fleet_*), as a list or separated by commas; at most 50. |
| `scope.metric_labels` | string \| null |  | Label matchers ANDed onto every metric read, key:value as ml= takes them. |
| `scope.logs` | string \| null |  | A q ANDed onto every log read; null or empty: the share reads no logs. |
| `scope.split` | string \| string[] \| null |  | Keys a read may split or Top-N by, at most 8. |
| `scope.narrow` | string \| string[] \| null |  | Keys a caller may narrow by as key:value, at most 8. |
| `raw_params` | boolean |  | Whether a page may pass its own params within the fence; on by default. |
| `expires_at` | string \| number |  | When the share stops: a date (2027-10-23), an ISO time or epoch ms, after now and at most a year out. An Owner must give it. |
| `limits` | object \| null |  | How fine, how long and how often a read may be; a field left out keeps its value, or takes its default. |
| `limits.min_step` | string |  | The finest bar a read gets, 1ms … 7d as step= takes it; 1m by default. |
| `limits.max_range` | string |  | The longest window one read covers, up to 365d (30d, 12h, 2w); 7d by default. |
| `limits.max_lookback` | string |  | How far before now a window may start, up to 730d; 30d by default. |
| `limits.reads_per_minute` | integer |  | Reads a minute; 120 by default. |
| `embed` | object \| null |  | Embedding the share's panels in a page; a field left out keeps its value, or takes its default. |
| `embed.frame_ancestors` | string \| string[] \| null |  | Origins that may frame the share's panels (https://host[:port], no paths, no *), at most 8; empty: JSON only. |
| `embed.ticket_ttl` | string |  | How long a ticket lasts, up to 24h (15m, 1h); 1h by default. |

### PUT /api/shares/{name}

Make or change a share in place; an Operator may only add panels to one that exists.

Role: **Operator** · `share_put`

Path: `name`.

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `panels` | object[] \| null |  | Named panels, at most 24; the fence is derived from them. Left out, a share keeps its panels. |
| `panels[].name` | string | yes | The panel's name, as a page's data-panel= names it: lower-case letters, digits, . _ -, up to 48. |
| `panels[].params` | { [key]: string \| number } | yes | The embed tag's params: chart (line, bars, stacked, stat, top or donut; line by default), metric, reading, ml, split, agg, key (a top or donut panel needs one), n, range, step, title. |
| `panels[].from` | string \| null |  | Where the panel was made, kept as a note. |
| `logs` | string \| null |  | With panels and no scope: the q ANDed onto every log read. |
| `scope` | object |  | What the share can ever read; left out, it is derived from the panels. It must cover them. |
| `scope.metric_names` | string \| string[] \| null |  | Metric names the share may read, exact or a prefix glob (fleet_*), as a list or separated by commas; at most 50. |
| `scope.metric_labels` | string \| null |  | Label matchers ANDed onto every metric read, key:value as ml= takes them. |
| `scope.logs` | string \| null |  | A q ANDed onto every log read; null or empty: the share reads no logs. |
| `scope.split` | string \| string[] \| null |  | Keys a read may split or Top-N by, at most 8. |
| `scope.narrow` | string \| string[] \| null |  | Keys a caller may narrow by as key:value, at most 8. |
| `raw_params` | boolean |  | Whether a page may pass its own params within the fence; on by default. |
| `expires_at` | string \| number |  | When the share stops: a date (2027-10-23), an ISO time or epoch ms, after now and at most a year out. An Owner must give it. |
| `limits` | object \| null |  | How fine, how long and how often a read may be; a field left out keeps its value, or takes its default. |
| `limits.min_step` | string |  | The finest bar a read gets, 1ms … 7d as step= takes it; 1m by default. |
| `limits.max_range` | string |  | The longest window one read covers, up to 365d (30d, 12h, 2w); 7d by default. |
| `limits.max_lookback` | string |  | How far before now a window may start, up to 730d; 30d by default. |
| `limits.reads_per_minute` | integer |  | Reads a minute; 120 by default. |
| `embed` | object \| null |  | Embedding the share's panels in a page; a field left out keeps its value, or takes its default. |
| `embed.frame_ancestors` | string \| string[] \| null |  | Origins that may frame the share's panels (https://host[:port], no paths, no *), at most 8; empty: JSON only. |
| `embed.ticket_ttl` | string |  | How long a ticket lasts, up to 24h (15m, 1h); 1h by default. |

### DELETE /api/shares/{name}

Revoke a share now: its secret and every read made with it stop.

Role: **Owner** · `share_revoke`

Path: `name`.

### POST /api/shares/{name}/ticket

A five-minute ticket to preview a share as the other site will see it.

Role: **Operator** · `share_ticket`

Path: `name`.

## Links and feeds

### GET /api/feeds

Every feed: a fixed filter whose rows are read in order.

Role: **Operator** · `feeds`

### POST /api/feeds

Make a feed on a filter; the filter never changes after.

Role: **Owner** · `feed_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `q` | string | yes | The feed's filter, in the query language; empty means every row. It never changes after. |

### GET /api/feeds/{id}

A feed's rows after a position, in order.

Role: **Operator** · `feed_read`

Path: `id`.

Query:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `after` | string |  | The position to read after, a whole number, 0 or more; 0 by default. |
| `limit` | string |  | How many to return at most, a whole number. |
| `kinds` | string |  | The kinds to read, separated by commas: logs, marks, spans, metrics, metric_buckets, profile_samples, monitor_results; all by default. |

### GET /api/links

This instance, its links and its link keys.

Role: **Operator** · `links`

### GET /api/links/{id}

One link's page: which way rows move, its scope, and each kind's state.

Role: **Operator** · `link_get`

Path: `id`.

### PUT /api/links/{id}

Pause or resume a link, or narrow its scope where rows leave here.

Role: **Owner** · `link_update`

Path: `id`.

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `paused` | boolean |  | Pause or resume the link. |
| `q` | string |  | A new filter, only on a link whose rows leave here. |
| `kinds` | string \| ("logs" \| "marks" \| "traces" \| "metrics" \| "profiles" \| "monitors")[] |  | Fewer kinds, only on a link whose rows leave here: a kind is never added to a key already used. |

### POST /api/links/offer

Mint a key that lets another instance copy rows from here.

Role: **Owner** · `link_offer`

Body, optional:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string \| null |  | This instance's name, the first time only: the other side sees it. After that it lives in Settings. |
| `q` | string \| null |  | The filter rows that leave here must match; empty means every row. |
| `kinds` | string \| ("logs" \| "marks" \| "traces" \| "metrics" \| "profiles" \| "monitors")[] |  | The kinds the link carries, as a list or separated by commas: logs, marks, traces, metrics, profiles, monitors; all by default. |

### POST /api/links/invite

Mint a key that lets another instance send rows here.

Role: **Owner** · `link_invite`

Body, optional:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string \| null |  | This instance's name, the first time only: the other side sees it. After that it lives in Settings. |
| `q` | string \| null |  | The filter rows the other side sends must match; empty means every row. |
| `kinds` | string \| ("logs" \| "marks" \| "traces" \| "metrics" \| "profiles" \| "monitors")[] |  | The kinds the link carries, as a list or separated by commas: logs, marks, traces, metrics, profiles, monitors; all by default. |
| `until` | number \| string \| null |  | Epoch ms until which the key works for many, at most 30 days out; left out, it works once. |

### POST /api/links/preview

Read a pasted key: who minted it, which way rows move, its filter, and whether it is unused.

Role: **Owner** · `link_preview`

Body, optional:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `key` | string |  | The pasted link key, tsl2_… |

### POST /api/links/confirm

Claim a pasted key at its minter and start the link.

Role: **Owner** · `link_confirm`

Body, optional:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `key` | string |  | The pasted link key, tsl2_… |
| `name` | string \| null |  | This instance's name, the first time only: the other side sees it. After that it lives in Settings. |

### DELETE /api/links/keys/{kid}

Revoke a link key that has not been used.

Role: **Owner** · `link_key_revoke`

Path: `kid`.

### DELETE /api/links/{id}

Stop a link; rows already moved age out under retention.

Role: **Owner** · `link_remove`

Path: `id`.

## Access

### GET /api/access

Every way in: people, tokens, links and shares, with today's use and refusals.

Role: **Operator** · `access`

### GET /api/api-tokens

The ingest tokens.

Role: **Operator** · `api_tokens`

### POST /api/api-tokens

Make an ingest token; it is in this answer and never again.

Role: **Owner** · `api_token_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string | yes | What sends with it, so Access can name it. |

### DELETE /api/api-tokens/{id}

Revoke an ingest token.

Role: **Owner** · `api_token_delete`

Path: `id`.

### GET /api/people

People, service accounts and invites, with their roles and tokens.

Role: **Operator** · `people`

### POST /api/people/invites

Invite someone with a role; the link is in this answer and never again.

Role: **Owner** · `invite_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `who` | string |  | Who it is for: an email, or a name. |
| `role` | "viewer" \| "operator" \| "owner" | yes | The role they join with. |
| `days` | number |  | How many days the link works. |

### DELETE /api/people/invites/{id}

Cancel an invite.

Role: **Owner** · `invite_cancel`

Path: `id`.

### POST /api/people/service-accounts

Make a service account with a role.

Role: **Owner** · `service_account_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string | yes | Its name. |
| `role` | "viewer" \| "operator" \| "owner" | yes | What its tokens may do. |

### PUT /api/people/{id}

Change a person's or a service account's role.

Role: **Owner** · `person_update`

Path: `id`.

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `role` | "viewer" \| "operator" \| "owner" | yes | The new role. |

### DELETE /api/people/{id}

Revoke a person or a service account; their sessions and tokens end.

Role: **Owner** · `person_revoke`

Path: `id`.

### POST /api/people/{id}/tokens

Make a service account's token; it is in this answer and never again.

Role: **Owner** · `service_token_create`

Path: `id`.

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string | yes | What uses it, so Access can name it. |
| `expires_in_days` | number |  | Days until it stops working, 1 to 365; 365 by default. |
| `read_only` | boolean |  | true: it reads and writes nothing. |

### DELETE /api/people/{id}/tokens/{tid}

Revoke one of a person's or a service account's tokens.

Role: **Owner** · `service_token_revoke`

Path: `id`, `tid`.

### DELETE /api/people/{id}/two-step

Reset a person's two-step; they set it up again at their next sign-in.

Role: **Owner** · `two_step_reset`

Path: `id`.

### POST /api/me/two-step/backup-codes

Ten new backup codes for the caller; the old ten stop working.

Role: **Viewer** · `my_backup_codes`

### GET /api/me/tokens

The caller's own personal tokens.

Role: **Viewer** · `my_tokens`

### POST /api/me/tokens

Make a personal token for the caller's own scripts; it is in this answer and never again.

Role: **Viewer** · `my_token_create`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `name` | string | yes | What uses it, so Access can name it. |
| `expires_in_days` | number |  | Days until it stops working, 1 to 365; 365 by default. |
| `read_only` | boolean |  | true: it reads and writes nothing. |

### DELETE /api/me/tokens/{id}

Revoke one of the caller's own tokens.

Role: **Viewer** · `my_token_revoke`

Path: `id`.

## Settings

### GET /api/sign-in-settings

How people sign in here: passwords, the provider, and who must have two-step.

Role: **Owner** · `sign_in_settings`

### PUT /api/sign-in-settings

Change how people sign in here; a field left out keeps its value.

Role: **Owner** · `sign_in_settings_set`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `passwords` | boolean |  | Whether people may sign in with a password. |
| `oidc` | object \| null |  | The sign-in provider; null removes it. |
| `oidc.preset` | string |  | The provider: google, entra, okta, keycloak, authentik, other; other when it is none of these. |
| `oidc.label` | string |  | The sign-in button's name, up to 40 characters; the preset's by default. |
| `oidc.issuer` | string |  | The provider's https URL, as its discovery document names it. |
| `oidc.client_id` | string |  | From the provider's app registration. |
| `oidc.client_secret` | string |  | From the provider's app registration; left out or empty keeps the one stored. |
| `oidc.allowed_domain` | string \| null |  | Only emails at this domain, like example.com; empty for any. |
| `oidc.without_invite` | string |  | The role someone gets who signs in with no invite: viewer (the default), operator, or none to refuse them. |
| `two_step_for` | "everyone" \| "owners" |  | Who must have a second step: everyone with a password, or Owners only. |

### GET /api/settings

Retention, metrics retention, the instance's name, the default webhook and who must have two-step.

Role: **Viewer** · `settings`

### PUT /api/settings

Change retention, metrics retention, the instance's name, the default webhook or who must have two-step; a field left out keeps its value.

Role: **Owner** · `settings_set`

Body:

| Field | Type | Required | What |
| --- | --- | --- | --- |
| `retention_days` | number |  | How many days rows are kept, 1 to 365. |
| `metrics_retention_days` | number \| "" \| null |  | How many days metric points are kept; null or empty follows retention_days. |
| `instance_name` | string \| null |  | This instance's name, as links and the tab title show it; null or empty unnames it. |
| `default_webhook_url` | string \| null |  | Where monitors call when they name no URL of their own, http(s); null or empty for none. |
| `two_step_for` | "everyone" \| "owners" |  | Who must have a second step: everyone with a password, or Owners only. |
