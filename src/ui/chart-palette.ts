import { levelHex } from "./level";

/**
 * The one chart palette (sheet 45, Patterns → Charts): series colours dark and light, the lone
 * line, `other`'s grey and the level colours. `--chart-1…8` in styles.css carry the dark set for
 * classes; histograms, panels, embeds, the waterfall and the flame graph read these hexes.
 * Exports (SVG, PNG) stay dark.
 */
export const chartDark = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#94a3b8", "#c084fc", "#2dd4bf"] as const;

/** 23b's light paint for embeds: dark ink first, then hues that hold on white. */
export const chartLight = ["#18181b", "#2563eb", "#d97706", "#7c3aed", "#059669", "#db2777", "#0891b2", "#65a30d"] as const;

/** `other`, `-` and anything past the palette. */
export const chartOtherDark = "#94a3b8";
export const chartOtherLight = "#a1a1aa";

/** One series alone: a panel's single line. */
export const chartLineDark = chartDark[1];
export const chartLineLight = chartLight[0];

/** An error span or frame. */
export const chartError = levelHex.error;

export { levelHex };

/** The palette colour for an index, wrapping. */
export function chartColor(index: number, palette: readonly string[] = chartDark): string {
  return palette[(index < 0 ? 0 : index) % palette.length] ?? chartOtherDark;
}
