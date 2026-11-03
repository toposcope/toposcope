# Sheet

`src/ui/components/ui/sheet.tsx`

A task with more fields than a dialog holds, from an edge.

## Props

- `side` — `top` (modal, centered under the header) | `bottom` (rises over its container; the page above stays live) | `left` | `right`; `label`, `onClose`, `width`.

## Use

- `top`: Invite someone, Make a token. `bottom`: Watch this.

## Do not

- Build another sheet by hand.

## Keys and access

Esc closes. `top`, `left` and `right` are modal dialogs; `bottom` is a region.

## Motion

None.
