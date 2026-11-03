# Input

`src/ui/components/ui/input.tsx`

A one-line field.

## Props

- `size` — `xs` 18 | `sm` 22 | `md` 26 | `lg` 30. Default `md`.
- Everything an `<input>` takes.

## Use

- Dialog fields and toolbars: `md`. The query bar is `lg`.
- A bare `<input>` inside a bordered box (`DialogControl`, `monitorBox`) lets the box show focus with `focus-within:`.

## Do not

- Write a new raw `<input>` with its own height and border. Use Input or a box that owns them.
- Leave `outline-none` without a focus state.

## Keys and access

Focus lifts the border to fg 40% on `focus-visible`. A field's label is a `<label>` or `aria-label`.

## Motion

Colour only, over `--duration-2`.
