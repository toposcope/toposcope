# Chip

`src/ui/components/ui/chip.tsx`

A facet value or a toggle that writes `q`.

## Props

- `size` — `xs` | `sm` | `md` | `lg`. Default `sm` 22; facet values use `md` 26.
- `aria-pressed` — on or off.
- Everything a `<button>` takes.

## Use

- A value and its count: the count is part of the name (`error 4.25K`).
- A level chip may carry the level colour on its border.

## Do not

- Use a Chip for an action. That is Button.
- Animate a count. Counts swap in place.

## Keys and access

Enter, Space. `aria-pressed` says on or off.

## Motion

Colour only. Counts swap in place.
