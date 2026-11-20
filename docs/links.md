# Links

This page is for operators who connect Toposcope instances: how to make a link, what it carries, how the two sides reach each other, and how Search and the other screens show rows that are still on their way.

A link is one instance pulling rows from another. Links chain (edge → region → centre), and a source behind NAT can feed an instance it can reach with no inbound port.

## Make a link

Links are made from **Access › Let someone in › Link** and listed under **Links** on Access, with **Paste a link key** on that group. The instance the other can reach mints a key; the other pastes it, and the side that pasted connects.

| Key | Made with | Who pastes it, and what it does |
| --- | --- | --- |
| Offer | **Offer rows from here** | A single-use key for one filter: whoever pastes it pulls the rows that match |
| Invite | **Invite a source here** | Lets this instance pull from whoever pastes it, once, or for many until a date (30 days at most) |

A key carries this instance's address, its name, a short id, the filter, the kinds and a secret. It starts `tsl2_`, is shown once and is stored hashed. A `tsl1_` key, made before 0.10, is refused at paste: mint a new one on the other side.

On the first paste the two instances swap the key for a secret of their own, and that secret reads the link's feed and nothing else.

### The Links list

| A link reads | When |
| --- | --- |
| *we copy from* | This instance pulls it |
| *copies from us* | The other side pulls it |
| *key not used yet* | The key has not been pasted |

The list also says who connects, "we call them" or "they call us". A quiet link reads "not answering since" or "has not called since" to match.

## A link's page

Each link has a page, from its Access row (**Access › its name**). It shows:

- which way rows move, its scope, its position and how far behind it is;
- its last pull, and its rate over a day, with any gap drawn as a floor;
- **Pause**: the link and its place stay; nothing is pulled or served;
- **Change scope**, where rows leave this instance.

It draws a line per kind on the link's one position: caught up, behind, a hole, not sent and why, paused, or unticked at the source. Each line has its rows and bytes over the last day, counted on the side that moved them. Both sides see the counts, so the side rows leave from can untick a kind that costs too much.

## What a link carries

A link carries every kind: logs, change marks, traces (spans), metrics (points and histogram buckets), profiles and monitors. **Let someone in › Link** has a box per kind, all ticked by default, and says before the key is made which kinds its scope cannot send and why.

The side rows leave from decides the set. The side that pastes sees it and cannot widen it. On that side, **Change scope** can untick a kind but never add one: to send a kind the key left out, make a new key. A refused change saves nothing, and unticking keeps the link and its place.

### How the filter applies to each kind

The filter runs on each kind by the fields it has. An empty filter sends every kind whole.

