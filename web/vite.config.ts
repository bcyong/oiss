import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

// Two pages: the specification's landing page at / and the demo store at /demo/.
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main: resolve(root, "index.html"),
        demo: resolve(root, "demo/index.html"),
      },
    },
  },
});
