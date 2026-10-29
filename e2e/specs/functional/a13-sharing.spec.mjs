// SPDX-License-Identifier: Apache-2.0
// A13 Sharing: the Share dialog, one invitation, removal, role change, inherited rows, teams, folders, the permanent owner and the visibility controls (SPEC §13).

/**
 * Who can read a document, and how the Share dialog says so (SPEC §2 "POST
 * /access", §13, §14 "Email", §16 "The presence mirror", §17, §18). Every case
 * has its own accounts, documents, folders and teams:
 *
 *   A13.1  the owner adds a person in the dialog: exactly one invitation, with
 *          notify.ts's subject; adding the same person again in the dialog and
 *          POSTing the whole list back send nothing more (LOCAL)
 *   A13.2  a removed member's read sent within 2 s of the removal is the
 *          absent id's 404; the RTDB rules then refuse their read of
 *          status/{doc} and their write of their own peer node, and the
 *          presence mirror no longer names them
 *   A13.3  a role change sends no email, and Edit appears in the member's open
 *          viewer without a reload
 *   A13.4  inherited grants in the dialog: after the document's own rows,
 *          nearest folder first and highest role first, each with its folder's
 *          path and no controls; a person granted directly and through a
 *          folder has both rows. Then three folder levels (X-a13-sharing-1
 *          formerly listed own folder, root, …, parent), and a
 *          folder above that the owner cannot open
 *   A13.5  a team grant expands to the team's members (each holds the
 *          presence mirror); removing one from the team revokes them from the
 *          document and the folder it was granted on
 *   A13.6  a folder grant reaches documents two and three levels down, filed
 *          before the grant and after it, and its removal reaches them too
 *   A13.7  the owner cannot be removed, or stored in a role
 *   A13.8  the three levels' radios, Copy puts the `?k=` link on the
 *          clipboard, and the expiry date can be cleared. The plan says
 *          `#public-edit` is "disabled while private"; the dialog does not
 *          render it at all while private (VisibilitySection.tsx), and the
 *          server stores publicEdit false for a private document
 *          (index.ts setVisibility), so the oracle is: absent while private,
 *          and making a document private withdraws open editing
 *   A13.9  the local operator grants and removes an editor; Firestore, both
 *          live mirrors and the grantee's actual content/RTDB gates agree
 *
 * Tiers. Sharing goes through lib/grant.mjs (share/unshare), which on
 * production is the operator's script and sends nothing. A13.1 adds a person
 * through the dialog, which is POST /access and an invitation: local only.
 * Folder grants (shareFolder/unshareFolder) and teams (createTeam,
 * teamMembers) have no production path at all (scripts/set-access.mjs takes
 * documents only; the guard refuses /folder-access, /team and /team-members),
 * so A13.4, A13.5 and A13.6 declare their emails as effects and are skipped on
 * production for them.
 *
 * RTDB. A13.2's refusals are rules-evaluated: lib/rtdb.mjs rtdbAs sends the
 * member's ID token only as `?auth=` (the emulator reads any Bearer header as
 * its admin). On a local stack the case first proves, live, that
 * ns=<projectId> enforces the tree's database.rules.json (rtdbRulesStatus;
 * suspect S31: a stack built before the harness bound them there ran that
 * namespace with no rules, which would blind every DENY).
 *
 * Load. A request the stack never answered (Hosting's 504 at its 60 s
 * cut-off, or the http client's deadline) ends a case INCONCLUSIVE, never
 * PASS or FAIL: nothing was measured (every case declares lib/test.mjs's
 * inconclusiveOnStackTimeout, and every response it reads itself, a page's
 * POST included, goes through answered()). An assertion or a precondition
 * still fails as it would. On a long-lived shared stack whose Firestore
 * emulator had grown to gigabytes, every write took 10-60 s and most cases
 * ended that way; on a fresh stack the file runs in about a minute.
 *
 * Negative controls. Product patches (e2e/patches/): controls-a13-reinvite
 * (setAccess invites everyone named: A13.1's re-save), controls-a13-revoke-mirror
 * (the presence mirror merges keys: A13.2's RTDB DENY), controls-a13-copy-link
 * (Copy drops ?k=: A13.8's clipboard). Every other oracle here was seen red by
 * a spec mutation run with --spec-file: no removal (A13.2), no role change, a
 * reload and a second invitation (A13.3), a control in an inherited row and
 * the hidden folder's name in the dialog (A13.4), the folder grant not
 * re-fanned and a team member's mirror missing (A13.5), the grant one level
 * too low (A13.6), the owner written into a role (A13.7), and Clear replaced
 * by another date (A13.8).
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { answered, currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, localEmail, rand4, runTag } from "../../lib/accounts.mjs";
import { openSessions } from "../../lib/session.mjs";
import { createFolder, createTeam, publish } from "../../lib/seed.mjs";
import { ROLES, principalOf, share, shareFolder, teamMembers, trackWindow, unshare, unshareFolder } from "../../lib/grant.mjs";
import { closeAdmin, emailKey, readDoc, rtdbGet } from "../../lib/admin.mjs";
import { rtdbAs, rtdbRulesStatus } from "../../lib/rtdb.mjs";
import { eventually, sameBytes, sameHeadersExceptDate } from "../../lib/assert.mjs";
import { unrecoveredListenerLoss } from "../../lib/listener-loss.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";
import { shimControl } from "../../lib/mail/shimctl.mjs";
import { runOperator } from "../../lib/operator.mjs";
import { liveLogPath } from "../../lib/live-log.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

/**
 * One request's own timeout, for every write this spec sends through lib/
 * (share, unshare, shareFolder, createFolder, teamMembers …): the http
 * client's default is 60 s, and on a shared stack whose Firestore emulator
 * sat at 100% CPU a POST /access once took longer than that (the functions
 * emulator then kills it at ~60 s and Hosting answers 504; a longer wait
 * shows that 504 instead of a client timeout). The case timeouts below are
 * sized for such a stack, where every write took 10–57 s (A13.4's first case
 * alone sends ten before it opens the dialog); on a fresh stack the whole
 * file takes under a minute. The file's budget is their sum
 * (lib/budget.mjs), so a slow stack no longer cancels healthy cases.
 */
const REQ_MS = 90_000;
/** A page's own waits for the server (signing in, opening a document): past Hosting's 60 s cut-off, so a slow answer ends in an answer or a 504. */
const PAGE_MS = 90_000;

/** SPEC §13's grant lists, by role (app/src/roles.ts GRANT_LIST). */
const GRANT_LIST = { viewer: "viewers", suggester: "suggesters", editor: "editors", approver: "approvers" };
/** What the dialog calls each role (app/src/roles.ts ROLE_LABEL). */
const ROLE_LABEL = { viewer: "Can read", suggester: "Can suggest", editor: "Can edit", approver: "Can approve" };
/** The owner's row (app/src/components/SharePanel.tsx). */
const OWNER_SUB = "Owner — cannot be removed";
/** An inherited row on a folder the owner may not open (SharePanel.tsx InheritedRow). */
const HIDDEN_VIA = "via a folder you cannot open";

const tag = () => `${runTag(target.runId)}-${rand4()}`;
const lower = (s) => String(s).toLowerCase();

// --- accounts, documents, folders --------------------------------------------

