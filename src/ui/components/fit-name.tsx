import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { cutToRoom } from "../series-list";

type Props = {
  name: string;
  /** Printed before the name and never cut: a reading, `avg · `. */
  lead?: string;
  leadStyle?: CSSProperties;
  /** Printed after the name and never cut: its labels, `{box=host-03}`. */
  trail?: string;
  /** Names this one must not read as once it is cut. */
  others?: readonly string[];
  className?: string;
  title?: string;
};

/**
 * A name in a monospace face, cut in the middle to the room it is given, not
 * to a count (#164). The whole text is laid out unseen, so the room is what
 * the layout gives the whole name; the cut is printed over it. Until the room
 * is measured, the name is whole.
 */
export function FitName({ name, lead = "", leadStyle, trail = "", others = [], className, title }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const wholeRef = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState<string | null>(null);
  const othersKey = others.join("\n");

  useLayoutEffect(() => {
    const box = boxRef.current;
    const whole = wholeRef.current;
    if (!box || !whole) {
      return;
    }
    const chars = lead.length + name.length + trail.length;
    const sync = () => {
      const wholePx = whole.getBoundingClientRect().width;
      const roomPx = box.getBoundingClientRect().width;
      setCut(
        chars === 0 || wholePx <= roomPx + 0.05
          ? null
          : cutToRoom(name, roomPx, wholePx / chars, { lead, trail, others }),
      );
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(box);
    ro.observe(whole);
    return () => ro.disconnect();
    // `others` is read through its key, so a new array with the same names does not re-measure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, lead, trail, othersKey]);

  const text = `${cut ?? name}${trail}`;
  return (
    // The box clips and never draws its own ellipsis: that would print over the cut.
    <span ref={boxRef} className={cn("relative min-w-0 overflow-hidden whitespace-nowrap", className)} title={title}>
      <span ref={wholeRef} aria-hidden="true" className="invisible">{`${lead}${name}${trail}`}</span>
      <span className="absolute inset-0 truncate">
        {leadStyle && lead ? (
          <>
            <span style={leadStyle}>{lead}</span>
            {text}
          </>
        ) : (
          `${lead}${text}`
        )}
      </span>
    </span>
  );
}
