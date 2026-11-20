# Shares

A share lets another app — an admin console, an internal dashboard — read Toposcope's numbers without signing in and without seeing anything outside one scope. This page is for the Owner who makes shares and the developer whose app reads them.

A share is a **scope of data** and a **secret**. It is not tied to one panel: one share feeds every panel a page needs. Toposcope adds the scope to every read made with the share, on the server; the caller never states it and cannot widen it.

## What a share can read

Aggregates only, over time buckets: a metric series (an average, a percentile, a sum, a rate), a count or rate of log rows, Top-N counts by a key. Never log lines, events, traces, profiles or fingerprints — those carry account ids, sandbox ids and addresses.

A bucketed count does not carry an id, unless a split or a narrowing names one. That is why both are lists the operator writes on the share:

| List | What it allows |
| --- | --- |
| **split** | The keys a read may split or Top-N by. Their values are shown. |
| **narrow** | The keys a caller may add as `key:value`. Narrowing by `account_id:123` and reading a count of 1 would tell the caller that account exists, so a key that is not listed cannot be narrowed by. |

Logs read as a count or a rate only. A numeric attr's percentile or maximum can be an id.

## Make one

An Owner makes a share in the app or over the API.

### In the app

**Access › Let someone in › Share** makes one. The secret is shown once, with the ticket call and the script tag to paste.

On a panel, **Share…** adds it to a share as a named panel and hands out the tag that names it.

Access lists each share with:

- its scope in a line, when it expires, and when it was last read;
- its reads and refusals today (a click on the refusals opens its rows as a hunt);
- revoke, in the row.

A share's row opens its page: its named panels, the fence, the raw-params switch, the tag and the panel as the page sees it.

### Over the API