/** Cast `roles` and open a session for each: {role: session}. */
async function people(roles) {
  const accounts = await cast(target, roles);
  const sessions = await openSessions(target, accounts);
  return Object.fromEntries(roles.map((r, i) => [r, sessions[i]]));
}

function docHtml(title, marker) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h1>${title}</h1>
<p id="a13-1">Who can read this is the question: ${marker}.</p>
<p id="a13-2">A second paragraph, so the document has a body.</p>
</body>
</html>
`;
}

/** Publish a small document as `owner`, optionally into a folder (an id or a createFolder result). */
async function publishDoc(owner, name, { folder } = {}) {
  const title = `A13 ${name} ${tag()}`;
  const folderId = typeof folder === "string" ? folder : folder?.folderId;
  const up = await publish(owner.http, { body: docHtml(title, rand4()), filename: "index.html", title, name: `a13-${name}`, folderId, ownerEmail: owner.account.email, timeoutMs: REQ_MS });
  precondition(up.status === 200 && up.docId, `publishing ${name}: ${up.status}`);
  return { docId: up.docId, title };
}

/** A folder `owner` makes at the root or inside `parent` (lib/seed.mjs createFolder ledgers it) → {folderId, name, …}. */
async function folderOf(owner, name, parent = null) {
  const f = await createFolder(owner.http, { name, ...(parent ? { parentId: parent } : {}), ownerEmail: owner.account.email, timeoutMs: REQ_MS });
  precondition(typeof f.folderId === "string" && f.name === name, `creating folder ${name}: ${f.status} ${JSON.stringify(f.json)}`);
  return f;
}

/** Grant each [account, role] on `folder` as `owner`, one POST /folder-access at a time (lib/grant.mjs shareFolder; LOCAL, it emails). */
async function grantOnFolder(owner, folder, grants) {
  for (const [account, role] of grants) await shareFolder(target, { owner, folder, account, role, timeoutMs: REQ_MS });
}

/** GET /content of v1, retaining denial bytes and headers for parity checks. */
async function contentReply(http, docId, { k = null } = {}) {
  return answered(await http.get(`/content/${encodeURIComponent(docId)}/v1/`, k ? { query: { k } } : {}), `GET /content/${docId}/v1/`);
}
async function contentStatus(http, docId, options = {}) {
  return (await contentReply(http, docId, options)).status;
}

/** Every principal a record names in any of its four grant lists. */
function grantedPrincipals(rec) {
  return ROLES.flatMap((r) => rec?.[GRANT_LIST[r]] ?? []);
}

// --- RTDB as a user ----------------------------------------------------------

/**
 * The rules' verdict on one rtdbAs request: ALLOW (200) or DENY (401
 * "Permission denied"). Anything else (a 400, a 401 for a bad token) is not a
 * verdict, and fails as a precondition rather than reading as a refusal.
 */
function verdictOf(r, what) {
  if (r.verdict) return r.verdict;
  return precondition(false, `${what}: the database answered ${r.status}${r.error ? ` ${r.error}` : ""}, which is neither an allow nor a rules denial`);
}

/**
 * On a local stack, prove live that ns=<projectId> enforces the tree's
 * database.rules.json (lib/rtdb.mjs rtdbRulesStatus: byte-equal read-back and
 * an anonymous root read refused). Without that every DENY below is blind.
 * Production runs its deployed rules, which nothing here can read back.
 */
async function rulesEnforced(ctx) {
  if (target.kind !== "local") {
    ctx.step("production: the deployed RTDB rules decide");
    return null;
  }
  const s = await rtdbRulesStatus(target, { http: ctx.http({ actor: "rtdb-rules" }) });
  precondition(s.ok, `RTDB ns=${s.namespace} enforces the tree's rules: ${s.reason}`);
  ctx.step(`RTDB ns=${s.namespace} enforces ${s.file} (${s.bytes} bytes, read back byte-equal; an anonymous read answers ${s.anonymousStatus})`);
  return s;
}

/** A peer node the rules accept from `session` (database.rules.json status/$docId/peers/$uid). */
function peerNode(session) {
  return { email: lower(session.account.email), mode: "view", lastChanged: { ".sv": "timestamp" } };
}

// --- the Share dialog ---------------------------------------------------------

/** Sign in through the UI and open the document. */
async function signedInAt(ctx, name, session, docId) {
  const u = await ctx.users.user({ name });
  await u.signInUi(session.account.email, session.account.password, { timeout: PAGE_MS });
  await u.open(docId, { timeout: PAGE_MS });
  await u.page.locator(".viewer-toolbar").waitFor({ state: "visible", timeout: 30_000 });
  return u;
}

/** Press Share in the viewer's toolbar → the dialog. */
async function openShare(u, title) {
  await u.page.locator('.viewer-toolbar [aria-label="Share"]').first().click();
  const dialog = u.page.getByRole("dialog", { name: `Share “${title}”` });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  return dialog;
}

/**
 * Every row of the dialog's people list, top to bottom: the name, the
 * sub-lines, the role (a select's value, or an inherited row's label), and
 * which controls it has.
 */
async function shareRows(dialog) {
  return dialog.locator(".share-list > li.share-row").evaluateAll((lis) =>
    lis.map((li) => {
      const select = li.querySelector("select");
      const subs = Array.from(li.querySelectorAll(".share-principal .share-sub")).map((s) => s.textContent.trim());
      return {
        name: li.querySelector(".share-name")?.textContent.trim() ?? null,
        subs,
        via: subs.find((s) => s.startsWith("via ")) ?? null,
        role: select ? select.value : (li.querySelector(".share-role")?.textContent.trim() ?? null),
        select: Boolean(select),
        buttons: Array.from(li.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent.trim()),
        controls: li.querySelectorAll("button, select, input, textarea").length,
      };
    }),
  );
}

/** Wait until the dialog lists `count` inherited rows, the list held still for 3 samples (they come from GET /access). */
async function inheritedRows(dialog, count, what) {
  return eventually(
    async () => {
      const rows = await shareRows(dialog);
      return rows.filter((r) => r.via).length === count ? rows : false;
    },
    { timeout: 45_000, interval: 250, stableSamples: 3, message: `${what}: ${count} inherited rows` },
  );
}

/**
 * Run `act` as the user `u` and resolve the POST `path` it caused (status and
 * JSON), from the user's response log (a mark taken before the act, so a fast
 * answer is never missed). It waits 75 s: under load the functions emulator
 * kills a request at its ~60 s timeout and Hosting answers 504 (seen on a
 * shared stack: "Your function timed out after ~60s", the dialog's toast "That
 * did not work (504)"). That 504 is the stack, not this spec's oracle:
 * lib/test.mjs answered() raises it as E2E_STACK_CUTOFF, which ends the case
 * INCONCLUSIVE (inconclusiveOnStackTimeout), and a 504 sooner than the
 * cut-off is an answer, judged like any other.
 */
async function posting(u, path, act) {
  const mark = u.responseMark();
  await act();
  const r = answered(await u.waitForResponse({ method: "POST", path }, { since: mark, timeout: 75_000 }), `the page's POST ${path}`);
  let json = null;
  try {
    json = await r.response.json();
  } catch {}
  return { status: r.status, json };
}

// --- A13.1 --------------------------------------------------------------------

