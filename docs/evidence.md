# What an investigation reads

Home and the hunt answer one question: *what changed since this deploy?* They answer it from the keys on the rows, not from the rows' volume. A million rows with no `version` and no fingerprint say less than a thousand that carry both. This page lists the keys an investigation reads, what each one buys, and what goes missing without it. How to send them is the [ingest guide](ingest.md).

## The keys

| Key | On | Set it with | Without it |
| --- | --- | --- | --- |
| `service` | logs, spans, metrics, marks, monitors | `OTEL_SERVICE_NAME`, or the resource's `service.name`; a mark's `service` | OTLP rows land under `otlp`, every app reads as one, and a deploy mark cannot be told apart from the next service's. |
| `host` | logs, metrics, spans | the resource's `host.name`, or the collector | Compare cannot split by host, so one bad box hides in the average. |
| `version` | logs (from `service.version`), a deploy mark's `attrs.version` | `OTEL_RESOURCE_ATTRIBUTES=service.version=…`; in CI, the tag | Nothing says which release a row ran. `version:v0.9` finds nothing, and a rollout's two versions read as one. |
| `level` | logs | the record's severity | `level:error`, the error rate and every monitor on it count nothing. |
| `exception.type` with `exception.stacktrace` or `exception.frames` | error logs | the logger bridged to the exporter, with the exception attached | `e1` falls back to the type and the message, so a reworded message reads as a new error in Fingerprints and on Home, and the Stack tab is empty. See [exception fingerprints](ingest.md#exception-fingerprints). |
| `trace_id` | logs | an OpenTelemetry logger bridge inside a span, or a `trace_id` / `request_id` attr of 32 hex | No View trace. A `req-…` id still works for Follow, not for the waterfall. |
| A deploy mark | `change_marks` | CI on release (`POST /v1/marks`), with `service`, `attrs.version` and `attrs.sha` | Home falls back to the last hour against the hour before. Compare and Fingerprints have nothing to stand on. |
| The service's repository | the resource's `vcs.repository.url.full`, a deploy mark's `attrs.repo`, or **Settings › Repositories** | `OTEL_RESOURCE_ATTRIBUTES=vcs.repository.url.full=…`; in CI, the repository's URL on the mark | A deploy's sha and a stack frame are text. See [Link the code](#link-the-code). |

`service`, `level`, `message` and the time are the floor. Each row past that adds one question Toposcope can answer.

## Names have to match

An investigation joins on strings. These pairs must be equal, letter for letter:

- **`service` across kinds.** The service name on a log, on a span's resource, on a metric's `service` label, on a deploy mark, and on a monitor. `billing`, `billing-api` and `Billing` are three services.
- **A mark's `version` and the rows' `version`.** If CI marks `v0.9` and the app reports `0.9`, nothing ties the deploy to the rows it shipped. Pick one form, with or without the `v`, and use it in both places.
- **`host` across kinds.** The same box under one name on logs, metrics and spans.

Fix them where they are made: set `OTEL_SERVICE_NAME` and `service.version` from the same variables CI uses for the mark, so one value feeds both. A collector that already parses lines can also rewrite a name on the way, as an alias in [Enrich at the collector](ingest.md#enrich-at-the-collector). Stored rows are not rewritten; a fix applies from the next row on.

## Mark every change

A mark is the anchor Home and the hunt measure from, so every change that can break production should leave one: deploys, flag flips, config pushes, migrations, incidents. The [GitHub Actions and GitLab CI samples](ingest.md#github-actions) cover releases. For the rest:

- **A deploy tool that can post JSON.** Point its notification at `POST /v1/marks` with the ingest token, a stable `id` (`deploy-<service>-<version>`), `kind`, `service`, and `attrs.version`, `attrs.sha` and `attrs.repo`. [Argo CD](#argo-cd) below is the worked example.
- **A tool with a fixed webhook body** (a flag service, an incident tool). Let Vector take the webhook and turn it into a mark: [a Vector relay](#a-vector-relay-for-webhooks) below. Toposcope does not take third-party webhook shapes itself.
- **A person.** The marks panel's note form, for the change no tool recorded.

### Argo CD

Argo CD's notifications post a deploy mark when an application has synced and is healthy, once per revision. In `argocd-notifications-cm`:

```yaml
data:
  service.webhook.toposcope: |
    url: https://toposcope.example.com
    headers:
    - name: Authorization
      value: Bearer $toposcope-ingest-token
    - name: Content-Type
      value: application/json
  template.toposcope-deploy: |
    webhook:
      toposcope:
        method: POST
        path: /v1/marks
        body: |
          {"kind":"deploy",
           "title":"{{index .app.metadata.annotations "toposcope/version"}}",
           "id":"deploy-{{.app.metadata.name}}-{{.app.status.sync.revision}}",
           "service":"{{.app.metadata.name}}",
           "attrs":{"version":"{{index .app.metadata.annotations "toposcope/version"}}",
                    "sha":"{{.app.status.sync.revision}}",
                    "repo":"{{.app.spec.source.repoURL}}",
                    "source":"argocd"}}
  trigger.on-deployed: |
    - when: app.status.operationState.phase in ['Succeeded'] and app.status.health.status == 'Healthy'
      oncePer: app.status.sync.revision
      send: [toposcope-deploy]
```

`toposcope-ingest-token` is a key in `argocd-notifications-secret` holding the ingest token. Then subscribe each application:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/subscribe.on-deployed.toposcope: ""
    toposcope/version: "1.4.2"
```

Argo CD does not know the release, so the pipeline that bumps the image also sets `toposcope/version` to the same string the app reports as `service.version`; that is what ties the mark to its rows. The service is the application's name: if the app reports another `service.name`, put that in the body instead. The `id` is stable per revision, so a re-sync of the same revision is still one mark.

### A Vector relay for webhooks

A tool that posts its own body shape goes through Vector: an `http_server` source takes the webhook, `remap` writes the mark, and an `http` sink posts it to `/v1/marks`. This example takes a flag service's body like `{"id":"evt_81","flag":"new-checkout","state":"on","service":"checkout","by":"maya"}`; change the field paths to your tool's.

```yaml
sources:
  flag_hooks:
    type: http_server
    address: 0.0.0.0:9000
    path: /hooks/flags
    decoding:
      codec: json

transforms:
  to_mark:
    type: remap
    inputs: [flag_hooks]
    source: |-
      flag = string!(.flag)
      state = string!(.state)
      . = {
        "kind": "flag",
        "title": flag + " " + state,
        "id": "flag-" + string!(.id),
        "service": string(.service) ?? "",
        "attrs": {"flag": flag, "state": state, "by": string(.by) ?? "", "source": "flags"}
      }

sinks:
  toposcope_marks:
    type: http
    inputs: [to_mark]
    uri: "${TOPOSCOPE_URL}/v1/marks"
    method: post
    encoding:
      codec: json
    batch:
      max_events: 1
    request:
      headers:
        Authorization: "Bearer ${TOPOSCOPE_INGEST_TOKEN}"
        Content-Type: application/json
```

Point the tool's webhook at `http://<vector-host>:9000/hooks/flags`. The mark's `id` comes from the tool's own event id, so a webhook the tool sends twice is still one mark. `batch.max_events: 1` posts each mark on its own, as one JSON object. The listener takes any POST to that path, so keep it on a network only the tool can reach, or put it behind the same reverse proxy as Toposcope. An incident tool works the same way with `kind: incident`, opening with one event and closing with another that sends the same `id` and an `end_ts`.

`attrs.sha` is the commit. The marks panel shows the first six characters beside the source, so the deploy names its code.

## Link the code

A sha and a stack frame open the code on the service's git host once Toposcope knows where the code lives. These are links only: Toposcope never fetches a repository and keeps no token, so the git host stays the source of the code and its permissions.

A service's repository comes from, in order:

1. a row an Operator set in **Settings › Repositories**, which wins over the other two;
2. `vcs.repository.url.full` on its resource (OpenTelemetry's name for it), on its logs or spans;
3. `attrs.repo` on its newest deploy mark.

Any of `https://github.com/acme/api`, `github.com/acme/api` or `git@github.com:acme/api.git` reads as the same repository. The link shape follows the host: GitHub, GitLab and Bitbucket by name (`github.com`, `gitlab.com`, `bitbucket.org`, or a host named `github.…`, `gitlab.…`, `bitbucket.…`); any other host links the way Gitea and Forgejo do. Settings › Repositories lists every service and where its repository is known from; a self-hosted address also says which host's links it uses (`· links as Gitea / Forgejo`).

Many services can share one repository: Set on a service lists the repositories Toposcope already knows, each with the services using it, so a second service from the same repository is a pick, not a URL to type again. Tick several services to set one repository for all of them. There is no "project" to declare; a service is the unit, and the repository is a value it points at.

A **folder** is only for a repository where a service is built from a subfolder, so its stack paths start there: in `acme/services`, `pay` builds from `services/pay/`, and its frame `/app/src/charge.ts:41` is `services/pay/src/charge.ts` in the repository. Set it from **Change › Folder…** on a service set here. Leave it empty when services share one codebase built from the root: their paths already start at the root. A path that already starts with the folder is not given it twice. Commit and compare links are the whole repository's and do not use it.

With a repository known:

- **The marks panel.** A selected deploy gets a `code` row: the commit at the mark's `attrs.sha`, and *changes since* the previous deploy of the same service, the host's compare page between the two shas.
- **The Stack tab.** Frames under the app's own paths link to that line of that file. The app's own paths are the roots the `e1` fingerprint strips: `/app`, `/usr/src/app`, `/src`, `/var/www…` and `/home/<user>`, so `/app/src/billing/charge.js:41` opens `src/billing/charge.js` at line 41. Library frames (`node_modules`, `site-packages`, `vendor`, …) and frames elsewhere stay text. The line is read at the sha of the deploy mark of the same service whose `attrs.version` equals the row's `version`; with no such mark, it is read on the default branch, and the tab's header says so.

So the same rule as above holds: a mark's `version` and the rows' `version` must match, letter for letter, for a frame to open the code that ran.

## Check what arrived

- `service:otlp` in the bar finds OTLP rows that came without a service name.
- **Settings → Fields** opens with **Coverage**: for each service in the last 24 h, the share of its rows that carry `version`, `host` and `trace_id`, the share of its error and fatal rows that carry a stack (`exception.stacktrace` or `exception.frames`), and its deploy marks. Services with a gap come first, the largest first; the rest, and the services that are complete or whose only gaps are accepted, fold into a line each, and **Find a service** searches them all. A key is complete at 90% of the service's rows; `trace_id` counts only for a service that sends spans. The counts come from the minute rollups and the marks, so the table costs no scan of the rows. Below it, **Names that do not match** lists the pairs from [Names have to match](#names-have-to-match) that differ only by case, a leading `v`, or an `-api` / `-svc` suffix: a service on spans, metrics or marks beside the one on logs, and a deploy mark's `version` beside the one on its rows. `GET /api/coverage` is the same answer for a script.
- **Home** lists what its answer stands on under the cards: up to three services that are not complete, the ones it reads the most rows from, each with the gap that costs it most and how to send it, and how many more there are. A mark whose `version` does not match its rows comes first when it is the selected mark. With nothing missing, the list is not there.
- The keys table under Coverage lists every key that arrived in the window. A key from the table above that is missing there is missing on every row.
- **Settings › Repositories** shows which services have a repository and where it came from. A service listed as `none` links no code.
- An error row in the event panel has a Stack tab when its exception arrived with a stack. Without one, the fingerprint line says its `e1` came from the message: check that the exception reached the log record, not only the span.
- Under the Compare fold, a deploy mark whose `version` is not a `version` on its service's rows says so: the after side holds both releases, and nothing tells them apart.
- A gap a service is not meant to close (a worker with no spans, a job that never deploys) can be accepted on Coverage by an Operator: Home, the counts and the event panel stop naming it, and the cell keeps its number marked accepted. It counts again if its share falls below what it was when accepted, and is cleared once the key reaches 90%. The Accepted gaps list says who accepted each and when.
- A Home with no deploy in a day that had one means the mark never arrived. Check the CI step's reply: a valid mark is always `200` with `ingested`.

## Related documentation

- [Ingest](ingest.md) — routes, formats, collectors, and enrichment
- [Query language](query.md) — `key:value`, fingerprints, and marks in the hunt
- [Operations](operations.md) — running the instance
