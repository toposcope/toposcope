export type KbdRegion = "plot" | "table" | "tabs" | "facet";

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function kbdRegion(target: EventTarget | null): KbdRegion | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const value = target.closest("[data-kbd]")?.getAttribute("data-kbd");
  if (value === "plot" || value === "table" || value === "tabs" || value === "facet") {
    return value;
  }
  return null;
}

export function stepIndex(index: number, delta: number, length: number): number {
  if (length <= 0) {
    return 0;
  }
  return Math.min(length - 1, Math.max(0, index + delta));
}

export function isArrowKey(key: string): boolean {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  );
}
