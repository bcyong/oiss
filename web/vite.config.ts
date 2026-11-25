import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

// Three pages: the specification's landing page at /, the demo store at /demo/ and the spec browser at /spec/.
// The spec browser bundles the schemas and examples from the repo root, so the dev server may read there.
export default defineConfig({
  plugins: [react()],
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
      },
    },
  },
});
