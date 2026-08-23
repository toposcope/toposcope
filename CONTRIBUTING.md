# Contributing

Issues and pull requests live on **GitHub**. [ROADMAP.md](ROADMAP.md) is the v0.x product contract (today, direction, will not). Delivery is GitHub issues and milestones. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the system. [CHANGELOG.md](CHANGELOG.md) records shipped versions.

Open an issue before adding or changing visual chrome. Implementation requires a maintainer-approved public mock; do not invent chrome the mock does not show.

## Repository layout

- `src/` — application code: auth, ingest, query, alerts, shared types, and UI
- `scripts/` — local helpers for dev, load, e2e, and truncate workflows
- `compose.yml` — packaged runtime
- `compose.dev.yml` — local ClickHouse for development
- `vector.yaml` — canonical collector path
- `docs/` — architecture and supporting docs
- `ROADMAP.md` — v0.x product contract
- `README.md` — public overview
- `CONTRIBUTING.md` — this guide
- `CHANGELOG.md` — shipped releases

## Local development

Use `.env.example` as the starting point for local work:

```bash
cp .env.example .env
docker compose -f compose.dev.yml up -d clickhouse
bun run dev
```

`bun run dev` runs the API on `:8080` and the UI on `:5173`. The UI talks to the local API, so hot reload works without a separate proxy. Syslog UDP listens on `127.0.0.1:5514`.

`bun run dev` may fill localhost demo defaults for convenience. Those values are only for local development.

## Common commands

```bash
bun test
bun run typecheck
bun run e2e
bun run seed
bun run truncate
bun run load
bun run load:live
bun run load:500k
bun run load:10m
bun run load:100m
```

`bun run e2e` expects ClickHouse to be up and the API to answer on `:8080`.

`bun run seed` writes a small local dataset for manual testing.

`bun run truncate` clears ClickHouse tables and rollups. Use it when you need a clean local data set.

`bun run load` ingests the 10k/1h smoke profile. `bun run load:500k` runs the larger 500k/24h profile.

`bun run load:live --logs=20 --metrics=2 --traces=1` runs continuously until you stop it; add `--for=12s` for a short smoke. Use it for sustained load testing, not routine development.

`bun run load:10m` is expensive. It needs the development ClickHouse limits from `compose.dev.yml` and extra disk. Do not run it against the packaged runtime.

`bun run load:100m` is much heavier. It uses ClickHouse bulk insert (`INSERT SELECT`), can consume several gigabytes, and should be preceded by `bun run truncate`.

## Pull requests

1. Open or find an **issue** (typos can skip this).
2. Branch from `main`. Open a PR early (draft is fine).
3. Bugs, security fixes, docs, tests, and packaging fixes are welcome. Start enhancements with an issue so scope and acceptance criteria can be agreed before coding. Prefer a thin slice that moves ingest, query, UI, and tests together — not a vertical rewrite of one subsystem.
4. Add a [CHANGELOG.md](CHANGELOG.md) line under Unreleased (or the version in `package.json`).
5. `bun test` and `bun run typecheck` must pass. `e2e` when the change touches ingest or search.

Maintainers squash-merge when CI is green. **Ship** is a `vX.Y.Z` tag: it must match `package.json` and the Compose image pin. That tag builds GHCR and attaches `compose.yml`, `env.example`, `vector.yaml`, and `LICENSE`. Pin the full version in Compose, not `:latest`.

## Scope

Bugs, security fixes, docs, tests, and packaging fixes can land when CI is green. Enhancements need an agreed GitHub issue first and should fit [ROADMAP.md](ROADMAP.md) (v0.x direction, not the Will not list). New visual chrome also requires a maintainer-approved public mock.

Do not add a hosted control plane, PromQL, Grafana, or a Toposcope ingest daemon.

## Versions

`package.json` is the product version. **0.3** is shipped (`0.3.14`). Series cuts (0.4, …) are GitHub milestones. A patch is one release. Changelog entries are the history; they are not a second spec.
