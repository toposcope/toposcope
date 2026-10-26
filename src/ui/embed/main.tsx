import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { mergePanelSearch, parseEmbedParams } from "../embed-view";

/** A tag with `data-panel` (#266): read the panel the share holds, then draw it as if the tag said it all. */
async function resolvePanel(search: string): Promise<string> {
  const url = new URLSearchParams(search);
  const panel = url.get("panel");
  const ticket = url.get("ticket");
  if (!panel || !ticket) {
    return search;
  }
  try {
    const res = await fetch(`/share/v1/panels/${encodeURIComponent(panel)}`, { headers: { authorization: `Bearer ${ticket}` } });
    if (!res.ok) {
      return search;
    }
    const body = (await res.json()) as { params: Record<string, string> };
    return mergePanelSearch(search, body.params);
  } catch {
    return search;
  }
}
import { darkPlotTheme, lightPlotTheme, PlotThemeContext } from "../plot-theme";
import { EmbedPanel } from "./panel";
import "./app.css";
import "./embed.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
const search = await resolvePanel(window.location.search);
const params = parseEmbedParams(search);
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
