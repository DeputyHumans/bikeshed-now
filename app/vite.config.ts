// SPDX-License-Identifier: Apache-2.0
// Vite build + the dev proxy that makes local development behave like production (SPEC §12).

// `defineConfig` comes from vitest/config, not vite, so the `test` block below
// type-checks. Vitest is a dev dependency and this file never ships.
import { defineConfig } from "vitest/config";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
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
/**
 * The Hosting emulator, which itself rewrites to the Functions emulator, so the
 * proxied paths behave exactly as they will in production.
 *
 * The port is read from firebase.json rather than repeated here — that file is
 * the one place emulator ports are configured, and a second copy would drift the
 * first time somebody changed one.
 */
const firebaseConfig = JSON.parse(
  readFileSync(new URL("../firebase.json", import.meta.url), "utf8"),
) as { emulators?: { hosting?: { port?: number } } };
const HOSTING_PORT = firebaseConfig.emulators?.hosting?.port ?? 5050;
const FUNCTIONS_ORIGIN =
  process.env.BIKESHED_FUNCTIONS_ORIGIN || `http://127.0.0.1:${HOSTING_PORT}`;

function devProxy(): Record<string, ProxyOptions> {
  const target: ProxyOptions = { target: FUNCTIONS_ORIGIN, changeOrigin: true };
  return Object.fromEntries(viteProxyKeys().map((key) => [key, target]));
}

/**
 * Declare a charset on the text files this app serves from `public/`.
 *
 * Vite's dev server sends `.txt` as bare `text/plain`, and a browser with no
 * charset to go on falls back to a single-byte encoding: `/llms.txt` then
 * renders its arrows and ellipses as mojibake. Firebase Hosting sends
 * `text/plain; charset=utf-8` and is unaffected, so this only ever bit local
 * development — which is also the only place anybody reads that file by eye.
 */
function utf8Text() {
  return {
    name: "utf8-text",
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use((req: any, res: any, next: () => void) => {
        if (req.url?.split("?")[0].endsWith(".txt")) {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), utf8Text()],
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
      /**
       * Excluded because jsdom cannot exercise them, not because they do not
       * matter. Each is named rather than covered by a wildcard, so adding one
       * is a decision somebody makes on purpose:
       *
       *   peers.ts   needs Range.getClientRects(), which returns nothing here
       *   image.ts   needs a canvas
       *   Sidebar    a React component over live Firestore subscriptions
       *   Mark, Wordmark  presentational SVG with no logic to assert
       *
       * They are covered instead by the emulator walkthrough in
       * docs/operations/overview.md. src/test/README.md explains each limitation.
       */
      exclude: [
        // The tests themselves are not the subject. Counting them inflates the
        // figure and hides which source is actually exercised.
        "**/*.test.ts",
        "**/*.test.tsx",
        "src/annotation/peers.ts",
        "src/annotation/Sidebar.tsx",
        "src/export/image.ts",
        "src/brand/Mark.tsx",
        "src/brand/Wordmark.tsx",
      ],
      // Set just under the current figures, so an ordinary change does not
      // fail the build, and a real drop does.
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 80 },
    },
  },
});
