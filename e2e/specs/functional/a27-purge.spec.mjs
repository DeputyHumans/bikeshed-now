// SPDX-License-Identifier: Apache-2.0
// A27 deleting forever: only from the browser, only with the code emailed for exactly that, and what is left is a tombstone (SPEC §4, ADR 0025).

/**
 * Cases
 *   A27.1  the emailed code deletes a trashed document forever: a tombstone
 *          and nothing else, in Firestore, Storage and the change log, its
 *          link answers as for an absent id, and the id is never reused
 *   A27.2  a token is refused, whoever's, and five wrong codes burn the code
 *   A27.3  a folder's early purge takes what is its owner's and leaves another
 *          owner's document in their Trash, to come back at their root
 *   A27.4  where email is off nothing can be deleted early, and nothing is sent
 *   A27.5  in the browser: the row's day, Delete forever, the code, and the
 *          row gone
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { bearerHttp, mintToken, openSession } from "../../lib/session.mjs";
import { createFolder, publish } from "../../lib/seed.mjs";
import { shareFolder } from "../../lib/grant.mjs";
import { closeAdmin, listObjects, readCollection, readDoc } from "../../lib/admin.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { eventually } from "../../lib/assert.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const MAIL = { tiers: ["local"], needs: ["email", "mailpit"], effects: ["email"], inconclusiveOnStackTimeout: true, timeoutMs: 300_000 };
const SUBJECT = /^(\d{6}) is your code to delete from your Trash$/;

async function castSessions(roles) {
  const accounts = await cast(target, roles);
  return Promise.all(accounts.map((a) => openSession(target, a)));
}

function page(title) {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n<h1>${title}</h1>\n<p>Two weekends, and the shed is done.</p>\n</body>\n</html>\n`;
}

const tagged = (name) => `A27 ${name} ${runTag(target.runId)}-${rand4()}`;

async function trashed(session, kind, id) {
  const r = await session.http.postJson("/organize", { kind, id, op: "trash" });
  precondition(r.status === 200, `trash ${id}: ${r.status} ${r.text?.slice(0, 200)}`);
}

/** Ask for a code for `purgeTarget`, and read it from the mail it went in. */
async function codeFor(session, purgeTarget) {
  const box = mailbox(target);
  const asked = await session.http.postJson("/purge", { op: "code", target: purgeTarget });
  precondition(asked.status === 200, `POST /purge code: ${asked.status} ${asked.text?.slice(0, 200)}`);
  const { messages } = await box.expectMail({ to: session.account.email, subject: SUBJECT, count: 1 });
  const code = String(messages[0].Subject).match(SUBJECT)[1];
  return { asked: asked.json, code, mail: await box.message(messages[0].ID) };
}

// --- A27.1 --------------------------------------------------------------------

