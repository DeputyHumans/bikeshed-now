// SPDX-License-Identifier: Apache-2.0
// What /sitemap.xml says: the site's own public pages, then its public documents (SPEC §2).

const test = require("node:test");
const assert = require("node:assert/strict");

const { sitemapXml } = require("../lib/lib/sitemap.js");

/** Each `<url>` as `[loc, lastmod or null]`, in order. */
function urls(xml) {
  return [...xml.matchAll(/<url><loc>([^<]*)<\/loc>(?:<lastmod>([^<]*)<\/lastmod>)?<\/url>/g)].map((m) => [m[1], m[2] ?? null]);
}

test("the site's own pages come first, with no date nobody can vouch for", () => {
  assert.deepEqual(urls(sitemapXml("https://h.example", [])), [
    ["https://h.example/", null],
    ["https://h.example/terms", null],
    ["https://h.example/privacy", null],
  ]);
});

test("a deployment with no public documents still lists a page", () => {
  // An empty <urlset> is what this answered before: a sitemap with nothing in
  // it, on a site that does have a front page.
  assert.ok(urls(sitemapXml("https://h.example", [])).length > 0);
});

test("documents follow, in the order given, each with its date", () => {
  const xml = sitemapXml("https://h.example", [
    { id: "newer", lastmod: "2026-11-05" },
    { id: "older", lastmod: "2026-09-18" },
  ]);
  assert.deepEqual(urls(xml).slice(3), [
    ["https://h.example/d/newer", "2026-11-05"],
    ["https://h.example/d/older", "2026-09-18"],
  ]);
});

test("a document with no date says nothing rather than something empty", () => {
  const xml = sitemapXml("https://h.example", [{ id: "undated", lastmod: "" }]);
  assert.deepEqual(urls(xml).at(-1), ["https://h.example/d/undated", null]);
  assert.equal(xml.includes("<lastmod></lastmod>"), false);
});

test("a location is escaped, so an id cannot break the document", () => {
  const xml = sitemapXml("https://h.example", [{ id: "a&b<c", lastmod: "" }]);
  assert.ok(xml.includes("<loc>https://h.example/d/a&amp;b&lt;c</loc>"));
});

test("it is the document a crawler expects", () => {
  const xml = sitemapXml("https://h.example", []);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'));
  assert.ok(xml.endsWith("\n</urlset>\n"));
});
