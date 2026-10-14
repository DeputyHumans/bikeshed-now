// SPDX-License-Identifier: Apache-2.0
// Self-test: I8 judged in place (checkI8 with draftHtml and each change's element and quote) and elementText, the element reader it stands on (SPEC §22).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openParser } from "../lib/bytes.mjs";
import { assertInvariant, checkI8, elementText } from "../lib/invariants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");
const FIXTURE = readFileSync(join(FIXTURES, "crdt-paragraphs.html"), "utf8");
const CONTROL = join(HERE, "..", "patches", "controls-c10-i8-in-place", "control.json");

let parser;
before(async () => {
  parser = await openParser();
});
after(async () => parser?.close());

const fails = (r, re) => {
  assert.equal(r.ok, false, `expected ${r.invariant} to fail`);
  assert.throws(() => assertInvariant(r), (err) => err.code === "ERR_ASSERTION" && err.message.startsWith(`${r.invariant}: `) && re.test(err.message));
};
const holds = (r) => {
  assert.equal(r.ok, true, `${r.invariant}: ${r.failures.join("; ")}`);
  assert.equal(assertInvariant(r), r);
};
/** The draft's text as c10 reads it: no script or style, no tags. */
const textOf = (html) => html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "").replace(/<[^>]*>/g, "");
/** A fixture paragraph's quote: its 5th and 6th words, as c10 stages them. */
function quote(k) {
  const id = `e2e-${k}`;
  const text = FIXTURE.match(new RegExp(`<p id="${id}">([^<]*)</p>`))[1];
  return { id, text, exact: text.split(" ").slice(4, 6).join(" ") };
}
/** The fixture with paragraph k's quote bytes replaced by `by` (what lib/apply.ts spliceHtml does to the source). */
const splice = (html, q, by) => html.replace(`<p id="${q.id}">${q.text}</p>`, `<p id="${q.id}">${q.text.replace(q.exact, () => by)}</p>`);
const entry = (annId, q, replacement) => ({ annId, replacement, elementId: q.id, text: q.text, exact: q.exact });

test("checkI8 without draftHtml is the old count: same verdicts and failures, every entry judged by its count alone", () => {
  const r = checkI8({ draftText: "a ALPHA b BETA", accepted: [{ annId: "x", replacement: "ALPHA" }, { annId: "y", replacement: "BETA" }] });
  holds(r);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.entries, [
    { annId: "x", count: 1, elementId: null, reads: null, expected: null, shape: null },
    { annId: "y", count: 1, elementId: null, reads: null, expected: null, shape: null },
  ]);
  const missing = checkI8({ draftText: "a ALPHA b", accepted: [{ annId: "y", replacement: "BETA" }] });
  assert.deepEqual(missing.failures, ["y: its replacement is in the draft 0 time(s), not once"]);
  fails(checkI8({ draftText: "ALPHA ALPHA", accepted: [{ annId: "x", replacement: "ALPHA" }] }), /^I8: x: its replacement is in the draft 2 time\(s\), not once$/);
  // draftHtml given, no entry naming an element: still the count alone
  holds(checkI8({ draftText: "a ALPHA", draftHtml: "<p>a ALPHA</p>", accepted: [{ annId: "x", replacement: "ALPHA" }] }));
  assert.throws(() => checkI8({ draftText: "x", accepted: [{ annId: "d", replacement: "" }] }), TypeError);
});