scenario("A27.1 the emailed code deletes a trashed document forever: its record becomes a tombstone, its versions, log and files go and stay gone, its link is an absent id's, and a new document of that name gets another id", MAIL, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const title = tagged("forever");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, name: "a27-forever" });
  precondition(doc.versionId === "v1", `publish: ${doc.status}`);
  await eventually(async () => (await readCollection(target, `docs/${doc.docId}/events`)).length > 0, { timeout: 60_000, message: "the publish is in the change log" });
  precondition((await listObjects(target, `docs/${doc.docId}/`)).length > 0, "its bytes are in Storage");
  await trashed(owner, "doc", doc.docId);

  const available = await owner.http.get("/purge");
  assert.deepEqual({ status: available.status, json: available.json, cache: available.headers.get("cache-control") }, { status: 200, json: { available: true, retentionDays: 30 }, cache: "private, no-store" }, "GET /purge: possible here, and uncached");
  const { asked, code, mail } = await codeFor(owner, { kind: "document", id: doc.docId });
  assert.deepEqual(asked.summary, { kind: "document", title, versions: 1 }, "the code is asked for with what will go");
  assert.match(asked.sentTo, /^.•••@/, "and says where the code went, masked");
  assert.ok(String(mail.Text).includes(`“${title}”`), "the mail names what the code deletes");
  assert.equal(await readDoc(target, `users/${owner.account.uid}`).then((u) => JSON.stringify(u ?? {}).includes(code)), false, "the code is on no record its account can read");

  const done = await owner.http.postJson("/purge", { op: "confirm", target: { kind: "document", id: doc.docId }, code });
  assert.deepEqual({ status: done.status, json: done.json }, { status: 200, json: { folders: 0, documents: 1 } }, "the code deletes it");
  assert.deepEqual(Object.keys(await readDoc(target, `docs/${doc.docId}`)), ["purgedAt"], "a tombstone, and nothing a gate or a query keys on");
  assert.deepEqual(await listObjects(target, `docs/${doc.docId}/`), [], "every object under docs/{id}/ is gone");
  // Its versions going fires the change-log trigger; give it time to have written, and see that it did not.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    assert.deepEqual(
      { versions: (await readCollection(target, `docs/${doc.docId}/versions`)).length, events: (await readCollection(target, `docs/${doc.docId}/events`)).length },
      { versions: 0, events: 0 },
      `${2 * (i + 1)} s after: no version, and nothing recorded into the log`,
    );
  }
  assert.equal((await owner.http.get(`/content/${doc.docId}/v1/index.html`)).status, 404, "its own owner gets the absent id's 404");
  assert.equal((await owner.http.postJson("/purge", { op: "confirm", target: { kind: "document", id: doc.docId }, code })).status, 404, "and a second confirm finds nothing in the Trash");
  const again = await publish(owner.http, { body: page(title), filename: "index.html", title, id: doc.docId });
  assert.notEqual(again.docId, doc.docId, "a new document asking for the deleted one's id is given another");
});

// --- A27.2 --------------------------------------------------------------------

scenario("A27.2 a token is refused POST /purge, whoever's, and five wrong codes burn the code: the sixth attempt, right, is refused and nothing is deleted", MAIL, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const title = tagged("burn");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, name: "a27-burn" });
  precondition(doc.versionId === "v1", `publish: ${doc.status}`);
  await trashed(owner, "doc", doc.docId);
  const purgeTarget = { kind: "document", id: doc.docId };

  for (const channel of ["cli", "mcp"]) {
    const { token } = await mintToken(owner, { name: `e2e a27 ${channel}`, channel });
    const agent = await bearerHttp(target, token, { actor: `owner-${channel}` }).postJson("/purge", { op: "code", target: purgeTarget });
    assert.equal(agent.status, 403, `the owner's own ${channel} token is refused`);
    assert.match(agent.json?.error ?? "", /in the browser/, "and told where it is done");
  }
  const { code } = await codeFor(owner, purgeTarget);
  const wrong = code === "000000" ? "111111" : "000000";
  const answers = [];
  for (let i = 0; i < 5; i++) answers.push((await owner.http.postJson("/purge", { op: "confirm", target: purgeTarget, code: wrong })).status);
  assert.deepEqual(answers, [400, 400, 400, 400, 400], "five wrong codes are each wrong");
  const sixth = await owner.http.postJson("/purge", { op: "confirm", target: purgeTarget, code });
  assert.deepEqual({ status: sixth.status, error: sixth.json?.error }, { status: 429, error: "too many attempts; ask for a new code" }, "the sixth attempt is refused, though right");
  assert.ok((await readDoc(target, `docs/${doc.docId}`))?.trashed, "and the document is still in the Trash");
  assert.equal(await readDoc(target, `purgeCodes/${owner.account.uid}`), null, "the code is burned");
});

// --- A27.3 --------------------------------------------------------------------

