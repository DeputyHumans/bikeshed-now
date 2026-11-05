// SPDX-License-Identifier: Apache-2.0
// Vite build + the dev proxy that makes local development behave like production (SPEC §12).

// `defineConfig` comes from vitest/config, not vite, so the `test` block below
// type-checks. Vitest is a dev dependency and this file never ships.
import { defineConfig } from "vitest/config";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { viteProxyKeys } from "../scripts/lib/endpoints.mjs";
import { deploymentStamp } from "../tools/stamp-deployment.mjs";

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
const { version: APP_VERSION } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

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
  /**
   * `deploymentStamp` rewrites `https://<deployment>` in the copies of
   * `/llms.txt` and `/skills/**` that land in `dist`, so the instructions a
   * deployment serves name that deployment. It is a plugin rather than a step
   * chained after `npm run build` because the documented hosting deploy runs
   * `npm --prefix app run build` directly (docs/operations/overview.md), and a
   * root-level step would be skipped by the one command the guide prescribes.
   * The tracked copies under `public/` always keep the placeholder.
   */
  plugins: [react(), utf8Text(), deploymentStamp()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  server: { port: 5173, proxy: devProxy() },
  build: { outDir: "dist", sourcemap: true },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],

    /**
     * Pinned, because Vitest loads app/.env.local and that file is gitignored.
     * Without these the suite asserts against whatever configuration a machine
     * happens to have: it passed on a developer machine that had the file and
     * failed on a fresh clone that did not, where firebase.ts throws
     * auth/invalid-api-key at import and takes three test files with it.
     *
     * These are the app/.env.example values. demo- project ids are
     * emulator-only, so nothing here can reach a backend.
     */
    env: {
      VITE_USE_EMULATORS: "1",
      VITE_FIREBASE_PROJECT_ID: "demo-bikeshed",
      VITE_FIREBASE_API_KEY: "demo-api-key",
      VITE_FIREBASE_AUTH_DOMAIN: "demo-bikeshed.firebaseapp.com",
      VITE_FIREBASE_STORAGE_BUCKET: "demo-bikeshed-content",
      VITE_FIREBASE_MESSAGING_SENDER_ID: "000000000000",
      VITE_FIREBASE_APP_ID: "1:000000000000:web:0000000000000000000000",
      VITE_FIREBASE_DATABASE_URL: "http://127.0.0.1:9000?ns=demo-bikeshed",
      VITE_FIREBASE_MEASUREMENT_ID: "",
      VITE_EXPORT_MARK_ENABLED: "",
      VITE_EXPORT_MARK_LABEL: "",
      VITE_EXPORT_MARK_FOOTER: "",
      VITE_LEGAL_CONTACT: "",
      VITE_LANDING_MEDIA_BASE_URL: "",
    },
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
      // fail the build, and a real drop does. Since Vitest 4 `statements` counts
      // statements rather than lines. That moved the figure from 93.4% of 1372
      // to 89.4% of 851 with the same tests and one fewer left uncovered, so 89
      // allows fewer uncovered statements than 90 allowed lines.
      thresholds: { lines: 90, functions: 90, statements: 89, branches: 80 },
    },
  },
});
