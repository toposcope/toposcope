# Shares

A share lets another app — an admin console, an internal dashboard — read Toposcope's numbers without the operator password and without seeing anything outside one scope.

A share is a **scope of data** and a **secret**. It is not tied to one panel: one share feeds every panel a page needs. Toposcope adds the scope to every read made with the share, on the server; the caller never states it and cannot widen it.

## What a share can read

Aggregates only, over time buckets: a metric series (an average, a percentile, a sum, a rate), a count or rate of log rows, Top-N counts by a key. Never log lines, events, traces, profiles or fingerprints — those carry account ids, sandbox ids and addresses.

A bucketed count does not carry an id, unless a split or a narrowing names one. That is why both are lists the operator writes on the share:

- **split** — the keys a read may split or Top-N by. Their values are shown.
- **narrow** — the keys a caller may add as `key:value`. Narrowing by `account_id:123` and reading a count of 1 would tell the caller that account exists, so a key that is not listed cannot be narrowed by.

Logs read as a count or a rate only. A numeric attr's percentile or maximum can be an id.

## Make one

Signed in (the operator password or a session):

```bash
curl -u :$TOPOSCOPE_PASSWORD -X PUT https://logs.example.com/api/shares/agental-console \
  -H 'content-type: application/json' \
  -d '{
    "expires_at": "2027-10-23",
    "scope": {
      "metric_names": ["fleet_*"],
      "metric_labels": "service:agental",
      "logs": "service:agental",
      "split": ["host", "pool"],
      "narrow": ["host", "pool"]
    }
  }'
```

The answer carries `secret` (`tss1_…`) once, when the share is made. It is stored only as its hash; a lost secret means a new share. `PUT` again changes the scope or the expiry in place and keeps the secret. `GET /api/shares` lists every share, `DELETE /api/shares/<name>` revokes one at once.

- `metric_names` — exact names or prefix globs (`fleet_*`), up to 50. A metric outside them reads as one that does not exist.
- `metric_labels` — equality matchers, as `ml=` writes them, added to every metric read.
- `logs` — a `q` added to every log read, or `null`: the share reads no logs.
- `expires_at` — required, at most a year out.
- `limits` — see below; a field left out takes its default, or keeps what the share had.

## Limits

A scope alone would still let a holder pull a fine-grained copy of everything in it, a few hundred bars at a time. Every share has four limits:

| | Default | |
| --- | --- | --- |
| `min_step` | `1m` | The finest bar. Auto snaps up to it; an explicit finer `step=` is refused (400 names the limit), so a caller always knows which number it got. |
| `max_range` | `7d` | The longest window one read covers, up to `365d`. |
| `max_lookback` | `30d` | How far before now a window may start, up to `730d`. Without it, a 7d window at `1m` walks all of history a week at a time. |
| `reads_per_minute` | `120` | Per share. Over it is `429` with `Retry-After`. |

A refused read never reaches ClickHouse. The scan budget that guards `logs` reads applies unchanged: over it, a log series answers 200 with `refused` and why.

## What a share was used for

Once a minute, each share that was read writes one row: `service:toposcope share:<name> status:used` with `reads`, `cached`, `refused`, `limited` and the distinct page origins it was read from. Every refused read also writes its own row (`status:refused`, `reason`, `path`). No viewer addresses. Search, chart or watch them like any rows: a monitor on `service:toposcope share:agental-console status:refused` pages when a page asks for more than its share allows. `GET /api/shares` gives each share's last read and its reads and refusals over 24 hours.

## Read with one

Keep the secret on your backend. Every read takes Search's window: `range=24h`, or `from` and `to`, and an optional `step=`.

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_SHARE" \
  'https://logs.example.com/share/v1/series?metric=p99:fleet_latency&range=24h&split=host'
```

- `GET /share/v1/series?metric=` — one metric series (`p99:name` for a histogram's reading), `split=` a split key, `ml=host:box-1` to narrow.
- `GET /share/v1/series?agg=count` (or `rate`) — the scope's log rows, `split=level|service|host` when that key is listed.
- `GET /share/v1/top?key=host&n=10` — the busiest values of a split key among the scope's log rows.
- `GET /share/v1/names` — the metric names the share can read in the window, with kind and unit, and the values of its split and narrow keys.

Only a share's secret opens `/share/v1`; the password and the ingest token do not, and a share's secret opens nothing else. A refusal is `401` with no Basic prompt.

## The agental shape

agental's admin console stops drawing its own fleet charts: one share, `service:agental` and `fleet_*`, split and narrow by `host` and `pool`, read from the console's backend.
