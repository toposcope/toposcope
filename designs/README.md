# designs

Locked chrome. Open the `.dc.html` files locally (they need `support.js` beside them). GitHub will not run the mock.

- [Toposcope App.dc.html](Toposcope%20App.dc.html) — hunt, with change marks, the fingerprint cut stack, and compare vs a mark: inspect → Fingerprints and/or Compare; Filter writes `e1:<hex>`; Compare unfolds a 30px fold under the lane
- [Toposcope Marks.dc.html](Toposcope%20Marks.dc.html) — marks frames 1a–1k · in-list frames 2a–2h
- [Toposcope Brand.dc.html](Toposcope%20Brand.dc.html) — Fault lockup
- [marks/](marks/) — crops of the Marks sheet for issues (1a–1k · 2a–2h)

Locked — compare vs a mark:

- [Toposcope Compare.dc.html](Toposcope%20Compare.dc.html) — frames 3a–3j: inspector verb, fold under the lane, fingerprint as series, near now, zeros, Live freeze, crowded with the cut, anatomy, placement rejects, product rejects
- [Toposcope Compare Split.dc.html](Toposcope%20Compare%20Split.dc.html) — frames 4a–4j: the fold stacks one 30px row per key of the hunt’s existing histogram split (`level` | `service` | `host` | `none`); `none` is today’s single row; cap 8 + `other`; no second picker
- [compare/](compare/) — crops of the Compare family for issues (3a–3j · 4a–4j)

Locked — fingerprints after a mark:

- [Toposcope Cut.dc.html](Toposcope%20Cut.dc.html) — frames 1a–1i: entry, the three sets (first seen / still here / stopped), opening one e1, mark near now, incident band, overflow, empty, row anatomy, rejected shapes
- [Toposcope Cut Rail.dc.html](Toposcope%20Cut%20Rail.dc.html) — frames 2a–2g: the rail is a stack (cut is the base; a selected line pushes its detail with a crumb back; two ×; trace-strip and Live; rejects)
- [cut/](cut/) — crops of Cut + Cut Rail for issues (1a–1i · 2a–2g)

Locked — picking a metric:

- [Toposcope Metrics.dc.html](Toposcope%20Metrics.dc.html) — frames 11a–11n: the Series control becomes a list you can type into, on the pinned toolbar, a timeseries footer and a Stat head; each metric says its kind in a word; a histogram’s reading sits where a log field’s reducer sits; crowded toolbar, long names, no points, Live, the readout, rejects, anatomy
- [metrics/](metrics/) — crops of the Metrics sheet for issues (11a–11n)

