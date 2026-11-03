import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Sheet 45's type steps: without these, `text-2xs` and `text-display` merge away as colours. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["2xs", "display"] },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
