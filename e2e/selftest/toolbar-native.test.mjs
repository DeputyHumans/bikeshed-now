// SPDX-License-Identifier: Apache-2.0
// Real native toolbar commands work in the scriptless editor frame and retain undo (SPEC §6a).

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from '../../app/node_modules/esbuild/lib/main.js';
import { BrowserPool } from '../lib/browser.mjs';

const source = resolve(process.env.E2E_TOOLBAR_SOURCE_DIR ?? new URL('../..', import.meta.url).pathname);
const target = { kind: 'local', runId: 'selftest-toolbar-native', origin: 'http://127.0.0.1:1', stack: { ports: { hosting: 1 } }, capabilities: new Set(['local']) };
let pool, user, bundle;
before(async () => {
  bundle = (await build({ stdin: { contents: `import {createRoot} from 'react-dom/client';import {createElement} from 'react';import {EditToolbar} from ${JSON.stringify(`${source}/app/src/wysiwyg/EditToolbar.tsx`)};window.mountToolbar=(doc)=>createRoot(document.getElementById('toolbar')).render(createElement(EditToolbar,{format:'html',doc,saveState:'saved',sharing:'solo',onCommit(){},onExit(){}}));`, resolveDir: `${source}/app` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', define: { 'import.meta.env.DEV': 'false' } })).outputFiles[0].text;
  pool = new BrowserPool({ target }); user = await pool.user();
});
after(async () => pool?.close());

async function mount(html = '<p id="subject">Before <b>bold &amp; safe</b> after.</p>') {
  await user.page.setContent('<!doctype html><div id="toolbar"></div><iframe sandbox="allow-same-origin"></iframe>');
  await user.page.evaluate((html) => {
    const frame = document.querySelector('iframe'); const doc = frame.contentDocument;
    doc.open(); doc.write(`<!doctype html><body contenteditable="true">${html}</body>`); doc.close();
  }, html);
  await user.page.addScriptTag({ content: bundle });
  await user.page.evaluate(() => window.mountToolbar(document.querySelector('iframe').contentDocument));
  await user.page.getByRole('toolbar', { name: 'Formatting' }).waitFor();
  await user.page.evaluate(() => {
    const doc = document.querySelector('iframe').contentDocument;
    const range = doc.createRange(); range.selectNode(doc.querySelector('b'));
    doc.getSelection().removeAllRanges(); doc.getSelection().addRange(range); doc.defaultView.focus();
  });
}
const body = () => user.page.evaluate(() => document.querySelector('iframe').contentDocument.body.innerHTML);

test('Inline code wraps selected rich text in semantic code, preserves surrounding bytes and undoes as one native edit', async () => {
  await mount('<p id="subject" style="white-space:normal;color:navy">Before <b>bold &amp; safe</b> after.</p>'); const original = await body();
  await user.page.getByRole('button', { name: 'Inline code', exact: true }).click();
  const actual = await user.page.evaluate(() => { const doc = document.querySelector('iframe').contentDocument; return { code: doc.querySelector('code')?.innerHTML, text: doc.body.textContent, style: doc.querySelector('p').getAttribute('style') }; });
  assert.equal(actual.code, '<b>bold &amp; safe</b>', 'inline code retains rich selected content');
  assert.equal(actual.text, 'Before bold & safe after.', 'inline code retains surrounding text');
  assert.equal(actual.style, 'white-space:normal;color:navy', 'inline code preserves the authored style bytes');
  await user.page.evaluate(() => document.querySelector('iframe').contentDocument.execCommand('undo'));
  assert.equal(await body(), original, 'one native undo restores the original document');
});

test('Link prompts from the app window and applies the supplied URL inside a sandbox without modal permission', async () => {
  await mount(); const dialogs = [];
  const handle = async (dialog) => { dialogs.push([dialog.type(), dialog.message()]); await dialog.accept('https://example.invalid/review'); };
  user.page.on('dialog', handle);
  try { await user.page.getByRole('button', { name: 'Link', exact: true }).click(); }
  finally { user.page.off('dialog', handle); }
  assert.deepEqual(dialogs, [['prompt', 'Link to']], 'the sandboxed editor can request one link destination');
  const actual = await user.page.evaluate(() => { const doc = document.querySelector('iframe').contentDocument; return { href: doc.querySelector('a')?.getAttribute('href'), text: doc.querySelector('a')?.textContent }; });
  assert.deepEqual(actual, { href: 'https://example.invalid/review', text: 'bold & safe' }, 'the link encloses exactly the original selection');
});

test('Cancelling the app link prompt preserves content and the editor selection', async () => {
  await mount(); const original = await body();
  let count = 0; const handle = async (dialog) => { count++; await dialog.dismiss(); }; user.page.on('dialog', handle);
  try { await user.page.getByRole('button', { name: 'Link', exact: true }).click(); }
  finally { user.page.off('dialog', handle); }
  assert.equal(count, 1, 'cancellation actually answered the destination prompt');
  assert.equal(await body(), original);
  assert.equal(await user.page.evaluate(() => document.querySelector('iframe').contentDocument.getSelection().toString()), 'bold & safe');
});
