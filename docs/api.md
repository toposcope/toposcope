# API

<!-- Written by `bun run api-docs` from src/api/routes.ts. Do not edit by hand. -->

Every `/api` route a personal or service account token may call, from the same table the app registers its routes from. `GET /api/openapi.json` is this page as OpenAPI 3.1.

Send the token as `Authorization: Bearer <token>`; a browser's session works too. Each route names the least role that may call it ([People and roles](people.md)). A query value is text; a body is JSON.

A refusal is one shape, with the route's status: `{ "error": "<sentence>", "field": "<path>" }`, `field` only when the sentence is about one input. A query or a body the route does not take is a 400 and the route does not run. A role refusal is a 403 that also names the role it needs, `need`.

## Elsewhere

These keep their own pages and are not in the spec:

- **Sign-in** ([people.md](people.md)): A person signs in with a browser, by password or the provider, sets up the second step, and joins by invite or owner link; a token never calls these. `POST /api/sign-in`, `POST /api/sign-out`, `POST /api/setup`, `POST /api/join`, `POST /api/two-step/verify`, `POST /api/two-step/setup`, `POST /api/two-step/finish`, `GET /auth/start`, `GET /auth/callback`.
- **Ingest** ([ingest.md](ingest.md)): Senders write logs, metrics, traces, profiles, marks and check results with an ingest token, over OTLP or Toposcope's own JSON. `POST /api/ingest`, `POST /v1/logs`, `POST /v1/metrics`, `POST /v1/traces`, `POST /v1/profiles`, `POST /v1/marks`, `POST /v1/probes`, `POST /v1/checks`, `GET /ping/{key}`.
- **Links between instances** ([access.md](access.md#links)): Another Toposcope pulls rows with a link's own secret, never a person's token. `POST /link/v1/lookup`, `POST /link/v1/claim`, `GET /link/v1/feed`, `POST /link/v1/remove`, `POST /link/v1/ask`, `POST /link/v1/rows`.
- **Shares, public side** ([shares.md](shares.md)): A page or an app reads a share's counts and series with the share's secret or a ticket. `POST /share/v1/tickets`, `GET /share/v1/series`, `GET /share/v1/top`, `GET /share/v1/names`, `GET /share/v1/panels/{name}`.
- **Open** ([operations.md](operations.md)): Health and Prometheus metrics answer without signing in. `GET /api/health`, `GET /api/metrics`.

## Instance

### GET /api/me

Who the caller is: their person, role and initials, and the Owners to ask.

Role: **Viewer** · `me`

### GET /api/instance

This instance's id, name and address, and how the caller's session ends.

Role: **Viewer** · `instance`

### GET /api/openapi.json

This API as OpenAPI 3.1, built from the same table as the routes.

Role: **Viewer** · `openapi`

### GET /api/system

The app's and ClickHouse's memory, CPU and disk now.

Role: **Viewer** · `system`

### GET /api/throughput

Rows received a second now, and a histogram of the last hour.

Role: **Viewer** · `throughput`

### GET /api/version

The running version, newer releases the daily check knows, and whether upgrading from here is on.

Role: **Viewer** · `version`

### POST /api/version/check

Check for newer releases now, on top of the daily check.

Role: **Owner** · `version_check`

### POST /api/version/upgrade

Ask the host to upgrade to a newer release the check knows.

Role: **Owner** · `version_upgrade`

## Search

### GET /api/search

Rows that match a query in a window, newest first, with a histogram or a metric's series.

Role: **Viewer** · `search`

### GET /api/traces/{trace_id}

One trace's spans, the slowest branches when it is large.

Role: **Viewer** · `traces_get`

Path: `trace_id`.

### GET /api/marks

Change marks in a window: deploys, flags, incidents and notes.

Role: **Viewer** · `marks`

### GET /api/probes

Probe samples in a window.

Role: **Viewer** · `probes`

### GET /api/profiles

The profile samples one span carries, as a flame graph.

Role: **Viewer** · `profiles`

### GET /api/search/context

The rows either side of one row, from the same service and host.

Role: **Viewer** · `search_context`

### GET /api/search/around

The rows that match a query either side of a time.

Role: **Viewer** · `search_around`

### GET /api/search/cut

Compare a query's fingerprints before and after a change mark.

Role: **Viewer** · `search_cut`

### GET /api/search/revisions

Which fingerprint keys a query's rows carry before and after a point.

Role: **Viewer** · `search_revisions`

### GET /api/search/follow-span

How many rows carry one key:value within a day of a time, and their first and last.

Role: **Viewer** · `search_follow_span`

### GET /api/fingerprints/{hex}

When one fingerprint was first and last seen, and how often, in a window.

Role: **Viewer** · `fingerprint_seen`

Path: `hex`.

### GET /api/facets

The top values of service, host, level and fingerprint among a query's rows.

Role: **Viewer** · `facets`

### GET /api/attr-keys

The attribute keys a query's rows carry.

Role: **Viewer** · `attr_keys`

### GET /api/attr-facets

The top values of some attribute keys among a query's rows.

Role: **Viewer** · `attr_facets`

### GET /api/attr-values

The values of one attribute key that start with a prefix.

Role: **Viewer** · `attr_values`

### GET /api/numeric-keys

The attribute keys with numbers among a query's rows, to sum or average.

Role: **Viewer** · `numeric_keys`

### GET /api/metric-names

The metric names with points in a window.

Role: **Viewer** · `metric_names`

### GET /api/metric-labels

The label keys one metric's points carry in a window, with how many values each.

Role: **Viewer** · `metric_labels`

## Saved searches

### GET /api/home

The saved search marked Home, if any.

Role: **Viewer** · `home`

### GET /api/home/since

What changed since a mark or in the last hour: new fingerprints, monitors that opened, marks.

Role: **Viewer** · `home_since`

### PUT /api/home

Mark a saved search Home, or unmark it.

Role: **Operator** · `home_set`

### GET /api/saved-searches

The saved searches the caller may see, with their pins.

Role: **Viewer** · `saved_searches`

### POST /api/saved-searches

Save a search: a Viewer's is their own, an Operator's is shared.

Role: **Viewer** · `saved_search_create`

### PUT /api/saved-searches/{id}

Change a saved search, or pin or unpin it; a field left out keeps its value.

Role: **Viewer** · `saved_search_update`

Path: `id`.

### DELETE /api/saved-searches/{id}

Delete a saved search.

Role: **Viewer** · `saved_search_delete`

Path: `id`.

### GET /api/saved-searches/{id}/run

Run a saved search over its own window and say what it finds.

Role: **Viewer** · `saved_search_run`

Path: `id`.

### POST /api/saved-searches/{id}/test

Send a test call to a saved search's webhook.

Role: **Operator** · `saved_search_test`

Path: `id`.

## Monitors

### GET /api/alert-rules

Every monitor as a rule, and whether a call can link back here.

Role: **Viewer** · `alert_rules`

### POST /api/alert-rules/test-call

Send a test call for a monitor as drafted, filled in from its last evaluation.

Role: **Operator** · `alert_rule_test_call`

### POST /api/alert-rules

Make a monitor on a saved search.

Role: **Operator** · `alert_rule_create`

### PUT /api/alert-rules/{id}

Change a monitor by id; a field left out keeps its value.

Role: **Operator** · `alert_rule_update`

Path: `id`.

### DELETE /api/alert-rules/{id}

Delete a monitor by id, and its record.

Role: **Operator** · `alert_rule_delete`

Path: `id`.

### GET /api/monitors

Every monitor with its state and the stretches, calls and results in a window.

Role: **Viewer** · `monitors`

### GET /api/monitors/preview

Where a monitor on a query would have opened over the last 24 hours.

Role: **Viewer** · `monitor_preview`

### POST /api/monitors/send

Run an HTTP(S), TCP or certificate check once from here and say what came back; nothing is stored.

Role: **Operator** · `monitor_send`

### GET /api/monitors/{name}

One monitor by name, with its last 200 stretches and their calls.

Role: **Viewer** · `monitor_get`

Path: `name`.

### PUT /api/monitors/{name}

Make or replace the monitor of that name; what is left out takes its default.

Role: **Operator** · `monitor_put`

Path: `name`.

### DELETE /api/monitors/{name}

Delete a monitor by name, and its record.

Role: **Operator** · `monitor_delete`

Path: `name`.

## Fields

### GET /api/fields

The fields rows carry, their roles, and the metric links.

Role: **Viewer** · `fields`

### PUT /api/fields

Set fields' roles and the metric links.

Role: **Operator** · `fields_set`

## Shares

### GET /api/shares

Every share, live ones first, with its panels and use.

Role: **Operator** · `shares`

### POST /api/shares

Make a share; its secret is in this answer and never again.

Role: **Owner** · `share_create`

### PUT /api/shares/{name}

Make or change a share in place; an Operator may only add panels to one that exists.

Role: **Operator** · `share_put`

Path: `name`.

### DELETE /api/shares/{name}

Revoke a share now: its secret and every read made with it stop.

Role: **Owner** · `share_revoke`

Path: `name`.

### POST /api/shares/{name}/ticket

A five-minute ticket to preview a share as the other site will see it.

Role: **Operator** · `share_ticket`

Path: `name`.

## Links and feeds

### GET /api/feeds

Every feed: a fixed filter whose rows are read in order.

Role: **Operator** · `feeds`

### POST /api/feeds

Make a feed on a filter; the filter never changes after.

Role: **Owner** · `feed_create`

### GET /api/feeds/{id}

A feed's rows after a position, in order.

Role: **Operator** · `feed_read`

Path: `id`.

### GET /api/links

This instance, its links and its link keys.

Role: **Operator** · `links`

### GET /api/links/{id}

One link's page: which way rows move, its scope, and each kind's state.

Role: **Operator** · `link_get`

Path: `id`.

### PUT /api/links/{id}

Pause or resume a link, or narrow its scope where rows leave here.

Role: **Owner** · `link_update`

Path: `id`.

### POST /api/links/offer

Mint a key that lets another instance copy rows from here.

Role: **Owner** · `link_offer`

### POST /api/links/invite

Mint a key that lets another instance send rows here.

Role: **Owner** · `link_invite`

### POST /api/links/preview

Read a pasted key: who minted it, which way rows move, its filter, and whether it is unused.

Role: **Owner** · `link_preview`

### POST /api/links/confirm

Claim a pasted key at its minter and start the link.

Role: **Owner** · `link_confirm`

### DELETE /api/links/keys/{kid}

Revoke a link key that has not been used.

Role: **Owner** · `link_key_revoke`

Path: `kid`.

### DELETE /api/links/{id}

Stop a link; rows already moved age out under retention.

Role: **Owner** · `link_remove`

Path: `id`.

## Access

### GET /api/access

Every way in: people, tokens, links and shares, with today's use and refusals.

Role: **Operator** · `access`

### GET /api/api-tokens

The ingest tokens.

Role: **Operator** · `api_tokens`

### POST /api/api-tokens

Make an ingest token; it is in this answer and never again.

Role: **Owner** · `api_token_create`

### DELETE /api/api-tokens/{id}

Revoke an ingest token.

Role: **Owner** · `api_token_delete`

Path: `id`.

### GET /api/people

People, service accounts and invites, with their roles and tokens.

Role: **Operator** · `people`

### POST /api/people/invites

Invite someone with a role; the link is in this answer and never again.

Role: **Owner** · `invite_create`

### DELETE /api/people/invites/{id}

Cancel an invite.

Role: **Owner** · `invite_cancel`

Path: `id`.

### POST /api/people/service-accounts

Make a service account with a role.

Role: **Owner** · `service_account_create`

### PUT /api/people/{id}

Change a person's or a service account's role.

Role: **Owner** · `person_update`

Path: `id`.

### DELETE /api/people/{id}

Revoke a person or a service account; their sessions and tokens end.

Role: **Owner** · `person_revoke`

Path: `id`.

### POST /api/people/{id}/tokens

Make a service account's token; it is in this answer and never again.

Role: **Owner** · `service_token_create`

Path: `id`.

### DELETE /api/people/{id}/tokens/{tid}

Revoke one of a person's or a service account's tokens.

Role: **Owner** · `service_token_revoke`

Path: `id`, `tid`.

### DELETE /api/people/{id}/two-step

Reset a person's two-step; they set it up again at their next sign-in.

Role: **Owner** · `two_step_reset`

Path: `id`.

### POST /api/me/two-step/backup-codes

Ten new backup codes for the caller; the old ten stop working.

Role: **Viewer** · `my_backup_codes`

### GET /api/me/tokens

The caller's own personal tokens.

Role: **Viewer** · `my_tokens`

### POST /api/me/tokens

Make a personal token for the caller's own scripts; it is in this answer and never again.

Role: **Viewer** · `my_token_create`

### DELETE /api/me/tokens/{id}

Revoke one of the caller's own tokens.

Role: **Viewer** · `my_token_revoke`

Path: `id`.

## Settings

### GET /api/sign-in-settings

How people sign in here: passwords, the provider, and who must have two-step.

Role: **Owner** · `sign_in_settings`

### PUT /api/sign-in-settings

Change how people sign in here; a field left out keeps its value.

Role: **Owner** · `sign_in_settings_set`

### GET /api/settings

Retention, the instance's name and the default webhook.

Role: **Viewer** · `settings`

### PUT /api/settings

Change retention, the instance's name or the default webhook; a field left out keeps its value.

Role: **Owner** · `settings_set`
