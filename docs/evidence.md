# What an investigation reads

Home and the hunt answer one question: *what changed since this deploy?* They answer it from the keys on the rows, not from the rows' volume. A million rows with no `version` and no fingerprint say less than a thousand that carry both. This page lists the keys an investigation reads, what each one buys, and what goes missing without it. How to send them is the [ingest guide](ingest.md).

## The keys

| Key | On | Set it with | Without it |
| --- | --- | --- | --- |
| `service` | logs, spans, metrics, marks, monitors | `OTEL_SERVICE_NAME`, or the resource's `service.name`; a mark's `service` | OTLP rows land under `otlp`, every app reads as one, and a deploy mark cannot be told apart from the next service's. |
| `host` | logs, metrics, spans | the resource's `host.name`, or the collector | Compare cannot split by host, so one bad box hides in the average. |
| `version` | logs (from `service.version`), a deploy mark's `attrs.version` | `OTEL_RESOURCE_ATTRIBUTES=service.version=…`; in CI, the tag | Nothing says which release a row ran. `version:v0.9` finds nothing, and a rollout's two versions read as one. |
| `level` | logs | the record's severity | `level:error`, the error rate and every monitor on it count nothing. |
| `exception.type` with `exception.stacktrace` or `exception.frames` | error logs | the logger bridged to the exporter, with the exception attached | No `e1`. Fingerprints and Home's new and stopped errors skip that error; it counts only as volume. See [exception fingerprints](ingest.md#exception-fingerprints). |
| `trace_id` | logs | an OpenTelemetry logger bridge inside a span, or a `trace_id` / `request_id` attr of 32 hex | No View trace. A `req-…` id still works for Follow, not for the waterfall. |
| A deploy mark | `change_marks` | CI on release (`POST /v1/marks`), with `service`, `attrs.version` and `attrs.sha` | Home falls back to the last hour against the hour before. Compare and Fingerprints have nothing to stand on. |

`service`, `level`, `message` and the time are the floor. Each row past that adds one question Toposcope can answer.

## Names have to match

An investigation joins on strings. These pairs must be equal, letter for letter:

- **`service` across kinds.** The service name on a log, on a span's resource, on a metric's `service` label, on a deploy mark, and on a monitor. `billing`, `billing-api` and `Billing` are three services.
- **A mark's `version` and the rows' `version`.** If CI marks `v0.9` and the app reports `0.9`, nothing ties the deploy to the rows it shipped. Pick one form, with or without the `v`, and use it in both places.
- **`host` across kinds.** The same box under one name on logs, metrics and spans.

Fix them where they are made: set `OTEL_SERVICE_NAME` and `service.version` from the same variables CI uses for the mark, so one value feeds both. A collector that already parses lines can also rewrite a name on the way, as an alias in [Enrich at the collector](ingest.md#enrich-at-the-collector). Stored rows are not rewritten; a fix applies from the next row on.

## Mark every change

A mark is the anchor Home and the hunt measure from, so every change that can break production should leave one: deploys, flag flips, config pushes, migrations, incidents. The [GitHub Actions and GitLab CI samples](ingest.md#github-actions) cover releases. For the rest:

- **A deploy tool that can post JSON.** Point its notification at `POST /v1/marks` with the ingest token, a stable `id` (`deploy-<service>-<version>`), `kind`, `service`, and `attrs.version` and `attrs.sha`.
- **A tool with a fixed webhook body** (a flag service, an incident tool). Let Vector take the webhook with an `http_server` source, `remap` it into a mark, and send it on with an `http` sink to `/v1/marks`. Toposcope does not take third-party webhook shapes itself.
- **A person.** The marks panel's note form, for the change no tool recorded.

`attrs.sha` is the commit. The marks panel shows the first six characters beside the source, so the deploy names its code.

## Check what arrived

- `service:otlp` in the bar finds OTLP rows that came without a service name.
- **Settings → Fields** lists the keys that arrived in the window. A key from the table above that is missing there is missing on every row.
- An error row in the event panel shows its fingerprint line. No line means no `e1`: check that the exception reached the log record, not only the span.
- A Home with no deploy in a day that had one means the mark never arrived. Check the CI step's reply: a valid mark is always `200` with `ingested`.

## Related documentation

- [Ingest](ingest.md) — routes, formats, collectors, and enrichment
- [Query language](query.md) — `key:value`, fingerprints, and marks in the hunt
- [Operations](operations.md) — running the instance
