# Roadmap

This is the **product contract** for v0.x: what you can run today, where the line is going, and what Toposcope will not become. It is not a sprint board. Work in flight lives in [GitHub issues](https://github.com/toposcope/toposcope/issues).

Shipped history is [CHANGELOG.md](CHANGELOG.md). How the system works is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). How to send a change is [CONTRIBUTING.md](CONTRIBUTING.md).

New Search chrome still needs a maintainer-approved mock. Prefer a thin slice across ingest, query, UI, and tests.

| | |
| --- | --- |
| **Today** | [0.4.1](https://github.com/toposcope/toposcope/releases/tag/v0.4.1) — hunt, fingerprints, stored change marks |
| **v0.x** | What changed after a deploy, on one clock |
| **Will not** | PromQL, Grafana, a hosted control plane, … |

## Today — 0.4.1

Two containers, MIT Expat, Compose pin `ghcr.io/toposcope/toposcope:0.4.1`.

Hunt is a self-hosted log manager: `key:value`, saved searches, alerts, histogram, workspaces, boards, Fields, OTLP traces and profiles, Vector → `POST /v1/logs`. Ingest stores `exception.type` / `exception.frames` when they arrive, writes `e1` fingerprints, and stores change marks (`POST /v1/marks`). The histogram does not draw marks. Lockup is Fault. Issues and pull requests target `main`. A `v*` tag publishes the image and release zip.

0.3 hunt stays. Later v0.x work adds evidence on that hunt; it does not replace the bar.

## v0.x

Hunt stays the inspector. The line we are building is a trusted answer on **one clock**:

> v0.9 introduced 3 new bugs which increased the error rate on the billing servers by 0.5%, 4% and 9% respectively.

That needs a **version** (and when it shipped), **error fingerprints** (the three bugs), a **delta** on a defined series, and a **slice** (billing / hosts). Other systems stay the source of git, flags, checks, and CRM. Toposcope stores projections on telemetry.

Capabilities, in this order — not patch numbers:

1. **Identities on the row** — `version`, customer, and flag stamped like `service` and `host` (collector-owned, stored attrs).
2. **Error fingerprints** — a stable id computed from application errors (exception type + stack, not an operator-written template). New ids after a change mark are the “three new bugs.”
3. **Change marks** — deploy / flag / incident as a point or band on the histogram clock. Consume CI/git/PagerDuty; a human note is the one write we own.
4. **Probe / liveness** — attach-and-pull status APIs; explicit `up=0`; consumed checks (not a second Nagios).
5. **Compare** — a series vs a locked baseline (including the window before a change mark), split **one** facet. This is what makes the 0.5% / 4% / 9% honest.
6. **The sentence** — a model or human writes it from evidence last. Not a source of counts. Not chat-as-search.

**Log templates** (grouping similar ops lines — Apache, syslog) can appear when we need occurrence counts. They are not the error grouper.

The bar stays copy-pasteable `key:value`. Fingerprints are queryable attrs, not a Sentry issue page. Histogram marks and compare chrome wait on a mock.

## Ideas we have not locked

These need a drawing or an explicit choice before they are work:

- Follow-window expand (today Follow is a fixed ±5m)
- Histogram-chip catch-up
- CSV / table export matching promoted columns
- Bind health before migration (`starting` / `schema` / `repair` / `ready`) with 503 gating
- Bound the syslog UDP queue and expose dropped-event accounting
- `ee/` (the root `LICENSE` already reserves it)

## Will not

Do not send these as PRs expecting a merge. They are a different product.

PromQL, Grafana, pie / heatmap, Helm, k8s, S3 / cold volume, SSO, users / roles, audit log, email, GELF, Lucene / regex / infix globs, per-widget `q`, generic event-table sort, a Toposcope ingest daemon, user JS on ingest, HTTP enrichment per event, a hosted control plane, metric-threshold alerts, OTLP metrics protobuf, a Fields role that text-indexes an attr.
