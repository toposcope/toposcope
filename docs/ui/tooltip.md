# Tooltip

`src/ui/components/ui/tooltip.tsx`

A short name for an icon or a fact behind a value.

## Props

- `Tooltip`, `TooltipTrigger asChild`, `TooltipContent` (`side`, `align`). The provider's delay is 400ms (`tooltipDelayMs`).

## Use

- Every icon-only button has one, plus `aria-label`.
- Live ages name their cadence in theirs.

## Do not

- Set a delay of your own.
- Put an action or anything needed to finish a task in a tooltip.

## Keys and access

Opens on hover or focus after 400ms; Esc closes.

## Motion

Fades and scales from 0.97 over `--duration-2`.
