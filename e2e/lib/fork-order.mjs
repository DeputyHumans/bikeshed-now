// SPDX-License-Identifier: Apache-2.0
// Observe fork intent ordering before asynchronous checks can hide an early create (SPEC §21).

export async function observeForkOrder(page, { origin, docId, key, delayMs = 1000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const expectedOrigin = new URL(origin).origin;
  const creates = [], unlocks = new Set();
  let signingIn = false, answered = false;
  const request = (req) => {
    const url = new URL(req.url());
    if (url.origin !== expectedOrigin || url.pathname !== '/fork' || req.method() !== 'POST') return;
    let body; try { body = req.postDataJSON(); } catch { return; }
    if (body?.op !== 'create') return;
    creates.push({ at: now(), href: page.url(), docId: body.docId, versionId: body.versionId ?? null, k: body.k === key ? 'the link key' : body.k ?? null, unlockAnswered: key ? answered : null });
  };
  const response = (res) => { if (unlocks.has(res.request()) && res.status() === 200) answered = true; };
  const matches = (url) => url.origin === expectedOrigin && url.pathname === '/unlock';
  const handle = async (route) => {
    const req = route.request();
    let body; try { body = req.postDataJSON(); } catch { return route.fallback(); }
    if (!key || !signingIn || req.method() !== 'POST' || body?.docId !== docId || body?.k !== key) return route.fallback();
    const headers = await req.allHeaders();
    if (!/(?:^|;\s*)__session=/.test(headers.cookie ?? '')) return route.fallback();
    unlocks.add(req);
    const reply = await route.fetch({ maxRedirects: 0, timeout: 60_000 });
    try { await sleep(delayMs); await route.fulfill({ response: reply }); }
    finally { await reply.dispose(); }
  };
  page.on('request', request); page.on('response', response);
  await page.route(matches, handle);
  return { creates, beginSignIn() { signingIn = true; }, async restore() {
    await page.unroute(matches, handle); page.off('request', request); page.off('response', response);
  } };
}
