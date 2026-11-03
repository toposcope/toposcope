# Tabs

`src/ui/components/workspace-strip.tsx`

The workspace tabs under the header: Search, Follow, Surroundings, Saved, boards.

## Props

- `tabs`, `activeId`, `onSelect`, `onClose`, `onNew`, `onDuplicate`.

## Use

- One tab per workspace. Overflow scrolls; past five a muted count shows.
- The active tab carries the plate underline.

## Do not

- Animate the content when a tab changes. Only the underline moves.

## Keys and access

← → switch tabs when a tab has focus.

## Motion

The plate underline slides to the active tab over `--duration-3`. Content does not animate.
