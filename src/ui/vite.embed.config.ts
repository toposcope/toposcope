import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

/** The embedded panel (#227): its own small bundle, served at /embed without a sign-in. */
export default defineConfig({
  plugins: [react()],
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