scenario("A13.1 adding a person in Share sends exactly one invitation, with the subject \"<owner> shared “<title>” with you\"; re-saving the same list sends none", {
  tiers: ["local"],
  effects: ["email:POST /access"],
  needs: ["email", "mailpit", "mail-fail-recipient"],
  timeoutMs: 300_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O } = await people(["owner"]);
  const [invitee] = await cast(target, ["invitee"]);
  const { docId, title } = await publishDoc(O, "invite");
  const box = mailbox(target, { http: ctx.http({ actor: "mailpit" }) });
  const shim = shimControl(target, { http: ctx.http({ actor: "shim" }) });
  precondition((await box.find({ to: invitee.email })).length === 0, "nothing for the invitee before the share");

  ctx.step(`the owner signs in, opens Share, types ${invitee.email}, picks "Can edit" and presses Add`);
  const o = await signedInAt(ctx, "owner", O, docId);
  const dialog = await openShare(o, title);
  const add = async () => {
    await dialog.locator("#share-input").fill(invitee.email);
    await dialog.getByLabel("Access level").selectOption("editor");
    return posting(o, "/access", () => dialog.getByRole("button", { name: "Add", exact: true }).click());
  };
  const first = await add();
  assert.equal(first.status, 200, `POST /access from the dialog: ${JSON.stringify(first.json)}`);
  assert.deepEqual(first.json?.editors, [invitee.email], "the dialog's add stored the invitee as an editor");
  await eventually(async () => (await shareRows(dialog)).some((r) => r.name === invitee.email && r.role === "editor") || false, { timeout: 10_000, message: "the invitee's row, Can edit" });
  const rec1 = await readDoc(target, `docs/${docId}`);
  assert.ok(rec1.members.includes(invitee.email) && rec1.editorMembers.includes(invitee.email), `the record: members ${JSON.stringify(rec1.members)}`);

  ctx.step("one invitation: the shim received one send for the invitee (made before POST /access answered), and it reaches Mailpit with notify.ts's subject and a link to this document");
  assert.equal((await shim.requests({ to: invitee.email })).length, 1, "the add sent one invitation");
  const messages = await eventually(async () => {
    const m = await box.find({ to: invitee.email });
    return m.length >= 1 ? m : false;
  }, { timeout: 30_000, interval: 250, message: "the invitation in Mailpit" });
  assert.equal(messages[0].Subject, `${O.account.email} shared “${title}” with you`, "the invitation's subject");
  const full = await box.message(messages[0].ID);
  assert.ok(String(full.Text).includes(`${target.origin}/d/${docId}`), `the text part links to the document: ${String(full.Text).slice(0, 300)}`);

  ctx.step("re-save 1: the owner adds the same address with the same role again in the dialog");
  const again = await add();
  assert.equal(again.status, 200, "the repeated add is accepted");
  assert.deepEqual({ viewers: again.json?.viewers, editors: again.json?.editors, members: again.json?.members }, { viewers: rec1.viewers, editors: rec1.editors, members: rec1.members }, "the repeated add changes nothing");
  assert.equal((await shareRows(dialog)).filter((r) => r.name === invitee.email).length, 1, "the invitee is still one row");

  ctx.step("re-save 2: the owner POSTs the whole list back as it stands");
  const rec2 = await readDoc(target, `docs/${docId}`);
  const whole = ROLES.flatMap((role) => (rec2[GRANT_LIST[role]] ?? []).map((email) => ({ email, role })));
  const resave = answered(await O.http.postJson("/access", { docId, add: whole }), "POST /access");
  assert.equal(resave.status, 200);
  assert.deepEqual(resave.json?.members, rec1.members, "the same list leaves the members as they were");

  ctx.step("no second invitation: the shim still holds one send for the invitee (each send is made before POST /access answers), and Mailpit's count holds at exactly one for 10 s");
  const sends = await shim.requests({ to: invitee.email });
  assert.equal(sends.length, 1, `re-saving the same list sent another invitation: the shim received ${sends.length} for the invitee (${sends.map((s) => s.subject).join(" | ")})`);
  await box.expectMail({ to: invitee.email, count: 1 });
  assert.deepEqual(await box.find({ to: O.account.email }), [], "the owner is not invited");
});

// --- A13.2 --------------------------------------------------------------------

scenario("A13.2 removing a member gives them the absent id's 404 within 2 s, takes away their presence mirror, and the RTDB rules then refuse their reads and writes", {
  tiers: ["local", "prod"],
  timeoutMs: 240_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O, viewer: V, other: W } = await people(["owner", "viewer", "other"]);
  const { docId } = await publishDoc(O, "remove");
  for (const s of [V, W]) {
    const g = await share(target, { owner: O, doc: docId, account: s.account, role: "viewer", timeoutMs: REQ_MS });
    precondition(g.status === 200 && g.mirror?.ok, `sharing with ${s.account.role}: ${g.status} mirror ${JSON.stringify(g.mirror)} (a missing mirror on production is suspect S16)`);
  }
  await rulesEnforced(ctx);
  const vdb = rtdbAs(target, { idToken: V.idToken, http: ctx.http({ actor: "viewer-rtdb" }) });
  const wdb = rtdbAs(target, { idToken: W.idToken, http: ctx.http({ actor: "other-rtdb" }) });
  const anon = ctx.http({ actor: "anon" });
  const vKey = emailKey(V.account.email);

  ctx.step("before: the viewer reads the content and the live state, and may write their own peer node");
  precondition((await contentStatus(V.http, docId)) === 200, "the viewer reads the content before the removal");
  assert.equal(verdictOf(await vdb.get(`status/${docId}/peers`), "V's read before"), "ALLOW", "control: the viewer's read of status/{doc}/peers is allowed while a member");
  assert.equal(verdictOf(await vdb.put(`status/${docId}/peers/${V.uid}`, peerNode(V)), "V's peer write before"), "ALLOW", "control: the viewer's peer write is allowed while a member");
  precondition(verdictOf(await vdb.delete(`status/${docId}/peers/${V.uid}`), "V's peer delete") === "ALLOW", "the viewer removed the peer node it wrote");

  ctx.step("the owner removes the viewer");
  const r = await unshare(target, { owner: O, doc: docId, account: V.account, timeoutMs: REQ_MS });
  assert.equal(r.status, 200);
  const removedAt = Date.now();

  ctx.step("the viewer's next reads, one every 100 ms: a read SENT within 2 s of the removal is the absent id's 404");
  // Timed by when each read was sent, not by when it was answered: the
  // property is that access stops, and an emulator slowed by load answers
  // late whatever it answers.
  const reads = [];
  for (;;) {
    const sentAfter = Date.now() - removedAt;
    const response = await contentReply(V.http, docId);
    const status = response.status;
    reads.push({ sentAfter, status, answeredAfter: Date.now() - removedAt, response });
    if (status === 404 || sentAfter > 2_000) break;
    await new Promise((r) => setTimeout(r, 100)); // the poll's own interval
  }
  const notFound = reads.find((r) => r.status === 404);
  assert.ok(notFound && notFound.sentAfter <= 2_000, `the removed viewer still reads ${reads.at(-1).status} more than 2 s after the removal: ${JSON.stringify(reads.slice(-3))}`);
  ctx.step(`404 for a read sent ${notFound.sentAfter} ms after the removal (answered at ${notFound.answeredAfter} ms; ${reads.length} read(s))`);
  const absent = answered(await anon.get(`/content/${encodeURIComponent(`${docId}-absent`)}/v1/`), "GET /content of an absent id");
  assert.equal(absent.status, 404, "an absent id is 404 too");
  assert.equal(sameBytes(notFound.response.buffer, absent.buffer).equal, true, "a removed member receives the absent id's exact body bytes");
  assert.equal(sameHeadersExceptDate(notFound.response, absent).equal, true, `a removed member receives the absent id's headers: ${JSON.stringify(sameHeadersExceptDate(notFound.response, absent).diff)}`);

  ctx.step("the RTDB rules refuse the removed viewer's read of status/{doc}/peers and write of their peer node; the other viewer is still allowed");
  assert.equal(verdictOf(await vdb.get(`status/${docId}/peers`), "V's read after"), "DENY", "the removed viewer's RTDB read is refused");
  assert.equal(verdictOf(await vdb.put(`status/${docId}/peers/${V.uid}`, peerNode(V)), "V's peer write after"), "DENY", "the removed viewer's peer write is refused");
  assert.equal(verdictOf(await wdb.get(`status/${docId}/peers`), "W's read"), "ALLOW", "the other viewer still reads the live state");
  assert.equal(await contentStatus(W.http, docId), 200, "the other viewer still reads the content");

  ctx.step("the record and the presence mirror no longer hold the viewer; the other viewer keeps both");
  const rec = await readDoc(target, `docs/${docId}`);
  assert.ok(!rec.members.includes(V.account.email) && !grantedPrincipals(rec).includes(V.account.email), `the record still names the viewer: ${JSON.stringify(rec.members)}`);
  assert.equal(await rtdbGet(target, `presenceAccess/${docId}/${vKey}`), null, "the viewer's presence mirror is gone");
  assert.equal(await rtdbGet(target, `presenceAccess/${docId}/${emailKey(W.account.email)}`), true, "the other viewer's mirror stays");
});

