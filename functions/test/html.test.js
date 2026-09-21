// SPDX-License-Identifier: Apache-2.0
// Escaping for markup the functions emit outside the Markdown renderer (SPEC §17).

const test = require("node:test");
const assert = require("node:assert/strict");

const { escapeText, escapeAttr } = require("../lib/lib/html.js");

test("escapeText escapes &, <, > in order", () => {
  assert.equal(escapeText("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

test("escapeText leaves quote characters alone", () => {
  assert.equal(escapeText(`a "b" c 'd'`), `a "b" c 'd'`);
});

test("escapeAttr closes a double-quoted attribute injection", () => {
  assert.equal(escapeAttr('" onmouseover="x'), "&quot; onmouseover=&quot;x");
});

test("escapeAttr closes a single-quoted attribute injection", () => {
  assert.equal(escapeAttr("' onerror='x"), "&#39; onerror=&#39;x");
});

test("escapeAttr does not double-decode an already-escaped ampersand", () => {
  assert.equal(escapeAttr("&amp;"), "&amp;amp;");
});

test("escapeText on a script-closing payload contains no <", () => {
  const out = escapeText("</title><script>alert(1)</script>");
  assert.equal(out.includes("<"), false);
});
