// SPDX-License-Identifier: Apache-2.0
// Real-browser controls for Markdown hierarchy and external-resource inspection (SPEC §11).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { BrowserPool } from "../lib/browser.mjs";
import { inspectMarkdownRendering } from "../lib/markdown-inspection.mjs";
const target = { kind: "local", runId: "selftest-markdown-inspection", origin: "http://127.0.0.1:1", stack: { ports: { hosting: 1 } }, capabilities: new Set(["local"]) };
let pool, parser;
before(async () => { pool = new BrowserPool({ target }); parser = await pool.parser(); });
after(async () => pool?.close());
const sections = '<section id="preamble"><p>Before</p></section><section id="title"><h1>Title</h1><section id="notes"><h2>Notes</h2><p>Text</p></section></section>';
const inspect = (html) => parser.evaluate(inspectMarkdownRendering, html);

test("hierarchy keeps DOM order, heading identity and each nearest section parent", async () => {
  const normal = await inspect('<style id="theme">p{color:black}</style>'+sections);
  assert.deepEqual(normal.sections, [
    { id:"preamble",parent:null,firstTag:"p",firstText:"Before" },
    { id:"title",parent:null,firstTag:"h1",firstText:"Title" },
    { id:"notes",parent:"title",firstTag:"h2",firstText:"Notes" },
  ]);
  assert.deepEqual(normal.styleIds,["theme"]);
  const flat = await inspect(sections.replace('<section id="notes">','</section><section id="notes">').replace('</section></section>','</section>'));
  assert.notDeepEqual(flat.sections, normal.sections, "negative: flat sections retain ids but lose hierarchy");
  const wrong = await inspect(sections.replace('<h2>Notes</h2>','<p>Notes</p>'));
  assert.notDeepEqual(wrong.sections, normal.sections, "negative: a paragraph cannot stand in for the heading");
});

test("self-contained style, local and data resources have no external URL", async () => {
  assert.deepEqual((await inspect('<style>#x{background:url(data:image/png;base64,AA==)}</style><a href="#x">Link</a><img src="image.png"><img src="data:image/png;base64,AA==">')).external,[]);
});

for (const [channel, html] of [
  ['source','<img src="https://outside.invalid/a.png">'],
  ['source-set','<img srcset="local.png 1x, //outside.invalid/a.png 2x">'],
  ['image-source-set','<link imagesrcset="https://outside.invalid/a.png 2x">'],
  ['object-data','<object data="https://outside.invalid/a.pdf"></object>'],
  ['refresh','<meta http-equiv="refresh" content="0; url=https://outside.invalid/">'],
  ['css-url','<style>p{background:url(https://outside.invalid/a.png)}</style>'],
  ['inline-css','<p style="background:url(//outside.invalid/a.png)">Text</p>'],
  ['css-import','<style>@import "https://outside.invalid/a.css";</style>'],
]) test(`negative: ${channel} cannot hide an external resource`, async () => {
  assert.ok((await inspect(html)).external.length > 0, channel);
});
