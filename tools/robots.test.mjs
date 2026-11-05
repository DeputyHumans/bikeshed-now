// SPDX-License-Identifier: Apache-2.0
// What app/public/robots.txt asks of a crawler, read the way RFC 9309 reads it (SPEC §2).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { stamp } from "./stamp-deployment.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROBOTS = readFileSync(join(ROOT, "app", "public", "robots.txt"), "utf8");

/** The lines that mean something: comments and blank lines dropped, field names lowercased. */
function directives(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(":");
      return { field: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
    });
}

/** A rule's path as a pattern: `*` is any run of characters and a final `$` ends the URL. */
function pattern(path) {
  const end = path.endsWith("$");
  const body = (end ? path.slice(0, -1) : path)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${end ? "$" : ""}`);
}

/** RFC 9309 §2.2.2: the rule with the most octets decides, and `Allow` wins a tie. No rule allows. */
function allowed(text, url) {
  let best = { length: -1, allow: true };
  for (const { field, value } of directives(text)) {
    if ((field !== "allow" && field !== "disallow") || value === "") continue;
    if (!pattern(value).test(url)) continue;
    const allow = field === "allow";
    if (value.length > best.length || (value.length === best.length && allow)) {
      best = { length: value.length, allow };
    }
  }
  return best.allow;
}

// Taken from a signed-out browser's requests on `/`, `/d/docs` and `/terms`,
// and from what agents and readers are told to fetch.
const OPEN = [
  "/",
  "/terms",
  "/privacy",
  "/docs",
  "/docs/developers",
  "/d/docs",
  "/d/docs-developers",
  "/content/docs/v9/index.html",
  "/content/a-deck/v1/styles.css",
  "/assets/index-CH5KUjoT.js",
  "/assets/index-BObYOb3B.css",
  "/fonts/bikeshed-sans-var.woff2",
  "/brand/favicon.svg",
  "/brand/og-default.png",
  "/site.webmanifest",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/skills/index.json",
  "/skills/publish/SKILL.md",
  "/.well-known/mcp.json",
  "/.well-known/oauth-protected-resource",
  "/mcp",
  "/folder/abc123",
  // A key's `noindex` works only if a crawler can fetch the page and see it.
  "/d/a-plan?k=token",
  "/d/a-plan/v2?k=token",
  "/folder/abc123?k=token",
  // A document's id can be any of these words. Its page is not that route.
  "/d/shared",
  "/d/trash",
  "/d/view",
  "/d/signup",
  "/d/account",
];

const CLOSED = [
  "/account",
  "/connect",
  "/connect?client_id=x&redirect_uri=y",
  "/everything",
  "/shared",
  "/signup",
  "/signup?next=%2Fd%2Fdocs",
  "/trash",
  "/d/docs/v8",
  "/d/docs/",
  "/download/docs/v9",
  "/thumb/docs/v9/1.webp",
  "/activity",
  "/view",
  "/verify/abc123",
];

for (const url of OPEN) {
  test(`a crawler may read ${url}`, () => {
    assert.equal(allowed(ROBOTS, url), true);
  });
}

for (const url of CLOSED) {
  test(`a crawler is asked to leave ${url}`, () => {
    assert.equal(allowed(ROBOTS, url), false);
  });
}

test("there is one group, for every bot", () => {
  // Under RFC 9309 a bot obeys only the group that names it. A second group
  // would silently lift every rule in this file for the bots it names.
  const agents = directives(ROBOTS).filter((d) => d.field === "user-agent");
  assert.deepEqual(agents.map((d) => d.value), ["*"]);
});

test("every line is a directive this file means to use", () => {
  // An unknown field is ignored without complaint, so a misspelt rule would
  // quietly be no rule.
  const fields = new Set(directives(ROBOTS).map((d) => d.field));
  assert.deepEqual([...fields].sort(), ["allow", "disallow", "sitemap", "user-agent"]);
});

test("the sitemap is named in full, and the build fills in the address", () => {
  const named = directives(ROBOTS).filter((d) => d.field === "sitemap");
  assert.deepEqual(named.map((d) => d.value), ["https://<deployment>/sitemap.xml"]);
  const stamped = stamp(ROBOTS, "https://h.example");
  assert.equal(stamped.includes("<deployment>"), false);
  assert.deepEqual(
    directives(stamped).filter((d) => d.field === "sitemap").map((d) => d.value),
    ["https://h.example/sitemap.xml"],
  );
});

test("the matcher can tell the two apart", () => {
  // Without these, a matcher that answered the same for everything would pass
  // half of the table and hide the other half.
  assert.equal(allowed("User-agent: *\nDisallow: /a/\nAllow: /a/b", "/a/b"), true, "longer Allow beats shorter Disallow");
  assert.equal(allowed("User-agent: *\nAllow: /a\nDisallow: /a/b", "/a/b"), false, "longer Disallow beats shorter Allow");
  assert.equal(allowed("User-agent: *\nDisallow: /a*\nAllow: /a/", "/a/x"), true, "Allow wins a tie");
  assert.equal(allowed("User-agent: *\nDisallow: /x$", "/x/y"), true, "$ ends the URL");
  assert.equal(allowed("User-agent: *\nDisallow: /x$", "/x"), false, "$ ends the URL");
  assert.equal(allowed("User-agent: *\nDisallow:", "/x"), true, "an empty Disallow is no rule");
});