Where [#77](https://github.com/toposcope/toposcope/issues/77) and [#78](https://github.com/toposcope/toposcope/issues/78) differ from the Metrics sheet, the issues win: a picked metric is listed once, “no points in this window” is said under the plot, and `sum` is one more reading of a histogram.

Locked — the operator cut (0.5.x, [#102](https://github.com/toposcope/toposcope/issues/102)–[#111](https://github.com/toposcope/toposcope/issues/111)). Each frame was one artboard of a Design canvas, approved 2026-10-16; a sheet stacks them in canvas order:

- [Toposcope Arriving.dc.html](Toposcope%20Arriving.dc.html) — frames 12a–12l: a sign-in page that names the instance (named, unnamed, wrong password, phone width), two instances in two tabs, the name in the header and Sign out from it ([#102](https://github.com/toposcope/toposcope/issues/102)); marking a saved search Home, landing on it, from Home to every row and back, no Home set ([#109](https://github.com/toposcope/toposcope/issues/109)); rejects
- [arriving/](arriving/) — crops for issues (12a–12l)
- [Toposcope Panels.dc.html](Toposcope%20Panels.dc.html) — frames 13a–13k ([#104](https://github.com/toposcope/toposcope/issues/104)): a saved search of metric panels split by one label, with units; no sidebar count without log rows; panels told apart by their labels at 6 and 4 columns; a long name; hover on one line and on a split; choosing a split; 11 values as 8 and `other`; units on a gauge, a counter, a histogram, none, and a Stat; Live; no points; rejects
- [panels/](panels/) — crops for issues (13a–13k)
- [Toposcope Story.dc.html](Toposcope%20Story.dc.html) — frames 14a–14l: Follow opens on first to last seen, ±5m when seen once or too large a read, and after the clock is changed ([#103](https://github.com/toposcope/toposcope/issues/103)); a span's details in the right rail at 1440 and 1024 wide, a 40-line stack, no exception, JSON and Copy, from the span to the log row and back ([#106](https://github.com/toposcope/toposcope/issues/106)); rejects
- [story/](story/) — crops for issues (14a–14l)
- [Toposcope Fingerprints Alert.dc.html](Toposcope%20Fingerprints%20Alert.dc.html) — frames 15a–15l: the cut 18 minutes, 2 hours and 3 minutes after a deploy, and later deploys named inside the after side ([#111](https://github.com/toposcope/toposcope/issues/111)); the alert dialog's two kinds and the Alerts list with both ([#107](https://github.com/toposcope/toposcope/issues/107)); a webhook body as text or JSON with fill-ins, one that does not parse, a test call, Pushover, ntfy and a Slack URL ([#108](https://github.com/toposcope/toposcope/issues/108)); rejects
- [fingerprints-alert/](fingerprints-alert/) — crops for issues (15a–15l)

Locked — links (0.5.x, [#133](https://github.com/toposcope/toposcope/issues/133)–[#142](https://github.com/toposcope/toposcope/issues/142)), 2026-10-07. Two single-file exports: open them directly, they need nothing beside them.

- [Toposcope Links.html](Toposcope%20Links.html) — frames 6a–10a: Links as a fourth view, empty and in both directions, removing a link, thirty links; offering rows and inviting a source, each key shown once; pasting a key, the preview before confirm, keys that will not work; the instance name in Settings; pasting before the instance has a name ([#136](https://github.com/toposcope/toposcope/issues/136), [#137](https://github.com/toposcope/toposcope/issues/137))
- [links/](links/) — crops for issues (6a–10a)
- [Toposcope Links Held.html](Toposcope%20Links%20Held.html) — frames 5a–5r: what Search says an instance holds once rows are pulled: no links, a source caught up, behind, not answering, a hole, an errors-only instance, thirty sources, Live, narrowed to one source, every count a short source could feed as a floor, mixed sources, a sidebar that already leads ([#139](https://github.com/toposcope/toposcope/issues/139)); Fingerprints and Compare refusing across a gap ([#140](https://github.com/toposcope/toposcope/issues/140)), then judging with floors ([#141](https://github.com/toposcope/toposcope/issues/141)); rejects
- [links-held/](links-held/) — crops for issues (5a–5r)

Approved — the Saved list, 2026-10-18. Not in a cut yet; no issue yet.

- [Toposcope Saved.dc.html](Toposcope%20Saved.dc.html) — frames 16a–16n: the sidebar's Saved list with 22 names that share their first words, as it reads today and grouped by the words before a colon; groups closed; a filter by name, one with no match, and buttons for one kind; the card on hover or focus with the whole name; a long name; the busiest row; a board, a search kept for its panels and a plain one; three saved searches; widened to 360 px; 50 on a board at 1280 × 800; rejects
- [saved/](saved/) — crops for issues (16a–16n)

Approved — panel lines, 2026-10-18. Not in a cut yet; no issue yet.

- [Toposcope Panel Lines.dc.html](Toposcope%20Panel%20Lines.dc.html) — frames 17a–17j: a board of six one-metric panels as it reads today, then the same as three panels: up to four metrics of one unit merged onto one axis, each line named, a title and a note on each panel; adding a line, with only the panel's unit offered; naming lines, a title, a note, a full note; another unit refused, and a unit that changes later; the sender's OTLP descriptions in the picker, on a line's hover and in place of a missing note; the readout with names; at 4 columns; a split whose values are named; rejects
- [panel-lines/](panel-lines/) — crops for issues (17a–17j)

Locked — monitors (0.6, [#175](https://github.com/toposcope/toposcope/issues/175)–[#180](https://github.com/toposcope/toposcope/issues/180)), 2026-10-20. Each frame was one artboard of a Design canvas; the sheet stacks the picked ones:

- [Toposcope Liveness.dc.html](Toposcope%20Liveness.dc.html) — frames 18c–18y: Watch, every monitor on one clock with open ones first; push monitors over 7 days, each result a tick and each run a bar; a monitor opened as a hunt; an open stretch as a band on the hunt clock beside the deploy before it; a new monitor choosing where its results come from; a saved-search monitor, at least or fewer than; HTTP(S) conditions picked from the live response and stored as lines; a push monitor and the three ways a script reports to it; the resolved body, left empty (no resolved call is sent) and written for ntfy; an HTTP(S) monitor's request headers and POST body; the default webhook in Settings; the TCP · certificate editor and Watch's TCP and Certificate filters
- [liveness/](liveness/) — crops for issues (18c 18f 18i 18o 18p 18j 18r 18s 18t 18u 18v 18w 18x 18y)

Locked — upgrades (0.6.1, [#195](https://github.com/toposcope/toposcope/issues/195)–[#199](https://github.com/toposcope/toposcope/issues/199), [#201](https://github.com/toposcope/toposcope/issues/201)), 2026-10-20.

- [Toposcope Upgrades.dc.html](Toposcope%20Upgrades.dc.html) — frames 19a–19j: the running version in the footer, up to date and behind; its panel with Before you upgrade first, what's new, the backup size and the command; an amber dot for a release in between that asks for a step; three releases behind; the command copied; could not check and the check off; the same as a Settings tab; a narrow window; rejects
- [upgrades/](upgrades/) — crops for issues (19a–19j)

Picked — Watch's marks lane when deploys crowd, 2026-10-21: option A (20b, 20c, 20f).

- [Toposcope Watch Marks.dc.html](Toposcope%20Watch%20Marks.dc.html) — frames 20a–20g: 43 deploys in a day as 0.6.1 draws them; A, Search's counted chips on Watch with the wash up through the monitor rows; a chip hovered and its list pinned; B, triangles only; C, a name only where it fits; A on a quiet day and at 7d and 30d, where a chip is a tick's worth of marks; rejects
- [watch-marks/](watch-marks/) — crops for issues (20a–20g)

Locked — metrics retention (0.6.x), 2026-10-23:

- [Toposcope Metrics Retention.dc.html](Toposcope%20Metrics%20Retention.dc.html) — frames 21a–21c: Settings gains Metrics retention days under Retention days; empty follows logs and says so; saved at 400 with one toast naming both; out of range refused
- [metrics-retention/](metrics-retention/) — crops for issues (21a–21c)

Locked — the version popover (0.6.x), 2026-10-23:

- [Toposcope Check Now.dc.html](Toposcope%20Check%20Now.dc.html) — frames 22a–22d: Check now on the popover's status line; checking; a check that finds a release; a check that fails · frames 22e–22j: upgrade from here, off by default and how to turn it on; on; confirm in the box; upgrading with the host's log; upgraded; failed and back on the old version
- [check-now/](check-now/) — crops for issues (22a–22j)

Locked — shares (0.7.0), 2026-10-23:

- [Toposcope Shares.dc.html](Toposcope%20Shares.dc.html) — frames 23a–23f, 23l: one panel embedded in another app's page (line, split, stale, ticket expired, refused, empty) and the script tag's fallback in the host page · frames 23g–23k: Settings → Shares (list, create, secret shown once, revoke in the row) and Copy embed on a panel
- [shares/](shares/) — crops for issues (23a–23l)

Locked — charts, and share from a panel (0.7.1), 2026-10-24:

- [Toposcope Share From A Panel.dc.html](Toposcope%20Share%20From%20A%20Panel.dc.html) — frames 24a–24e: Share… on a panel, the scope proposed from it, a new share inline, the code in three steps with a live preview, added to an existing share · frames 24f–24h: a panel that cannot be shared as it is, Share panels… on a board, Settings → Shares empty
- [share-from-panel/](share-from-panel/) — crops for issues (24a–24h)
- [Toposcope Charts.dc.html](Toposcope%20Charts.dc.html) — frames 25a–25d: Line · Bars · Stacked on a metric panel, stacked refused for an average · 25e–25g: a histogram metric as a heatmap, with its p99, and among its readings · 25h–25j: Bars · Donut on Top-N, top N + other · 25k: the same charts embedded
- [charts/](charts/) — crops for issues (25a–25k)

Approved — the redesign (0.8, one cut), 2026-10-26. Drawn on the Design canvas "Toposcope reimagined" in three rounds; Ian picked A (one clock) and D (what changed) in round 1, 3f (named panels on a share, with the raw-params switch) over 3e, and approved rounds 2–3 as drawn. The round-1 boards A and D became 26d and 26a and are not exported. Not in a cut yet; drafts in `private/issues/v0.8-redesign/`.

- [Toposcope Redesign.dc.html](Toposcope%20Redesign.dc.html) — frames 26a–26p: Home since a mark (the strip of recent marks is the one control; cards per saved hunt and monitor with before → after on equal windows and a sparkline; new fingerprints and open monitors as cards; saved hunts in a right column), a quiet day (no mark in 24 h: the last hour against the hour before, grey deltas), first run (three steps that become cards); the hunt opened from a card (crumb Home › hunt with the mark carried, the key:value bar, a full-width clock with a named-marks rail, the Compare fold open under the selected mark, facet chips including e1 fingerprints, rows, no sidebar), an event open (a right panel narrows the rows; Fields / JSON / Stack; the fingerprint line with first seen; Live pauses while reading), the marks panel (every mark of the day, kind filters, actions in words, a note form); Watch (every monitor with state, checks, a 24 h strip, last check, value; what opened today; delivery), Watch this (a sheet on the hunt: one-sentence condition, would-have-opened plot, webhooks); Access (ingest tokens, link keys, links and shares in one list: kind in words, scope, expiry, last used, refusals, revoke), Let someone in (three kinds as cards, the link-key form, the secret shown once); a share with named panels and the raw-params switch; Fields; a link's page (direction, scope, position, behind, last pull, rate, gaps as floors); Settings (instance, retention, time, delivery, release, storage); sign in; the twelve principles
- [redesign/](redesign/) — crops for issues (26a–26p)

The sheet carries each artboard's own styles scoped to its frame (`private/tools/canvas-export/merge-scoped.ts`), so it loads Inter and JetBrains Mono from Google Fonts; offline it falls back to system UI and Menlo.

Approved — Fields under Settings, 2026-10-26. Drawn on the Design canvas "Toposcope reimagined" after the redesign shipped; Ian approved both frames as drawn. Part of 0.8.

- [Toposcope Fields In Settings.dc.html](Toposcope%20Fields%20In%20Settings.dc.html) — frames 28a–28b: Settings with a Fields card (keys seen in the last 24 h, roles, new keys with no role chosen, metric links, Open fields →) and no Fields tab in the header; the Fields page under a Settings › Fields crumb, Settings lit, on a fixed last-24 h window with no clock
- [fields-in-settings/](fields-in-settings/) — crops for issues (28a–28b)

Approved — Access is the one door, 2026-10-26. Drawn on the Design canvas "Toposcope reimagined" as round 5; Ian approved both frames as drawn. Part of 0.8.

- [Toposcope Access One Door.dc.html](Toposcope%20Access%20One%20Door.dc.html) — frames 29a–29b: the header without Links (Home · Hunt · Watch, then Access · Settings); Access grouped as Tokens, Links and Shares, each with one line on what it does, plain kinds (token, we copy from, copies from us, key not used yet, share), the filter All · Tokens · Links · Shares, Paste a link key on the Links group; a link's page under an Access › name crumb with Access lit and the direction as a chip
- [access-one-door/](access-one-door/) — crops for issues (29a–29b)

Where an issue and its sheet differ, the issue wins.

Not the shipped app. Do not invent chrome these files do not draw.
