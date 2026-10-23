import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseEmbedParams } from "../embed-view";
import { darkPlotTheme, lightPlotTheme, PlotThemeContext } from "../plot-theme";
import { EmbedPanel } from "./panel";
import "./app.css";
import "./embed.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
const params = parseEmbedParams(window.location.search);
document.documentElement.dataset.theme = params.theme;
// The app's tokens, light or dark (#235): the same panels paint both.
document.documentElement.classList.add(params.theme);
document.title = `${params.title} · toposcope`;

createRoot(root).render(
  <StrictMode>
    <PlotThemeContext.Provider value={params.theme === "light" ? lightPlotTheme : darkPlotTheme}>
      <EmbedPanel params={params} />
    </PlotThemeContext.Provider>
  </StrictMode>,
);
