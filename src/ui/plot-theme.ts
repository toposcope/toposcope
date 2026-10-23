import { createContext, useContext } from "react";

/**
 * How a panel's plot is coloured (#235). The app is dark; an embed may be light. The panels read
 * their line colours from here and their greys from CSS tokens (`--plot-*` in styles.css, with a
 * `.light` set), so one painter serves both.
 */
export type PlotTheme = {
  name: "dark" | "light";
  /** One line per value of a split (frames 13e, 13g); the sixth colour is not `other`'s grey. */
  palette: readonly string[];
  /** One line, alone. */
  line: string;
  other: string;
};

export const darkPlotTheme: PlotTheme = {
  name: "dark",
  palette: ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#e2e8f0", "#c084fc", "#2dd4bf"],
  line: "#a78bfa",
  other: "#94a3b8",
};

/** 23b's light paint: dark ink first, then hues that hold on white. */
export const lightPlotTheme: PlotTheme = {
  name: "light",
  palette: ["#18181b", "#2563eb", "#d97706", "#7c3aed", "#059669", "#db2777", "#0891b2", "#65a30d"],
  line: "#18181b",
  other: "#a1a1aa",
};

export const PlotThemeContext = createContext<PlotTheme>(darkPlotTheme);

export function usePlotTheme(): PlotTheme {
  return useContext(PlotThemeContext);
}
