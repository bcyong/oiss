import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { sitePages } from "./site/plugin.ts";

const root = import.meta.dirname;

// Five pages, all under one site header: the blueprint landing page at /, the RFC at /rfc/, the demo store
// at /demo/, the spec browser at /spec/ and the repository overview at /github/. The spec browser bundles the
// schemas and examples from the repo root, and the RFC page renders docs/rfc, so the dev server may read there.
export default defineConfig({
  plugins: [react(), sitePages(resolve(root, ".."))],
  worker: { format: "es" },
  server: { fs: { allow: [resolve(root, "..")] } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        demo: resolve(root, "demo/index.html"),
        spec: resolve(root, "spec/index.html"),
        rfc: resolve(root, "rfc/index.html"),
        github: resolve(root, "github/index.html"),
      },
    },
  },
});
