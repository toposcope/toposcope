# Armed

`src/ui/components/ui/armed.tsx`

An in-place confirm, never a dialog.

## Props

- `armed`, `onArm`, `onDisarm`, `onConfirm`, `label` (revoke), `confirm` (sure? revoke), `form` — `text` (in a row) | `button` (outline Button), `title`, `className`.

## Use

- Revoke on Access, People, a share, a link; forget a browser; remove a share's panel. A panel's Remove uses `PanelArmed`.

## Do not

- Open a dialog to ask "are you sure".
- Change the words between places: the label is the verb, the armed words start with "sure?".

## Keys and access

The first click arms it and focus moves to it; the second does it; Esc disarms.

## Motion

Colour only.
