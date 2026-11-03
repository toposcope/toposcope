# UI

How Toposcope's screens are built: the tokens in `src/ui/styles.css`, the primitives in `src/ui/components/ui/`, and the rules that keep them in step. The approved sheet is [`designs/Toposcope Design System.html`](../../designs/Toposcope%20Design%20System.html) (sheet 45). Read the page for a primitive before changing it or adding a use of it.

## Tokens

Tailwind names, so classes read `text-sm`, `rounded-lg`, `bg-surface-1`.

| Kind | Tokens |
| --- | --- |
| Type | `text-2xs` 10.5 · `xs` 11.5 · `sm` 12.5 · `base` 14 · `lg` 17 · `xl` 22 · `display` 34, no paired line-height. Body is `base`; page titles `xl`; one big number `display`. |
| Surfaces | `ground` (the page) · `surface-1` (band, well, plot ground, panel body) · `surface-2` (card, panel head, chip) · `overlay` (menu, popover, dialog, tooltip) · `control` (secondary fill, selected row). |
| Levels | `level-debug` · `level-info` · `level-warn` · `level-error` · `level-fatal`; `levelHex` in `src/ui/level.ts` mirrors them for canvas and SVG. |
| States | `danger` · `warn` · `ok` · `info`, each with `-fg` (text) and `-soft` (fill); `plate` is the one accent (selection, Live). Errors are `danger-fg`; a refusal is `warn`. |
| Text | `foreground`, `muted-foreground`, `faint` (never on `control`). |
| Radius | `rounded-sm` 2.4 (kbd, marks, badge) · `md` 4.4 (controls) · `lg` 6.4 (cards, panels, menus) · `xl` 10 (dialogs, sheets, palette) · `full`. |
| Heights | `xs` 18 · `sm` 22 · `md` 26 (default) · `lg` 30, on Button, Input and Chip. |
| Spacing | `0.5 1 1.5 2 3 4 6` (2–24px). `2.5` and `3.5` only inside primitives. Gutters: page 24, card 16, panel 12, row 8. |
| Pages | reading 820 (`pageReading`) · page 1040 (`pageWidth`) · full (Hunt, Watch, boards, Settings, Access). |
| Side panels | `railPanel` 376 (max 34%) · `detailPanel` 560 (max 40%). |
| Charts | `--chart-1…8` and `src/ui/chart-palette.ts`; ticks `2xs`, legend and hover `xs`; exports stay dark. |
| Query | `--q-key` · `--q-op` · `--q-str` · `--q-glob`; a fault is a wavy `danger` underline. |
| Icons | lucide at 12 (`xs`, `sm` controls), 14 (`md`, `lg`) and 16 (header), stroke 2. Mark glyphs are drawn by hand at the same stroke. |
| Numbers | Counts through `CountText` / `formatCompactCount` (`4.25K`, raw under Settings). Durations through `formatDuration(ms, short \| long \| precise)` in `src/shared/duration.ts`. |

## Motion

Three durations, one curve (`--ease-out`). Motion is for controls only.

- **Press** scales a button to 0.97 over `--duration-1` (90ms).
- **Colour and opacity** ease over `--duration-2` (150ms): hover, menus, popovers, tooltips, toasts, a label that changes.
- **Position** eases over `--duration-3` (220ms): the tab underline, a width that follows a new label.
- **Data never moves.** Bars, counts and rows repaint in place; Live polls keep the last paint (no dim, no skeleton).
- **Reduced motion** sets all three to 0; spinners slow down and skeletons stop pulsing.

## Words

The UI's terms: **hunt**, **saved hunt**, **board**, **panel**, **query**, **window**, **input**, **Add to board**, **Edit panel**. Labels and short facts; a helper line only when an action does something unexpected. Results in the past tense: Saved, Removed, Copied. No internals in copy: no rollups, budgets or table names.

## Primitives and patterns

[Button](button.md) · [Split button](split-button.md) · [Input](input.md) · [Chip](chip.md) · [Badge](badge.md) · [Tabs](tabs.md) · [Switch](switch.md) · [Menu](menu.md) · [Tooltip](tooltip.md) · [Toast](toast.md) · [Skeleton](skeleton.md) · [Busy](busy.md) · [Refused](refused.md) · [Empty](empty.md) · [LiveAge](live-age.md) · [Band](band.md) · [Panel](panel.md) · [Dialog](dialog.md) · [Sheet](sheet.md) · [Armed](armed.md) · [Command palette](command-palette.md)

## Lint ratchet

`src/ui/design-lint.test.ts` scans `src/ui/components` and fails when a file adds a `text-[Npx]`, a `[#hex]` colour, a raw palette class (`text-red-300`, `bg-amber-500/20`, `text-zinc-400`…), a `rounded-[Npx]`, a bracketed spacing, a `<button>` with `h-[…]`, or an `outline-none` with no focus state. Each file's counts are in `src/ui/design-lint.baseline.json`; they only go down. When you remove some, lower the baseline with `DESIGN_LINT_UPDATE=1 bun test src/ui/design-lint.test.ts`. Chart palettes (`histogram-series.ts`, `flame.ts`, `waterfall.ts`) are not scanned.

## Contrast

WCAG ratio of each text colour on each dark surface. Small text needs 4.5.

| Text | ground | surface-1 | surface-2 | overlay | control |
| --- | ---: | ---: | ---: | ---: | ---: |
| `foreground` #fafafa | 19.1 | 18.3 | 17.8 | 17.0 | 14.3 |
| `muted-foreground` #9f9fa9 | 7.6 | 7.3 | 7.1 | 6.8 | 5.7 |
| `faint` #84848e | 5.4 | 5.2 | 5.0 | 4.8 | 4.0 ✗ |
| `danger-fg` #f87171 | 7.2 | 6.9 | 6.7 | 6.4 | 5.4 |
| `warn-fg` #fbbf24 | 11.9 | 11.5 | 11.1 | 10.6 | 8.9 |
| `ok-fg` #34d399 | 10.3 | 10.0 | 9.6 | 9.2 | 7.7 |
| `info-fg` #38bdf8 | 9.3 | 8.9 | 8.7 | 8.3 | 7.0 |
| `plate` #e7e1d3 | 15.3 | 14.7 | 14.2 | 13.6 | 11.4 |
| before 0.15: muted at 70% | 4.2 ✗ | 4.1 ✗ | 4.1 ✗ | 3.9 ✗ | 3.5 ✗ |
| before 0.15: zinc-500 #71717a | 4.1 ✗ | 4.0 ✗ | 3.8 ✗ | 3.7 ✗ | 3.1 ✗ |
| before 0.15: zinc-600 #52525b | 2.6 ✗ | 2.5 ✗ | 2.4 ✗ | 2.3 ✗ | 1.9 ✗ |

- Faint text is `text-faint`, never muted at an alpha or a zinc grey. Never put faint text on `control`.
- Debug's grey (`level-debug`) is a fill, not text.

## Focus

One look on every control, shown on `focus-visible` only:

- **Controls** (buttons, icon buttons, chips, triggers): a 1px ring in `--ring` (`focus-visible:ring-1 focus-visible:ring-ring`).
- **Fields** (inputs, text areas, the query bar, a box around an input): the border lifts to fg 40% (`focus-visible:border-foreground/40`, or `focus-within:` on the box). Plate stays for selection and Live.
- **Rows** in menus and lists: the control fill (`focus:bg-control`, `data-[highlighted]:bg-control`), not a ring.

Every `outline-none` keeps one of these; the lint ratchet counts the ones that do not.
