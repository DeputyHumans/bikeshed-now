// SPDX-License-Identifier: Apache-2.0
// Canaries for the harness features specific areas build on: email off, per-recipient mail failures, the dummy measurement id, operator scripts (SPEC §9, §12, §14, §15).

/**
 * Each case runs only on a stack that has its capability (lib/options.mjs,
 * lib/target.mjs) and is SKIPPED, with the reason, elsewhere:
 *
 *   email-off            stack up --email-off
 *   mail-fail-recipient  every stack this harness version builds (needs email too)
 *   measurement-id       stack up --app-env VITE_FIREBASE_MEASUREMENT_ID=dummy
 *   operator-scripts     every stack this harness version builds
 *
 * They use only what a spec may use, and only addresses they mint, so they
 * are safe on a shared stack. A failure here is a HARNESS problem: the area
 * specs that rely on the feature cannot be trusted until it is fixed.
 *
 * Negative control: e2e/patches/controls-email-off removes the product's
 * trim of the whitespace key (built with --email-off), so the product tries
 * to send; the email-off case must then fail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTarget } from "../../lib/target.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish, updateUpload } from "../../lib/seed.mjs";
import { share } from "../../lib/grant.mjs";
import { createHttp } from "../../lib/http.mjs";
import { listObjects, readDoc } from "../../lib/admin.mjs";
import { logMark, waitForLog } from "../../lib/logs.mjs";
import { MAIL_SETTLE_MS, mailbox } from "../../lib/mail/reader.mjs";
import { shimControl } from "../../lib/mail/shimctl.mjs";
import { isMeasurementIdShape } from "../../lib/options.mjs";
import { runOperator } from "../../lib/operator.mjs";
import { egressMark, readEgress } from "../../lib/egress.mjs";

const target = loadTarget();
const has = (...caps) => caps.every((c) => target.capabilities.has(c));
const skipUnless = (...caps) => (has(...caps) ? false : `needs ${caps.filter((c) => !target.capabilities.has(c)).join(", ")} (the stack lacks it)`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const invitee = (role) => `${role}-${runTag(target.runId)}-${rand4()}@example.com`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function ownerWithDoc(title) {
  const [owner] = await cast(target, ["owner"]);
  const session = await openSession(target, owner);
  const doc = await publish(session.http, { fixture: "crdt-paragraphs.html", title });
  return { owner, session, docId: doc.docId };
}

test("canary: email off — a share reaches the product's own skip path, and the shim receives nothing for the recipient", { skip: skipUnless("email-off", "mailpit") }, async () => {
  const { session, docId } = await ownerWithDoc("E2E email-off canary");
  const to = invitee("off");
  const shim = shimControl(target);
  const mark = logMark({ target });
  await share(target, { owner: session, doc: docId, account: to, verify: false });

  // Either outcome shows up: the product's skip line naming the recipient, or
  // (if email were NOT off) a request reaching the shim for them.
  const skipped = new RegExp(`\\[email\\] skipped "[^"]*" to ${escapeRe(to)}: no API key configured`);
  let skipLine = null;
  let reached = [];
  const end = Date.now() + 90_000;
  while (Date.now() < end && !skipLine && reached.length === 0) {
    reached = await shim.requests({ to });
    skipLine = await waitForLog(skipped, { target, since: mark, timeout: 1000 }).catch(() => null);
  }
  assert.equal(reached.length, 0, `on an email-off stack the shim received ${reached.length} request(s) for ${to}: ${JSON.stringify(reached.map((r) => ({ status: r.status, auth: r.auth, subject: r.subject })))}`);
  assert.ok(skipLine, `the product never logged "[email] skipped … to ${to}" within 90 s`);
  // …and nothing arrives late either.
  await sleep(MAIL_SETTLE_MS);
  assert.deepEqual(await shim.requests({ to }), [], "nothing reached the shim after the settle");
  const box = mailbox(target);
  assert.deepEqual((await box.find({ to })).map((m) => m.ID), [], "and nothing reached Mailpit");
});

test("canary: a per-recipient mail failure on the shim hits only its own recipient (safe on a shared stack)", { skip: skipUnless("email", "mailpit", "mail-fail-recipient") }, async () => {
  const { session, docId } = await ownerWithDoc("E2E per-recipient failure canary");
  const failing = invitee("fails");
  const fine = invitee("fine");
  const shim = shimControl(target);
  try {
    assert.deepEqual(await shim.failRecipient(failing, { status: 500, count: 1 }), { to: failing, pending: 1 });
    await share(target, { owner: session, doc: docId, account: failing, verify: false });
    await share(target, { owner: session, doc: docId, account: fine, verify: false });
    const box = mailbox(target);
    const [ok, none] = await Promise.all([box.expectMail({ to: fine, count: 1 }), box.expectMail({ to: failing, count: 0 })]);
    assert.equal(ok.messages.length, 1, "the other recipient got their invitation");
    assert.equal(none.messages.length, 0, "the failing recipient got nothing");
    const got = await shim.requests({ to: failing });
    assert.deepEqual(got.map((r) => [r.status, r.injected, r.injectedFor]), [[500, true, failing]], JSON.stringify(got));
    assert.deepEqual((await shim.requests({ to: fine })).map((r) => r.status), [200]);
    assert.equal(await shim.pending(failing), 0, "the injected failure was used up");
  } finally {
    await shim.clear(failing);
  }
});

test("canary: the app was built with the generated dummy measurement id", { skip: skipUnless("measurement-id") }, async () => {
  const id = target.options?.appEnv?.VITE_FIREBASE_MEASUREMENT_ID;
  assert.ok(isMeasurementIdShape(id), "target.options carries a measurement-id-shaped dummy");
  const http = createHttp(target, { actor: "measurement-id" });
  const index = await http.get("/", { expect: 200 });
  const scripts = [...index.text.matchAll(/<script[^>]+src="([^"]+\.js)"/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, "the shell names its scripts");
  const hits = [];
  for (const src of scripts) if ((await http.get(src, { expect: 200 })).text.includes(id)) hits.push(src);
  assert.ok(hits.length > 0, `the served bundle carries the dummy id (looked in ${scripts.join(", ")})`);
});

test("canary: an operator script (delete-version) runs against the stack with the stack's HOME and a dummy ADC, and nothing reaches out", { skip: skipUnless("operator-scripts") }, async () => {
  const { owner, session, docId } = await ownerWithDoc("E2E operator canary");
  const v2 = await updateUpload(session.http, docId, { fixture: "foreign-marker.html", baseVersion: "v1", expect: 200 });
  assert.equal(v2.json?.versionId, "v2", JSON.stringify(v2.json));
  assert.equal((await readDoc(target, `docs/${docId}`)).currentVersion, "v2");
  const since = egressMark(target);
  const r = await runOperator(target, "delete-version.mjs", ["--doc", docId, "--version", "v2", "--repoint", "v1", "--yes", "--account", owner.email, "--project", target.projectId, "--bucket", target.bucket]);
  assert.equal(r.code, 0, `delete-version exited ${r.code}\n${r.stdout}\n${r.stderr}`);
  assert.equal(r.env.HOME, target.stack.homeDir, "the stack's HOME, never the user's");
  assert.ok(r.env.GOOGLE_APPLICATION_CREDENTIALS.startsWith(`${target.stack.homeDir}/`), r.env.GOOGLE_APPLICATION_CREDENTIALS);
  assert.equal((await readDoc(target, `docs/${docId}`)).currentVersion, "v1", "currentVersion was repointed");
  assert.equal(await readDoc(target, `docs/${docId}/versions/v2`), null, "the v2 record is gone");
  assert.deepEqual(await listObjects(target, `docs/${docId}/v2/`), [], "and its bytes");
  const reachedOut = readEgress(target, { since }).filter((x) => /delete-version/.test(x.script ?? ""));
  assert.deepEqual(reachedOut, [], "the script never tried to fetch a token or anything else");
});
