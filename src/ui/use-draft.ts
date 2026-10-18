import { useState } from "react";

/**
 * What a panel's text field shows while it is typed in (#169). The panel keeps
 * its title, note and names with spaces collapsed and trimmed, so the field
 * keeps what was typed, a trailing space too, and takes the panel's value again
 * only when that value changes.
 */
export function useDraft(value: string, commit: (next: string) => void): [string, (next: string) => void] {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return [
    draft,
    (next) => {
      setDraft(next);
      commit(next);
    },
  ];
}
