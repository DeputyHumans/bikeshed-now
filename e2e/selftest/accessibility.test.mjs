// SPDX-License-Identifier: Apache-2.0
// Real-Chrome negative controls for the explicit accessibility inspector and product focus/touch/forced-colour CSS (SPEC §7, §10).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BrowserPool } from '../lib/browser.mjs';
import { observeFrameFocus } from '../../app/src/viewer/frameFocus.ts';
import { inspectUi, spokenText } from '../lib/accessibility.mjs';

const target = { kind: 'local', runId: 'selftest-accessibility', origin: 'http://127.0.0.1:1', stack: { ports: { hosting: 1 } }, capabilities: new Set(['local']) };
let pool;
let u;
before(async () => {
  pool = new BrowserPool({ target });
  u = await pool.user({ device: { width: 400, height: 800, touch: true } });
  // Navigate before document.write-based fixtures: Chromium can leave its initial
  // blank document with desktop pointer media despite the context's touch setting.
  await u.page.goto('data:text/html,<!doctype html><title>Accessibility fixture</title>');
  assert.equal(await u.page.evaluate(() => navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches), true, 'accessibility fixture is a real touch context');
});
after(async () => pool?.close());
const html = (body, css = '') => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--color-focus:rgb(0,118,155)}body{font:16px Arial;color:#111;background:#fff}button,input,select,a{min-width:44px;min-height:44px} ${css}</style>${body}`;

test('contrast resolves translucent backgrounds, large type, opacity and placeholders; each bad paint is caught', async () => {
  await u.page.setContent(html('<p>Readable</p><div style="background:color(srgb 0 0 0 / .6)"><p style="color:white">Readable on grey</p></div><p style="font-size:24px;color:#777">Large text</p><input aria-label="Address" placeholder="Address">', 'input::placeholder{color:#555;opacity:1}'));
  assert.deepEqual((await inspectUi(u.page)).issues.contrast, []);
  for (const [paint, text] of [['color:#aaa', 'Low contrast'], ['color:#111;opacity:.2', 'Faded'], ['background:linear-gradient(white,black)', 'Unmeasured gradient']]) {
    await u.page.setContent(html(`<p style="${paint}">${text}</p>`));
    assert.equal((await inspectUi(u.page)).issues.contrast[0]?.text, text, `negative: ${paint}`);
  }
  await u.page.setContent(html('<input aria-label="Address" placeholder="Poor placeholder">', 'input::placeholder{color:#aaa;opacity:1}'));
  assert.equal((await inspectUi(u.page)).issues.contrast[0]?.text, 'Poor placeholder');
});

test('Chrome computes control names; labels and decorative images pass, unnamed controls and missing alt fail', async () => {
  await u.page.setContent(html('<label for="email">Email</label><input id="email"><button aria-label="Close">×</button><img alt="" width="20" height="20"><iframe srcdoc="<button></button>"></iframe>'));
  assert.deepEqual((await inspectUi(u.page)).issues.names, []);
  await u.page.setContent(html('<button></button><input><img width="20" height="20">'));
  const issues = (await inspectUi(u.page)).issues.names;
  assert.ok(issues.some((x) => x.role === 'button'));
  assert.ok(issues.some((x) => x.role === 'textbox'));
  assert.ok(issues.some((x) => /missing alt/.test(x.problem)));
});

test('spoken words exclude hidden, CSS-hidden and aria-hidden descendants but retain clipped labels', async () => {
  await u.page.setContent(html('<div id="words"><span style="position:absolute;clip-path:inset(50%)">Replace </span>old<span aria-hidden="true"> → </span><span class="spoken"> with </span>new<span hidden> hidden</span><span style="display:none"> display none</span><span style="visibility:hidden"> invisible</span></div>'));
  assert.equal(await spokenText(u.page.locator('#words')), 'Replace old with new');
  await u.page.addStyleTag({ content: '.spoken{display:none}' });
  assert.notEqual(await spokenText(u.page.locator('#words')), 'Replace old with new', 'negative: hidden spoken words are not counted');
});

test('nested scrollports, fixed overlays and non-button targets have independent negative controls', async () => {
  await u.page.setContent(html('<div style="width:100px;overflow:auto"><div style="width:600px">Wide content</div></div><aside style="position:fixed;left:350px;width:100px">Overlay</aside><a href="#">Link</a><select aria-label="Mode"><option>View</option></select><label style="display:inline-block;width:80px;height:44px"><input type="checkbox">Check</label>', 'a,select{min-width:0;min-height:0}'));
  const { issues } = await inspectUi(u.page);
  assert.equal(issues.horizontal.length, 2);
  assert.ok(issues.small.some((x) => x.element.startsWith('a.')));
  assert.ok(issues.small.some((x) => x.element.startsWith('select.')));
  assert.ok(!issues.small.some((x) => x.element.startsWith('input.')), 'associated label supplies checkbox hit area');
});

test('focus colour is reserved by actual paint, including non-focused outlines; a focus ring is allowed', async () => {
  await u.page.setContent(html('<button id="focus">Focus</button><p style="color:var(--color-focus)">Reserved colour</p><div style="outline:2px solid var(--color-focus)">Wrong outline</div>', ':focus-visible{outline:2px solid var(--color-focus)}'));
  await u.page.keyboard.press('Tab');
  const issues = (await inspectUi(u.page)).issues.focusPaint;
  assert.equal(issues.length, 2);
  assert.ok(issues.some((x) => x.paints.includes('text')));
  assert.ok(issues.some((x) => x.paints.includes('outline')));
});

const cssFiles = ['tokens', 'base', 'primitives', 'viewer', 'slides', 'comments'];
async function productCss() {
  const sheets = await Promise.all(cssFiles.map(async (name) => `@layer ${name}{${await readFile(new URL(`../../app/src/styles/${name}.css`, import.meta.url), 'utf8')}}`));
  return `@layer tokens,base,primitives,viewer,slides,comments;${sheets.join('\n')}`;
}
const controls = '<button class="btn btn-sm">Small button</button><a href="#">Navigation</a><select aria-label="Mode"><option>View</option></select><label class="check-label"><input type="checkbox">Check</label><div class="checkbox-row"><input type="checkbox" id="account-check"><label for="account-check">Default marking</label></div><iframe class="doc-frame" title="Document" srcdoc="<p>Authored content</p>"></iframe>';

test('the actual product cascade floors touch controls and paints the focused iframe; old cascade and iframe exemption fail', async () => {
  const css = await productCss();
  await u.page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}.check-label{display:flex;align-items:center}</style>${controls}`);
  assert.deepEqual((await inspectUi(u.page)).issues.small, []);
  await u.page.evaluate(`window.stopFocus = (${observeFrameFocus.toString()})(document.querySelector('iframe'))`);
  await u.page.locator('button').focus();
  await u.page.locator('iframe').focus();
  await u.page.waitForFunction(() => document.querySelector('iframe').hasAttribute('data-frame-focus'));
  const ring = () => u.page.locator('iframe').evaluate((el) => { const s = getComputedStyle(el); return [s.outlineStyle, s.outlineWidth, s.outlineColor]; });
  await u.page.waitForFunction(() => getComputedStyle(document.querySelector('iframe')).outlineWidth === '2px');
  assert.deepEqual(await ring(), ['solid', '2px', 'rgb(0, 118, 155)']);
  await u.page.addStyleTag({ content: '@layer base{button{min-width:0!important;min-height:0!important}} iframe.doc-frame[data-frame-focus]{outline:none!important}' });
  assert.ok((await inspectUi(u.page)).issues.small.some((x) => x.element.includes('btn-sm')), 'negative: touch floor removed');
  assert.notEqual((await ring())[0], 'solid', 'negative: iframe exemption restored');
  await u.page.locator('button').focus();
  assert.equal(await u.page.locator('iframe').getAttribute('data-frame-focus'), null, 'the indicator leaves when focus returns to the app');
  await u.page.evaluate(() => window.stopFocus());
});

test('forced-colour presence dots retain visible paint; browser colour substitution without the override erases them', async () => {
  await u.page.emulateMedia({ forcedColors: 'active' });
  try {
    await u.page.setContent(`<style>${await productCss()}</style><button class="presence-chip"><span class="presence-dot" data-mode="view"></span><span>Reader</span></button>`);
    const paint = () => u.page.locator('.presence-dot').evaluate((dot) => [getComputedStyle(dot).backgroundColor, getComputedStyle(dot.parentElement).backgroundColor]);
    const good = await paint();
    assert.notEqual(good[0], good[1]);
    await u.page.addStyleTag({ content: '.presence-dot{forced-color-adjust:auto!important;background:currentColor!important}' });
    const bad = await paint();
    assert.equal(bad[0], bad[1], 'negative: both become Canvas in forced colours');
  } finally { await u.page.emulateMedia({ forcedColors: 'none' }); }
});

test('the phone slide drawer stays below the viewer toolbar; the previous viewport anchoring covers Comments', async () => {
  await u.page.setContent(`<style>${await productCss()}</style><div style="height:var(--header-h)"></div><div class="viewer"><div class="viewer-toolbar"><div class="pane-toggle"><button>Document</button><button id="comments">Comments</button></div></div><div class="viewer-body"><div class="doc-frame-wrap"><aside class="slide-rail" data-drawer="open"><button class="slide-thumb"><span class="slide-thumb-box">Slide one</span></button></aside><main class="doc-frame-stage">Document</main></div></div></div>`);
  const reachable = () => u.page.locator('#comments').evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
  assert.equal(await reachable(), true);
  await u.page.addStyleTag({ content: '@media(max-width:860px){.slide-rail{position:fixed;inset:var(--header-h) auto 0 0}}' });
  assert.equal(await reachable(), false, 'negative: the old drawer overlaps the toolbar');
});

test('the phone toolbar keeps its actions visible and every presence chip reachable at 2, 5, 10 and 20 people', async () => {
  const css = await productCss();
  for (const peers of [1, 4, 9, 19]) {
    const chips = Array.from({ length: peers }, (_, i) => `<button class="presence-chip"><span class="presence-dot" data-mode="view"></span><span class="presence-name">person-${i}@example.test</span></button>`).join('');
    await u.page.setContent(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div class="viewer-toolbar"><span class="chip mono">v1</span><div class="presence-bar" role="group" aria-label="People here now">${chips}</div><div class="viewer-toolbar-actions"><div class="pane-toggle"><button>Document</button><button>Comments</button></div><button class="btn" aria-label="Edit">Edit</button></div></div>`);
    const layout = await u.page.evaluate(() => {
      const bar = document.querySelector('.viewer-toolbar');
      const presence = document.querySelector('.presence-bar');
      const width = document.documentElement.clientWidth;
      const reachable = (el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.width > 0 && r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= innerHeight && !!hit && (hit === el || el.contains(hit));
      };
      const actions = [...bar.querySelectorAll('.viewer-toolbar-actions button')].map(reachable);
      const chips = [...presence.querySelectorAll('.presence-chip')].map((el) => {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
        return reachable(el);
      });
      presence.scrollLeft = 0;
      return { page: document.documentElement.scrollWidth, width, bar: bar.scrollWidth, barWidth: bar.clientWidth, actions, chips };
    });
    assert.ok(layout.page <= layout.width && layout.bar <= layout.barWidth, `${peers} peers: toolbar and page fit the phone: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.actions, [true, true, true], `${peers} peers: primary actions remain on screen at rest`);
    assert.deepEqual(layout.chips, Array(peers).fill(true), `${peers} peers: every named person is reachable, not hidden`);
  }
});
