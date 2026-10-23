# Roadmap

This is the **product contract** for v0.x: what you can run today, where the line is going, and what Toposcope will not become. It is not a sprint board. Work in flight lives in [GitHub issues](https://github.com/toposcope/toposcope/issues).

Shipped history is [CHANGELOG.md](CHANGELOG.md). How the system works is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How to send a change is [CONTRIBUTING.md](CONTRIBUTING.md).

New Search chrome still needs a maintainer-approved mock. Prefer a thin slice across ingest, query, UI, and tests.

| | |
| --- | --- |
| **Today** | [0.7.0](https://github.com/toposcope/toposcope/releases/tag/v0.7.0) — hunt, fingerprints, change marks, compare per plotted series, OpenTelemetry logs, traces and metrics, links between instances, monitors, shares |
| **v0.x** | What changed after a deploy, on one clock |
| **Will not** | PromQL, Grafana, a hosted control plane, … |

## Today — 0.7.0

Two containers, MIT Expat, Compose pin `ghcr.io/toposcope/toposcope:0.7.0`.

Hunt is a self-hosted log manager: `key:value`, saved searches, alerts, histogram, workspaces, boards, Fields, OTLP traces and profiles, Vector → `POST /v1/logs`. An app with an OpenTelemetry exporter sends its logs, traces, and metrics straight in over OTLP, by HTTP or gRPC: metrics are stored as gauges, counters, and histograms with no exporter setting, a histogram is read as an average or a percentile, a span keeps the exception recorded on it, and an OTLP reply says what was not stored. The packaged Vector config is an optional collector in between that buffers on disk. Ingest stores exception attrs, uses supplied frames or known `exception.stacktrace` formats for `e1` fingerprints, and stores change marks (`POST /v1/marks`). Search / Follow draw them on the pinned volume plot and as seams between event rows. Compare shows the before and after values for each plotted level, service, or host on exact equal windows around a mark. Fingerprints uses the same exact clock and refuses sets when either side exceeds 200 distinct ids. Ingest copies `service.version` to `version` and consumes attached or pulled status checks. An instance pulls rows and change marks from another over a link — any `q` as the filter, one key pasted once, either side connecting — and Search says what it holds: while a source is short, counts read as floors, the plot and table show the gap, and Fingerprints and Compare never file a line only that source fed as stopped or first seen. Monitors say when something stopped: a saved search that goes quiet or loud, a check-in a script pushes (`POST /v1/checks`, or a keyed `/ping/<key>` with Nagios exit codes), or an HTTP(S), TCP or certificate check from this node; each opens, reminds and resolves, every result is a log row, and Watch draws them on one clock beside the marks. `TOPOSCOPE_WATCHDOG_URL` checks in somewhere else after each pass, so Toposcope stopping is noticed too. The instance says when a newer release is out, in its footer and as a row a monitor can page on, and `upgrade.sh` upgrades it from the host with a backup first and a way back. Metrics can keep longer than logs, on a retention of their own. The footer can check for a release at once and, where the host allows it, upgrade from there. A share lets another app read and embed one scope of numbers — series and counts within limits, never events — with a token that expires and can be revoked at once. Lockup is Fault. Issues and pull requests target `main`. A `v*` tag publishes the image and release zip.

0.3 hunt stays. Later v0.x work adds evidence on that hunt; it does not replace the bar.

## v0.x

Hunt stays the inspector. The line we are building is a trusted answer on **one clock**:

> v0.9 introduced 3 new bugs which increased the error rate on the billing servers by 0.5%, 4% and 9% respectively.

That needs a **version** (and when it shipped), **error fingerprints** (the three bugs), a **delta** on a defined series, and a **slice** (billing / hosts). Other systems stay the source of git, flags, checks, and CRM. Toposcope stores projections on telemetry.

Capabilities, in this order — not patch numbers:

1. **Identities on the row** — `version`, customer, and flag stamped like `service` and `host` (collector-owned, stored attrs).
2. **Error fingerprints** — a stable id computed from application errors (exception type + stack, not an operator-written template). New ids after a change mark are the “three new bugs.”
3. **Change marks** — deploy / flag / incident as a point or band on the histogram clock. Consume CI/git/PagerDuty; a human note is the one write we own. A monitor's open stretch is drawn on the same clock, from its own record, not written as a mark.
4. **Monitors** — a saved search that goes quiet or loud, a check-in that is missed or fails, an HTTP(S) check from this node; each opens, reminds and resolves; anything else pushes its result (not a second Nagios). Locked for 0.6 as [#175](https://github.com/toposcope/toposcope/issues/175)–[#180](https://github.com/toposcope/toposcope/issues/180).
5. **Compare** — a series vs a locked baseline (including the window before a change mark). The fold vs a selected mark is shipped. Split **one** facet (the hunt’s histogram split) stacks one row per series key so the 0.5% / 4% / 9% reading is honest.
6. **The sentence** — a model or human writes it from evidence last. Not a source of counts. Not chat-as-search.

**Log templates** (grouping similar ops lines — Apache, syslog) can appear when we need occurrence counts. They are not the error grouper.

The bar stays copy-pasteable `key:value`. Fingerprints are queryable attrs, not a Sentry issue page.

## Ideas we have not locked

These need a drawing or an explicit choice before they are work:

- Histogram-chip catch-up
- CSV / table export matching promoted columns
- Bound the syslog UDP queue and expose dropped-event accounting
- `ee/` (the root `LICENSE` already reserves it)

## Will not

Do not send these as PRs expecting a merge. They are a different product.

PromQL, Grafana, pie / heatmap, Helm, k8s, S3 / cold volume, SSO, users / roles, audit log, email, GELF, Lucene / regex / infix globs, per-widget `q`, generic event-table sort, a Toposcope ingest daemon, user JS on ingest, HTTP enrichment per event, a hosted control plane, metric-threshold alerts, a Fields role that text-indexes an attr, status pages, on-call schedules and escalation, checks from more than one place, an upgrade button or upgrading on its own.
