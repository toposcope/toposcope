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

Where an issue and its sheet differ, the issue wins.

Not the shipped app. Do not invent chrome these files do not draw.
