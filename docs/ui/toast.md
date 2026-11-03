# Toast

`sonner, in src/ui/main.tsx`

The result of an action, in its past tense: Saved, Created, Removed, Copied.

## Props

- `toast.success(text)`, `toast.error(text)` from `sonner`. The `Toaster` sits top right, dark.

## Use

- One toast per finished action, past tense, no rationale.

## Do not

- Show a query error in a toast. It goes in the field.
- Show an outage in a toast. That is the Band.

## Keys and access

Announced politely; it does not take focus.

## Motion

Stacks of three; fans out on hover (sonner's default).
