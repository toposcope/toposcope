import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseEmbedParams } from "../embed-view";
import { EmbedPanel } from "./panel";
import "./embed.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
const params = parseEmbedParams(window.location.search);
document.documentElement.dataset.theme = params.theme;
document.title = `${params.title} · toposcope`;

createRoot(root).render(
  <StrictMode>
    <EmbedPanel params={params} />
  </StrictMode>,
);
