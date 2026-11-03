# LiveAge

`src/ui/components/ui/states.tsx`

How old a Live paint is.

## Props

- `fetchedAt` (a time or a function), `cadence` (`2s`, `30s` — for the hover), `paused`, `minAgeMs` (default 3s: shown after a missed 2s poll; the facet row passes 0), `tip(label)`.

## Use

- The facet row, extra panels and board panels. Muted; plate past 35s.

## Do not

- Show it outside Live.
- Dim or skeleton a Live paint instead.

## Keys and access

`aria-label` carries the hover text; the tooltip names the cadence.

## Motion

None: the number changes in place.
