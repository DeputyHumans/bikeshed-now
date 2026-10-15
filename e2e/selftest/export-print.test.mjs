// SPDX-License-Identifier: Apache-2.0
// Real print snapshots retain marking above authored ancestors and hide every rendered chrome surface (SPEC §20).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from '../../app/node_modules/esbuild/lib/main.js';
import { BrowserPool } from '../lib/browser.mjs';
import { colourPixels } from '../lib/png.mjs';

const source = resolve(process.env.E2E_PRINT_SOURCE_DIR ?? new URL('../..', import.meta.url).pathname);
const target = { kind: 'local', runId: 'selftest-export-print', origin: 'http://127.0.0.1:1', stack: { ports: { hosting: 1 } }, capabilities: new Set(['local']) };
const MARKS = '.bshd-print-mark,.bshd-print-footer';
const marking = { enabled: true, label: 'VISIBLE MARKING', footer: 'VISIBLE FOOTER' };
let pool, user, bundle;
before(async () => {
  bundle = (await build({ stdin: { contents: `import {printDoc} from ${JSON.stringify(`${source}/app/src/export/pdf.ts`)};window.printProduct=printDoc;`, resolveDir: source }, bundle: true, write: false, format: 'iife', platform: 'browser', define: { 'import.meta.env.DEV': 'false' } })).outputFiles[0].text;
  pool = new BrowserPool({ target }); user = await pool.user();
});
after(async () => pool?.close());

async function captured(html) {
  await user.page.setContent('<!doctype html><title>Print host</title>');
  await user.page.addScriptTag({ content: bundle });
  const result = await user.capturePrint(() => user.page.evaluate(({ html, marking }) => window.printProduct(new DOMParser().parseFromString(html, 'text/html'), { marking }), { html, marking }), {
    match: '[sandbox~="allow-modals"]',
    extract: (doc) => ({ marks: [...doc.querySelectorAll('.bshd-print-mark,.bshd-print-footer')].map((el) => ({ name: el.className, topLayer: el.matches(':popover-open'), position: el.style.position })) }),
  });
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].printed, 1);
  return { html: result.frames[0].snaps[0].html, ...result.frames[0].snaps[0].extra };
}

async function painted(html, marks, width = 794) {
  const renderer = await pool.printRenderer({ width, height: 1123 });
  try {
    return await renderer.render(html, {
      probe: (page) => page.evaluate((marks) => {
        // A serialized snapshot loses top-layer state; replay ONLY what the
        // product had already activated when it actually called print().
        for (const mark of marks.filter((m) => m.topLayer)) document.getElementsByClassName(mark.name)[0].showPopover();
        return [...document.querySelectorAll('.bshd-print-mark,.bshd-print-footer')].map((el) => { const r = el.getBoundingClientRect(); return { name: el.className, rect: [r.x, r.y, r.width, r.height] }; });
      }, marks),
      without: MARKS,
      regions: { label: { x: width - 420, y: 0, w: 420, h: 80, color: [176,35,24] }, footer: { x: 0, y: 1063, w: width, h: 60, color: [74,74,85] } },
    });
  } finally { await renderer.close(); }
}

function assertPaint(out, label) {
  for (const key of ['label', 'footer']) assert.ok(out.pixels[key].count >= 20, `${label}: ${key} paints readable glyphs in its page-edge region: ${JSON.stringify(out.pixels[key])}`);
  for (const { rect: [x,y,w,h] } of out.probed) assert.ok(x >= 0 && y >= 0 && x+w <= out.width+1 && y+h <= out.height+1, `${label}: stamp remains inside the page`);
}

test('the actual print call has two fixed top-layer marks, preserves authored page geometry and strips live decoration', async () => {
  const snap = await captured('<!doctype html><style>@page{size:200mm 120mm;margin:9mm}</style><p>A <mark class="bshd-hl" data-bshd-ann="thread">passage</mark></p>');
  assert.deepEqual(snap.marks.map((m) => [m.position,m.topLayer]), [['fixed',true],['fixed',true]]);
  assert.equal((snap.html.match(/@page/g) ?? []).length, 1, 'print adds no page geometry');
  assert.ok(snap.html.includes('200mm 120mm'));
  assert.equal(snap.html.includes('bshd-hl'), false, 'DECOR is absent from the actual print snapshot');
});

