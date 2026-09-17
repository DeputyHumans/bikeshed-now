// SPDX-License-Identifier: Apache-2.0
// Vite build + the dev proxy that makes local development behave like production (SPEC §12).

// `defineConfig` comes from vitest/config, not vite, so the `test` block below
// type-checks. Vitest is a dev dependency and this file never ships.
import { defineConfig } from "vitest/config";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { viteProxyKeys } from "../scripts/lib/endpoints.mjs";

/**
 * In development the app runs on :5173 while the endpoints live in the Functions
 * emulator, so every gated path has to be proxied for the same-origin `__session`
 * cookie to work at all.
 *
 * The proxy table is derived from `scripts/lib/endpoints.mjs` rather than
 * hand-written. That is the whole point: this list drifted to 2-of-14 coverage in
 * the design this is rebuilt from, and the symptom was "half the app
 * mysteriously does not work locally", which reads as a backend bug.
 *
 * Exact endpoints get an ANCHORED regex key. `/folder` is both a POST endpoint
 * and the prefix of the client route `/folder/{id}`; a plain `/folder` string key
 * is a PREFIX match in Vite, so it would send folder deep-links to the emulator
 * and break them silently. Do not "simplify" this back to string keys.
 */
const FUNCTIONS_ORIGIN =
  process.env.BIKESHED_FUNCTIONS_ORIGIN || "http://127.0.0.1:5000";

function devProxy(): Record<string, ProxyOptions> {
  const target: ProxyOptions = { target: FUNCTIONS_ORIGIN, changeOrigin: true };
  return Object.fromEntries(viteProxyKeys().map((key) => [key, target]));
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: devProxy() },
  build: { outDir: "dist", sourcemap: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/annotation/**",
        "src/export/**",
        "src/workspace/**",
        "src/brand/**",
        "src/stats.ts",
      ],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 80 },
    },
  },
});
