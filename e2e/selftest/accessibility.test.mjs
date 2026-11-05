// SPDX-License-Identifier: Apache-2.0
// Real-Chrome negative controls for the explicit accessibility inspector and product focus/touch/forced-colour CSS (SPEC §7, §10).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BrowserPool } from '../lib/browser.mjs';
import { observeFrameFocus } from '../../app/src/viewer/frameFocus.ts';
import { chipsThatFit } from '../../app/src/components/presenceFit.ts';
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

test('two controls in one layer may not overlap; a floating layer may cover the page, and a control may hold another', async () => {
  await u.page.setContent(html('<div style="display:flex;width:300px"><a href="#" style="width:120px;flex:none">Home</a><a href="#" style="width:60px;margin-left:-40px;flex:none">Docs</a></div>'));
  const hit = (await inspectUi(u.page)).issues.overlap;
  assert.equal(hit.length, 1, 'negative: a wordmark over the link beside it');
  await u.page.setContent(html('<div style="position:relative"><button>Page</button><div style="position:absolute;top:0;left:0"><button>Menu item</button></div></div><summary><a href="#">Inside</a></summary>'));
  assert.deepEqual((await inspectUi(u.page)).issues.overlap, []);
  // A field scrolled out of a dialog's body is not under the dialog's footer.
  await u.page.setContent(html('<div style="height:60px;overflow:auto"><input aria-label="Body field" style="display:block;margin-top:50px;height:44px"></div><button style="display:block">Footer</button>'));
  assert.deepEqual((await inspectUi(u.page)).issues.overlap, []);
});

test('a control past the screen or cut by a box is clipped; one inside a scroller is not', async () => {
  await u.page.setContent(html('<div style="width:600px"><button style="margin-left:380px">Sign out</button></div>'));
  assert.equal((await inspectUi(u.page)).issues.clipped[0]?.by, 'the viewport', 'negative: an action off the edge of the screen');
  await u.page.setContent(html('<div style="width:100px;height:60px;overflow:hidden"><button style="margin-left:80px">Cut</button></div>'));
  assert.ok((await inspectUi(u.page)).issues.clipped[0]?.by.startsWith('div'), 'negative: an action cut by its box');
  await u.page.setContent(html('<div style="width:100px;overflow:auto"><button style="margin-left:300px">Scrolled</button></div><button>Fine</button>'));
  assert.deepEqual((await inspectUi(u.page)).issues.clipped, []);
});

test('an icon flexed below its declared size is caught, at its declared size it is not', async () => {
  const svg = '<svg width="22" height="22" viewBox="0 0 22 22"><rect width="22" height="22"/></svg>';
  await u.page.setContent(html(`<a href="#" style="display:flex;width:44px;height:44px;overflow:visible">${svg.replace("<svg ", "<svg style=\"max-width:100%\" ")}<span style="flex:none;width:60px">bikeshed</span></a>`));
  assert.equal((await inspectUi(u.page)).issues.mark[0]?.declared, 22, 'negative: the logo flexed away');
  await u.page.setContent(html(`<a href="#" style="display:flex;width:144px;height:44px">${svg}<span style="flex:none;width:60px">bikeshed</span></a>`));
  assert.deepEqual((await inspectUi(u.page)).issues.mark, []);
});

test('on touch, a text field or select below 16px is caught; a checkbox and a 16px field are not', async () => {
  await u.page.setContent(html('<input aria-label="Small" style="font-size:13.76px"><textarea aria-label="Note" style="font-size:15px"></textarea><select aria-label="Mode" style="font-size:12px"><option>View</option></select>'));
  assert.equal((await inspectUi(u.page)).issues.inputFont.length, 3, 'negative: iOS would zoom on each');
  await u.page.setContent(html('<input aria-label="Big" style="font-size:16px"><label><input type="checkbox" style="font-size:10px">Check</label>'));
  assert.deepEqual((await inspectUi(u.page)).issues.inputFont, []);
});