// --- A13.3 --------------------------------------------------------------------

scenario("A13.3 changing a member's role sends no email, and Edit appears in their open viewer without a reload", {
  tiers: ["local", "prod"],
  timeoutMs: 240_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O } = await people(["owner"]);
  const [memberAcct] = await cast(target, ["member"]);
  const M = { account: memberAcct };
  const { docId, title } = await publishDoc(O, "role");
  const g = await share(target, { owner: O, doc: docId, account: M.account, role: "viewer", timeoutMs: REQ_MS });
  precondition(g.status === 200, `sharing with the member: ${g.status}`);
  const mail = target.capabilities.has("mailpit") ? mailbox(target, { http: ctx.http({ actor: "mailpit" }) }) : null;
  const shim = target.capabilities.has("mail-fail-recipient") ? shimControl(target, { http: ctx.http({ actor: "shim" }) }) : null;
  if (mail) {
    ctx.step("the share's own invitation is the baseline the role change must not move: one send at the shim, and it reaches Mailpit");
    if (shim) assert.equal((await shim.requests({ to: M.account.email })).length, 1, "the share sent one invitation");
    await eventually(async () => (await mail.find({ to: M.account.email })).length >= 1 || false, { timeout: 30_000, interval: 250, message: "the share's invitation in Mailpit" });
  }

  ctx.step("the member opens the document as a viewer: no Edit");
  const m = await signedInAt(ctx, "member", M, docId);
  const edit = m.page.locator('.viewer-toolbar [aria-label="Edit"]');
  assert.equal(await edit.count(), 0, "a viewer has no Edit");
  const marker = `a13-${rand4()}`;
  await m.page.evaluate((v) => {
    window.__a13 = v;
  }, marker);

  let roleWriteAt;
  if (target.kind === "local") {
    ctx.step("the owner changes the member to Can edit with the row's select in Share");
    const o = await signedInAt(ctx, "owner", O, docId);
    const dialog = await openShare(o, title);
    const select = dialog.getByLabel(`Access for ${M.account.email}`);
    await select.waitFor({ state: "visible", timeout: 20_000 });
    assert.equal(await select.inputValue(), "viewer");
    roleWriteAt = Date.now();
    const changed = await posting(o, "/access", () => select.selectOption("editor"));
    assert.equal(changed.status, 200, `POST /access from the row's select: ${JSON.stringify(changed.json)}`);
    assert.deepEqual({ viewers: changed.json?.viewers, editors: changed.json?.editors }, { viewers: [], editors: [M.account.email] }, "one role per principal: moved, not added");
  } else {
    ctx.step("the operator changes the member to editor (production: set-access.mjs, which sends nothing)");
    roleWriteAt = Date.now();
    const up = await share(target, { owner: O, doc: docId, account: M.account, role: "editor", timeoutMs: REQ_MS });
    assert.equal(up.status, 200);
  }

  ctx.step("Edit appears in the member's open viewer, and the page was not reloaded");
  const appeared = await edit.first().waitFor({ state: "visible", timeout: 30_000 }).then(() => true, () => false);
  if (!appeared) {
    const loss = unrecoveredListenerLoss(m, roleWriteAt);
    if (loss) ctx.inconclusive(`Edit did not appear after the role write while this member's listener remained disconnected (${loss.signs} new sign(s), no later successful Listen response)`);
  }
  assert.ok(appeared, "Edit did not appear in the member's open viewer within 30 s of the role change");
  assert.equal(await m.page.evaluate(() => window.__a13), marker, "the member's page is the same page: no reload");
  const rec = await readDoc(target, `docs/${docId}`);
  assert.ok(rec.editorMembers.includes(M.account.email) && !(rec.viewers ?? []).includes(M.account.email), `the record: editors ${JSON.stringify(rec.editors)} viewers ${JSON.stringify(rec.viewers)}`);
  if (target.kind === "local") assert.equal(await rtdbGet(target, `editAccess/${docId}/${emailKey(M.account.email)}`), true, "the edit mirror follows the role");

  if (mail) {
    ctx.step("no email for the role change: the shim received only the share's invitation, and Mailpit's count holds at one for 10 s");
    if (shim) {
      const sends = await shim.requests({ to: M.account.email });
      assert.equal(sends.length, 1, `the role change emailed the member: the shim received ${sends.length} sends (${sends.map((s) => s.subject).join(" | ")})`);
    }
    await mail.expectMail({ to: M.account.email, count: 1 });
  } else {
    ctx.step("no Mailpit on this target: the zero-send proof is the run's");
  }
});

// --- A13.4 --------------------------------------------------------------------

