# Panel

`src/ui/components/ui/panel.tsx`

One shell for hunt panels and board panels.

## Props

- `Panel` (`lifted`, `highlight`), `PanelHead` (a drag starts on it), `PanelTitle`, `PanelQuery`, `PanelValue`, `PanelArmed` (`name`, `narrow`, `onRemove`, `onCancel`), `panelIconButton`, `panelMenuRow`, `PanelDots`.

## Use

- Head `lg` 30 on `surface-2`: title `sm` semibold sans, what it reads `xs` mono muted, value `xs` mono. Body on `surface-1`, 12px padding; a stat is `display` 34.
- Icon buttons `icon-sm` 22; ⋯ rows `md` 26. Each place keeps its own ⋯ items.
- Counts print through `CountText` / `formatCompactCount` (`4.25K`).

## Do not

- Build a panel head by hand.
- Confirm Remove in a dialog. It arms the head.

## Keys and access

Remove arms the head: "Remove *name*?" · Remove · Cancel. Focus moves to Cancel; Esc cancels. ⋯ menus: ↑ ↓, Enter, Esc.

## Motion

The armed head's fill changes colour only; the menu as Menu.
