# UI

How Toposcope's screens are built: the tokens in `src/ui/styles.css`, the primitives in `src/ui/components/ui/`, and the rules that keep them in step. The approved sheet is [`designs/Toposcope Design System.html`](../../designs/Toposcope%20Design%20System.html) (sheet 45).

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
