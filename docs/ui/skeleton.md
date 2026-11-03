# Skeleton

`src/ui/components/ui/states.tsx`

An empty first paint only.

## Props

- `kind` — `rows` (with `rows`, `cells(i)` widths, `rowClassName`, `rowStyle`) | `bars` | `block` (with `className`).

## Use

- The event table, Fields, a chart, a top-N list or a stat before anything has painted.

## Do not

- Show a Skeleton on a re-query or a Live poll. Those keep the last paint (dimmed for a re-query, not for a poll).

## Keys and access

`aria-hidden`; the region's Busy or heading says what is loading.

## Motion

Pulses; reduced motion stops it.
