import { useEffect, useMemo, useRef, useState } from "react";
import { heldSources, type HeldSource } from "../shared/held";
import type { LinksList } from "./link-words";

/** How often Search re-reads where each source stands: the pull loop runs every 5 seconds. */
export const heldPollMs = 5_000;

/**
 * Where each source this instance pulls from stands (#139), re-read while Search is open. A
 * failed read keeps the last answer: Search never flickers chrome on a poll. In Live a short
 * source's age ticks each second, like Live's own.
 */
export function useHeld(
  enabled: boolean,
  live: boolean,
): { sources: HeldSource[]; now: number; links: LinksList["links"] } {
  const [links, setLinks] = useState<LinksList["links"]>([]);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    let stop = false;
    const read = async () => {
      if (busy.current) {
        return;
      }
      busy.current = true;
      try {
        const res = await fetch("/api/links");
        if (!stop && res.ok) {
          const json = (await res.json()) as LinksList;
          setLinks(json.links ?? []);
          setNow(Date.now());
        }
      } catch {
        // Keep the last answer.
      } finally {
        busy.current = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), heldPollMs);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [enabled]);

  const sources = useMemo(() => heldSources(links, now), [links, now]);
  const ticking = enabled && live && sources.some((s) => s.state.kind !== "caught-up");
  useEffect(() => {
    if (!ticking) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);

  return { sources, now, links };
}
