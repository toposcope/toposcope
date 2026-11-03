/**
 * Motion is for controls only (sheet 45): press over `--duration-1`, colour and fades over
 * `--duration-2`, position over `--duration-3`, one curve. Reduced motion sets all three to 0.
 * Data never moves: bars, counts and rows repaint in place.
 */

/** Menus and popovers fade and scale from 0.97 at their anchor. */
export const overlayMotion =
  "duration-(--duration-2) ease-(--ease-out) data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-97 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-97";

/** Tooltips: the same, on their own open states. */
export const tooltipMotion =
  "duration-(--duration-2) ease-(--ease-out) data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-97 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-97";

/** A tooltip opens after 400ms on hover or focus. */
export const tooltipDelayMs = 400;
