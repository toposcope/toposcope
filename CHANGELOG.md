# Changelog

Newest first. Unreleased work is listed here until the next `v*` tag. Shipped versions match `package.json` at tag time.

## Unreleased

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