Over the API, a share is made as an Owner, with a personal or service account token (see [People and roles](people.md#tokens)). This call makes or changes the share `agental-console`, which reads `fleet_*` metrics and `service:agental` logs:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT https://logs.example.com/api/shares/agental-console \
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

The answer carries `secret` (`tss1_…`) once, when the share is made. It is stored only as its hash; a lost secret means a new share.

| Call | Does |
| --- | --- |
| `PUT /api/shares/<name>` again | Changes the scope or the expiry in place and keeps the secret. |
| `GET /api/shares` | Lists every share, with its last read and its reads and refusals over 24 hours. |
| `DELETE /api/shares/<name>` | Revokes one at once. |

A share's body has these fields at its top level:

| Field | Meaning |
| --- | --- |
| `expires_at` | Required, at most a year out. |
| `scope` | What the share may read: the fields in the next table. |
| `limits` | See [Limits](#limits); a field left out takes its default, or keeps what the share had. |
| `panels` | Named panels, at most 24 (see [Named panels](#named-panels)); with panels and no `scope`, the scope is worked out from them. |
| `logs` | Only with `panels` and no `scope`: the `q` added to every log read. |
| `embed` | Embedding the share's panels in a page (see [Embed a panel](#embed-a-panel)); a field left out keeps its value or takes its default. |
| `raw_params` | Whether a page may pass its own params within the share's fence; on by default. |

Inside `scope`:

| Field | Meaning |
| --- | --- |
| `metric_names` | Exact names or prefix globs (`fleet_*`), up to 50. A metric outside them reads as one that does not exist. |
| `metric_labels` | Equality matchers, as `ml=` writes them, added to every metric read. |
| `logs` | A `q` added to every log read, or `null`: the share reads no logs. |
| `split`, `narrow` | The lists in [What a share can read](#what-a-share-can-read), up to 8 each. |

## Named panels

A share carries named panels. A panel is the embed tag's own params kept under a name, so a page names it in one line and its title, kind, range and split live on the share. Edit the panel on the share and every page that names it follows.

This tag draws the share's panel `latency-p99`:

```html
<script src="https://logs.example.com/embed.js"
  data-ticket="${ticket}"
  data-panel="latency-p99"></script>
```

This call puts two named panels on the share, and lets pages pass their own params too:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_TOKEN" -X PUT https://logs.example.com/api/shares/agental-console \
  -H 'content-type: application/json' \
  -d '{
    "expires_at": "2027-10-23",
    "logs": "service:agental",
    "panels": [
      { "name": "latency-p99", "params": { "metric": "p99:fleet_latency", "ml": "service:agental", "split": "host", "range": "24h" } },
      { "name": "errors-by-level", "params": { "agg": "count", "split": "level", "range": "7d" } }
    ],
    "raw_params": true
  }'
```

- A panel's `params` are the tag's: `chart`, `metric`, `reading`, `ml`, `split`, `agg`, `key`, `n`, `range`, `step`, `title`. A panel has no `q` of its own; log panels read the share's `logs`.
- With no `scope` sent, the fence is **derived from the panels**: the metric names they read, the labels they all read under, the keys they split or count by.
- A `scope` that is sent must cover the panels, or the answer names what is outside.
- `raw_params` (on by default) still lets a page pass its own params within the fence. Off, a read may only name a panel and move its window (`range`, `from`, `to`, `step`); anything else is refused with a use row.
- `GET /share/v1/series` and `/share/v1/top` take `panel=`; `GET /share/v1/panels/<name>` gives the embed a panel's definition.

## Limits

A scope alone would still let a holder pull a fine-grained copy of everything in it, a few hundred bars at a time. Every share has four limits:

| | Default | |
| --- | --- | --- |
| `min_step` | `1m` | The finest bar. Auto snaps up to it; an explicit finer `step=` is refused (400 names the limit), so a caller always knows which number it got. |
| `max_range` | `7d` | The longest window one series or Top-N read covers, up to `365d`. A `latest` read is not held to it. |
| `max_lookback` | `30d` | How far before now a window may start, up to `730d`. Without it, a 7d window at `1m` walks all of history a week at a time. It is also the longest `lookback` of a `latest` read. |
| `reads_per_minute` | `120` | Per share. Over it is `429` with `Retry-After`. |

A read refused by a limit is refused before any data is read. A log series that would read more than the instance allows one read answers 200 with `refused` and why.

## What a share was used for

Once a minute, each share that was read writes one row: `service:toposcope access:<name> kind:share status:used`. The row keeps `share:<name>` too, with `reads`, `cached`, `refused`, `limited` and the distinct page origins it was read from.

Every refused read also writes its own row (`status:refused`, `reason`, `path`). No viewer addresses.

Search, chart or watch them like any rows: a monitor on `service:toposcope share:agental-console status:refused` pages when a page asks for more than its share allows. `GET /api/shares` gives each share's last read and its reads and refusals over 24 hours.

## Read with one

Keep the secret on your backend. Only a share's secret opens `/share/v1`; a person's session or token and the ingest token do not, and a share's secret opens nothing else. A refusal is `401` with no Basic prompt.

Every read takes Search's window: `range=24h`, or `from` and `to`, and an optional `step=`. This call reads the p99 of `fleet_latency` over a day, split by host:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_SHARE" \
  'https://logs.example.com/share/v1/series?metric=p99:fleet_latency&range=24h&split=host'
```

| Route | Reads |
| --- | --- |
| `GET /share/v1/series?metric=` | One metric series (`p99:name` for a histogram's reading), `split=` a split key, `ml=host:box-1` to narrow. |
| `GET /share/v1/series?agg=count` (or `rate`) | The scope's log rows, `split=level\|service\|host` when that key is listed. |
| `GET /share/v1/top?key=host&n=10` | The busiest values of a split key among the scope's log rows. |
| `GET /share/v1/names` | The metric names the share can read in the window, with kind and unit, and the values of its split and narrow keys. |
| `GET /share/v1/latest?metric=&by=&lookback=` | The newest point of each value of a label: see [Latest value per label](#latest-value-per-label). |

### Latest value per label

Some senders re-send totals as gauges, one per day or cohort: a day's sign-ups, re-sent every few minutes and again when a refund changes it. The answer for a day is then the newest point of its series. `latest` gives every day at once instead of a series per day.

This call reads the newest sign-ups and received dollars for every `day` over the last 400 days:

```bash
curl -H "Authorization: Bearer $TOPOSCOPE_SHARE" \
  'https://logs.example.com/share/v1/latest?metric=agental.business.sign_ups,agental.business.received_usd&by=day&lookback=400d'
```

It answers one row per metric and day:

```json
{
  "metrics": ["agental.business.sign_ups", "agental.business.received_usd"],
  "by": ["day"],
  "lookback": "400d",
  "from": "2025-10-15T12:00:00.000Z",
  "rows": [
    { "metric": "agental.business.received_usd", "day": "2026-11-03", "value": 120.5, "at": "2026-11-19T11:58:00.000Z" },
    { "metric": "agental.business.sign_ups", "day": "2026-11-03", "value": 4, "at": "2026-11-19T11:58:00.000Z" }
  ]
}
```

| Parameter | Meaning |
| --- | --- |
| `metric` | One name, or up to 8 separated by commas, each inside `metric_names`. Plain names only: a histogram's reading (`p99:`) is not a latest value. |
| `by` | The label to group by, or up to 3 (`by=source,cohort`). Each must be in the scope's **`narrow`** list. A point without the label is not a row. |
| `ml` | Narrowing as everywhere (`ml=source:all`), on `narrow` keys other than those grouped by. The scope's `metric_labels` are always ANDed on. |
| `lookback` | How far back to look, as `30d` or `400d`. Required. |

### Latest rows and limits

- There is one row per name and value of the `by` labels, sorted by name, then by the values. `value` is the newest point's, `at` its time.
- When several series share a row's values (say two hosts both send `day:2026-11-03`), the newest point among them wins; narrow with `ml` to pick one.
- At most **2,000 rows**. A read that would answer more is refused (400) rather than cut short: narrow it, ask for fewer names, or look back less.
- It reads only the names asked for, never every metric in the lookback, and counts as **one read** against `reads_per_minute`.
- `lookback` is held to **`max_lookback`**, not `max_range`: it is not a series. So a 400d lookback works on a share whose longest window is 7d, as long as `max_lookback` is at least `400d`. Over it is 400 `this share reaches back …`.
- `min_step` does not apply.
- Metrics older than `metrics_retention_days` are gone whatever the lookback.
- A share with `raw_params` off answers its named panels only, and refuses `latest`.

## Embed a panel

A page that wants Toposcope to draw embeds a panel. The secret stays on the host's backend: it trades the secret for a **ticket** a page can hold, then puts the ticket in the page.

### Share from a panel

The short way starts from the panel. **Share…** at the top of a panel's copy menu (its ⋯ when narrow) shares one; **Share ▾ › Share panels…** at the end of a hunt's query row shares several.

- It proposes the scope from what the panels read: their metrics or every metric like them, their labels fixed, their split, the hunt's `q` for a log count or a Top-N.
- It makes a share, or adds them to one whose fixed labels agree.
- It gives the three things to paste: the secret, the ticket call, and a tag per panel, beside a live preview read through the share.
- A panel that merges several metrics, or reads a value from log lines, says why it cannot be shared as it is and offers what can.

The steps below are what it does.

### Embed by hand

1. On the share, list the origins that may frame it, and how long a ticket lasts:

   ```json
   "embed": { "frame_ancestors": ["https://admin.example.com"], "ticket_ttl": "1h" }
   ```

   Empty `frame_ancestors` (the default) means JSON only: no page may frame the share. `*` is refused.

2. On each page load, the host's backend mints a ticket:

   ```bash
   curl -X POST -H "Authorization: Bearer $TOPOSCOPE_SHARE" https://logs.example.com/share/v1/tickets
   # {"ticket":"tst1_…","expires_at":1792800000000}
   ```

   A ticket reads exactly what its share reads, for `ticket_ttl` (up to 24h) and never past the share's own expiry; it cannot mint another ticket, and it dies the moment its share is revoked.

3. In the page, the script tag:

   ```html
   <script src="https://logs.example.com/embed.js"
     data-ticket="tst1_…" data-metric="fleet_cpu_seconds" data-reading="p99"
     data-range="24h" data-title="CPU · all boxes" data-height="240px"></script>
   ```

   or the iframe it places: `<iframe src="https://logs.example.com/embed?ticket=…&metric=fleet_cpu_seconds&reading=p99&range=24h">`.

### Panel params

A panel takes these params, on the tag as `data-<param>` or on the iframe's URL:

| Param | Meaning |
| --- | --- |
| `ticket` | The share's secret. |
| `panel` | A named panel's name: the panel's own params, so the tag needs no others. |
| `chart` | `line`, the default; `stat`, one number; `top`, a Top-N, or `donut`, the same as a donut; `bars` or `stacked` for a metric. |
| `key`, `n` | For `top` and `donut`: the field to group by and how many values. |
| `metric`, `reading` | The metric, and the reading of a histogram. |
| `ml`, `split` | Narrowing and the split key. |
| `agg` | `count` or `rate` of log rows. Not with `metric`. |
| `range` (or `from` and `to`), `step` | The window and the bar width. |
| `title` | The panel's title. |
| `theme` | `dark`, the default, or `light`. |

The tag alone also takes `data-width` (default `100%`), `data-height` (default `240px`) and `data-origin`, the Toposcope address when you serve `embed.js` yourself.

It is painted by the same panel components as the app, so it looks as the panel does in Toposcope. Its params are checked against the share exactly as `/share/v1/series` checks them; a refused param is painted in the frame, not left blank. The frame polls at its bar width, never faster than every 30 seconds.

### When Toposcope is unreachable

`embed.js` is a loader, not a renderer: it places the iframe where the tag sits and draws nothing itself.

- When the frame has said nothing within 5 seconds, it puts one plain line, *Toposcope unreachable*, in an element with class `toposcope-fallback`. It is styled with zero specificity, so the host's own CSS for that class wins.
- The frame stays, hidden, and takes its place back if Toposcope answers later.
- A frame that loaded and then loses Toposcope keeps its last paint, muted, and says when it last read.

Loaded from Toposcope, the loader cannot help when Toposcope is down: it does not load either. It is the same small file for every share, so serve a copy from your own site and name Toposcope on the tag — `<script src="/js/embed.js" data-origin="https://logs.example.com" data-ticket=…>` — and the fallback shows whenever Toposcope is unreachable.

The frame posts `{ type: "toposcope:ready" }`, `toposcope:stale` and `toposcope:expired` to its parent, with no data in them, for a host that wants its own handling.

### Framing and caching

Framing rules stop framing, not reading: whoever holds a ticket can fetch its numbers. The scope and the limits are the security; `frame_ancestors` keeps Toposcope's panels off pages the operator did not choose. Toposcope itself may frame `/embed`, for that preview; every other Toposcope page refuses to be framed (`frame-ancestors 'none'`).

Answers are kept for a moment: until the panel's next bar starts, or 30 seconds, whichever is sooner. So twenty open consoles showing one panel cost one read. Answers served that way count as `cached` and do not count against the rate.

## The agental shape

One worked example, from agental, a real deployment that reads its fleet numbers through a share.

agental's admin console stops drawing its own fleet charts:

- one share, `service:agental` and `fleet_*`;
- split and narrow by `host` and `pool`;
- framed by the console's origin.

The console's backend mints a ticket per page load and embeds each panel with a script tag.