scenario("A13.4 inherited grants: listed after the document's own, nearest folder first and highest role first, each with its folder's path and no controls; a person granted directly and through a folder has both rows", {
  tiers: ["local", "prod"],
  effects: ["email:POST /folder-access", "email:POST /access"],
  timeoutMs: 480_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O } = await people(["owner"]);
  const t = tag();
  const [nameA, nameB] = [`A13.4 outer ${t}`, `A13.4 inner ${t}`];
  const A = await folderOf(O, nameA);
  const B = await folderOf(O, nameB, A);
  const who = Object.fromEntries(["aview", "aedit", "bsugg", "bappr", "both", "dview"].map((r) => [r, localEmail(target, r)]));

  ctx.step(`folders ${nameA} / ${nameB}; ${nameA} grants a viewer and an editor, ${nameB} a suggester, an approver and a viewer`);
  await grantOnFolder(O, A, [[who.aview, "viewer"], [who.aedit, "editor"]]);
  await grantOnFolder(O, B, [[who.bsugg, "suggester"], [who.bappr, "approver"], [who.both, "viewer"]]);
  const { docId, title } = await publishDoc(O, "inherit", { folder: B });
  ctx.step("a document filed in the inner folder, shared directly with an editor (also a viewer through the folder) and a viewer");
  for (const [email, role] of [[who.both, "editor"], [who.dview, "viewer"]]) {
    const g = await share(target, { owner: O, doc: docId, account: email, role, timeoutMs: REQ_MS });
    precondition(g.status === 200, `sharing ${email}: ${g.status}`);
  }

  ctx.step("GET /access: every grant on the inner folder, then the outer, highest role first within each, each with its path");
  const inh = answered(await O.http.get("/access", { query: { docId } }), "GET /access");
  assert.equal(inh.status, 200);
  const pathB = `${nameA}/${nameB}`;
  const want = [
    { folderId: B.folderId, path: pathB, principal: who.bappr, role: "approver" },
    { folderId: B.folderId, path: pathB, principal: who.bsugg, role: "suggester" },
    { folderId: B.folderId, path: pathB, principal: who.both, role: "viewer" },
    { folderId: A.folderId, path: nameA, principal: who.aedit, role: "editor" },
    { folderId: A.folderId, path: nameA, principal: who.aview, role: "viewer" },
  ];
  assert.deepEqual(inh.json?.inherited, want, "GET /access inherited");

  ctx.step("the dialog: the owner, the document's own rows with a select and Remove, then the inherited rows in that order, with no controls");
  const o = await signedInAt(ctx, "owner", O, docId);
  const dialog = await openShare(o, title);
  const rows = await inheritedRows(dialog, want.length, "the share dialog");
  assert.deepEqual(rows[0], { name: O.account.email, subs: [OWNER_SUB], via: null, role: null, select: false, buttons: [], controls: 0 }, "the owner's row");
  assert.deepEqual(
    rows.slice(1, 3).map((r) => ({ name: r.name, role: r.role, select: r.select, buttons: r.buttons, via: r.via })),
    [
      { name: who.both, role: "editor", select: true, buttons: [`Remove ${who.both}`], via: null },
      { name: who.dview, role: "viewer", select: true, buttons: [`Remove ${who.dview}`], via: null },
    ],
    "the document's own rows, highest role first, each with a select and a Remove",
  );
  assert.deepEqual(
    rows.slice(3).map((r) => ({ name: r.name, role: r.role, via: r.via, controls: r.controls })),
    want.map((w) => ({ name: w.principal, role: ROLE_LABEL[w.role], via: `via ${w.path}`, controls: 0 })),
    "the inherited rows: nearest folder first, highest role first, each with its path and no select, button or field",
  );
  assert.equal(rows.length, 1 + 2 + want.length, "nothing else is listed");
  assert.equal(rows.filter((r) => r.name === who.both).length, 2, "the person granted directly and through the folder has both rows");
});

scenario("A13.4 three folder levels: the inherited grants still come nearest folder first, the parent before the root", {
  tiers: ["local", "prod"],
  effects: ["email:POST /folder-access"],
  timeoutMs: 300_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O } = await people(["owner"]);
  const t = tag();
  const names = [`A13.4 root ${t}`, `A13.4 middle ${t}`, `A13.4 leaf ${t}`];
  const A = await folderOf(O, names[0]);
  const B = await folderOf(O, names[1], A);
  const C = await folderOf(O, names[2], B);
  const who = { a: localEmail(target, "rootview"), b: localEmail(target, "midview"), c: localEmail(target, "leafview") };
  ctx.step(`folders ${names.join(" / ")}, each granting one viewer of its own`);
  for (const [folder, email] of [[A, who.a], [B, who.b], [C, who.c]]) await grantOnFolder(O, folder, [[email, "viewer"]]);
  const { docId } = await publishDoc(O, "three-levels", { folder: C });
  const inh = answered(await O.http.get("/access", { query: { docId } }), "GET /access");
  precondition(inh.status === 200 && Array.isArray(inh.json?.inherited) && inh.json.inherited.length === 3, `GET /access: ${inh.status} ${inh.text.slice(0, 300)}`);
  const got = inh.json.inherited.map((r) => ({ path: r.path, principal: r.principal }));
  ctx.ev.json("inherited", inh.json.inherited);
  // The dialog lists GET /access's rows in its order, verbatim (SharePanel.tsx
  // `inherited.map`; the first A13.4 case asserts the dialog's order equals
  // the answer's), so the order the server gives is the order a person reads.

  ctx.step("SPEC §13: nearest folder first — the leaf, then the middle, then the root");
  const want = [
    { path: names.join("/"), principal: who.c },
    { path: `${names[0]}/${names[1]}`, principal: who.b },
    { path: names[0], principal: who.a },
  ];
  assert.deepEqual(got, want, "GET /access lists the inherited grants nearest folder first");
});

scenario("A13.4 a folder above that the owner cannot open is shown as \"a folder you cannot open\", never by its name", {
  tiers: ["local", "prod"],
  effects: ["email:POST /folder-access"],
  timeoutMs: 300_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O, other: P } = await people(["owner", "other"]);
  const t = tag();
  const top = `A13.4 hidden ${t}`;
  const mid = `A13.4 open ${t}`;
  const reader = localEmail(target, "topview");
  ctx.step(`another account owns ${top} and, inside it, ${mid}; it grants a viewer on ${top} and the owner Can edit on ${mid}`);
  const Top = await folderOf(P, top);
  const Mid = await folderOf(P, mid, Top);
  await grantOnFolder(P, Top, [[reader, "viewer"]]);
  await grantOnFolder(P, Mid, [[O.account, "editor"]]);
  precondition(answered(await O.http.get("/folder-access", { query: { folderId: Top.folderId } }), "GET /folder-access").status === 404, `the owner cannot open ${top}`);
  const { docId, title } = await publishDoc(O, "hidden-folder", { folder: Mid });

  ctx.step("GET /access names the level the owner can open and writes … for the one they cannot");
  const inh = answered(await O.http.get("/access", { query: { docId } }), "GET /access");
  assert.equal(inh.status, 200);
  assert.deepEqual(inh.json?.inherited, [
    { folderId: Mid.folderId, path: `…/${mid}`, principal: O.account.email, role: "editor" },
    { folderId: Top.folderId, path: "…", principal: reader, role: "viewer" },
  ], "GET /access inherited");
  assert.ok(!inh.text.includes(top), "the answer never names the folder the owner cannot open");

  ctx.step("the dialog: the hidden folder's grant reads \"via a folder you cannot open\", and its name is nowhere in the dialog");
  const o = await signedInAt(ctx, "owner", O, docId);
  const dialog = await openShare(o, title);
  const rows = (await inheritedRows(dialog, 2, "the share dialog")).filter((r) => r.via);
  assert.deepEqual(rows.map((r) => ({ name: r.name, via: r.via, controls: r.controls })), [
    { name: O.account.email, via: `via …/${mid}`, controls: 0 },
    { name: reader, via: HIDDEN_VIA, controls: 0 },
  ]);
  assert.ok(!(await dialog.textContent()).includes(top), "the dialog never names the folder the owner cannot open");
  assert.ok(rec(await readDoc(target, `docs/${docId}`)).members.includes(reader), "the hidden folder's reader is a member all the same");
});

/** A record, or a precondition failure when it is absent. */
function rec(r) {
  precondition(r, "the record exists");
  return r;
}

