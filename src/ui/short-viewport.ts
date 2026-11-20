import { useEffect, useState } from "react";

/** Sheet 47b: under this inner height (a laptop's 623px inside the browser) a hunt draws dense. */
export const shortViewportPx = 820;

export function isShortViewport(innerHeight: number): boolean {
  return innerHeight < shortViewportPx;
}

/** True while the window is short; follows resizes. `on: false` always answers false. */
export function useShortViewport(on = true): boolean {
  const read = () => typeof window !== "undefined" && isShortViewport(window.innerHeight);
  const [short, setShort] = useState(read);
  useEffect(() => {
    if (!on) {
      return;
    }
    const onResize = () => setShort(read());
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [on]);
  return on && short;
}