test("in place: each replacement in its own paragraph in place of its quote holds; beside its kept quote, or in another paragraph, fails though counting finds it once", () => {
  const q1 = quote(1);
  const q2 = quote(2);
  const good = splice(splice(FIXTURE, q1, "c10-t-s1-ok"), q2, "c10-t-s2-ok");
  const accepted = [entry("A1", q1, "c10-t-s1-ok"), entry("A2", q2, "c10-t-s2-ok")];
  const r = checkI8({ draftText: textOf(good), draftHtml: good, accepted });
  holds(r);
  assert.deepEqual(r.entries.map((e) => [e.annId, e.count, e.elementId, e.shape]), [["A1", 1, "e2e-1", "in place"], ["A2", 1, "e2e-2", "in place"]]);
  assert.equal(r.entries[0].reads, q1.text.replace(q1.exact, "c10-t-s1-ok"));
  assert.equal(r.entries[0].expected, r.entries[0].reads);

  // controls-c10-i8-in-place's bug: the quote kept, the replacement put after it
  const kept = splice(splice(FIXTURE, q1, `${q1.exact} c10-t-s1-ok`), q2, "c10-t-s2-ok");
  holds(checkI8({ draftText: textOf(kept), accepted: accepted.map(({ annId, replacement }) => ({ annId, replacement })) }));
  const k = checkI8({ draftText: textOf(kept), draftHtml: kept, accepted });
  assert.deepEqual(k.failures, [
    `A1: its replacement is in the draft once, but not in place: #e2e-1 reads ${JSON.stringify(q1.text.replace(q1.exact, `${q1.exact} c10-t-s1-ok`))}, not its text with ${JSON.stringify(q1.exact)} replaced by "c10-t-s1-ok"`,
  ]);
  assert.deepEqual(k.entries.map((e) => e.shape), ["other", "in place"]);
  fails(k, /^I8: \S+: its replacement is in the draft once, but not in place: #e2e-\d+ reads "Paragraph \d+\. /);
  if (existsSync(CONTROL)) {
    const control = JSON.parse(readFileSync(CONTROL, "utf8"));
    fails(k, new RegExp(control.expect.message));
  }

  // the replacement in the wrong paragraph: #e2e-1 untouched, #e2e-3 holds it
  const q3 = quote(3);
  const elsewhere = splice(splice(FIXTURE, q3, "c10-t-s1-ok"), q2, "c10-t-s2-ok");
  fails(checkI8({ draftText: textOf(elsewhere), draftHtml: elsewhere, accepted }), new RegExp(`^I8: A1: its replacement is in the draft once, but not in place: #e2e-1 reads ${JSON.stringify(q1.text).replace(/[.]/g, "\\.")}, not its text`));

  // the quote replaced twice over in its paragraph: once in the text, still not the one span
  const q5 = { id: "e2e-5", text: "alpha beta gamma beta", exact: "gamma" };
  const twiceHtml = '<p id="e2e-5">alpha NEW NEW beta</p>';
  fails(checkI8({ draftText: textOf(twiceHtml), draftHtml: twiceHtml, accepted: [{ annId: "B", replacement: "NEW NEW", elementId: q5.id, text: q5.text, exact: q5.exact }] }), /#e2e-5 reads "alpha NEW NEW beta", not its text with "gamma" replaced by "NEW NEW"/);
});

test("in place: the paragraph missing or duplicated fails; a count other than one fails on the count alone, and absent with the paragraph untouched is told apart", () => {
  const q1 = quote(1);
  const good = splice(FIXTURE, q1, "R1");
  const gone = good.replace(`<p id="e2e-1">`, `<p id="e2e-x">`);
  fails(checkI8({ draftText: textOf(gone), draftHtml: gone, accepted: [entry("A", q1, "R1")] }), /#e2e-1 reads \(no such element, or more than one\)/);
  const doubled = good.replace(`<p id="e2e-2">`, `<p id="e2e-1">R0 </p><p id="e2e-2">`);
  fails(checkI8({ draftText: textOf(doubled), draftHtml: doubled, accepted: [entry("A", q1, "R1")] }), /#e2e-1 reads \(no such element, or more than one\)/);

  // absent: the count fails, no in-place line; the paragraph as it was
  const lost = checkI8({ draftText: textOf(FIXTURE), draftHtml: FIXTURE, accepted: [entry("A", q1, "R1")] });
  assert.deepEqual(lost.failures, ["A: its replacement is in the draft 0 time(s), not once"]);
  assert.equal(lost.entries[0].shape, "absent");
  assert.equal(lost.entries[0].reads, q1.text);
  // twice: the count fails alone, the shape is "other"
  const twice = splice(FIXTURE, q1, "R1 R1");
  const t = checkI8({ draftText: textOf(twice), draftHtml: twice, accepted: [entry("A", q1, "R1")] });
  assert.deepEqual(t.failures, ["A: its replacement is in the draft 2 time(s), not once"]);
  assert.equal(t.entries[0].shape, "other");
  // absent but the paragraph changed (the quote deleted): "other", not a lost update
  const deleted = splice(FIXTURE, q1, "");
  assert.equal(checkI8({ draftText: textOf(deleted), draftHtml: deleted, accepted: [entry("A", q1, "R1")] }).entries[0].shape, "other");
  // count failures come first, then the in-place ones
  const q2 = quote(2);
  const mixed = splice(splice(FIXTURE, q2, `${q2.exact} R2`), q1, "R1 R1");
  const m = checkI8({ draftText: textOf(mixed), draftHtml: mixed, accepted: [entry("A2", q2, "R2"), entry("A1", q1, "R1")] });
  assert.equal(m.failures.length, 2);
  assert.match(m.failures[0], /^A1: its replacement is in the draft 2 time/);
  assert.match(m.failures[1], /^A2: its replacement is in the draft once, but not in place/);
});

test("in place: a replacement holding $& or markup characters is compared as text (escaped in the source, decoded when read)", () => {
  const q = { id: "e2e-9", text: "one two three", exact: "two" };
  const by = "$& <b> & $1";
  const html = '<body><p id="e2e-9">one $&amp; &lt;b&gt; &amp; $1 three</p></body>';
  const r = checkI8({ draftText: "one $& <b> & $1 three", draftHtml: html, accepted: [{ annId: "S", replacement: by, elementId: q.id, text: q.text, exact: q.exact }] });
  holds(r);
  assert.equal(r.entries[0].expected, "one $& <b> & $1 three");
});

test("a caller's mistake is a TypeError, never a verdict", () => {
  const q = { id: "e2e-1", text: "a quote b", exact: "quote" };
  const draftHtml = '<p id="e2e-1">a R b</p>';
  const base = { draftText: "a R b", draftHtml };
  const typeError = (accepted, re, over = {}) => assert.throws(() => checkI8({ ...base, ...over, accepted }), (e) => e instanceof TypeError && re.test(e.message));
  typeError([{ annId: "A", replacement: "R", elementId: q.id }], /A judged in place needs elementId, text and exact \(it has elementId alone\)/);
  typeError([{ annId: "A", replacement: "R", elementId: q.id, exact: q.exact }], /it has elementId, exact alone/);
  typeError([{ annId: "A", replacement: "R", text: q.text, exact: q.exact }], /needs elementId, text and exact/);
  typeError([{ annId: "A", replacement: "R", elementId: "", text: q.text, exact: q.exact }], /elementId is the id/);
  typeError([{ annId: "A", replacement: "R", elementId: q.id, text: 5, exact: q.exact }], /text is its element's text/);
  typeError([{ annId: "A", replacement: "R", elementId: q.id, text: q.text, exact: "" }], /exact is its quote/);
  typeError([{ annId: "A", replacement: "R", elementId: q.id, text: q.text, exact: "zzz" }], /stands 0 time\(s\) in its element's text/);
  typeError([{ annId: "A", replacement: "R", elementId: q.id, text: "x b x", exact: "x" }], /stands 2 time\(s\)/);
  typeError([{ annId: "A", replacement: "R", ...q, elementId: q.id }], /needs draftHtml/, { draftHtml: undefined });
  typeError([{ annId: "A", replacement: "R", elementId: q.id, text: q.text, exact: q.exact }, { annId: "B", replacement: "S", elementId: q.id, text: q.text, exact: "b" }], /A and B both name #e2e-1/);
  assert.throws(() => checkI8({ draftText: "x", draftHtml: 5, accepted: [] }), TypeError);
  assert.throws(() => elementText(null, "x"), TypeError);
  assert.throws(() => elementText("<p id=x>", ""), TypeError);
});

test("elementText reads an element's textContent from the source: nesting, markup, references, comments, raw text", () => {
  assert.equal(elementText('<div id="x">a<div>b</div>c</div>d', "x"), "abc");
  assert.equal(elementText('<p id="x">one <b>two</b> <a href="/p">three</a></p>', "x"), "one two three");
  assert.equal(elementText('<p id="x">a &amp; b &lt;c&gt; &#233;&#xE9; &nbsp;&hellip; &bogus; &copy;</p>', "x"), "a & b <c> \u00e9\u00e9 \u00a0\u2026 &bogus; \u00a9");
  assert.equal(elementText('<p id="x">a<!-- </p> -->b<!---->c<!-->d</p>', "x"), "abcd");
  assert.equal(elementText('<p id="x">a<script>if (1 < 2) s = "</p>";</script>b<style>p>i{}</style>c</p>', "x"), 'aif (1 < 2) s = "</p>";bp>i{}c');
  assert.equal(elementText('<title id="x">a &amp; <b></title>', "x"), "a & <b>");
  assert.equal(elementText('<p id="x">a<br>b<img src="i.png" alt="no">c<br/>d</p>', "x"), "abcd");
  assert.equal(elementText('<pre id="x">\n  code\n</pre>', "x"), "  code\n");
  assert.equal(elementText('<p id="x">a\r\nb\rc</p>', "x"), "a\nb\nc");
  assert.equal(elementText('<p id="x">1 < 2 and 3 <4</p>', "x"), "1 < 2 and 3 <4");
  assert.equal(elementText('<img id="x" src="a">', "x"), "");
  assert.equal(elementText('<p id="x"></p>', "x"), "");
});

test("elementText matches the id attribute itself, exactly once, however it is written", () => {
  assert.equal(elementText('<p data-id="x">no</p><p id="x">yes</p>', "x"), "yes");
  assert.equal(elementText('<p title="id=x">no</p><p ID=\'x\'>yes</p>', "x"), "yes");
  assert.equal(elementText('<p class=a id=x>yes</p>', "x"), "yes");
  assert.equal(elementText('<p id = "x" >yes</p>', "x"), "yes");
  assert.equal(elementText('<p title="a > b" id="x">yes</p>', "x"), "yes");
  assert.equal(elementText('<p id="a&amp;b">yes</p>', "a&b"), "yes");
  assert.equal(elementText('<p id="x" id="y">yes</p>', "y"), null, "the first of two id attributes wins");
  assert.equal(elementText('<p id="X">no</p>', "x"), null);
  assert.equal(elementText('<p id="x">a</p><p id="x">b</p>', "x"), null);
  assert.equal(elementText('<div id="x"><span id="x">a</span></div>', "x"), null);
  assert.equal(elementText("<p>nothing</p>", "x"), null);
  assert.equal(elementText('<p id="x', "x"), null, "a tag the input ends inside is dropped");
});

test("elementText ends an element where the HTML parser does", () => {
  assert.equal(elementText('<p id="x">a<div>b</div>', "x"), "a", "a block start tag closes a p");
  assert.equal(elementText('<p id="x">a<p>b', "x"), "a");
  assert.equal(elementText('<p id="x">a<button>b<div>c</div>d</button>e</p>', "x"), "abcde", "inside a button the p is out of button scope");
  assert.equal(elementText('<div><p id="x">a</div>b', "x"), "a", "an enclosing block's end tag");
  assert.equal(elementText('<p id="x">a</span>b</b>c</p>', "x"), "abc", "a stray inline end tag is ignored");
  assert.equal(elementText('<p><span id="x">a</p>b', "x"), "a", "a p's end tag closes a span inside it");
  assert.equal(elementText('<div id="x">a</p>b</div>', "x"), "ab", "a stray </p> does not close a div");
  assert.equal(elementText('<ul><li id="x">a<li>b</ul>', "x"), "a");
  assert.equal(elementText('<ul><li id="x">a<ul><li>b</ul>c<li>d</ul>', "x"), "abc", "a nested list's item does not close it");
  assert.equal(elementText('<dl><dt id="x">a<dd>b</dl>', "x"), "a");
  assert.equal(elementText('<div id="x">a<svg><path d="M0"/><circle/></svg>b</div>', "x"), "ab", "self-closed in svg");
  assert.equal(elementText('<svg><circle id="x"/><text>t</text></svg>', "x"), "");
  assert.equal(elementText('<div id="x">a<span/>b</span>c</div>', "x"), "abc", "a self-closing slash on an HTML element is ignored");
  assert.equal(elementText('<section id="x">a<p>b<p>c</section>d', "x"), "abc");
  assert.equal(elementText('<p id="x">open to the end', "x"), "open to the end");
});

test("elementText decodes references as the parser does: legacy ones without their ;, windows-1252 numbers, and an attribute's own rule", () => {
  assert.equal(elementText('<p id="x">&amp &lt; &AMP; &Amp; &ampx &amp1 &copyright &lt=</p>', "x"), "& < & &Amp; &x &1 \u00a9right <=");
  assert.equal(elementText('<p id="x">x &#0; &#xD800; &#x110000; &#65 &#x41 y</p>', "x"), "x \ufffd \ufffd \ufffd A A y");
  assert.equal(elementText('<p id="x">a&#150;b&#x80;c&#x81;d</p>', "x"), "a\u2013b\u20acc\u0081d");
  assert.equal(elementText('<p id="a&ampb">yes</p>', "a&ampb"), "yes", "in an attribute a legacy reference before a letter stays");
  assert.equal(elementText('<p id="c&amp=d">yes</p>', "c&amp=d"), "yes", "and before =");
  assert.equal(elementText('<p id="g&amp">yes</p>', "g&"), "yes", "at the end of the value it is decoded");
});

test("elementText: headings, quirks mode, template contents", () => {
  assert.equal(elementText('<h2 id="x">a<h3>b</h3></h2>', "x"), "a", "a heading start tag closes the heading it meets");
  assert.equal(elementText('<h2 id="x">a<span><h3>b</h3></span>c</h2>d', "x"), "abc", "unless something is open inside it");
  assert.equal(elementText('<h1 id="x">a</h3>b', "x"), "a", "any heading's end tag ends it");
  assert.equal(elementText('<p id="x">a<table><tr><td>b</td></tr></table>c</p>', "x"), "abc", "no doctype: quirks mode, where a table stays in the p");
  assert.equal(elementText('<!DOCTYPE html><p id="x">a<table><tr><td>b</td></tr></table>c</p>', "x"), "a");
  assert.equal(elementText('<!-- c --><!doctype html><p id="x">a<table></table>c</p>', "x"), "a");
  assert.equal(elementText('<div id="x">a<template>b<p id="y">c</p><template>d</template>e</template>f</div><p id="y">g</p>', "x"), "af");
  assert.equal(elementText('<div><template><p id="y">c</p></template></div><p id="y">g</p>', "y"), "g", "an id inside a template is not the document's");
  assert.equal(elementText('<template id="x">a</template>', "x"), "");
});

/** Edge cases the parser model claims, each checked against Chrome's own parse (no noscript: DOMParser parses with scripting off). */
const AGAINST_CHROME = [
  '<div id="x">a<div>b</div>c</div>d', '<p id="x">one <b>two</b> <a href="/p">three</a></p>', '<p id="x">a &amp; b &lt;c&gt; &#233;&#xE9; &nbsp;&hellip; &bogus; &copy;</p>',
  '<p id="x">a<!-- </p> -->b<!---->c<!-->d</p>', '<p id="x">a<script>if (1 < 2) s = "</p>";</script>b<style>p>i{}</style>c</p>', '<title id="x">a &amp; <b></title>',
  '<p id="x">a<br>b<img src="i.png" alt="no">c<br/>d</p>', '<pre id="x">\n  code\n</pre>', '<p id="x">a\r\nb\rc</p>', '<p id="x">1 < 2 and 3 <4</p>', '<img id="x" src="a">',
  '<p data-id="x">no</p><p id="x">yes</p>', "<p title=\"id=x\">no</p><p ID='x'>yes</p>", '<p class=a id=x>yes</p>', '<p id = "x" >yes</p>', '<p title="a > b" id="x">yes</p>',
  '<p id="a&amp;b">yes</p>', '<p id="x" id="y">yes</p>', '<p id="x">a</p><p id="x">b</p>', '<div id="x"><span id="x">a</span></div>', '<p id="x',
  '<p id="x">a<div>b</div>', '<p id="x">a<p>b', '<p id="x">a<button>b<div>c</div>d</button>e</p>', '<div><p id="x">a</div>b', '<p id="x">a</span>b</b>c</p>',
  '<p><span id="x">a</p>b', '<div id="x">a</p>b</div>', '<ul><li id="x">a<li>b</ul>', '<ul><li id="x">a<ul><li>b</ul>c<li>d</ul>', '<dl><dt id="x">a<dd>b</dl>',
  '<div id="x">a<svg><path d="M0"/><circle/></svg>b</div>', '<svg><circle id="x"/><text>t</text></svg>', '<div id="x">a<span/>b</span>c</div>',
  '<section id="x">a<p>b<p>c</section>d', '<p id="x">open to the end', '<p id="x">a<textarea>b</p>c</textarea>d</p>', '<p id="x">a<?php echo 1 ?>b<!doctype x>c</p>',
  '<p id="x">a</>b</ x>c</p>', '<h2 id="x">a<h3>b</h3></h2>', '<h2 id="x">a<span><h3>b</h3></span>c</h2>d', '<h1 id="x">a</h3>b',
  '<p id="x">a<table><tr><td>b</td></tr></table>c</p>', '<!DOCTYPE html><p id="x">a<table><tr><td>b</td></tr></table>c</p>', '<div id="x">a<p>b<ul><li>c</li></ul>d</div>',
  '<p id="x">a<b>b<div>c</div>d</b>e</p>', '<li id="x">a<div>b<li>c</div>d', '<div id="x">a<form>b</form>c</div>d', '<p id="x">a<listing>\nb</listing>c', '<span id="x">a<p>b</p>c</span>d',
  '<a id="x" href="/">a<div>b</div>c</a>d', '<p id="x">a<math><mi>x</mi></math>b</p>', '<p id="x" >a<input type=text value="v">b<select><option>o1<option>o2</select>c</p>',
  '<p id="x">&amp &lt; &AMP; &Amp; &ampx &amp1 &copyright &lt=</p>', '<p id="x">x &#0; &#xD800; &#x110000; &#65 &#x41 y</p>', '<p id="x">a&#150;b&#x80;c&#x81;d</p>',
  '<p id="a&ampb">yes</p><p id="c&amp=d">y2</p><p id="e&amp;f">y3</p><p id="g&amp">y4</p>', '<div id="x">a<template>b<p id="y">c</p><template>d</template>e</template>f</div><p id="y">g</p>',
  '<template id="x">a</template>', '<div id="x">a<template>b', '<p id="x">a<object>b<div>c</div>d</object>e</p>',
];
const idsOf = (html) => [...new Set([...html.matchAll(/\bid\s*=\s*["']?([^"'\s>]+)/gi)].map((m) => m[1]).concat(["x", "a&b", "e&f", "g&"]))];

test("elementText reads every element as Chrome's parser does: the edge cases above and every id of every e2e fixture", async () => {
  const docs = [...AGAINST_CHROME, ...readdirSync(FIXTURES).filter((n) => n.endsWith(".html")).map((n) => readFileSync(join(FIXTURES, n), "utf8"))];
  let checked = 0;
  const off = [];
  for (const html of docs) {
    const ids = idsOf(html);
    const chrome = await parser.page.evaluate(({ html, ids }) => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const all = [...doc.querySelectorAll("[id]")];
      return ids.map((id) => {
        const m = all.filter((e) => e.getAttribute("id") === id);
        return m.length === 1 ? m[0].textContent : null;
      });
    }, { html, ids });
    ids.forEach((id, i) => {
      checked += 1;
      const mine = elementText(html, id);
      if (mine !== chrome[i]) off.push(`#${id} in ${JSON.stringify(html.slice(0, 80))}: ${JSON.stringify(mine)?.slice(0, 80)}, Chrome ${JSON.stringify(chrome[i])?.slice(0, 80)}`);
    });
  }
  assert.deepEqual(off, [], `${off.length} of ${checked} element(s) read differently from Chrome`);
  assert.ok(checked > 700, `${checked} element(s) checked`);
});

test("the README documents I8 in place and elementText", () => {
  const readme = readFileSync(join(HERE, "..", "README.md"), "utf8");
  assert.ok(readme.includes("`checkI8({draftText, draftHtml = null, accepted: [{annId, replacement, elementId?, text?, exact?}]})` → `+{entries}`"), "the invariants table names checkI8's in-place call");
  assert.ok(readme.includes("`elementText(html, id)` → string \\| null"), "and elementText as its reader");
  const section = readme.slice(readme.indexOf("**I8 in place.**"));
  assert.ok(readme.includes("**I8 in place.**"), "the README explains I8 in place");
  for (const words of ["but not in place: #<elementId> reads", "give all three or none", '`"absent"`', "A TypeError, never a verdict", "Chrome's own"]) assert.ok(section.includes(words), `the I8 in place section says ${JSON.stringify(words)}`);
});
