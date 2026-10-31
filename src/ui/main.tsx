import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./App";
import { installOutageWatch } from "./outage";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}

installOutageWatch();

createRoot(root).render(
  <StrictMode>
    <TooltipProvider>
      <App />
      <Toaster theme="dark" richColors position="top-right" />
    </TooltipProvider>
  </StrictMode>,
);
