# Command palette

`src/ui/components/command-palette.tsx`

⌘K or Ctrl K on any page: go somewhere or do what a control already does.

## Props

- `open`, `onOpenChange`, `items` (`group`, `label`, `detail`, `run`), `onHunt(q)`.

## Use

- Groups in order: Saved hunts, Boards, Go to, Actions. Typing filters names and queries.
- Text like `key:value` puts **Hunt for** first; any other text puts it last.

## Do not

- Add a verb that is not a control somewhere else, or a shortcut the app does not have.

## Keys and access

⌘K / Ctrl K toggles; ↑ ↓ move; ↵ runs; Esc closes and focus returns. `role="dialog"`; the input is a `combobox` over a `listbox` with `aria-activedescendant`.

## Motion

Fades and scales from 0.97 over `--duration-2`.
