# Changelog

Newest first. Unreleased work is listed here until the next `v*` tag. Shipped versions match `package.json` at tag time.

## Unreleased

An [agent skill](skills/toposcope/SKILL.md) ships in the repo: one `SKILL.md` and one script. It stands up one Toposcope on the machine from the pinned release files (or uses the one running), writes the settings an app needs without printing a secret, and checks one test error end to end, answering **frames**, **message**, or **nothing arrived** with the `q` and window to paste. It carries the ingest guide’s *What an app sends* word for word. It talks only to 127.0.0.1, stops the instance when asked, and never removes data. No MCP server and no CLI. [#52](https://github.com/toposcope/toposcope/issues/52)

The README quick start writes the three secrets into `.env` without printing them, instead of asking for three `openssl` outputs to be pasted in. A test runs those commands. `docs/operations.md` says what an idle instance takes, measured: about 1.7 GiB once ClickHouse has levelled off, a quarter of an hour after starting.

The image is published for `linux/arm64` as well as `linux/amd64`. Earlier images are amd64 only, and on an arm64 host Docker refuses to pull one unless the `app` service names `platform: linux/amd64`.

Unknown `/v1/*` paths, and a wrong method on an ingest path, return JSON **404** instead of the UI page or a plain-text 404. A sender with a typo in its endpoint no longer sees a 200 and a body it cannot parse. [#66](https://github.com/toposcope/toposcope/issues/66)

An OTLP log record with no event time is stored at its observed time, when a collector set one, instead of the time it arrived. A batch that sat in a collector’s buffer no longer lands late on the clock or on the wrong side of a change mark. A record with both keeps its event time. [#65](https://github.com/toposcope/toposcope/issues/65)

On `POST /v1/logs` the level comes from `severityNumber` when it is 1–24, and a record with only a severity text is read by its word. Before, the text was read first and only a few words were known, so a text-only `CRITICAL`, `CRIT`, `ALERT`, or `SEVERE` was stored as `info`, and an unspecified number (0) as `debug`. [#64](https://github.com/toposcope/toposcope/issues/64)

A PHP closure frame is hashed without its line number and with its path normalized. PHP 8.4 and later name a closure with where it was declared (`{closure:/app/public/index.php:15}`), so the same error got a new `e1` in every deploy directory and whenever the closure’s line moved. Errors with such a frame get a new id once at upgrade; old rows are not rewritten. [#67](https://github.com/toposcope/toposcope/issues/67)

A Node `at async /path/file.js:12:5` frame is read as that file. Before, `async` was taken as part of the path, the path was hashed as written, and the same error got a new `e1` in every deploy directory. Errors with such a frame get a new id once at upgrade; old rows are not rewritten. [#63](https://github.com/toposcope/toposcope/issues/63)

A Python traceback deeper than 50 frames keeps the 50 nearest the raise instead of the outermost 50, so two errors under the same framework frames no longer share one `e1`. Deep Python stacks get a new id once at upgrade; old rows are not rewritten. [#62](https://github.com/toposcope/toposcope/issues/62)

## 0.4.10

Ingest accepts a bearer token only when it is the configured ingest token or a created API token that still exists. Before, a token that was never issued, or one that had been deleted, was accepted on `/api/ingest` and every `/v1/*` ingest route. Search and the other routes take the operator password and were not affected.

Ingest is tested against what real runtimes and exporters send, not hand-typed stacks: one stack each from Node, Python, the JVM, .NET, PHP, and Go with a real framework above the error, and the log requests the OpenTelemetry exporters for Node and Python send for one logged exception. The ingest guide names the versions. One capture found a gap: PHP 8.4 and later put a closure’s file and line in its frame name, so that error gets a different `e1` in each deploy directory; the test is pinned until it is fixed. [#47](https://github.com/toposcope/toposcope/issues/47)

The ingest guide opens with **What an app sends**: the fields a row needs for hunt, the exception fields an error row needs for a stack fingerprint, the attribute rules and what is dropped with a 200, the three ways a row arrives, and what each reply means for a sender. The stated default is an app speaking OpenTelemetry straight to Toposcope, on a laptop and in production; a collector is optional and Vector stays the canonical one. The section’s examples run in `bun test` and in e2e. [#48](https://github.com/toposcope/toposcope/issues/48)

On `POST /v1/logs` a stored row counts the record’s own attributes first, then its trace and span ids, then the resource’s. A stock OpenTelemetry resource carries enough process, runtime, and host details to fill the 50-attribute cap, and what was cut was the record’s request id or customer and the trace id that View trace needs. The cap, `e1`, and `version` are unchanged, and so is `/api/ingest`. [#51](https://github.com/toposcope/toposcope/issues/51)

The OTLP routes — `POST /v1/logs`, `POST /v1/traces`, and `POST /v1/profiles` — take up to 1,024 records in a request, up from 500. An OpenTelemetry exporter batches 512 by default and does not retry a **400**, so a full batch — what an error storm produces — was dropped whole. The 1 MB decoded-body cap and its **413** are unchanged, and `/api/ingest` and the other endpoints keep 500. [#50](https://github.com/toposcope/toposcope/issues/50)

`GET /api/health` carries `version`: the running release, the same string as `package.json` and the image tag. An install or an upgrade script can confirm which Toposcope is answering. The route stays open and stays **503** until ready. [#49](https://github.com/toposcope/toposcope/issues/49)

## 0.4.9

Framed errors keep the same `e1` across dated release directories and common deployment roots. Hashing normalizes source paths without changing stored frames. Ingest also reads known Node/V8, Python, JVM, .NET, PHP, and Go `exception.stacktrace` formats when no valid `exception.frames` arrive. Unknown formats keep the type plus stabilized log-body fallback. Old rows are not rewritten; corrected inputs can receive a new id once at upgrade. See the [ingest guide](docs/ingest.md#exception-fingerprints).

Fingerprints refuses the cut when either side exceeds 200 distinct `e1` values. It reads a 201st value to detect the limit instead of calling an omitted old bug first seen or an omitted current bug stopped.

`PUT /api/settings` requires an integer from 1 to 365 before writing SQLite or changing TTL. Invalid retention no longer becomes one day. The shared operator password still permits valid retention changes. Unknown `/api/*` paths return JSON **404** instead of the UI page.

The too-old-ClickHouse boot error uses the packaged or development Compose command and points to backup and restore without volume removal. Current image pins, release links, and the security policy name **0.4.9**.

## 0.4.8

Fingerprints uses the returned exact windows for rail labels and plot washes. Events at a change mark belong to the after side only; minute buckets no longer put the same fingerprint on both sides. Cut counts use the existing bounded log scan, with an explicit refusal when that budget is exceeded. [#38](https://github.com/toposcope/toposcope/pull/38)

Inspector Compare follows the hunt’s histogram split: `none` is the shipped single row; `level` / `service` / `host` stack one 30px row per series key under the lane (cap 8 + `other`), same mark / windows / percent rules. A stacked row under 1% keeps its decimal; `none` keeps `+<1%`. `bun run load:hunt` pins `split=host` so the billing hosts read **+0.5% / +4% / +9%**. [#35](https://github.com/toposcope/toposcope/issues/35)

Compare reads exact equal windows and retains the plot’s named keys on both sides, so `other` has the same membership before and after. Numeric and metric deltas need measured values on both sides. The stack keeps its plot space under Live and does not change stored widget positions. Closing Compare leaves Fingerprints open. [#37](https://github.com/toposcope/toposcope/issues/37)

Ingest aliases OTEL `service.version` onto attr `version` when `version` is unset (sender `version` wins; the dotted key is dropped). `customer` and `flag` stay collector remaps. `bun run load:hunt` plants all three on the billing v0.9 slice, pins them as promoted columns, and writes `/tmp/toposcope-hunt.json` for screenshot capture. [#31](https://github.com/toposcope/toposcope/issues/31)

`POST /v1/probes` attaches `{ service, up: 0|1 }` or pulls one status URL. A failed pull stores `up=0` (not a silent green). `GET /api/probes` lists samples. Hunt overlays the ingested `up` metric. `bun run load:hunt` plants billing down after the v0.9 mark and pins `metric=up&ml=service:billing`. [#33](https://github.com/toposcope/toposcope/issues/33)

## 0.4.7

`POST /v1/marks` closes an open mark by posting the same caller `id` with `end_ts` (stored start stays). The same `id` without `end_ts` is still a skip, so a CI re-run does not move or close the glyph. Already closed is a skip, not a reopen. One object returns `{ ingested, id }`; an array returns `{ ingested, ids }`. [#28](https://github.com/toposcope/toposcope/issues/28)

Inspector Compare opens a 30px fold under the pinned volume lane: the hunt series (Count, Rate, a numeric agg, an ingested metric, or `e1:` in the bar) on equal windows after vs before a selected mark. Percent needs a before; first-seen drops it; stopped is −100%. Live freezes both windows at open. [#25](https://github.com/toposcope/toposcope/issues/25)

## 0.4.6

Inspector Fingerprints opens a results-rail reader: which `e1` are first seen, still here, or stopped on equal windows around a selected mark. Filter writes `e1:<hex>`. A table row then opens the shipped event detail with a crumb back to the same cut. Coming back from Follow keeps that line. [#18](https://github.com/toposcope/toposcope/issues/18)

The process listens before migrate. `/api/health` returns **503** with `phase` (`starting` / `schema` / `repair` / `ready`) until ingest and search are safe; **200** only then. Hunt and ingest are refused during schema. [#15](https://github.com/toposcope/toposcope/issues/15)

GitHub Actions and GitLab CI samples POST a deploy mark with a stable `id` (`deploy-<service>-<tag>`). Posting that `id` again is skipped, so a job re-run is one glyph. [#14](https://github.com/toposcope/toposcope/issues/14)

A complete Top-N paints `-` for hunt events that never had the field. When N cuts the list, `other` is still hunt minus named. [#21](https://github.com/toposcope/toposcope/issues/21)

## 0.4.5

Saved-search sidebar counts no longer re-run every saved search after a foreground search. They refresh on list load, Alerts, and a 30s clock. [#13](https://github.com/toposcope/toposcope/issues/13)

## 0.4.4

OTLP `POST /v1/logs`, `/v1/traces`, and `/v1/profiles` decode gzip under the 1MB body cap instead of expanding the full payload first.

## 0.4.3

Search / Follow draws stored change marks as seams between event rows (same mute and inspector as the histogram lane). The marks chip sits on the right of the canvas bar. Focus in logs opens Surroundings titled with the mark (50 older above, 50 newer below). [#9](https://github.com/toposcope/toposcope/issues/9)

## 0.4.2

The Search / Follow volume plot draws stored change marks on a 22px lane under the bars (inspect, hide for this hunt, neighbor peeks). Glyphs line up with the volume bar for that time. Mute is per workspace tab, not the URL, and does not rewrite `q`. `POST /v1/marks` accepts optional `id` (omit to mint `mk_…`) and `end_ts`; `GET /api/marks` returns `{ marks, before, after }`. No `DELETE /v1/marks`. Wheel, `+`/`−`, head-drill, Shift+drag, and mark peeks keep `to` at now the same way pan already did. Absolute From/To is unchanged.

## 0.4.1

A `v*` GitHub release copies that version’s [CHANGELOG.md](CHANGELOG.md) section into the release notes.

## 0.4.0

Lockup and favicon are the Fault mark (two offset filled bands) in plate, in place of Skyline.

Ingest stores `exception.type` and `exception.frames` when they already arrive as attrs. Direct ingest does not parse stacks from `message`.

Ingest writes `e1` so the same application error is one searchable attr (`e1:…`). Frames hash type plus `file`/`function` (in-app only when any frame is in-app); otherwise type or an `error`/`fatal` line hashes with a stabilized message. Old rows are not rewritten. Not a log template.

Change marks (`deploy` / `flag` / `incident` / `note`) land in `change_marks` via `POST /v1/marks`. GitHub Actions and GitLab CI samples POST on release. The histogram does not draw them yet.

`bun run load` / `load:live` include a v0.9 deploy mark, some `version:v0.9` rows, framed errors, and errors with no stack. Search waits until `e1:` and `version:v0.9` are present.

`ee/LICENSE` is all rights reserved so the root MIT reservation is not hollow. The MIT app does not import `ee/`.

Public [ROADMAP.md](ROADMAP.md) is the v0.x product contract (today, direction, will not); delivery lives in GitHub issues. Documentation is organized by audience: a concise operator README, focused [ingest](docs/ingest.md) and [operations](docs/operations.md) guides, and an expanded [contributor guide](CONTRIBUTING.md).

## 0.3.14

Initial public release. Toposcope 0.3.14 is ready for public use.

## 0.3.13

Stabilization. Budgeted p99/avg over `logs` refuses instead of 500ing on a missing import. Saved-search `/run` refuses a count only when the histogram scan refused (not when only the event page did). The GitHub release attaches `env.example` because GitHub renames a leading-dot `.env.example`. `bun run typecheck` is green. Backup docs copy ClickHouse and SQLite. GHCR stays private.

## 0.3.12

Promoted display fields. Up to three attr columns sit between Host and Message on Search and Follow. The Message-header `+` picks keys seen on the loaded page. Missing cells are an em dash. The list lives in the workspace tab (`cols=` on copy-link) and on the saved search. Follow copies the parent tab’s columns; New starts empty; Surroundings stays five-col. Not a Field role and not Settings.

## 0.3.11

Search retained hot data. The window cap is 365 days (Settings TTL), not 7. Auto bars grow `7d` so a year stays readable. Newest-first lookbacks continue past 7d. A raw `logs` scan that blows the read budget refuses in the JSON (`scan.source: "refused"`) instead of 500ing. Pan follows Settings retention. No S3 or cold tier.

## 0.3.10

Toposcope name and Skyline mark. Chrome and CLI are `toposcope`; prose is Toposcope. Env is `TOPOSCOPE_*`. SQLite defaults to `toposcope.sqlite`. Settings localStorage is `toposcope.*`. Prometheus series are `toposcope_*`. Compose used a versioned image pin; local builds filled the gap until that tag was published.

## 0.3.9

Packaged install a stranger can run: versioned image, production `compose.yml` with no demo passwords, ClickHouse unpublished. Packaged boot refuses missing or demo `TOPOSCOPE_PASSWORD` / `TOPOSCOPE_INGEST_TOKEN` / `CLICKHOUSE_PASSWORD`. Canonical collector is Vector → `POST /v1/logs` protobuf (`vector.yaml`). TLS is a reverse-proxy README snippet, not a third container. `bun run dev` still uses `compose.dev.yml` and may fill localhost defaults.

## 0.3.8

Stat and Top-N identity is the query. Those heads are dashed-underline pickers (`p99(duration_ms)`, `Top 10 · status`); the footer strip on those cards goes away. Timeseries keeps title + footer selects. Duplicate / Copy / Export collapse behind ⋯ when the extra head is too narrow for the icons (not at a hard 4-col). Copy / Export on a wide extra head use the same popover as ⋯ (the drag surface was eating the dropdown). Copy… / Export… stay on that menu. Stat min is 1×2. A value already on the canvas sinks with `on canvas`. Custom Top-N 1–50 stays. Settings retention `PUT` writes SQLite first and issues `ALTER TTL` without waiting for mutations (`alter_sync = 0`), so a corrupt MergeTree part cannot 500 the save or leave unfinished mutations blocking the next one. Loaders stamp `client_ip` on every fake log (region-weighted public IPv4; 40% hot hosts, 60% /16 tail). `load:live` CLI rates are uncapped; the client pipelines POSTs (24 in-flight, wall-clock /s) and chunks to ingest 500 / 1MB. The 2s `/s` line is the last interval (not a lifetime average) and does not drop increments under parallel POSTs.

## 0.3.7

UTC absolute calendar. Custom windows print both ends on the search-bar clock (`08-14 14:00 → 15:00 · 1h`). Relative Last N includes `w` (`1w` is 7d; the search cap stays 7d). Day and time clicks draft; Apply commits Absolute if that section was touched, otherwise Relative. Window strip dates both ends when the window is ≥1d, not today, or crosses midnight.

## 0.3.6

Histogram 1ms floor. Chips grow `1ms|10ms|100ms|1s|10s` under `1m`. Auto stays ≤200 bars (15m → `10s`, 1h → `1m`). A 1ms window is one column; a 1s window Auto is ~100 × 10ms bars. Sub-minute bars scan `logs` (read budget); minute rollups stay for `1m+`. Axis ticks add `HH:MM:SS.mmm` under 1s.

## 0.3.5

Clock milliseconds. Absolute From/To are a native datetime picker (`step` 1ms) and commit a custom window on change. Relative Last N includes `ms` and `s` (`1ms` is not `1m`). Custom `from`/`to` keep milliseconds.

## 0.3.4

Adaptive event timestamps. Compact follows the histogram date rule (`HH:MM:SS`, or `MM-DD HH:MM:SS` when the window is ≥1d, not today, or crosses midnight). Settings → Timestamps switches to full `YYYY-MM-DD HH:MM:SS.mmm`. localStorage, not the URL. Hover still shows the stored ISO.

## 0.3.3

Workspace tabs keep last paint. Switching Search / Follow does not re-run the query when the hunt is unchanged (Live off included). Enter, facets, range, Live, New, Saved, and Follow still search.

## 0.3.2

Arrow keys follow focus. `j`/`k` and global Enter-to-toggle-detail go away. Plot pans only when the histogram surface is focused; a focused log row uses ↑↓ / → detail / ← close; facets ↑↓; workspace tabs ←→.

## 0.3.1

View trace only when a log alias is a 32-hex OTLP TraceId (not all zeros). `req-…` stays Follow-able and never opens the waterfall. Invalid `GET /api/traces/:id` is 400; a valid hex with no spans stays 200 empty. Empty waterfall / profile copy no longer claims the collector sampled it out. `load:live` keeps ~1/8 of logs with a `trace_id`, and most of those join a posted tree.

## 0.3.0

Boards (frozen saved-search template + bindings). Honest Live clocks (2s mergeable extras, 30s whole-window aggregates). ClickHouse 26.3 + token search on `message`. Filtered log-derived p99/avg (budgeted scan or a clear refuse).

## 0.2.0

Ingested metrics overlay. OTLP traces + View trace waterfall. Bloom on `trace_id` / attr values. Fields catalog and log-to-metric links. Canvas widgets, histogram gestures. `load:live`. OTLP profiles + View profiles icicle. Collector-owned enrich. Workspace tabs (Surroundings / Follow / Saved) and a Results strip.

## 0.1.0

Walking skeleton through Graylog-familiar search, operator UI, surrounding context, protobuf ingest, numeric `key:>n` in `q`.
