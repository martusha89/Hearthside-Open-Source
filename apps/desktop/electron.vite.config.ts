import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Workspace packages ship TypeScript source, so they must be bundled rather
// than left as runtime requires.
const bundleWorkspace = { exclude: ["@hearthside/ipc-contract"] };

export default defineConfig({
  main: {
    build: { externalizeDeps: bundleWorkspace },
  },
  preload: {
    build: {
      externalizeDeps: bundleWorkspace,
      // Sandboxed preloads must be CommonJS.
      rollupOptions: { output: { format: "cjs", entryFileNames: "[name].js" } },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") },
      // A desktop app loads its bundle from disk, so one large chunk is fine.
      chunkSizeWarningLimit: 1500,
    },
    plugins: [react(), tailwindcss()],
  },
});