// --- A13.5 --------------------------------------------------------------------

scenario("A13.5 a team grant expands to the team's members; removing one from the team revokes them from the document and the folder the team was granted on", {
  tiers: ["local", "prod"],
  effects: ["email:POST /team-members", "email:POST /access", "email:POST /folder-access"],
  timeoutMs: 420_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O, one: T1, two: T2 } = await people(["owner", "one", "two"]);
  const t = tag();
  const teamName = `A13.5 team ${t}`;
  ctx.step(`the owner creates ${teamName} and adds two people`);
  const made = await createTeam(O.http, { name: teamName, ownerEmail: O.account.email, timeoutMs: REQ_MS });
  precondition(typeof made.teamId === "string" && made.name === teamName, `POST /team: ${made.status} ${JSON.stringify(made.json)}`);
  const team = principalOf(made);
  const added = await teamMembers(O.http, made, { add: [T1.account, T2.account], timeoutMs: REQ_MS });
  assert.deepEqual(added.members, [O.account.email, T1.account.email, T2.account.email].sort(), "the team: its owner and the two");

  ctx.step("the team is granted Can read on a document, and Can edit on a folder holding a second document");
  const d1 = await publishDoc(O, "team-doc");
  // lib/grant.mjs share() grants a team as the product names it,
  // {principal: "team:<id>", role}, keeping the id's case, and reads every
  // member's mirror back (readTeamMirror).
  const g = await share(target, { owner: O, doc: d1.docId, team: made, role: "viewer", timeoutMs: REQ_MS });
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.viewers, [team], "the grant is stored as the team, not as its people");
  const F = await folderOf(O, `A13.5 folder ${t}`);
  const d2 = await publishDoc(O, "team-folder-doc", { folder: F });
  await shareFolder(target, { owner: O, folder: F, account: made, role: "editor", timeoutMs: REQ_MS });

  ctx.step("expanded: both people are in each record's effective sets, read both documents, and hold the presence mirror");
  const r1 = await readDoc(target, `docs/${d1.docId}`);
  const r2 = await readDoc(target, `docs/${d2.docId}`);
  for (const s of [T1, T2]) {
    const e = s.account.email;
    assert.ok(r1.members.includes(e) && !r1.editorMembers.includes(e), `${s.account.role} reads ${d1.docId} through the team, and only reads`);
    assert.ok(r2.editorMembers.includes(e), `${s.account.role} edits ${d2.docId} through the team's folder grant`);
    assert.deepEqual([await contentStatus(s.http, d1.docId), await contentStatus(s.http, d2.docId)], [200, 200], `${s.account.role} reads both documents`);
  }
  assert.ok(!grantedPrincipals(r1).includes(T1.account.email), "the team's people are not written into the grant lists");
  if (target.kind === "local") {
    assert.equal(await rtdbGet(target, `presenceAccess/${d1.docId}/${emailKey(T1.account.email)}`), true, "the presence mirror holds the team's member");
    assert.deepEqual(g.mirror.members.filter((m) => !m.presence).map((m) => m.email), [], "every person the team names holds the presence mirror of the team's document");
    assert.equal(await rtdbGet(target, `editAccess/${d2.docId}/${emailKey(T1.account.email)}`), true, "the edit mirror holds the team's member on the folder's document");
  }

  ctx.step("the dialog names the team, counts its people, and says who they are");
  const o = await signedInAt(ctx, "owner", O, d1.docId);
  const dialog = await openShare(o, d1.title);
  const row = await eventually(async () => (await shareRows(dialog)).find((r) => r.name === teamName && r.subs.includes("3 people")) ?? false, { timeout: 15_000, message: "the team's row, named and counted" });
  assert.equal(row.role, "viewer");
  const who = dialog.locator(".team-expansion");
  await who.locator("summary").click();
  assert.equal((await who.textContent()).replace(/^Who that is/, "").trim(), [O.account.email, T1.account.email, T2.account.email].sort().join(", "), "the team's expansion, inline");

  ctx.step("the owner removes the first person from the team");
  const removed = await teamMembers(O.http, made, { remove: [T1.account], timeoutMs: REQ_MS });
  assert.deepEqual(removed.members, [O.account.email, T2.account.email].sort());
  assert.equal(removed.affected, 2, "the re-fan reached the document grant and the folder grant");

  ctx.step("revoked everywhere: out of both documents' and the folder's sets, 404 on both, mirrors gone; the other person keeps both");
  const [a1, a2, af] = await Promise.all([readDoc(target, `docs/${d1.docId}`), readDoc(target, `docs/${d2.docId}`), readDoc(target, `folders/${F.folderId}`)]);
  for (const [what, r] of [[d1.docId, a1], [d2.docId, a2], [`folder ${F.folderId}`, af]]) {
    assert.ok(!r.members.includes(T1.account.email), `${what} still lists the removed member: ${JSON.stringify(r.members)}`);
    assert.ok(r.members.includes(T2.account.email), `${what} dropped the remaining member`);
  }
  assert.deepEqual([await contentStatus(T1.http, d1.docId), await contentStatus(T1.http, d2.docId)], [404, 404], "the removed member reads neither document");
  assert.deepEqual([await contentStatus(T2.http, d1.docId), await contentStatus(T2.http, d2.docId)], [200, 200], "the remaining member reads both");
  if (target.kind === "local") {
    const k1 = emailKey(T1.account.email);
    assert.deepEqual(
      [await rtdbGet(target, `presenceAccess/${d1.docId}/${k1}`), await rtdbGet(target, `presenceAccess/${d2.docId}/${k1}`), await rtdbGet(target, `editAccess/${d2.docId}/${k1}`)],
      [null, null, null],
      "the removed member's presence and edit mirrors are gone",
    );
  }
});

// --- A13.6 --------------------------------------------------------------------

