# Dialog

`src/ui/components/ui/dialog.tsx`

A short task that needs the page to wait.

## Props

- `DialogContent` `size` — `sm` 440 | `md` 640 | `lg` 1080. Also `DialogHeader`, `DialogTitle`, `DialogDescription`, `DialogField`, `DialogControl`, `DialogFooter`, `DialogClose`.

## Use

- `sm`: Save hunt, a board's name. `md`: links, shares, Share panels. `lg`: every monitor.
- One footer: right-aligned, Cancel then the one primary. A destructive primary is `destructive`.

## Do not

- Pick a width of your own.
- Put the primary on the left.
- Use a dialog to confirm. That is Armed.

## Keys and access

Esc closes; focus is trapped and returns to the trigger.

## Motion

As Menu.
