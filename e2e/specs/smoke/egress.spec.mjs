// SPDX-License-Identifier: Apache-2.0
// Canary: a function's real outbound fetch is refused by the stack's egress guard and logged, and the product carries on (SPEC §12, §23).

/**
 * The product has one deliberate outbound fetch: an OAuth client given as a
 * URL (a client metadata document, functions/src/oauth/fetch.ts) is fetched
 * from that URL when the consent page describes the request. Here a signed-in
 * account asks POST /oauth/consent to describe a request from a client whose
 * id is an https URL on a `.invalid` name (RFC 2606: it can never resolve).
 * The function worker's https.request must be refused AT CONNECT by the guard
 * every stack process preloads — before any name is looked up — and the
 * refusal must be in logs/egress.jsonl, with the product's fetch.js among its
 * frames; the product must answer as it does when a metadata fetch fails.
 *
 * Negative control: e2e/patches/controls-egress lets names through the
 * guard's connect layer (its DNS layer still refuses, so even the control
 * sends nothing); this case must then fail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTarget, requireCapability } from "../../lib/target.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { approveViaApi, authorizeParams, pkce } from "../../lib/oauth.mjs";
import { egressMark, readEgress, waitForEgress } from "../../lib/egress.mjs";

const target = loadTarget();

test("canary: a function's outbound fetch (OAuth client metadata) is refused at connect by the egress guard and logged", async () => {
  requireCapability(target, "egress-guard");
  const [account] = await cast(target, ["egress"]);
  const session = await openSession(target, account);
  const host = `egress-canary-${runTag(target.runId)}-${rand4()}.invalid`;
  const clientId = `https://${host}/oauth/client.json`;
  const since = egressMark(target);

  const r = await approveViaApi(session.http, session.idToken, authorizeParams({ clientId, redirectUri: "http://127.0.0.1:1/callback", challenge: pkce().challenge }), { action: "describe" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json?.valid, false, `the product treats the refused fetch as a failed one: ${JSON.stringify(r.json)}`);
  assert.equal(r.json?.error, "invalid_client");

  let refusal;
  try {
    refusal = await waitForEgress(target, (x) => x.kind === "connect" && x.host === host && x.port === 443, { since, timeout: 20_000 });
  } catch (err) {
    throw new Error(`no connect refusal for ${host}:443 in the egress log — the guard did not refuse the function's fetch at connect (${err.message})`);
  }
  assert.ok(refusal.frames.some((f) => /\/oauth\/fetch\.js/.test(f)), `refused inside the product's metadata fetch: ${JSON.stringify(refusal.frames)}`);
  assert.ok(Number.isInteger(refusal.pid) && refusal.pid !== process.pid, "refused in a stack process (a function worker), not in this spec");
  const lookups = readEgress(target, { since }).filter((x) => x.kind === "dns" && x.host === host);
  assert.deepEqual(lookups, [], "the name was never even looked up");
});
