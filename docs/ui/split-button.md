# Split button

`src/ui/components/ui/split-button.tsx`

An action and its menu, as one control: Save ▾ on a hunt and a board.

## Props

- `children` — the action's label. `onClick` — the action.
- `menu` — the menu's items (`DropdownMenuItem`s). `menuLabel` — the chevron's accessible name.
- `size` — `xs` | `sm` | `md` | `lg` (default `md`); both halves take it. `variant` — as Button (default `outline`). `disabled` — the action only.

## Use

- One height and one radius: the action keeps the left corners, the chevron the right.
- The chevron opens a menu of the action's relatives (Save as…, Pin to Home, Delete).

## Do not

- Put a different height on either half.
- Put an unrelated verb in the menu.

## Keys and access

The action and the chevron are two tab stops. The menu takes ↑ ↓, Enter and Esc (focus returns to the chevron).

## Motion

As Button; the menu as Menu.
