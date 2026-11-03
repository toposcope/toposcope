# Menu

`src/ui/components/ui/dropdown-menu.tsx`

A list of actions on a control: ⋯ on a panel, Save ▾, a picker.

## Props

- `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent` (`align`, `sideOffset`), `DropdownMenuItem` (`onSelect`, `disabled`).
- A panel's ⋯ uses `panelIconButton` and rows of `panelMenuRow` (`src/ui/components/ui/panel.tsx`).

## Use

- Rows are `md` 26. A destructive row is `text-danger-fg` and last, after a separator.
- A row that opens a second page (Copy…, Export…) ends in `…`.

## Do not

- Put a row's state in a ring. Rows use the control fill.
- Put the same verb in two places on one menu.

## Keys and access

↑ ↓ move, Enter runs, Esc closes and returns focus to the trigger.

## Motion

Fades and scales from 0.97 at its anchor over `--duration-2`.
