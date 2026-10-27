# Shares

A share lets another app — an admin console, an internal dashboard — read Toposcope's numbers without signing in and without seeing anything outside one scope.

A share is a **scope of data** and a **secret**. It is not tied to one panel: one share feeds every panel a page needs. Toposcope adds the scope to every read made with the share, on the server; the caller never states it and cannot widen it.

## What a share can read

Aggregates only, over time buckets: a metric series (an average, a percentile, a sum, a rate), a count or rate of log rows, Top-N counts by a key. Never log lines, events, traces, profiles or fingerprints — those carry account ids, sandbox ids and addresses.

A bucketed count does not carry an id, unless a split or a narrowing names one. That is why both are lists the operator writes on the share:

- **split** — the keys a read may split or Top-N by. Their values are shown.
- **narrow** — the keys a caller may add as `key:value`. Narrowing by `account_id:123` and reading a count of 1 would tell the caller that account exists, so a key that is not listed cannot be narrowed by.

Logs read as a count or a rate only. A numeric attr's percentile or maximum can be an id.

## Make one

In the app: **Access › Let someone in › Share**. Access lists each share with its scope in a line, when it expires, when it was last read, its reads and refusals today (a click on the refusals opens its rows as a hunt), and revokes in the row. The secret is shown once, with the ticket call and the script tag to paste. A share's row opens its page: its named panels, the fence, the raw-params switch, the tag and the panel as the page sees it.

On a panel, **Share…** adds it to a share as a named panel and hands out the tag that names it.

Or over the API, as an Owner (a personal or service account token, see [People and roles](people.md#tokens)):

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

The answer carries `secret` (`tss1_…`) once, when the share is made. It is stored only as its hash; a lost secret means a new share. `PUT` again changes the scope or the expiry in place and keeps the secret. `GET /api/shares` lists every share, `DELETE /api/shares/<name>` revokes one at once.

- `metric_names` — exact names or prefix globs (`fleet_*`), up to 50. A metric outside them reads as one that does not exist.
- `metric_labels` — equality matchers, as `ml=` writes them, added to every metric read.
- `logs` — a `q` added to every log read, or `null`: the share reads no logs.
- `expires_at` — required, at most a year out.
- `limits` — see below; a field left out takes its default, or keeps what the share had.

## Named panels

A share carries named panels (0.8, frame 26k). A panel is the embed tag's own params kept under a name, so a page names it in one line and its title, kind, range and split live on the share:

```html
<script src="https://logs.example.com/embed.js"
  data-ticket="${ticket}"
  data-panel="latency-p99"></script>
```

Edit the panel on the share and every page that names it follows.

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
- With no `scope` sent, the fence is **derived from the panels**: the metric names they read, the labels they all read under, the keys they split or count by. A `scope` that is sent must cover the panels, or the answer names what is outside.
- `raw_params` (on by default) still lets a page pass its own params within the fence. Off, a read may only name a panel and move its window (`range`, `from`, `to`, `step`); anything else is refused with a use row.
- `GET /share/v1/series` and `/share/v1/top` take `panel=`; `GET /share/v1/panels/<name>` gives the embed a panel's definition.

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

Once a minute, each share that was read writes one row: `service:toposcope access:<name> kind:share status:used` (the row keeps `share:<name>` too) with `reads`, `cached`, `refused`, `limited` and the distinct page origins it was read from. Every refused read also writes its own row (`status:refused`, `reason`, `path`). No viewer addresses. Search, chart or watch them like any rows: a monitor on `service:toposcope share:agental-console status:refused` pages when a page asks for more than its share allows. `GET /api/shares` gives each share's last read and its reads and refusals over 24 hours.

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

Only a share's secret opens `/share/v1`; a person's session or token and the ingest token do not, and a share's secret opens nothing else. A refusal is `401` with no Basic prompt.

## Embed a panel

A page that wants Toposcope to draw embeds a panel. The secret stays on the host's backend: it trades the secret for a **ticket** a page can hold, then puts the ticket in the page.

The short way starts from the panel: **Share…** at the top of a panel's copy menu (its ⋯ when narrow), or **Share panels…** on the canvas for several. It proposes the scope from what the panels read (their metrics or every metric like them, their labels fixed, their split, the hunt's `q` for a log count or a Top-N), makes a share or adds them to one whose fixed labels agree, and gives the three things to paste: the secret, the ticket call, and a tag per panel, beside a live preview read through the share. A panel that merges several metrics, or reads a value from log lines, says why it cannot be shared as it is and offers what can. The steps below are what it does.

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

A panel takes `chart` (`line`, the default; `stat`, one number; `top`, a Top-N with `key` and `n`, or `donut`, the same as a donut; `bars` or `stacked` for a metric), `metric`, `reading`, `ml`, `split`, `agg`, `range` (or `from` and `to`), `step`, `title` and `theme` (`dark`, the default, or `light`). It is painted by the same panel components as the app, so it looks as the panel does in Toposcope, checked against the share exactly as `/share/v1/series` checks them; a refused param is painted in the frame, not left blank. The frame polls at its bar width, never faster than every 30 seconds.

`embed.js` is a loader, not a renderer: it places the iframe where the tag sits and draws nothing itself. When the frame has said nothing within 5 seconds, it puts one plain line, *Toposcope unreachable*, in an element with class `toposcope-fallback`, styled with zero specificity so the host's own CSS for that class wins; the frame stays, hidden, and takes its place back if Toposcope answers later. Loaded from Toposcope, the loader cannot help when Toposcope is down: it does not load either. It is the same small file for every share, so serve a copy from your own site and name Toposcope on the tag — `<script src="/js/embed.js" data-origin="https://logs.example.com" data-ticket=…>` — and the fallback shows whenever Toposcope is unreachable. A frame that loaded and then loses Toposcope keeps its last paint, muted, and says when it last read. The frame posts `{ type: "toposcope:ready" }`, `toposcope:stale` and `toposcope:expired` to its parent, with no data in them, for a host that wants its own handling.

Framing rules stop framing, not reading: whoever holds a ticket can fetch its numbers. The scope and the limits are the security; `frame_ancestors` keeps Toposcope's panels off pages the operator did not choose. Toposcope itself may frame `/embed`, for that preview; every other Toposcope page refuses to be framed (`frame-ancestors 'none'`).

Answers are kept for a moment: until the panel's next bar starts, or 30 seconds, whichever is sooner, so twenty open consoles showing one panel cost one read. Answers served that way count as `cached` and do not count against the rate.

## The agental shape

agental's admin console stops drawing its own fleet charts: one share, `service:agental` and `fleet_*`, split and narrow by `host` and `pool`, framed by the console's origin. The console's backend mints a ticket per page load and embeds each panel with a script tag.