scenario("A27.3 deleting a folder forever takes what of its owner's went with it and leaves another owner's document in their Trash, which comes back at their root", MAIL, async (ctx) => {
  const [owner, editor] = await castSessions(["owner", "editor"]);
  const folder = await createFolder(owner.http, { name: tagged("folder") });
  await shareFolder(target, { owner, folder: folder.folderId, account: editor.account, role: "editor" });
  const mine = await publish(owner.http, { body: page(tagged("mine")), filename: "index.html", title: tagged("mine"), folderId: folder.folderId, name: "a27-mine" });
  const theirs = await publish(editor.http, { body: page(tagged("theirs")), filename: "index.html", title: tagged("theirs"), folderId: folder.folderId, name: "a27-theirs" });
  precondition(mine.versionId === "v1" && theirs.versionId === "v1", "both published into the folder");
  await trashed(owner, "folder", folder.folderId);
  precondition((await readDoc(target, `docs/${theirs.docId}`))?.trashed, "the editor's document went with the folder");

  const { asked, code } = await codeFor(owner, { kind: "folder", id: folder.folderId });
  assert.deepEqual({ documents: asked.summary.documents, theirs: asked.summary.theirs }, { documents: 1, theirs: 1 }, "it says what goes and what stays");
  const done = await owner.http.postJson("/purge", { op: "confirm", target: { kind: "folder", id: folder.folderId }, code });
  assert.deepEqual({ status: done.status, json: done.json }, { status: 200, json: { folders: 1, documents: 1 } });
  assert.equal(await readDoc(target, `folders/${folder.folderId}`), null, "the folder's record is gone");
  assert.deepEqual(Object.keys(await readDoc(target, `docs/${mine.docId}`)), ["purgedAt"], "the owner's document is a tombstone");
  assert.ok((await readDoc(target, `docs/${theirs.docId}`))?.trashed, "the editor's is still in their Trash");
  const back = await editor.http.postJson("/organize", { kind: "doc", id: theirs.docId, op: "restore" });
  assert.equal(back.status, 200, `the editor restores it: ${back.text?.slice(0, 160)}`);
  const restored = await readDoc(target, `docs/${theirs.docId}`);
  assert.deepEqual({ trashed: restored.trashed, folderId: restored.folderId ?? null }, { trashed: null, folderId: null }, "at their root");
});

// --- A27.4 --------------------------------------------------------------------

scenario("A27.4 where email is off nothing can be deleted early: GET /purge says so, a code is refused with the reason, and nothing is sent", { tiers: ["local"], needs: ["email-off", "mailpit"], inconclusiveOnStackTimeout: true, timeoutMs: 240_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const title = tagged("off");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, name: "a27-off" });
  await trashed(owner, "doc", doc.docId);
  assert.deepEqual((await owner.http.get("/purge")).json, { available: false, retentionDays: 30 }, "GET /purge says it is not possible here");
  const refused = await owner.http.postJson("/purge", { op: "code", target: { kind: "document", id: doc.docId } });
  assert.deepEqual({ status: refused.status, emailOff: refused.json?.emailOff }, { status: 409, emailOff: true }, "a code is refused, with the reason");
  await new Promise((r) => setTimeout(r, 3_000));
  assert.deepEqual(await mailbox(target).find({ to: owner.account.email }), [], "nothing reached Mailpit");
  assert.ok((await readDoc(target, `docs/${doc.docId}`))?.trashed, "and the document is still in the Trash");
});

// --- A27.5 --------------------------------------------------------------------

scenario("A27.5 in the browser, a Trash row says the day it is deleted forever, and Delete forever asks for the emailed code, takes it, and the row goes", { ...MAIL, timeoutMs: 400_000 }, async (ctx) => {
  const [owner] = await castSessions(["owner"]);
  const title = tagged("ui");
  const doc = await publish(owner.http, { body: page(title), filename: "index.html", title, name: "a27-ui" });
  await trashed(owner, "doc", doc.docId);
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(owner.account.email, owner.account.password);
  await u.goto("/trash");
  const row = u.page.locator(".trash-row").filter({ has: u.page.locator(".trash-name > a", { hasText: title }) });
  await row.waitFor({ timeout: 60_000 });
  assert.match(await row.innerText(), /deleted forever on /, "the row says when it goes");
  const box = mailbox(target);
  await row.getByRole("button", { name: "Delete forever" }).click();
  const dialog = u.page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Email me a code" }).click();
  const { messages } = await box.expectMail({ to: owner.account.email, subject: SUBJECT, count: 1 });
  const code = String(messages[0].Subject).match(SUBJECT)[1];
  await dialog.getByLabel(/six-digit code/).fill(code);
  await dialog.getByRole("button", { name: "Delete forever" }).click();
  await u.page.getByText("Deleted forever.").waitFor({ timeout: 60_000 });
  await eventually(async () => (await row.count()) === 0, { timeout: 60_000, message: "the row is gone" });
  assert.deepEqual(Object.keys(await readDoc(target, `docs/${doc.docId}`)), ["purgedAt"], "and the document is deleted forever");
});
