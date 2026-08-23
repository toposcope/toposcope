# toposcope

Toposcope is a lightweight, self-hosted log manager for searching live logs with `key:value` queries, saved searches, alerts, histograms, and linked traces and profiles.

It runs on a single node as one Toposcope application plus ClickHouse. Toposcope does not provide high availability.

Current release: `0.3.14` · [MIT Expat license](LICENSE)

## Quick start

The packaged install is the recommended path for operators. Download these four files from the [v0.3.14 release](https://github.com/toposcope/toposcope/releases/tag/v0.3.14) into one directory:

- `compose.yml`
- `env.example`
- `vector.yaml`
- `LICENSE`

Create the environment file, generate three independent secrets, and start the stack:

```bash
cp env.example .env
openssl rand -base64 32   # run three times
# Set CLICKHOUSE_PASSWORD, TOPOSCOPE_PASSWORD, and TOPOSCOPE_INGEST_TOKEN in .env.
docker compose up -d
```

Wait for the application and ClickHouse:

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

Start the included Vector smoke source with Vector 0.51 or newer:

```bash
set -a
source .env
set +a
vector -c vector.yaml
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). HTTP Basic Auth accepts any username; use `TOPOSCOPE_PASSWORD` as the password. Search for `service:smoke`, save the search, then use **Alerts → Test** to verify the full path.

The deployment pins `ghcr.io/toposcope/toposcope:0.3.14`; it never uses `:latest`. Anonymous image pulls need no registry login.

## What Toposcope does

- Searches logs with copyable `key:value` queries, boolean operators, prefix matching, and numeric comparisons.
- Tails a moving Live window while keeping older loaded rows available.
- Provides histograms, facets, promoted columns, saved searches, boards, and webhook alerts.
- Opens surrounding events or follows identifiers without replacing the current investigation.
- Links logs to OTLP trace waterfalls and profile icicles when matching IDs are present.
- Overlays ingested metrics or log-derived rate and numeric series on log volume.

Logs, ingested metrics, spans, and profile samples are stored in ClickHouse. Saved searches, alerts, tokens, and settings are stored in SQLite inside the Toposcope application.

## Send data

The canonical production path is Vector sending OTLP protobuf logs to `POST /v1/logs`; Fluent Bit and Alloy are supported alternatives. Collectors own buffering, parsing, sampling, and enrichment.

| Input | Endpoint | Notes |
| --- | --- | --- |
| OTLP logs | `POST /v1/logs` | JSON or protobuf |
| JSON or NDJSON logs | `POST /api/ingest` | One event, an array, or NDJSON |
| Metrics | `POST /v1/metrics` | JSON metric points |
| OTLP traces | `POST /v1/traces` | JSON or protobuf |
| OTLP profiles | `POST /v1/profiles` | JSON or protobuf |
| Syslog | UDP `5514` | RFC 3164 |

HTTP ingest accepts `Authorization: Bearer <TOPOSCOPE_INGEST_TOKEN>` as well as Basic Auth. See the [ingest guide](docs/ingest.md) for collector configuration, curl examples, signal-specific behavior, enrichment, and token management.

## Search

The search bar accepts queries such as:

```text
level:error service:api
service:checkout "connection reset"
status:>=500 duration_ms:>100
(level:error OR level:fatal) host:api-1
```

Queries run when you press Enter, select a facet, change the time window, or enable Live; they do not run on every keystroke. Copying the browser URL preserves the active search and visualization state.

See the [query language reference](docs/query.md) for operators, precedence, quoting, comparisons, URL state, histogram behavior, and query limits.

## Operate Toposcope

The packaged stack binds the application to `127.0.0.1:8080` and syslog UDP to `127.0.0.1:5514`. ClickHouse is available only on the internal Docker network.

Terminate TLS with a reverse proxy already running on the host; the packaged Compose file intentionally does not include one. Back up both the ClickHouse and application volumes. Pin a previous image version to roll back application code, but restore data if a ClickHouse data directory cannot start.

See the [operations guide](docs/operations.md) for TLS, ports, health checks, retention, upgrades, backup and restore, and rollback boundaries.

## Develop and contribute

Local development runs ClickHouse in Docker and the Bun API plus Vite UI on the host. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, tests, load profiles, repository layout, pull-request scope, and release rules.

## Documentation

- [Roadmap](ROADMAP.md)
- [Ingest guide](docs/ingest.md)
- [Operations guide](docs/operations.md)
- [Query language](docs/query.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
