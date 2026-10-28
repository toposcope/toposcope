# toposcope

Toposcope is self-hosted observability for the question after a deploy: what changed? It puts logs, metrics, traces and profiles on one clock, compares equal windows before and after each deploy, and lists the errors that are new.

It runs on a single node as one Toposcope application plus ClickHouse. Toposcope does not provide high availability.

Current release: `0.10.1` · [MIT Expat license](LICENSE)

## Quick start

The packaged install is the recommended path for operators. Download these files from the [v0.10.1 release](https://github.com/toposcope/toposcope/releases/tag/v0.10.1) into one directory:

- `compose.yml`
- `env.example`
- `vector.yaml`
- `LICENSE`
- `toposcope.sh`
- `upgrade.sh`
- `SHA256SUMS`

Check them against the release's sums before you use them (on macOS, `shasum -a 256 -c SHA256SUMS`):

```bash
sha256sum -c SHA256SUMS
```

Create the environment file, write two independent secrets into it without printing them, and start the stack:

```bash
cp env.example .env
for key in CLICKHOUSE_PASSWORD TOPOSCOPE_INGEST_TOKEN; do
  sed -i.bak "s/^${key}=\$/${key}=$(openssl rand -hex 32)/" .env
done
rm .env.bak
chmod 600 .env
docker compose up -d
```

Wait for the application and ClickHouse:

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

Start the included Vector config with Vector 0.51 or newer. It sends three smoke events, then keeps running as a collector an app can send OpenTelemetry to; stop it with Ctrl-C once you have seen the events:

```bash
set -a
source .env
set +a
VECTOR_DATA_DIR=vector-data vector -c vector.yaml
```

Make the first Owner. There is no shared password: this prints a link that works once, for an hour, and nowhere else:

```bash
./toposcope.sh owner-link you@example.com
```

Open the link, choose your name and a password, set up two-step with any authenticator app, and keep the ten backup codes somewhere safe; a browser then stays signed in for 30 days. Name the instance in Settings so two of them can be told apart. Search for `service:smoke` and save the search: it becomes a card on **Home**, and **Watch this** on the hunt makes a monitor from it. **Access** lists every way in or out of the instance, and [What leaves this instance](docs/access.md) says the same in prose.

Then let the others in: **Access › People › Invite someone** gives a link that works once, with a role, Viewer, Operator or Owner, and **Settings › Sign-in and roles** can add Google, Entra, Okta, Keycloak or any other OIDC provider. A script sends `Authorization: Bearer` with a personal or service account token from **Access › Make a token**; HTTP Basic is not accepted. [People and roles](docs/people.md) has the details, and what to do when upgrading from 0.8.

The deployment pins `ghcr.io/toposcope/toposcope:0.10.1`; it never uses `:latest`. Anonymous image pulls need no registry login.

## What Toposcope does

- **Home** opens on the latest deploy, flag or incident. Every saved hunt you can see (your own, and the ones Operators share) is a card, before and after on equal windows (each side is the time since the mark, cut at the next one, between 5 minutes and an hour). Below them are the error fingerprints first seen since, and the monitors that are open.
- **Hunt** searches with copyable `key:value` queries on one clock, with named marks on a rail above it. Compare folds open under a mark, one row per level, service or host; fingerprints are `e1:` chips. It tails a Live window, opens surrounding events, follows identifiers without replacing the current investigation, and links logs to OTLP trace waterfalls and profile icicles when matching IDs are present. Histograms, facets, promoted columns and boards stay; ingested metrics or log-derived rate and numeric series overlay log volume.
- **Watch** lists every monitor with a strip of its day:
  - **On a saved search:** rows, a share of all rows, or a value (rate, avg or p99 of a field).
  - **Checks:** HTTP(S), TCP and certificate checks run from this node, plus push monitors.

  Each monitor opens, reminds and resolves through up to five webhooks. **Watch this** on a hunt shows where a monitor would have opened in the last 24 hours.
- **Access** lists every way in or out: people and their invites, tokens (ingest, personal and service account), links (another Toposcope pulls rows and change marks through any `q`, and Hunt says when a source is short), and shares (named panels, aggregates only, embedded on a page with `data-panel=`).

Logs, ingested metrics, spans, profile samples, and change marks are stored in ClickHouse. Saved searches, monitors, tokens, and settings are stored in SQLite inside the Toposcope application.

## Send data

An app speaks OpenTelemetry to Toposcope: OTLP over HTTP to `POST /v1/logs`, the same way on a laptop and in production. A collector in between is optional — add one for a disk buffer or enrichment. Vector is the canonical collector; Fluent Bit and Alloy are supported alternatives. Collectors own buffering, parsing, sampling, and enrichment. The ingest guide says [what an app sends](docs/ingest.md#what-an-app-sends).

A coding agent can do this for an app: the [toposcope skill](skills/toposcope/SKILL.md) stands up one local instance, gets the app’s errors into it, and checks that they arrive with a stack fingerprint.

Record each deploy from CI; Home and Compare measure from these marks:

```bash
curl -X POST http://127.0.0.1:8080/v1/marks -H "Authorization: Bearer $TOPOSCOPE_INGEST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"kind":"deploy","title":"v1.0","service":"api","id":"deploy-api-v1.0","attrs":{"version":"v1.0"}}'
```

An error row with `exception.type` and frames or a stack gets an `e1` fingerprint; one without hashes its type and message. A span keeps the same `e1` as the log row for the exception it recorded.

| Input | Endpoint | Notes |
| --- | --- | --- |
| OTLP logs | `POST /v1/logs` | JSON or protobuf |
| OTLP over gRPC | port `4319` | Logs, traces, metrics and profiles; same token |
| JSON or NDJSON logs | `POST /api/ingest` | One event, an array, or NDJSON |
| Metrics | `POST /v1/metrics` | JSON metric points |
| Change marks | `POST /v1/marks` | Deploy / flag / incident / note; CI samples in the [ingest guide](docs/ingest.md) |
| Check results | `POST /v1/checks`, `/ping/<key>` | A script's ok, warn or fail; a first result creates its push monitor; the keyed URL takes no token |
| Probes | `POST /v1/probes` | Attach `up=0`/`up=1` or pull one status URL; overlay `metric=up`; an attached one is also a check result |
| OTLP traces | `POST /v1/traces` | JSON or protobuf |
| OTLP profiles | `POST /v1/profiles` | JSON or protobuf |
| Syslog | UDP `5514` | RFC 3164 |

HTTP ingest takes `Authorization: Bearer` with the ingest token; Basic Auth is not accepted. See the [ingest guide](docs/ingest.md) for collector configuration, curl examples, signal-specific behavior, enrichment, and token management.

## Search

The search bar on Hunt accepts queries such as:

```text
level:error service:api
service:checkout "connection reset"
status:>=500 duration_ms:>100
(level:error OR level:fatal) host:api-1
```

Queries run when you press Enter, select a facet, change the time window, or enable Live; they do not run on every keystroke. Copying the browser URL preserves the active search and visualization state.

See the [query language reference](docs/query.md) for operators, precedence, quoting, comparisons, URL state, histogram behavior, and query limits.

## Operate Toposcope

The packaged stack binds the application to `127.0.0.1:8080`, OTLP over gRPC to `127.0.0.1:4319`, and syslog UDP to `127.0.0.1:5514`. ClickHouse is available only on the internal Docker network.

Terminate TLS with a reverse proxy already running on the host; the packaged Compose file intentionally does not include one. Back up both the ClickHouse and application volumes. Pin a previous image version to roll back application code, but restore data if a ClickHouse data directory cannot start.

See the [operations guide](docs/operations.md) for TLS, ports, health checks, retention, upgrades, backup and restore, and rollback boundaries.

## Develop and contribute

Local development runs ClickHouse in Docker and the Bun API plus Vite UI on the host. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, load profiles, repository layout, pull-request scope, and release rules.

## Documentation

- [Roadmap](ROADMAP.md)
- [API](docs/api.md): every `/api` route a token may call, its role and what it takes; `GET /api/openapi.json` is the same as OpenAPI 3.1
- [MCP](docs/mcp.md): an agent calls the API as tools at `/mcp`, with the same token
- [Ingest guide](docs/ingest.md)
- [Operations guide](docs/operations.md)
- [Query language](docs/query.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
