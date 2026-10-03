import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { codeModeRuntimeProvenancePlugin } from "./scripts/build-code-mode-runtime.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    plugins: [codeModeRuntimeProvenancePlugin(root)],
    build: {
      // Carry the exact reviewed executor in the normal Desktop and re-entry host.
      externalizeDeps: { exclude: ["@ai-sdk/code-mode", "run"] },
      rollupOptions: {
        // Preserve the SDK package boundary: its native library resolver is relative to the package.
        external: ["@trycua/cua-driver"],
        input: {
          index: path.join(root, "src/desktop/electron/main/index.ts"),
          cuaProcess: path.join(root, "src/computer/cuaProcess.ts")
        },
        output: {
          manualChunks: (id) => id === path.join(root, "src/agent/codeMode.ts") ? "code-mode-runtime" : undefined
        }
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: path.join(root, "src/desktop/electron/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    }
  },
  renderer: {
    root: path.join(root, "src/desktop/renderer"),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: path.join(root, "src/desktop/renderer/index.html")
        }
      }
    }
  }
});
