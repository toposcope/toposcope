import { createContext, useContext } from "react";
import type { HeldView } from "./held-view";

/** What this instance holds, for the hunt Search is showing (#139); null when nothing is linked. */
export const HeldContext = createContext<HeldView | null>(null);

export function useHeldView(): HeldView | null {
  return useContext(HeldContext);
}