test('body and html containing blocks cannot hide marking while authored content remains visible; omitting top-layer activation fails', async () => {
  for (const ancestor of ['body','html']) for (const vector of ['transform:translateZ(0)','filter:opacity(1)','contain:paint']) {
    const snap = await captured(`<!doctype html><style>html,body{margin:0;background:white} ${ancestor}{${vector};position:relative;top:-10000px;padding-top:10000px}#authored{height:80px;width:220px;background:rgb(0,128,0);color:white}</style><div id="authored">AUTHORED CONTENT</div>`);
    const out = await painted(snap.html, snap.marks);
    assert.ok(colourPixels(out.basePng, { color:[0,128,0], tol:0 }).count > 1000, 'the ancestor vector preserves visible authored content');
    assertPaint(out, `${ancestor} ${vector}`);
    if (ancestor === 'body' && vector.startsWith('transform')) {
      const negative = await painted(snap.html, snap.marks.map((m) => ({ ...m, topLayer:false })));
      assert.throws(() => assertPaint(negative,'old placement'), /label paints readable glyphs/, 'negative: unpromoted fixed descendants disappear while content remains');
    }
  }
});

test('independent rotation is neutralized on both print marks; removing the lock fails with a live edge-on author rule', async () => {
  const snap = await captured('<!doctype html><style>.bshd-print-mark,.bshd-print-footer{rotate:x 90deg!important}</style><p>Content</p>');
  assertPaint(await painted(snap.html, snap.marks), 'rotate');
  const unlocked = snap.html.replace(/rotate:\s*none\s*!important;?/g, '');
  assert.notEqual(unlocked,snap.html,'the control removes the independent rotation lock');
  const negative = await painted(unlocked, snap.marks);
  assert.throws(() => assertPaint(negative,'without rotate'), /label paints readable glyphs/);
});

test('print media hides all five rendered chrome classes; dropping each selector is independently detected', async () => {
  const css = await readFile(`${source}/app/src/styles/viewer.css`, 'utf8');
  const selectors = ['.app-header','.viewer-toolbar','.viewer-banners','.comments-panel','.consent'];
  const body = selectors.map((s) => `<div class="${s.slice(1)}">Rendered ${s}</div>`).join('');
  const read = () => user.page.evaluate((ss) => Object.fromEntries(ss.map((s) => [s,getComputedStyle(document.querySelector(s)).display])),selectors);
  const check = (r) => assert.deepEqual(r,Object.fromEntries(selectors.map((s)=>[s,'none'])),'all rendered viewer chrome is hidden in print media');
  await user.page.setContent(`<style>${css}</style>${body}`);
  await user.page.emulateMedia({media:'screen'});
  assert.ok(Object.values(await read()).every((x)=>x!=='none'),'all five elements exist and display before print');
  await user.page.emulateMedia({media:'print'});check(await read());
  for (const selector of selectors) {
    const start=css.indexOf('@media print {');const before=css.slice(0,start), media=css.slice(start);
    assert.ok(media.includes(`  ${selector},`));
    await user.page.setContent(`<style>${before}${media.replace(`  ${selector},\n`,'')}</style>${body}`);
    const result = await read();
    assert.throws(()=>check(result), /all rendered viewer chrome/);
  }
  await user.page.emulateMedia({media:'screen'});
});


test('the print layout permits a full-height frame to paginate; clipping the viewer makes the pagination oracle fail', async () => {
  const css = await readFile(`${source}/app/src/styles/viewer.css`, 'utf8');
  const body = '<div class="viewer"><div class="viewer-body"><iframe style="height:3600px;width:100%;border:0" srcdoc="<p style=&quot;height:3500px&quot;>Long authored content</p>"></iframe></div></div>';
  const count = async (styles) => {
    await user.page.emulateMedia({ media: 'print' });
    await user.page.setContent(`<style>${styles}</style>${body}`);
    const pdf = await user.page.pdf({ format:'A4' });
    return Number(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/s.exec(pdf.toString('latin1'))?.[1] ?? 0);
  };
  assert.ok(await count(css) >= 2, 'the document paginates');
  const clipped = css.replace('  .viewer { height: auto; }','  .viewer { height: 700px; position: fixed; overflow: hidden; }');
  assert.notEqual(clipped,css);
  assert.equal(await count(clipped),1,'negative: the viewer clips all but the first page');
});