test('words cut by their box need an ellipsis, and a flex box cannot draw one', async () => {
  const box = 'width:40px;overflow:hidden;white-space:nowrap';
  await u.page.setContent(html(`<p style="${box}">Everything</p>`));
  assert.equal((await inspectUi(u.page)).issues.cutText.length, 1, 'negative: cut with no ellipsis');
  await u.page.setContent(html(`<p style="${box};text-overflow:ellipsis;display:inline-flex">Everything</p>`));
  assert.equal((await inspectUi(u.page)).issues.cutText.length, 1, 'negative: an ellipsis a flex box never draws');
  await u.page.setContent(html(`<p style="${box};text-overflow:ellipsis">Everything</p><p style="width:300px;overflow:hidden">Fits</p>`));
  assert.deepEqual((await inspectUi(u.page)).issues.cutText, []);
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

test('the phone toolbar keeps its actions on screen at 2, 5, 10 and 20 people; each shown name is whole on one line, the rest are counted by a reachable +N, and nothing in the bar scrolls; the old scrolling row with 12ch names fails', async () => {
  const css = await productCss();
  const page = (peers, extraCss = '') => {
    const chips = Array.from({ length: peers }, (_, i) => `<button class="presence-chip"><span class="presence-dot" data-mode="view"></span><span class="presence-name">Victoria Aleinikova ${i}</span></button>`).join('');
    return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}${extraCss}</style><div class="viewer-toolbar"><span class="chip mono">v1</span><div class="presence-bar" role="group" aria-label="People here now">${chips}<button class="presence-more">+0</button></div><div class="viewer-toolbar-actions"><div class="pane-toggle"><button>Document</button><button>Comments</button></div><button class="btn" aria-label="Edit">Edit</button></div></div>`;
  };
  // PresenceBar's fold, done here with the same measurements and the same function, since this page has no React.
  const fold = async () => {
    const m = await u.page.evaluate(() => {
      const bar = document.querySelector('.presence-bar');
      const s = getComputedStyle(bar);
      return {
        widths: [...bar.querySelectorAll(':scope > .presence-chip')].map((c) => c.offsetWidth),
        gap: parseFloat(s.columnGap) || 0,
        inner: bar.clientWidth - (parseFloat(s.paddingLeft) || 0) - (parseFloat(s.paddingRight) || 0),
        more: bar.querySelector('.presence-more').offsetWidth,
      };
    });
    const shown = chipsThatFit(m.widths, m.gap, m.inner, m.more);
    await u.page.evaluate((shown) => {
      const chips = [...document.querySelectorAll('.presence-chip')];
      chips.forEach((c, i) => { if (i >= shown) c.setAttribute('data-folded', ''); });
      const more = document.querySelector('.presence-more');
      more.textContent = `+${chips.length - shown}`;
      if (chips.length === shown) more.setAttribute('data-idle', '');
    }, shown);
  };
  const measure = () => u.page.evaluate(() => {
    const bar = document.querySelector('.viewer-toolbar');
    const presence = document.querySelector('.presence-bar');
    const width = document.documentElement.clientWidth;
    const reachable = (el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.width > 0 && r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= innerHeight && !!hit && (hit === el || el.contains(hit));
    };
    const chips = [...presence.querySelectorAll('.presence-chip')];
    const shown = chips.filter((c) => !c.hasAttribute('data-folded'));
    const folded = chips.filter((c) => c.hasAttribute('data-folded'));
    const more = presence.querySelector('.presence-more');
    const ps = getComputedStyle(presence);
    return {
      page: document.documentElement.scrollWidth, width, bar: bar.scrollWidth, barWidth: bar.clientWidth,
      actions: [...bar.querySelectorAll('.viewer-toolbar-actions button')].map(reachable),
      overflow: `${ps.overflowX}/${ps.overflowY}`,
      shown: shown.map(reachable),
      // Whole: nothing cut sideways, and one line, which is less than twice the font size tall.
      whole: shown.map((c) => { const n = c.querySelector('.presence-name'); return n.scrollWidth <= n.clientWidth + 0.5 && n.getBoundingClientRect().height < 2 * parseFloat(getComputedStyle(n).fontSize); }),
      foldedVisible: folded.filter((c) => c.checkVisibility({ checkVisibilityCSS: true })).length,
      folded: folded.length,
      more: { reachable: folded.length ? reachable(more) : true, count: Number(more.textContent.slice(1)) },
    };
  });
  for (const peers of [1, 4, 9, 19]) {
    await u.page.setContent(page(peers));
    await fold();
    const m = await measure();
    const at = `${peers} peers: ${JSON.stringify(m)}`;
    assert.ok(m.page <= m.width && m.bar <= m.barWidth, `${at}: toolbar and page fit the phone`);
    assert.deepEqual(m.actions, [true, true, true], `${at}: primary actions remain on screen at rest`);
    assert.equal(m.overflow, 'clip/clip', `${at}: the presence bar clips and is no scroll container`);
    assert.ok(m.shown.length >= 1, `${at}: the first person is named`);
    assert.ok(m.shown.every(Boolean), `${at}: every shown chip is reachable`);
    assert.ok(m.whole.every(Boolean), `${at}: every shown name is whole, on one line`);
    assert.equal(m.foldedVisible, 0, `${at}: a folded chip is invisible`);
    assert.ok(m.more.reachable && m.more.count === m.folded && m.shown.length + m.folded === peers, `${at}: +N is reachable and counts everyone not shown`);
  }
  // Negative: the old row, sideways-scrolling with names capped at 12ch and free to wrap, fails both halves:
  // a scroll container, and "Victoria Aleinikova 0" on two lines, as in the bug report.
  await u.page.setContent(page(1, '.presence-bar{overflow-x:auto!important;overflow-y:auto!important}.presence-name{max-width:12ch;overflow:hidden;text-overflow:ellipsis;white-space:normal!important}'));
  await fold();
  const bad = await measure();
  assert.notEqual(bad.overflow, 'clip/clip', 'negative: the old bar is a scroll container');
  assert.ok(bad.whole.includes(false), `negative: the old 12ch name is cut: ${JSON.stringify(bad)}`);
});
