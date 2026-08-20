# Contributing

Issues and pull requests on **GitHub**. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the system and [CHANGELOG.md](CHANGELOG.md) records shipped versions. Visual chrome requires a maintainer-provided mock; if no public mock draws it, open an issue and ask before coding it.

## Local

```bash
docker compose -f compose.dev.yml up -d clickhouse
bun run dev
```

UI is `:5173`, API `:8080`. Copy `.env.example` to `.env` and fill secrets (`bun run dev` may fill localhost defaults).

```bash
bun test
bun run typecheck
bun run e2e   # ClickHouse up, API on :8080
```

## Pull requests

1. Open or find an **issue** (typos can skip this).
2. Branch from `main`. Open a PR early (draft is fine).
3. Bugs, security fixes, docs, tests, and packaging fixes are welcome. Start enhancements with an issue so scope and acceptance criteria can be agreed before coding. Prefer a thin slice that moves ingest, query, UI, and tests together — not a vertical rewrite of one subsystem.
4. Add a [CHANGELOG.md](CHANGELOG.md) line under Unreleased (or the version in `package.json`).
5. `bun test` and `bun run typecheck` must pass. `e2e` when the change touches ingest or search.

Maintainers squash-merge when CI is green. **Ship** is a `vX.Y.Z` tag: it must match `package.json` and the Compose image pin. That tag builds GHCR and attaches `compose.yml`, `env.example`, `vector.yaml`, and `LICENSE`. Pin the full version in Compose, not `:latest`.

## Scope

Bugs, security fixes, docs, tests, and packaging fixes can land when CI is green. Enhancements require an agreed issue first. New chrome requires a maintainer-provided mock.

Do not add a hosted control plane, PromQL, Grafana, or a Toposcope ingest daemon.

## Versions

`package.json` is the product version. `0.3.x` is the current series. A patch is one release. Changelog entries are the history; they are not a second spec.