| Kind | What `service`, `host`, `toposcope` and other `key:value` match |
| --- | --- |
| Logs | The rows that match the filter |
| Spans | `service`, the `host.name` attribute, the span's attributes |
| Metric points and buckets | Their `service` and `host` labels, then any label |
| Monitors | Service, host and `toposcope` only |
| Profiles | A profile goes when the span it belongs to went, in this range or before. One with no span goes by `service` alone, and not when the filter names anything else |
| Change marks | See [Change marks from a source](#change-marks-from-a-source) |

A filter that names a field a kind lacks sends none of that kind, and the link's page says why. `level` and words in the message rule out spans, metrics, profiles and monitors; any other key rules out monitors.

## Reaching the other instance

The address in a key is `TOPOSCOPE_PUBLIC_URL` when it is set, else the address the browser opened. The other instance has to reach `/link/v1/` there: behind a reverse proxy, forward it like the rest of the app.

Those routes do not take a person's sign-in; each proves a key's or a link's secret. No one's sign-in travels between instances.

### A source behind NAT

The side that pasted connects. An invite is pasted by the source, so a source behind NAT (a customer site, a laptop) feeds a reachable instance with no inbound port. It calls out every 5 seconds, asks where the puller stands, reads its own rows from there and hands them over.

It is still a pull: the puller keeps the position and the source's own store is the buffer, so a dropped connection resumes where it stopped. Both sides behind NAT is for the operator's VPN; Toposcope runs no relay.

### Both sides on the same version

Both sides of a link must speak the same link protocol and schema. A side that speaks another answers 409. The link then stops where it stands and names the side to upgrade ("edge-1 is on 0.11.0, this instance on 0.12.0: upgrade edge-1.").

No row is stored while they differ, and the link carries on from its place once they match. There is no conversion between versions.

## Pulling and positions

The puller asks every 5 seconds for what arrived after where it stands. It stores the rows as they were, keeping the source's `e1` fingerprints and its `toposcope` name, and keeps its position, so a restart of either side picks up where it stopped.

- A row is never stored twice: across retries, links with overlapping filters, or a row that left and came back.
- Pulled rows follow this instance's retention.
- Removing a link stops it and deletes nothing.

## Chains

Links chain: edge → region → centre. A pulled row of any kind takes a position here and keeps where it first entered. So an instance that pulls can be pulled from, and the centre shows the edge's rows under the edge's name, never the region's. A row is stored once however it comes, two ways included (an edge linked to both the region and the centre).

A source short two hops away is short at the centre too. Each feed reply says where the source's own sources stand, as its Search would tell them, and the centre adds that to its own link.

While the edge is behind at the region, or the region has not reached it, the centre's tells name the edge: behind, or not answering since when. Its held group adds "through region", and its link opens the region's link. A source's own sources that a link's filter rules out by `toposcope` are not told.

A direct link that takes every row speaks for its source alone, so an edge also linked straight to the centre is short there only when that link is.

The region's link from the edge says how far behind it is in time. Its link to the centre, and the centre's link from the region, list the sources further away with where each stands.

## Monitors from a source

A source's monitors show on Watch at the collecting instance, read-only, under the source's name. Their results travel as a kind. Once a link has caught up, each reply also carries the monitors the filter lets through, with their stretches open now or resolved within 30 days, and the monitors that came to it over its own links.

Watch groups Here and one group per source, with how far the source is read and a link to its link's page. A short source's lanes are hatched, never green. A source's monitor opens with its definition, results and stretches, and no Edit, Pause, Silence or Delete. Nothing is judged or called again at the collecting instance.

## Change marks from a source

Change marks come with a link, so Fingerprints and Compare at the collecting instance have the source's deploys to cut against.

A mark is not a log line, so a filter like `level:error` does not apply to it. A link brings every mark whose `service` its filter does not rule out by a plain mismatch.

- A pulled mark keeps its kind, service, title and attributes.
- Its id gains the instance it was posted at: `deploy-api-v1.4@edge-fra`. Two sources that both post `deploy-api-v1.4` stay two marks on the lane, each cutting its own window.
- An incident the source closes later closes here too.
- A pulled mark is not edited or deleted here, and nothing is written back to the source.
- Marks posted before 0.5.5 stay where they were posted.

## What Search shows from linked sources

Search says what this instance holds. An instance that pulls from no one shows none of what follows.

Once anything is linked, a `from <instance>` chip group leads the slice under the plot: each source as named on its side, with its count in the hunt. Ticking a source writes `toposcope:<name>` in the bar, as ticking a level does. The link's page says its filter and where it stands: behind and read to when, not answering (or not called) since when, or a hole, closed at both ends.

### Counts from a short source

Under 30 seconds behind reads as caught up. While a source is short inside the window, every count it could feed is a floor (`≥`):

- the strip, with one pill naming the source;
- the table footer, the facets, Stat counts and Top-N bars;
- saved-search badges over their own spans.

The plot hatches the span its rows are not here for, and the table has one hatched row at its read position.

A count stays plain when the hunt names other sources (`toposcope:prod-us`), or when the short source's filter rules it out by a plain `key:value` mismatch. A percentile, rate or average keeps its number and says it is over what is here. When part of a count came through a link's filter that the hunt does not already imply, a grey scope beside it says so.

### Fingerprints and Compare across a gap

Fingerprints and Compare judge across a gap with floors. While a source that could feed the hunt is short inside either window, the cut keeps its three sets, counted by source on both sides:

| A line | Is filed |
| --- | --- |
| No short source fed it | As ever |
| Also fed by a caught-up source | As its counts read, with the short side's count a floor and a note that it is partly from the short source |
| Every row came from a short source | As can't tell, reading `131 → ?` or `? → 64`: never stopped, never first seen |

The head note says where the source stands and which side misses its rows. The Compare fold keeps each short side as a floor and shows no delta and no percent. Both are frozen at open: close and reopen once the source has caught up. A new-fingerprints alert pages only what it can tell is new.

## Traces, metrics and profiles from linked sources

The other kinds say the same on their own screens.

- A trace's waterfall names where each span entered. While a source is short inside the trace, one amber line names it and its missing span is a hatched row.
- A metric panel hatches a short source's span with a pill naming it. A sum or count Stat reads `≥`, and an average or percentile is named partial.
- A profile names where it entered, and says when its profile is not here yet.

### A metric in two units

A name whose points came in two units or kinds is split, never summed, and the panel says so ("two units: ms (edge-1), s (here)"). Its lines share one plot, each on its own unit's scale, with each unit's peak on the axis in its line's colour.

When one source changed unit at a deploy, the old line ends and the new one starts at the deploy's mark ("two units: ms until ▲ api v2.0, s after"). Hunt's pinned plot draws and says it the same way.
