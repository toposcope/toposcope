/** The key that turns a wheel over a chart into a zoom (sheet 47e): ⌘ on a Mac, Ctrl elsewhere. */
export function zoomKey(platform: string = typeof navigator === "undefined" ? "" : navigator.platform): string {
  return /mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl";
}