scenario("A13.6 a folder grant reaches documents two and three levels down, filed before it and after it, and removing it reaches them too", {
  tiers: ["local", "prod"],
  effects: ["email:POST /folder-access"],
  timeoutMs: 360_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O, grantee: G } = await people(["owner", "grantee"]);
  const t = tag();
  const A = await folderOf(O, `A13.6 top ${t}`);
  const B = await folderOf(O, `A13.6 middle ${t}`, A);
  const C = await folderOf(O, `A13.6 bottom ${t}`, B);
  const [d1, d2] = await Promise.all([publishDoc(O, "in-middle", { folder: B }), publishDoc(O, "in-bottom", { folder: C })]);
  const before = await Promise.all([d1, d2].map((d) => contentStatus(G.http, d.docId)));
  precondition(before.every((s) => s === 404), `the grantee reads nothing before the grant (${before})`);

  ctx.step("the owner grants the grantee Can read on the top folder");
  const r = await shareFolder(target, { owner: O, folder: A, account: G.account, role: "viewer", timeoutMs: REQ_MS });
  assert.equal(r.status, 200, `POST /folder-access: ${JSON.stringify(r.json)}`);
  const d3 = await publishDoc(O, "after-grant", { folder: C });
  const docs = [d1, d2, d3];

  ctx.step("the grantee is a member of both folders below and of every document in them, filed before or after the grant, and reads each");
  const gKey = emailKey(G.account.email);
  const folders = await Promise.all([B, C].map((f) => readDoc(target, `folders/${f.folderId}`)));
  for (const [i, f] of [B, C].entries()) assert.ok(folders[i].members.includes(G.account.email), `folder ${f.folderId} inherited the grantee`);
  const granted = await Promise.all(docs.map(async (d) => ({
    d,
    rec: await readDoc(target, `docs/${d.docId}`),
    content: await contentStatus(G.http, d.docId),
    mirror: target.kind === "local" ? await rtdbGet(target, `presenceAccess/${d.docId}/${gKey}`) : true,
  })));
  for (const { d, rec: rd, content, mirror } of granted) {
    assert.ok(rd.members.includes(G.account.email) && !rd.suggesterMembers.includes(G.account.email), `${d.docId}: the grantee reads through the folder, and only reads`);
    assert.equal(content, 200, `${d.docId}: the grantee reads the content`);
    assert.equal(mirror, true, `${d.docId}: the presence mirror`);
  }

  ctx.step("the owner removes the grant on the top folder: it is gone from every level");
  const rm = await unshareFolder(target, { owner: O, folder: A, account: G.account, timeoutMs: REQ_MS });
  assert.equal(rm.status, 200);
  const revoked = await Promise.all(docs.map(async (d) => ({
    d,
    rec: await readDoc(target, `docs/${d.docId}`),
    content: await contentStatus(G.http, d.docId),
    mirror: target.kind === "local" ? await rtdbGet(target, `presenceAccess/${d.docId}/${gKey}`) : null,
  })));
  for (const { d, rec: rd, content, mirror } of revoked) {
    assert.ok(!rd.members.includes(G.account.email), `${d.docId} still lists the grantee`);
    assert.equal(content, 404, `${d.docId}: the grantee no longer reads it`);
    assert.equal(mirror, null, `${d.docId}: the presence mirror is gone`);
  }
});

// --- A13.7 --------------------------------------------------------------------

scenario("A13.7 the owner cannot be removed or written into a role, and the dialog offers no way to try", {
  tiers: ["local", "prod"],
  timeoutMs: 240_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O } = await people(["owner"]);
  const [viewerAcct] = await cast(target, ["viewer"]);
  const V = { account: viewerAcct };
  const { docId, title } = await publishDoc(O, "owner");
  const g = await share(target, { owner: O, doc: docId, account: V.account, role: "viewer", timeoutMs: REQ_MS });
  precondition(g.status === 200, `sharing with the viewer: ${g.status}`);
  const before = await readDoc(target, `docs/${docId}`);

  ctx.step("removing the owner's own address is accepted and changes nothing");
  const rm = await unshare(target, { owner: O, doc: docId, account: O.account.email, timeoutMs: REQ_MS });
  assert.equal(rm.status, 200);
  ctx.step("adding the owner as an editor is accepted and stores nothing");
  const add = await share(target, { owner: O, doc: docId, account: O.account.email, role: "editor", verify: false, timeoutMs: REQ_MS });
  assert.equal(add.status, 200);

  const after = await readDoc(target, `docs/${docId}`);
  const sets = (r) => ({ ownerEmail: r.ownerEmail, members: r.members, editorMembers: r.editorMembers, approverMembers: r.approverMembers, viewers: r.viewers, editors: r.editors });
  assert.deepEqual(sets(after), sets(before), "the record is exactly as before");
  assert.ok(after.approverMembers.includes(O.account.email) && after.members.includes(O.account.email), "the owner is still in every effective set");
  assert.ok(!grantedPrincipals(after).includes(O.account.email), "the owner is in no grant list");
  assert.equal(await contentStatus(O.http, docId), 200, "the owner still reads it");
  assert.equal(answered(await O.http.get("/access", { query: { docId } }), "GET /access").status, 200, "and still manages its sharing");

  ctx.step("the dialog: the owner's row says so and has no select and no Remove; the viewer's row has both");
  const o = await signedInAt(ctx, "owner", O, docId);
  const dialog = await openShare(o, title);
  const rows = await eventually(async () => {
    const r = await shareRows(dialog);
    return r.length === 2 ? r : false;
  }, { timeout: 20_000, stableSamples: 3, message: "two rows" });
  assert.deepEqual(rows[0], { name: O.account.email, subs: [OWNER_SUB], via: null, role: null, select: false, buttons: [], controls: 0 }, "the owner's row");
  assert.deepEqual({ name: rows[1].name, role: rows[1].role, buttons: rows[1].buttons }, { name: V.account.email, role: "viewer", buttons: [`Remove ${V.account.email}`] }, "the viewer's row");
  assert.equal(await dialog.getByRole("button", { name: `Remove ${O.account.email}` }).count(), 0, "nothing in the dialog removes the owner");
  assert.equal(await dialog.getByLabel(`Access for ${O.account.email}`).count(), 0, "nothing in the dialog sets the owner's role");
});

// --- A13.8 --------------------------------------------------------------------

/** The dialog's radio for a level. */
const radio = (dialog, level) => dialog.locator(`input[type="radio"][name="visibility"][value="${level}"]`);

/** The record's visibility triple and token. */
async function levelOf(docId) {
  const r = await readDoc(target, `docs/${docId}`);
  return { visibility: r.visibility ?? "private", publicEdit: r.publicEdit === true, linkToken: r.linkToken ?? null, expiresAt: r.expiresAt ? r.expiresAt.toMillis() : null };
}

