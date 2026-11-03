# Refused

`src/ui/components/ui/states.tsx`

A read the server would not run: always warn, never danger.

## Props

- `reason`, `form` — `inline` (a count or a footnote) | `block` (a table or a panel), `title` (block), `count` (inline: lead with a muted `—`).

## Use

- Inline in the hunt head and under a chart; block in the event table, a board panel, an embed.
- The words say what to narrow.

## Do not

- Colour it danger. A refusal is not an error.
- Name internals (rollups, budgets, tables).

## Keys and access

`role="status"` on the block.

## Motion

None.
