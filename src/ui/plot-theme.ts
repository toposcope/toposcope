import { createContext, useContext } from "react";
import { chartDark, chartLight, chartLineDark, chartLineLight, chartOtherDark, chartOtherLight } from "./chart-palette";

/**
 * How a panel's plot is coloured (#235). The app is dark; an embed may be light. The panels read
 * their line colours from here and their greys from CSS tokens (`--plot-*` in styles.css, with a
 * `.light` set), so one painter serves both.
 */
export type PlotTheme = {
  name: "dark" | "light";
  /** One line per value of a split (frames 13e, 13g), from `chart-palette.ts`. */
  palette: readonly string[];
  /** One line, alone. */
  line: string;
  other: string;
};

export const darkPlotTheme: PlotTheme = {
  name: "dark",
  palette: chartDark,
  line: chartLineDark,
  other: chartOtherDark,
};

/** 23b's light paint: dark ink first, then hues that hold on white. */
export const lightPlotTheme: PlotTheme = {
  name: "light",
  palette: chartLight,
  line: chartLineLight,
  other: chartOtherLight,
};

export const PlotThemeContext = createContext<PlotTheme>(darkPlotTheme);

export function usePlotTheme(): PlotTheme {
  return useContext(PlotThemeContext);
}
