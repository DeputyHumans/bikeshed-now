// SPDX-License-Identifier: Apache-2.0
// The canonical endpoint table: one row per Cloud Function (SPEC §2).

/**
 * Why this file exists
 * --------------------
 * The same list of endpoints has to appear in four places: the Hosting rewrites
 * in `firebase.json`, the exports of `functions/src/index.ts`, the Vite dev
 * proxy, and whatever teardown deletes. In the original of this design those
 * four drifted badly — teardown deleted 2 of 14 functions because it was
 * written when there were two, and the dev proxy covered 2 of 14 for the same
 * reason. Both were silent: teardown reported success, and the dev proxy just
 * made half the app mysteriously not work in development.
 *
 * So the list lives here once. `functions/test/wiring.test.js` asserts that this
 * table, `firebase.json`, and the built function exports all agree, which means
 * a fifteenth endpoint cannot be added without teardown and the proxy learning
 * about it.
 */

/**
 * `match` decides how a request reaches the function, and it is not cosmetic.
 *
 *   exact   — the path and nothing beneath it. `/folder` is a POST endpoint AND
 *             `/folder/{id}` is a client route, so a prefix rule here would
 *             proxy folder deep-links to the emulator and silently break them.
 *   prefix  — the path and everything beneath it (`/content/{doc}/{ver}/...`).
 *
 * `devProxy: false` keeps a row out of the Vite dev proxy while Hosting still
 * rewrites it — for a function that serves a client route rather than an API.
 */
export const ENDPOINTS = [
  { path: "/session", fn: "session", match: "exact" },
  { path: "/config", fn: "appConfig", match: "exact" },
  { path: "/access", fn: "setAccess", match: "exact" },
  { path: "/publish", fn: "createDoc", match: "exact" },
  { path: "/folder", fn: "createFolder", match: "exact" },
  { path: "/folder-access", fn: "setFolderAccess", match: "exact" },
  { path: "/organize", fn: "organize", match: "exact" },
  { path: "/fork", fn: "forkDoc", match: "exact" },
  { path: "/trust", fn: "trustDoc", match: "exact" },
  { path: "/marking", fn: "setMarking", match: "exact" },
  { path: "/visibility", fn: "setVisibility", match: "exact" },
  { path: "/team", fn: "manageTeam", match: "exact" },
  { path: "/team-members", fn: "manageTeamMembers", match: "exact" },
  { path: "/tokens", fn: "manageTokens", match: "exact" },
  { path: "/view", fn: "recordView", match: "exact" },
  { path: "/unlock", fn: "unlockDoc", match: "exact" },
  { path: "/draft", fn: "saveDraft", match: "exact" },
  { path: "/commit", fn: "commitVersion", match: "exact" },
  { path: "/mcp", fn: "mcp", match: "exact" },
  { path: "/sitemap.xml", fn: "sitemap", match: "exact" },
  { path: "/verify", fn: "verifyEmail", match: "prefix" },
  { path: "/download", fn: "downloadBundle", match: "prefix" },
  { path: "/draft", fn: "getDraft", match: "prefix" },
  { path: "/content", fn: "contentProxy", match: "prefix" },
  // This function serves a CLIENT ROUTE — the app shell, with the document's
  // own head spliced in for crawlers — so the Vite dev server must keep
  // serving its own shell for `/d/*`. `devProxy: false` keeps the row out of
  // the dev proxy while Hosting still rewrites it.
  { path: "/d", fn: "docShell", match: "prefix", devProxy: false },
];

/**
 * Functions with no Hosting rewrite. `onCommentCreated` is a Firestore
 * `onDocumentCreated` trigger — the only non-HTTP function in the codebase.
 */
export const TRIGGERS = ["onCommentCreated"];

/** Every deployed function name, in `firebase functions:delete` order. */
export function functionNames() {
  return [...new Set([...ENDPOINTS.map((e) => e.fn), ...TRIGGERS])];
}

/** The `source` string this row must have in firebase.json's rewrites. */
export function rewriteSource(endpoint) {
  return endpoint.match === "prefix" ? `${endpoint.path}/**` : endpoint.path;
}

/** Every rewrite, in the order firebase.json must list them (exact first). */
export function rewrites() {
  return [
    ...ENDPOINTS.filter((e) => e.match === "exact"),
    ...ENDPOINTS.filter((e) => e.match === "prefix"),
  ].map((e) => ({ source: rewriteSource(e), function: e.fn }));
}

/**
 * Vite dev-proxy keys. Exact endpoints get an ANCHORED regex so they cannot
 * swallow a client route that shares their prefix; prefix endpoints get a plain
 * string key, which Vite treats as a prefix match.
 *
 * Keep the anchored form even when no client route currently collides — the
 * collision arrives when someone adds a route, and by then the proxy failure
 * looks like a backend bug.
 */
export function viteProxyKeys() {
  const keys = [];
  for (const e of ENDPOINTS) {
    if (e.devProxy === false) continue;
    if (e.match === "prefix") {
      if (!keys.includes(e.path)) keys.push(e.path);
    } else {
      const escaped = e.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      keys.push(`^${escaped}(\\?.*)?$`);
    }
  }
  return keys;
}