scenario("A13.8 the visibility radios set the level; Copy puts the ?k= link on the clipboard; open editing is offered only off private; the expiry date can be cleared", {
  tiers: ["local", "prod"],
  timeoutMs: 300_000,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const { owner: O } = await people(["owner"]);
  const { docId, title } = await publishDoc(O, "levels");
  const o = await signedInAt(ctx, "owner", O, docId);
  await o.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: target.origin });
  const dialog = await openShare(o, title);
  const pick = async (level) => {
    // The dialog opens a window on the document: register it with the case
    // BEFORE the click (lib/grant.mjs trackWindow), so a case that fails or
    // times out half-way still makes the document private again.
    if (level !== "private") trackWindow(target, { owner: O, doc: docId, visibility: level });
    const r = await posting(o, "/visibility", () => radio(dialog, level).click());
    assert.equal(r.status, 200, `POST /visibility ${level}`);
    if (level === "private") trackWindow(target, { owner: O, doc: docId, visibility: "private" });
    await eventually(async () => (await radio(dialog, level).isChecked()) && (await radio(dialog, level).isEnabled()), { timeout: 10_000, message: `the ${level} radio checked and idle` });
    return r.json;
  };
  const link = dialog.getByLabel("Share link");
  const openEdit = dialog.locator("#public-edit");

  ctx.step("private: the private radio is checked, and there is no link and no open-editing box");
  assert.equal(await radio(dialog, "private").isChecked(), true);
  assert.deepEqual([await link.count(), await openEdit.count()], [0, 0], "no link row and no #public-edit while private");

  ctx.step("Anyone with the link: the record is unlisted with a token, and the link field carries it as ?k=");
  await pick("unlisted");
  const u = await levelOf(docId);
  assert.equal(u.visibility, "unlisted");
  assert.ok(typeof u.linkToken === "string" && u.linkToken.length >= 22, "a link token was minted");
  const keyed = `${target.origin}/d/${docId}?k=${u.linkToken}`;
  assert.equal(await link.inputValue(), keyed, "the link field");

  ctx.step("Copy: the clipboard holds exactly that link, and its k reads the content without an account");
  const since = o.toastMark();
  await dialog.getByRole("button", { name: "Copy", exact: true }).click();
  await o.waitForToast("Link copied", { since, timeout: 10_000 });
  const copied = await o.page.evaluate(() => navigator.clipboard.readText());
  assert.equal(copied, keyed, "the clipboard");
  const k = new URL(copied).searchParams.get("k");
  assert.equal(k, u.linkToken, "the copied ?k= is the document's link token");
  assert.equal(await contentStatus(ctx.http({ actor: "anon" }), docId, { k }), 200, "the copied key reads the content anonymously");

  ctx.step("open editing is offered now; ticking it is stored");
  await openEdit.waitFor({ state: "visible", timeout: 10_000 });
  assert.deepEqual([await openEdit.isEnabled(), await openEdit.isChecked()], [true, false]);
  const ticked = await posting(o, "/visibility", () => openEdit.click());
  assert.equal(ticked.status, 200);
  assert.equal((await levelOf(docId)).publicEdit, true, "publicEdit stored");

  ctx.step("Public: the record is public, keeps open editing, drops the token, and the link has no ?k=");
  await pick("public");
  assert.deepEqual(await levelOf(docId), { visibility: "public", publicEdit: true, linkToken: null, expiresAt: null });
  assert.equal(await link.inputValue(), `${target.origin}/d/${docId}`, "a public link carries no key");

  ctx.step("Private again: open editing is withdrawn with it, and the box and the link are gone");
  await pick("private");
  assert.deepEqual(await levelOf(docId), { visibility: "private", publicEdit: false, linkToken: null, expiresAt: null }, "making private withdraws open editing");
  await eventually(async () => (await openEdit.count()) === 0 && (await link.count()) === 0, { timeout: 10_000, message: "no #public-edit and no link while private" });

  ctx.step("expiry: a date a month out is stored as the end of that day; Clear removes it");
  const day = await o.page.evaluate(() => {
    const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return { input: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime() };
  });
  const date = dialog.locator("#expires-on");
  const clear = dialog.getByRole("button", { name: "Clear", exact: true });
  const set = await posting(o, "/visibility", () => date.fill(day.input));
  assert.equal(set.status, 200);
  assert.equal((await levelOf(docId)).expiresAt, day.end, "the expiry is the end of the chosen day");
  await clear.waitFor({ state: "visible", timeout: 10_000 });
  const cleared = await posting(o, "/visibility", () => clear.click());
  assert.equal(cleared.status, 200);
  assert.equal((await levelOf(docId)).expiresAt, null, "Clear removed the expiry");
  await eventually(async () => (await clear.count()) === 0 && (await date.inputValue()) === "", { timeout: 10_000, message: "the field empty and no Clear" });

  ctx.step("emptying the field clears it too");
  await posting(o, "/visibility", () => date.fill(day.input));
  assert.equal((await levelOf(docId)).expiresAt, day.end);
  const emptied = await posting(o, "/visibility", () => date.fill(""));
  assert.equal(emptied.status, 200);
  assert.deepEqual(await levelOf(docId), { visibility: "private", publicEdit: false, linkToken: null, expiresAt: null }, "an emptied field clears the expiry and nothing else");
});

// --- A13.9 --------------------------------------------------------------------

scenario("A13.9 local operator set-access grants and revokes an editor in Firestore and both RTDB mirrors, changing their actual reads and writes", {
  tiers: ["local"], needs: ["operator-scripts", "rtdb-rules"], timeoutMs: 240_000,
}, async (ctx) => {
  const { owner, editor } = await people(["owner", "editor"]);
  const { docId } = await publishDoc(owner, "operator-access");
  await rulesEnforced(ctx);
  const key = emailKey(editor.account.email), db = rtdbAs(target, { idToken: editor.idToken, http: ctx.http({ actor: "operator-grantee-rtdb" }) });
  const logPath = await liveLogPath(target, docId), epoch = logPath.split("/").at(-1);
  const peerPath = `status/${docId}/peers/operator-${rand4()}`;
  const peer = { uid: editor.uid, email: editor.account.email.toLowerCase(), mode: "edit", liveEpoch: epoch, lastChanged: { ".sv": "timestamp" } };
  const mirrors = async () => ({ presence: await rtdbGet(target, `presenceAccess/${docId}/${key}`), edit: await rtdbGet(target, `editAccess/${docId}/${key}`) });
  const operate = async (action) => {
    const result = await runOperator(target, "set-access.mjs", ["--doc", docId, action, editor.account.email, "--role", "editor", "--account", owner.account.email, "--project", target.projectId]);
    assert.equal(result.code, 0, `operator ${action} completes before access is observed`);
    ctx.ev.json(`operator-${action.slice(2)}`, { code: result.code, signal: result.signal, ms: result.ms });
  };
  assert.equal(await contentStatus(editor.http, docId), 404, "the future editor cannot read before the operator grant");
  assert.equal(verdictOf(await db.put(`${logPath}/before`, "AAA="), "log before grant"), "DENY", "the future editor cannot write before the operator grant");
  await operate("--add");
  const granted = await readDoc(target, `docs/${docId}`);
  assert.ok(granted.members.includes(editor.account.email) && granted.editorMembers.includes(editor.account.email) && granted.editors.includes(editor.account.email), "operator grant stores the editor and effective membership");
  assert.deepEqual(await mirrors(), { presence: true, edit: true }, "operator grant installs both member mirrors");
  assert.equal(await contentStatus(editor.http, docId), 200, "operator grant permits the editor's content read");
  assert.equal(verdictOf(await db.put(peerPath, peer), "peer after grant"), "ALLOW", "operator grant permits the editor's own presence write");
  assert.equal(verdictOf(await db.put(`${logPath}/granted`, "AAA="), "log after grant"), "ALLOW", "operator grant permits the editor's live append");
  assert.equal(verdictOf(await db.get(logPath), "log read after grant"), "ALLOW", "operator grant permits shared draft reads");
  await operate("--remove");
  const revoked = await readDoc(target, `docs/${docId}`);
  assert.ok(!revoked.members.includes(editor.account.email) && !revoked.editorMembers.includes(editor.account.email) && !revoked.editors.includes(editor.account.email), "operator revoke removes direct and effective membership");
  assert.deepEqual(await mirrors(), { presence: null, edit: null }, "operator revoke removes both member mirrors");
  assert.equal(await contentStatus(editor.http, docId), 404, "operator revoke refuses the former editor's content read");
  assert.equal(verdictOf(await db.get(logPath), "log read after revoke"), "DENY", "operator revoke refuses shared draft reads");
  assert.equal(verdictOf(await db.put(`${logPath}/revoked`, "AAA="), "log after revoke"), "DENY", "operator revoke refuses the former editor's live append");
  assert.equal(verdictOf(await db.put(peerPath, peer), "peer after revoke"), "DENY", "operator revoke refuses new presence updates");
  assert.equal(verdictOf(await db.delete(peerPath), "departed peer cleanup"), "ALLOW", "the revoked editor can remove only their departed session");
  const ownerKey = emailKey(owner.account.email);
  assert.deepEqual({ presence: await rtdbGet(target, `presenceAccess/${docId}/${ownerKey}`), edit: await rtdbGet(target, `editAccess/${docId}/${ownerKey}`) }, { presence: true, edit: true }, "operator grant and revoke retain the owner's mirrors");
});
