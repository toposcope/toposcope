# Hunting

This page is about the hunt screen: the window and Live, the volume chart, panels, facet chips, change marks, tabs, and following a row to its surroundings, trace or profile. It is for anyone looking into logs in the app or linking to a hunt. What to type in the search bar is in [Query language](query.md).

## The window and Live

The strip above the chart names the window, `from → to`, then `UTC · span · bar width`. The date is on the stamp when the window is a day or longer, or not today. Pick a quick window (`15m`, `1h`, `4h`, `24h`, `7d`), type any length up to 730 days, or set **From** and **To**. After you zoom or pan a custom window, **Reset** in that strip goes back to the window you started from. Window values are in [Query language](query.md#time-window).

**Live** keeps the window ending now. With a custom window, Live slides it forward, keeping its length.

- New rows and the current bar arrive every 2 seconds.
- The whole hunt is read again every 30 seconds, so the sliding window stays right.
- Extra charts of volume, rate, min, max or sum, and metric charts without label matchers, update every 2 seconds like the volume chart. Count and rate figures come from the volume chart.
- Figures over the whole window refresh on the 30-second pass: Top-N panels (a Top-N of levels can follow the volume chart instead), a window p99 or average, charts that read every row, metric series with label matchers, and pinned attribute chips.
- A panel that missed the last 2-second update shows a muted age, when it was last read.
- Only the tab in front updates: a hunt, or a Follow tab while Live is on. Surroundings and boards do not.
- Panning or selecting on the chart pauses Live.
- A query with a mistake is skipped; the last results stay.

### The event table

The table shows the newest 100 events in the window. Loading more adds older events; the chart and the total stay those of the first read. When nothing matches, the table says so for your query and window (*No events match `q` in the last 1h*), and only says *No events ingested yet* when the instance holds no rows at all. When a read was refused as too large, it says why instead. A busy window can be refused rather than failing.

Stamps in the event table, Surroundings and the row's detail follow the chart's date rule when **Settings** sets them to compact. **Full** always shows `YYYY-MM-DD HH:MM:SS.mmm`. This choice is kept in the browser, not the URL.

## The volume chart

The volume chart counts matching rows per bar. Its controls sit in one header; the legend is under the chart, and a strip under it shows the figure over the whole window. The hunt's total is the sum of the bars.

| Control | Choices |
| --- | --- |
| Split | **Level**, **Service**, **Host**, **None**. Service and host show the 8 largest and `other` |
| Chart | Stacked, grouped, line, area |
| Scale | **Linear**, **Log** |
| Bar width | **Auto**, or a width from `1ms` to `7d` |

A stacked bar is drawn at the scaled total and divided by each series' share, so on a log scale it is the log of the sum, never a sum of logs. Columns have 1px between them and no gap inside a stack.

### Bar width

**Auto** picks the finest width that draws at most 200 bars. The chip shows it, as in `Auto · 1m`.

| Window | Auto bar width |
| --- | --- |
| 15m | `10s` |
| 1h | `1m` |
| 4h | `5m` |
| 24h | `15m` |
| 7d | `1h` |
| 30d | `4h` |
| 365d and 730d | `7d` |

The widths are `1ms`, `10ms`, `100ms`, `1s`, `10s`, `1m`, `5m`, `15m`, `1h`, `4h`, `1d` and `7d`. A width that would draw more than 500 bars is disabled. One bar is allowed at `1ms`, or when the width equals the window. A width you picked that the window cannot draw is replaced and marked, as in `15m*`.

### Zoom, pan and select

- The wheel, or `+` and `−`, zooms about the pointer, from a 1ms window up to 730 days. `1ms` is both the finest bar and the tightest window.
- Dragging the chart pans; the span stays the same, and the axis follows so bars and times line up.
- Shift+drag selects a span, at least 1ms.
- A thin strip above the chart drills: hover previews it, a click drills to the next span on the zoom ladder around that bar, and a drag sweeps a span and pins it.
- A plain click on the bars does nothing.
- Zooming, panning, drilling, selecting and peeking at a mark keep **To** at now when it was now. A future **To** can still be typed in **From**/**To**.
- The wheel zooms over the marks rail too.

### Keyboard

These keys work when the chart has focus. The wheel zooms without focus.

| Key | Action |
| --- | --- |
| `←` / `→` | Pan one bar |
| Shift+`←` / Shift+`→` | Pan one window |
| `+` / `−` | Zoom in / out |

### Axis times

Ticks read `HH:MM`. They add seconds (`HH:MM:SS`) when the window is under 15 minutes or the bar under a minute, and milliseconds (`HH:MM:SS.mmm`) when the bar is under a second or the window is a second or less. They show the date (`MM-DD`) when the window is a day or longer, is not today, or crosses midnight.

## Derived series and metrics

A volume chart can carry a second series, read from the same rows or from ingested metrics. It is set beside the query, never inside it, and is never PromQL.

| URL | Series |
| --- | --- |
| `agg=rate` | Rows per second: each bar's count divided by its width |
| `agg=p99:duration_ms` | p99 of a numeric attribute per bar; also `avg`, `min`, `max`, `sum` |
| `metric=cpu_seconds` | An ingested metric: a gauge as an average, a counter as a sum, per bar |
| `metric=p99:http.server.request.duration` | One reading of a histogram metric: `count`, `sum`, `avg`, `p50`, `p90` or `p99` |
| `ml=service:api` | Narrows a metric by label equality, up to 4 matchers |

- The series is drawn over the counts, or replaces them as the Y axis (`y=agg`).
- The figure under the chart is over the whole window: a window p99 is the p99 of every row, not an average of bar p99s.
- A bar with no rows has no value; it is left out, not drawn as 0.
- The query does not filter a metric series, and one chart takes `agg` or `metric`, not both.
- A key whose role is lookup or ignore is refused: *p99/avg need a numeric field*.
- A read too large is refused, never a partial p99: *p99/avg over this query exceeds the scan budget*. Live reads these on the 30-second pass.

### The Series picker

The **Series** picker lists numeric attributes in the window (`duration_ms` first, up to 8, and the one in the URL), **Rate**, then metric names seen in the window (up to 8, and the one in the URL; the query does not narrow them). A quiet window still offers `duration_ms`.

**Graph** on a linked field in a row's detail sets `metric=` and `ml=` from that field's link (the mapped label and this value). It does not add the value to the query.

Probes are the ingested metric `up`: draw one with `metric=up`, narrowed with `ml=service:billing`. A missing bar is not a 0; `up=0` has to be posted or pulled. See [Probes / liveness](ingest.md#probes--liveness).

### Saving and alerting

A saved hunt keeps its `agg` and its panel layout, metric and labels included, so it opens as you left it. An alert on a saved hunt watches its log series: the count when there is no `agg`, otherwise the window figure. A refused read or a key that is not numeric does not fire. Alerts on a metric threshold are not supported.

## Panels on a hunt

Beside the volume chart a hunt can hold extra panels, up to 6 in all with the chart (ids `a` to `f`): a stat, a Top-N, and more charts. **Logs off** hides the event table.

- The volume chart sits at the top left. It resizes, but does not move, close or duplicate.
- A panel moves by its head and resizes from any edge. It lands in the columns it is dropped on, panels in its way move down while you drag, and every panel floats up so no hole is left.
- The left and top edges move the border with the panels touching it, or shrink the panel when none do. The right and bottom edges push.
- A panel is at most 16 rows tall.
- Any panel can carry a note of up to 160 characters: **Add note** on its **⋯** menu.
- Every chart shares one hover line: the moment under the pointer is drawn on all of them, led by the volume chart. Extra charts draw the window's change marks as ◆ on a dashed tick, named on hover.

### Top-N panels

A Top-N panel counts rows per value of `level`, `service`, `host` or an attribute key such as `status` or `path`. It shows counts, not averages or maxima. It reads the full query, unlike the facet chips, which leave out their own field.

- Clicking a row offers **Filter** and **Exclude**; it does not change the query by itself.
- **%** shows each row as a share of the window total. It changes the view only.
- **N** caps the named rows: 5, 10, 20, or **Custom** from 1 to 50; 10 by default. `other` is the remainder, shown only when N cuts the list.

The attribute pickers for Top-N and facets leave out keys whose role is lookup or ignore.

### Export

Every panel exports what it draws as CSV, JSON, SVG or PNG. Extra panels also have **Copy**, which puts the same data on the clipboard. The event table's footer exports the loaded events.

## Facet chips

One row of chips sits under the chart: level, service and host, then the window's loudest exception fingerprints as `e1:<hex>`, then the attribute keys you pinned with **+ facet** (up to 8).

- A click adds or removes that value in the field's OR group, as `(level:error OR level:fatal)`. Typing a group of that shape ticks the same chips.
- Once the query names a value of a field, that chip is filled and the field's other values show a dashed `+`. Their counts leave the field's own filter out, so they say what adding them would bring. The tooltip shows the query a click runs.
- **only** keeps one value; **clear** removes the field. The `+` in a row's detail adds the value to the group rather than replacing it.
- Typing in a pinned group narrows its values by prefix.
- With Live on, pinned attribute values refresh every 30 seconds, and when the query, window or pins change.

When nothing matches, the chips give way to the empty state. For each field the query names, it lists the field's other values with counts (*Other levels: warn 945 · info 2.22K*). A click swaps that value.

## Change marks and Compare

Change marks (deploy, flag, incident, note) are recorded beside the logs, not in them; they are not query terms. Sending them is in [Ingest](ingest.md#change-marks). A hunt or Follow tab draws them as named chips on a rail above the volume chart; extra panels, Surroundings and boards have no rail.

- A mark shows its name where there is room, else its glyph and time. Close marks fold into one chip with a count.
- The rail takes no room when there is nothing to draw: no mark in the window, none before or after to step to, no monitor stretch.
- A chip selects its mark and opens **Compare** in a fold under it. `mark=<id>` in the URL opens with that fold open.
- **marks · N** opens the marks panel: the day's marks with **Compare**, **Fingerprints**, **Focus in logs** and **Hide**, and a form to add a note.
- Selecting or hiding a mark does not change the query.

Compare reads the same query and windows. With Split on host, service or level it shows one row per series (the 8 largest and `other`); with None, one row. **Focus in logs** opens Surroundings titled with the mark: 50 older events above it, 50 newer below. The hunt tab stays.

## Workspace tabs

Each tab is one line of investigation: **New**, **Duplicate**, Surroundings, Follow, and saved hunts or boards you open. There is no limit; tabs that overflow scroll, and past 5 a muted count shows. Tabs last for the session and are not in the URL.

Switching back to a hunt or Follow tab shows its last results when its hunt has not changed. Copy link copies the tab in front.

## Surroundings

**Surroundings**, in the footer of a row's detail, opens a reader tab around that row, so your hunt is not thrown away. **Fields** and **JSON** stay the detail's only tabs. A saved hunt stays live in the reader.

- **All** shows N rows either side from the same service, and the same host when the row has one.
- **Matching** also applies the hunt's query.
- **Earlier** and **Later** add 50 rows, up to 200.
- Clicking a row selects it; **Surroundings** in its footer re-centres the tab on it.

## Follow this value

**Follow this value**, on a lookup or id-like field in a row's detail, opens a new Follow tab and leaves the hunt as it was. Its query is that `key:value` alone, without the service or host. Its window runs from the value's first to its last row within 24 hours either side of the event. When the value was seen once, or that read is refused, the window is 5 minutes either side.

## Traces and profiles

**View trace**, in the same footer, opens the trace as a waterfall tab on the Results strip. It shows only when one of the row's trace id fields holds a 32-hex OpenTelemetry trace id; a `req-…` id is Follow only. It does not change the query. The strip holds up to 5 trace and profile tabs.

- A clicked span is read in the side rail: where it entered, its exception, the span, then the resource, with **JSON** and **Copy**.
- On an instance with [links](links.md), the waterfall draws spans from every source in one tree with an **Entered at** column and a chip per source, caught up or short.
- While a source is short inside the trace, one amber line names it and a hatched row stands for its missing span.

**View profiles**, in a span's footer, opens an icicle tab for the profiles linked to that exact span. It is empty when nothing is linked yet. It names where the profile entered. While the span's source has been read only to before the span ended and no profile is here, it says the profile is not here yet.

Close a trace or profile tab with its ×, or go back with **Results** or **Surroundings**.

## The page URL

The hunt is kept in the page URL, so a copied link opens the same hunt.

| Parameter | Value |
| --- | --- |
| `q` | The query |
| `range` | A window ending now: `15m`, `1h`, `4h`, `24h`, `7d`, or any length up to 730 days (`90m`, `30d`, `2w`, `1w`); `custom` with `from` and `to` |
| `from`, `to` | ISO times for a custom window |
| `live=1` | Live on |
| `saved=<id>` | The saved hunt this is |
| `view=alerts`, `view=fields` | Which view the page opens on |
| `split` | Chart split: `level`, `service`, `host`, `none` |
| `chart` | Chart type |
| `scale=log` | Log scale |
| `step` | Bar width; left out for Auto |
| `agg`, `y=agg` | A series from the logs, drawn over the counts or as the Y axis |
| `metric`, `ml` | An ingested metric and its label matchers |
| `logs=0` | Logs off |
| `w` | The panel grid; left out for the volume chart alone. `a` is the volume chart and comes back if a link drops it |
| `.pct`, `.n20` | In a Top-N's entry in `w`: % on, and N (left out when N is 10) |
| `af` | Pinned attribute chips; left out when none |
| `mark=<id>` | Opens with that mark's Compare fold |

A board's copy link is the same URL plus the board's slot keys, such as `saved=s7&install_name=acme-eu&range=4h`. Those keys count only for that saved board's own keys. Field roles and links are kept on the instance (**Settings** → **Fields**), not in the URL.

## Boards

A board is a page of panels, each a copy of a hunt panel with its own query and, optionally, its own window. Up to 4 inputs narrow every panel at once; section headings and notes read no rows. Its panels use the same grid, moves and resizing as a hunt, its time charts share the hover line and draw change marks, and it does not update with Live. Sharing panels outside the app is in [Shares](shares.md).
