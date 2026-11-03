# Roadmap

This is the **product contract** for v0.x: what you can run today, where the line is going, and what Toposcope will not become. It is not a sprint board. Work in flight lives in [GitHub issues](https://github.com/toposcope/toposcope/issues).

Shipped history is [CHANGELOG.md](CHANGELOG.md). How the system works is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How to send a change is [CONTRIBUTING.md](CONTRIBUTING.md).

New Search chrome still needs a maintainer-approved mock. Prefer a thin slice across ingest, query, UI, and tests.

| | |
| --- | --- |
| **Today** | [0.15.0](https://github.com/toposcope/toposcope/releases/tag/v0.15.0) — what changed after a deploy, on one clock: logs, metrics, traces and profiles under change marks, Compare on equal windows before and after, and the error fingerprints that are new. One node, two containers. |
| **v0.x** | The sentence (step 6 below), written from that evidence. Team features wait for an HA design: see [One node](#one-node). |
| **Will not** | PromQL, Grafana, a hosted control plane, … |

## Today — 0.15.0

Two containers, MIT Expat, Compose pin `ghcr.io/toposcope/toposcope:0.15.0`.

- **Home** — every saved hunt as a card, before and after the latest deploy, flag or incident on equal windows; the error fingerprints first seen since; the monitors that are open.
- **Hunt** — the log search: a copyable `key:value` bar, saved hunts, histogram, facets, workspaces, Fields, promoted columns and Live. Change marks sit on the plot and as seams between rows. Compare shows before and after for each plotted level, service or host on exact equal windows around a mark; Fingerprints reads the same clock and refuses a side past 200 distinct ids. A matching id opens a trace waterfall and a profile icicle. A deploy's sha and a stack frame link to the code once **Settings › Repositories** knows where it lives. Fields says which keys each service sends and which names do not match.
- **Boards** — panels that move and resize, fold into sections and carry notes, each with its own `q`, up to 26. A metric draws as lines, bars or stacked bars, a histogram metric as a heatmap, a Top-N as a donut.
- **Ingest** — OTLP logs, traces, metrics and profiles over HTTP or gRPC; metrics are gauges, counters and histograms with no exporter setting, and an OTLP reply says what was not stored. Prometheus remote write (`POST /v1/prometheus/write`), JSON / NDJSON, syslog UDP, change marks (`POST /v1/marks`) and check results. An error with a type and frames gets an `e1` fingerprint; `service.version` becomes `version`. The packaged Vector config is an optional disk buffer that also sends the machine's health and any `/metrics` page listed in it.
- **Watch** — a saved search that goes quiet or loud, a check-in a script pushes (`POST /v1/checks`, or `/ping/<key>` with Nagios exit codes), or an HTTP(S), TCP or certificate check from this node. Each opens, reminds and resolves; every result is a log row. `TOPOSCOPE_WATCHDOG_URL` checks in somewhere else, so Toposcope stopping is noticed too.
- **Access** — people with three roles (Owner, Operator, Viewer), two-step and OIDC sign-in, and every write stamped with who made it; tokens; links; shares. A link pulls every kind (logs, marks, spans, metric points, profiles, monitors) from another instance through any `q`, and on down a chain; while a source is short, counts read as floors and the gap shows. A share lets another page embed one scope of numbers, never events, with a token that expires and can be revoked at once.
- **Agents** — MCP at `/mcp` and the toposcope skill: set up an instance, read it, propose monitors and panels, and save only what you say yes to.
- **Operating** — `upgrade.sh` takes a backup first and keeps a way back. The footer says when a release is out and can check at once; it upgrades on a click only where the host ran `upgrade.sh enable-ui`. Metrics keep on a retention of their own. ⌘K opens the command palette; [docs/ui](docs/ui/README.md) is the design system.

Issues and pull requests target `main`. A `v*` tag publishes the image and release zip.

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

## One node

Toposcope runs on one node and does not survive it. Since 0.9 it has people, links and shares, so a team can come to depend on that one box. Until there is an HA design:

- What ships holds on one node: a backup and restore bring all of it back, `upgrade.sh` backs up first, and the watchdog says when the node stops ([operations](docs/operations.md#who-watches-toposcope)).
- No more team features: no new roles or sign-in kinds, and nothing under `ee/` (SAML, SCIM, roles with a data fence, an audit log of every change). A team that needs these needs an instance that survives a node.

## Ideas we have not locked

These need a drawing or an explicit choice before they are work:

- Histogram-chip catch-up
- CSV / table export matching promoted columns
- Enterprise under `ee/` (the root `LICENSE` already reserves it): SAML, SCIM with directory groups to roles, roles with a data fence, an audit log — after an HA design, since a team that needs these needs an instance that survives a node
- A map, by a country or region the collector adds to each row (a local GeoIP lookup in Vector, as the enrich recipes do); Toposcope never looks up an address itself

## People and roles

One shared password fitted one operator on one box. It stopped fitting once links joined instances, shares put panels on other teams' pages, and teams wanted to hand someone a read-only view without handing them the password. So from 0.9 Toposcope has people, in the open-source edition: named users invited by a one-time link and revoked one by one; three fixed roles, Owner, Operator and Viewer; two-step sign-in with an authenticator app; sign-in with one OIDC provider, on purpose, so single sign-on is not a paid extra; and every write records who made it. There is no shared password any more: the first Owner comes from a setup link, scripts use personal tokens or a service account's, and machines that send logs keep ingest tokens.

## Links carry every kind

Up to 0.9, a link copied log rows and change marks, and nothing else, so an instance that collected from small nodes held their logs but not their traces, panels, profiles or monitors, and a pulled log line offered View trace for spans that never arrived. Someone who links a node expects everything on it to arrive. So from 0.10 a link carries every kind: logs, marks, spans, metric points and histogram buckets, profiles, and monitor results with their definitions, shown read-only under the source's name. A key carries a set of kinds, all ticked, and the scope runs on each kind by the fields it has: a scope that names a field a kind lacks sends none of that kind, and says so. Every kind takes its place from one arrival sequence, so a link keeps one position and one *behind*; spans, points, profiles and monitor results travel in ClickHouse's own format, compressed; a pulled row can be pulled on, edge to region to centre, and is never stored twice. Each kind keeps the tells Search already draws for logs: a short source is a floor, a hatch or a named partial, on a waterfall, a metric panel and a profile too. A metric point carries its kind and unit, so one name sent in two units is two lines, never summed, and a monitor names its service and host; monitors made before 0.10 are not kept. 0.10 does not keep 0.9's links or keys: both sides of a link must speak the same link protocol and schema, and a link whose sides do not stops where it stands and says which side to upgrade.

## Will not

Do not send these as PRs expecting a merge. They are a different product.

PromQL, Grafana, Helm, k8s, S3 / cold volume, an audit log in the open-source edition (each write names who made it; a log of every change is `ee/`, after HA), email, GELF, Lucene / regex / infix globs, per-widget `q` in a hunt (a hunt has one `q`; board panels each carry their own, #410), generic event-table sort, a Toposcope ingest daemon, user JS on ingest, HTTP enrichment per event, a hosted control plane, metric-threshold alerts, a Fields role that text-indexes an attr, status pages, on-call schedules and escalation, checks from more than one place, upgrading on its own (the footer upgrades only on a click, where the host turned it on).
