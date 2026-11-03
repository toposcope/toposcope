# Busy

`src/ui/components/ui/states.tsx`

A request in flight: a pill with the elapsed time and Stop, and the 2px bar under the field.

## Props

- `Busy`: `label` (default `Searching`), `elapsedMs`, `slow` (default: past 5s), `hint` (default `narrow the window or add a service: filter`), `onStop`, `size`.
- `BusyBar`: the 2px bar; its parent is `relative`.
- `busyDim`: the classes for the last paint while busy (50%, no pointer).

## Use

- The hunt's search and the Fields catalog. One hint, warn, past 5s.

## Do not

- Show Busy on a Live poll.
- Dim at another opacity.

## Keys and access

`role="status"`; Stop is a button.

## Motion

The bar runs; reduced motion holds it still. The spinner slows under reduced motion.
