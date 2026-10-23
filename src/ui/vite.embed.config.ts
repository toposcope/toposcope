import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

/** The embedded panel (#227): its own bundle, served at /embed without a sign-in, painted by the app's panels (#235). */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(root, "embed"),
  base: "/embed/",
  resolve: {
    alias: {
      "@": root,
    },
  },
  build: {
    outDir: resolve(root, "dist-embed"),
    emptyOutDir: true,
  },
});
