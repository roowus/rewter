import react from "@vitejs/plugin-react";
// `vitest/config`, not `vite`: the explicit `types` list in tsconfig.json keeps
// the `/// <reference types="vitest" />` augmentation from ever loading, so the
// `test` block below only typechecks against a `defineConfig` that knows it.
import { defineConfig } from "vitest/config";

/**
 * The dashboard builds to a static bundle the daemon serves itself — one
 * process for API and UI, so there is no second thing to start or to forget to
 * start. In dev that would mean rebuilding on every keystroke, so `vite dev`
 * proxies `/internal` (and the socket) at the daemon instead.
 */
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5273,
    proxy: {
      // `DEFAULT_PORT` in `server/src/config/config.ts`. Hardcoded rather than
      // imported: this file is config for the dev server, and reaching into the
      // daemon's package to start a UI would invert the dependency.
      "/internal": {
        target: "http://127.0.0.1:20130",
        ws: true,
      },
    },
  },
  test: {
    environment: "happy-dom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
