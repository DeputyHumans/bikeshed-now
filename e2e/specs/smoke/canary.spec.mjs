// SPDX-License-Identifier: Apache-2.0
// Canary: the target answers, mail reaches Mailpit through the shim, and the spec env is the stack's (SPEC §12).

/**
 * Runs before anything else. If it fails the run is a HARNESS problem, not a
 * product finding: nothing after it can be trusted. Every request goes through
 * lib/http.mjs, like a spec's: held to the stack's ports, guarded, traced.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTarget, requireCapability } from "../../lib/target.mjs";
import { createHttp } from "../../lib/http.mjs";
import { shimKey } from "../../lib/mail/shimctl.mjs";

const target = loadTarget();
const http = createHttp(target, { actor: "canary" });

test("canary: GET /config answers 200 through Hosting → Functions", async () => {
  const r = await http.get("/config");
  assert.equal(r.status, 200);
  for (const k of Object.keys(r.json)) assert.ok(["signInHint"].includes(k), `unexpected /config key ${k}`);
});

test("canary: the spec process got this stack's emulator hosts and nothing ambient", () => {
  if (target.kind !== "local") return;
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, `127.0.0.1:${target.stack.ports.firestore}`);
  assert.equal(process.env.GCLOUD_PROJECT, "demo-bikeshed");
  assert.equal(process.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  for (const k of Object.keys(process.env)) assert.ok(!/^(BIKESHED_|RESEND_|VITE_)/.test(k), `${k} leaked into the spec env`);
});

test("canary: the shim delivers into Mailpit, and refuses a wrong key", async () => {
  // The shim itself, not the product's email: an email-off stack runs it too.
  requireCapability(target, "mailpit");
  const key = shimKey(target);
  const subject = `canary spec ${target.runId} ${Date.now()}`;
  const to = `canary-spec@${target.runId}.e2e.invalid`;
  const shim = target.mail.shimUrl;
  const mailpit = target.mail.mailpitUrl;
  const wrong = await http.postJson(`${shim}/emails`, { from: "a@e2e.invalid", to, subject }, { headers: { authorization: "Bearer re_wrong" } });
  assert.equal(wrong.status, 403);
  const sent = await http.postJson(`${shim}/emails`, { from: "Bikeshed E2E <noreply@e2e.bikeshed.invalid>", to, subject, text: "canary" }, { headers: { authorization: `Bearer ${key}` } });
  assert.equal(sent.status, 200);
  const { id } = sent.json;
  let found = [];
  for (let i = 0; i < 40 && found.length === 0; i++) {
    const r = await http.get(`${mailpit}/api/v1/search`, { query: { query: `subject:"${subject}"` } });
    found = r.json?.messages ?? [];
    if (found.length === 0) await new Promise((res) => setTimeout(res, 250));
  }
  assert.equal(found.length, 1, "exactly one message in Mailpit");
  assert.equal(found[0].To[0].Address, to);
  const headers = (await http.get(`${mailpit}/api/v1/message/${found[0].ID}/headers`)).json;
  // Mailpit canonicalises header names (X-E2e-Shim-Id), so match without case.
  const shimId = Object.entries(headers).find(([k]) => k.toLowerCase() === "x-e2e-shim-id")?.[1];
  assert.deepEqual(shimId, [id], `the message carries the shim's id (headers: ${Object.keys(headers).join(", ")})`);
  await http.request("DELETE", `${mailpit}/api/v1/messages`, { json: { IDs: [found[0].ID] } });
});
