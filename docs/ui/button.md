# Button

`src/ui/components/ui/button.tsx`

One action. One primary per surface.

## Props

- `variant` — `default` (primary) | `secondary` | `outline` | `ghost` | `destructive` | `link`. Default `default`.
- `size` — `xs` 18 | `sm` 22 | `md` 26 | `lg` 30, and `icon` 26, `icon-sm` 22. Default `md`.
- `busy` — boolean. Sets `aria-busy`, shows a spinner, swallows clicks, keeps focus.
- `asChild` — render the child (Radix `Slot`) with the button's classes.

## Use

- Toolbars and rows: `md`. Dialog footers and the query bar's neighbours: `lg`. Panel heads: `icon-sm`. In a row next to a badge or count: `xs`.
- A label that changes (Save hunt → Saved) is plain-text children; it fades in and the width eases.
- A destructive primary is `destructive`.

## Do not

- Hand-build a `<button>` with `h-[26px]` and `rounded-[7px]`. Use `size`.
- Set a height in `className` (`h-8`, `h-[30px]`). Pick a size.
- Use Button for on/off. That is Switch or Chip.
- Disable while busy. `busy` keeps focus; `disabled` drops it.

## Keys and access

Enter, Space. Icon-only needs `aria-label` and a Tooltip. Focus is a 1px `--ring` ring on `focus-visible`.

## Motion

Press scales to 0.97 over `--duration-1`. A changed label fades over `--duration-2` while the width eases. Reduced motion: none.
