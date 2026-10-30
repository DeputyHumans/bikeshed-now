// SPDX-License-Identifier: Apache-2.0
// A14 Workspace: sort and search, folders, the upload dialog and drag and drop, the actions menus and the cover backfill (SPEC §2, §4, §5, §13).

/**
 * The workspace as its owner meets it, each case with its own accounts,
 * documents and folders:
 *
 *   A14.1  the default order is "Recently updated" (updatedAt desc), which a
 *          new version of the oldest document moves to the top; a sort with
 *          nothing to sort on keeps the query's createdAt desc (SPEC §5);
 *          Name sorts by title; and searching narrows the cards without one
 *          network request (no search index, overview "What this is not"),
 *          and reaches into folders
 *   A14.2  a folder made with the toolbar's Folder button, and one made inside
 *          it, each deep-link: their URL survives a reload and a fresh
 *          navigation, with the breadcrumb, the rail and the contents
 *   A14.3  the upload dialog and POST /publish behind it: only the listed
 *          types; an invalid id is a 400 that stores nothing; a taken id
 *          becomes {id}-[a-z0-9]{6}; the title comes from <title>, then
 *          og:title, then the file name, and Markdown's from its first H1,
 *          with a typed title winning; the marking checkbox is applied
 *   A14.4  dropping files on the workspace, on a folder card, inside a folder
 *          and on the dialog's drop zone: the same type rule, the folder it
 *          landed in, the account's default marking, one upload per file
 *   A14.4b dropping a file uses the same embedded title and permanent-address
 *          defaults as the upload dialog
 *   A14.5  the actions menus: rename keeps the docId, document delete is a
 *          disabled entry and /organize answers 400, deleting a folder lifts
 *          its children one level
 *   A14.5b moving a document into and out of a shared folder updates its
 *          members, and deleting that folder lifts it out (sends a folder
 *          invitation, so it is skipped on production)
 *   A14.6  the cover backfill: one cover POST per card that lacks one, none
 *          for a trusted scripted deck or a document not on screen, none on a
 *          reload; an expired document gets its cover from its owner's
 *          workspace only, and stays a placeholder for its editor
 *
 *   A14.7/8 new versions from card actions and document-frame drops; 7b/8b
 *          exercise pending, accepted, expired, revoked and active-editor
 *          refusals, preserving the selected file, draft and published bytes
 *
 * The only waits on time are the product's own clocks: an expiry instant, and
 * the backfill's idle loop (startAfterMs 1.5 s, idleMs 2 s in
 * app/src/hooks/useCoverBackfill.ts), which is what "nothing more is sent"
 * has to outlast.
 *
 * A case the stack could not serve ends INCONCLUSIVE, never PASS or FAIL
 * (every case declares lib/test.mjs's inconclusiveOnCaseTimeout): a request
 * the Hosting emulator cut off at its minute, one with no answer at all, or a
 * wait (the case's own budget included) that ran out while a page's request
 * was cut off or its Firestore client had lost the emulator. Assertions are
 * never excused.
 *
 * Negative controls live under e2e/patches/controls-a14-* and the existing
 * controls-workspace-search-quiet / controls-cover-* sets. Each targets a
 * named assertion; campaign closure still requires observed red and restored
 * green runs, not merely the existence of these patch files.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { answered, currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { absentDocId, createFolder, docIdFor, ledgerDoc, ledgerFolder, publish, readSample, updateUpload, zipBundle } from "../../lib/seed.mjs";
import { share, shareFolder } from "../../lib/grant.mjs";
import { adminFor, closeAdmin, listObjects, readCollection, readDoc, readObject, rtdbGet, trustAsOperator, writeUser } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { shimControl } from "../../lib/mail/shimctl.mjs";
import { mailbox } from "../../lib/mail/reader.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const BOTH = ["local", "prod"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- what the product says, quoted from its source -----------------------------

/** app/src/upload.ts UPLOAD_HINT. */
const UPLOAD_HINT = "A self-contained .html file, a .md file, or a .zip bundle";
/** functions/src/lib/bundle.ts extractBundle, for any other single file. */
const TYPE_ERROR = "upload a self-contained .html, a .md file, or a .zip bundle";
/** functions/src/lib/folders.ts BAD_DOC_ID. */
const BAD_DOC_ID = "id may use lowercase letters, digits and hyphens between them, up to 60 characters";
/**
 * BAD_DOC_ID as the upload dialog's toast shows it. From 0.16.0,
 * app/src/upload.ts sentence() gives a server refusal a capital and a closing
 * full stop ("A person is shown it as a sentence"). The text is written out,
 * not computed, so this is not a copy of the function it checks.
 */
const BAD_DOC_ID_TOAST = "Id may use lowercase letters, digits and hyphens between them, up to 60 characters.";
/** functions/src/index.ts organize. */
const DOC_DELETE_ERROR = "deleting documents is not supported";
/** app/src/pages/DocList.tsx docMenu's delete entry. */
const DELETE_LABEL = "Deleting documents is not supported";
const DELETE_REASON = "A document is permanent by design. A single version can be withdrawn by a deployment operator.";
/** app/src/pages/DocList.tsx folderMenu's confirmation. */
const folderDeleteConfirm = (name) => `Delete “${name}”? Everything inside moves up one level — nothing is deleted.`;
/** The input's accept list (app/src/components/UploadDialog.tsx). */
const ACCEPT = ".html,.htm,.md,.markdown,.zip";
/** The backfill's own clock (app/src/hooks/useCoverBackfill.ts): start after 1.5 s, look again every 2 s. */
const BACKFILL_SETTLE_MS = 6_000;
/**
 * An absence ("nothing was sent") can only be observed over a window. Every
 * decision these cases wait on is made synchronously in the handler that
 * shows its toast, so this only covers the delivery of a request event
 * already started; a deferred (debounced) search request gets its own,
 * longer window in A14.1.
 */
const ABSENCE_SETTLE_MS = 1_000;
const DEBOUNCE_WINDOW_MS = 2_000;

/** functions/src/lib/folders.ts slugify. */
function slugify(name) {
  const base = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base || "untitled";
}

// --- fixtures -------------------------------------------------------------------

/**
 * A small HTML document with a first screen a capture cannot mistake for a
 * blank page. `title` and `og` go in the head when given; `heading` is body
 * text, which the title scanner never reads.
 */
function pageHtml({ title = null, og = null, heading, text = "" }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8">${title != null ? `<title>${title}</title>` : ""}${og != null ? `<meta property="og:title" content="${og}">` : ""}</head>
<body style="margin:0;background:#f4efe6;color:#1d2a3a;font:24px/1.4 Georgia,serif">
<h1 style="font-size:72px;margin:40px;padding:24px;background:#1d2a3a;color:#f4efe6">${heading}</h1>
<p style="margin:40px">${text || `A14 workspace fixture: ${heading}.`}</p>
</body>
</html>
`;
}

const file = (name, data, type = "") => ({ name, data: Buffer.isBuffer(data) ? data : Buffer.from(String(data), "utf8"), type });

// --- accounts, records, ledger ----------------------------------------------------

/**
 * Every server call this spec makes waits up to this long for its answer
 * (http.mjs defaults to 60 s, the same as Hosting's cut-off; each session's
 * client is opened with this, so a slow call ends in Hosting's 504 rather
 * than in the client's own deadline). The Functions emulator of a shared
 * stack has been measured at 3.5 s for POST /session and over 60 s for one
 * POST /publish while peer specs run; a bound is not an oracle.
 *
 * Every client is made with `cutoffError: true`: Hosting's own 504 at its
 * minute (lib/test.mjs HOSTING_CUTOFF_MS) throws E2E_STACK_CUTOFF, which
 * ends the case INCONCLUSIVE; any other status, a quick 504 included, is the
 * product's and is judged.
 */
const REQUEST_MS = 180_000;
/** How long a page's own request may take to be answered: past Hosting's cut-off, so a stalled one ends in its 504. */
const PAGE_ANSWER_MS = 180_000;
/**
 * How long a freshly loaded page may take to show the workspace or the
 * Account page: the app shows "Signing in…" until its own POST /session
 * answers (app/src/auth.tsx syncSession, on every load), then waits for the
 * listener's first snapshot. Past Hosting's cut-off, so a stalled sign-in
 * ends in its 504 (evidence the stack did not answer), never in a shorter
 * wait.
 */
const PAGE_LOAD_MS = 90_000;

/** One session per role, by role, each client patient and throwing on Hosting's cut-off. */
async function sessions(roles) {
  const accounts = await cast(target, roles);
  const opened = await Promise.all(accounts.map((a) => openSession(target, a, { timeoutMs: REQUEST_MS, cutoffError: true })));
  return Object.fromEntries(opened.map((s, i) => [accounts[i].role, s]));
}

const tagFor = () => `${runTag(target.runId)}-${rand4()}`;

/** Every document this owner owns, by id (an owner is fresh per case). */
async function ownedDocIds(email) {
  const snap = await adminFor(target).db.collection("docs").where("ownerEmail", "==", email).get();
  return snap.docs.map((d) => d.id).sort();
}

const millis = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : null);

/** A folder made over HTTP (lib createFolder ledgers it), its id. */
async function createFolderAs(session, name, parentId = null) {
  const r = await createFolder(session.http, { name, parentId, ownerEmail: session.account.email });
  precondition(r.folderId, `POST /folder answered a folderId (${JSON.stringify(r.json)})`);
  return r.folderId;
}

/** Ledger what the browser made, which no seed helper sees: a document through the upload dialog or a drop, a folder with the Folder button. */
function ledgerUi(kind, id, ownerEmail) {
  if (kind === "doc") ledgerDoc(target, { docId: id, via: "upload-ui", ownerEmail });
  else ledgerFolder(target, { folderId: id, via: "folder-ui", ownerEmail });
}

// --- the page -------------------------------------------------------------------

const pathOf = (u) => new URL(u).pathname;

/** Every request the page starts from now on (all frames), with when it started. */
function watchRequests(page) {
  const list = [];
  const on = (req) => list.push({ t: Date.now(), method: req.method(), url: req.url(), type: req.resourceType(), req });
  page.on("request", on);
  return {
    list,
    since: (t0) => list.filter((r) => r.t >= t0),
    stop: () => page.off("request", on),
  };
}

/**
 * Firestore's listen backchannel: the SDK re-opens this GET on its own
 * schedule to receive pushes. It never carries a query — a new listen target
 * is a POST to the same path — so it is the one request a search window may
 * contain without the search having sent it.
 */
function isListenBackchannel(r) {
  const u = new URL(r.url);
  return r.method === "GET" && u.pathname.endsWith("/google.firestore.v1.Firestore/Listen/channel") && u.searchParams.get("RID") === "rpc";
}

/** What a request log entry says, for a message. */
const describe = (r) => `${r.method} ${r.url.replace(/^https?:\/\/[^/]+/, "").slice(0, 140)} (${r.type})`;

/** Cover POSTs this page sent for one document. */
function coverPosts(watch, docId) {
  return watch.list.filter((r) => {
    if (r.method !== "POST" || pathOf(r.url) !== "/thumb") return false;
    const q = new URL(r.url).searchParams;
    return q.get("doc") === docId && q.get("kind") === "cover";
  });
}

/** Until the page has gone `ms` without starting a request (the listen backchannel aside). */
async function quiet(watch, ms, what) {
  await eventually(() => {
    const last = watch.list.filter((r) => !isListenBackchannel(r)).at(-1);
    return !last || Date.now() - last.t >= ms;
  }, { timeout: 60_000, interval: 200, message: `${what} went ${ms} ms without starting a request` });
}

/** The ids of the document cards, in the order they are drawn. */
async function docOrder(page) {
  return page.$$eval(".doc-grid a.doc-card-title", (els) =>
    els.map((e) => e.getAttribute("href") ?? "").filter((h) => h.startsWith("/d/")).map((h) => decodeURIComponent(h.slice(3))),
  );
}

/** The ids of the folder cards, in the order they are drawn. */
async function folderOrder(page) {
  return page.$$eval(".doc-grid a.doc-card-title", (els) =>
    els.map((e) => e.getAttribute("href") ?? "").filter((h) => h.startsWith("/folder/")).map((h) => decodeURIComponent(h.slice(8))),
  );
}

const docCard = (page, id) => page.locator(".doc-card", { has: page.locator(`a.doc-card-title[href="/d/${id}"]`) });
const folderCard = (page, id) => page.locator(".doc-card", { has: page.locator(`a.doc-card-title[href="/folder/${id}"]`) });

/**
 * Until the page draws exactly these document cards (in any order). Generous:
 * a Firestore backend that does not answer within 10 s puts the SDK offline,
 * and the listener first shows an empty snapshot from cache (suspicion
 * X-a14-workspace-2) until it reconnects.
 */
async function waitDocCards(page, ids, { timeout = 90_000, what = "the workspace" } = {}) {
  const want = [...ids].sort();
  return eventually(async () => {
    const got = await docOrder(page);
    if (JSON.stringify([...got].sort()) !== JSON.stringify(want)) throw new Error(`cards ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    return got;
  }, { timeout, interval: 150, message: `${what} draws exactly ${want.length} document card(s)` });
}

/** The card's own Actions menu, open. */
async function openActions(page, card, title) {
  await card.locator('button[aria-label="Actions"]').click();
  const menu = page.getByRole("menu", { name: `Actions for ${title}` });
  await menu.waitFor({ state: "visible", timeout: 10_000 });
  return menu;
}

/** Run `action`, answer the window.prompt/confirm it raises, and say what it asked. */
async function answerDialog(page, action, { accept = true, value } = {}) {
  let resolveSeen;
  const seen = new Promise((r) => (resolveSeen = r));
  page.once("dialog", async (d) => {
    const info = { type: d.type(), message: d.message(), defaultValue: d.defaultValue() };
    if (accept) await d.accept(value);
    else await d.dismiss();
    resolveSeen(info);
  });
  const [info] = await Promise.all([seen, action()]);
  return info;
}

/**
 * The page's first `method path` response since `mark` (u.responseMark(),
 * taken before acting), as a User response entry ({status, json(), …}). One
 * Hosting cut off at its minute throws E2E_STACK_CUTOFF (lib answered()).
 */
async function pageAnswer(u, mark, method, path) {
  const r = answered(await u.waitForResponse({ method, path }, { since: mark, timeout: PAGE_ANSWER_MS }), `${u.name}'s page's ${method} ${path}`);
  return { status: r.status, json: () => r.response.json(), entry: r };
}

/**
 * Drop `files` on the element `selector` names: a real DataTransfer holding
 * File objects, as the browser builds one for a drop from the desktop, through
 * the events useFileDrop listens to. Returns, per event, whether the page
 * claimed it (preventDefault), without which the browser would navigate to
 * the file.
 */
async function dropFiles(page, selector, files, { events = ["dragenter", "dragover", "drop"] } = {}) {
  const payload = files.map((f) => ({ name: f.name, type: f.type ?? "", b64: f.data.toString("base64") }));
  return page.evaluate(({ selector, payload, events }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element ${selector}`);
    const dt = new DataTransfer();
    for (const f of payload) {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.type }));
    }
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + Math.min(r.height / 2, 40) };
    return events.map((type) => ({ type, claimed: !el.dispatchEvent(new DragEvent(type, init)) }));
  }, { selector, payload, events });
}

/** Through the toolbar's Upload button: choose the file, fill what is given, press Upload, read POST /publish's answer. */
async function uploadThroughDialog(u, { f, title = null, id = null, marking = null }) {
  const page = u.page;
  await page.locator(".workspace-toolbar").getByRole("button", { name: "Upload", exact: true }).click();
  const dlg = page.getByRole("dialog", { name: "Upload a document" });
  await dlg.waitFor({ state: "visible", timeout: 10_000 });
  await dlg.locator('input[type="file"]').setInputFiles({ name: f.name, mimeType: f.type || "application/octet-stream", buffer: f.data });
  await dlg.locator(".upload-dropzone strong", { hasText: f.name }).waitFor({ timeout: 10_000 });
  if (title != null) await dlg.locator("#upload-title").fill(title);
  if (id != null) await dlg.locator("#upload-id").fill(id);
  if (marking != null) await dlg.locator("#upload-marking").setChecked(marking);
  const mark = u.responseMark();
  await dlg.getByRole("button", { name: "Upload", exact: true }).click();
  const res = await pageAnswer(u, mark, "POST", "/publish");
  const json = await res.json().catch(() => null);
  return { status: res.status, json, dlg };
}

/** A dialog upload that must succeed: it lands on /d/<docId>, which is ledgered and returned. */
async function uploadOk(u, ownerEmail, opts) {
  const r = await uploadThroughDialog(u, opts);
  assert.equal(r.status, 200, `POST /publish from the dialog: ${r.status} ${JSON.stringify(r.json)}`);
  const docId = r.json.docId;
  ledgerUi("doc", docId, ownerEmail);
  await u.page.waitForURL((url) => url.pathname === `/d/${docId}`, { timeout: 30_000 });
  return { docId, json: r.json };
}

/** Back to the workspace root (or a folder), with its cards drawn. */
async function gotoWorkspace(u, folderId = null) {
  await u.goto(folderId ? `/folder/${folderId}` : "/");
  await u.page.locator(".workspace-toolbar").waitFor({ timeout: PAGE_LOAD_MS });
  await u.page.locator(".skeleton").first().waitFor({ state: "detached", timeout: PAGE_LOAD_MS });
}

/**
 * Press Dismiss on every error toast, as a person would: they stay until
 * dismissed (app/src/components/Toast.tsx) and the stack sits over a
 * dialog's footer.
 */
async function dismissToasts(u) {
  const buttons = u.page.locator(".toast-stack").getByRole("button", { name: "Dismiss" });
  for (let n = await buttons.count(); n > 0; n = await buttons.count()) await buttons.first().click();
}

function noPageErrors(users) {
  for (const u of users) assert.deepEqual(u.log.errors.map((e) => e.message), [], `${u.name}: uncaught page errors`);
}

// --- A14.1 ----------------------------------------------------------------------

scenario("A14.1 the workspace lists Recently updated first (by the current version's publish, which a rename does not move), a sort with nothing to sort on keeps the query's createdAt desc, Name sorts by title, and searching narrows the cards with no network request and reaches into folders", { tiers: BOTH, effects: ["email:POST /access"], timeoutMs: 420_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O, viewer: V } = await sessions(["owner", "viewer"]);
  const tag = tagFor();
  const titles = { A: `Alpha ${tag}`, B: `Bravo ${tag}`, C: `Charlie ${tag}` };

  ctx.step("the owner publishes Charlie, Alpha and Bravo in that order, then a second version of Charlie");
  const ids = {};
  for (const k of ["C", "A", "B"]) {
    const up = await publish(O.http, { body: pageHtml({ title: titles[k], heading: titles[k] }), filename: "index.html", title: titles[k], name: `a14-1-${k}` });
    ids[k] = up.docId;
    await share(target, { owner: O, doc: up.docId, account: V.account, role: "viewer" });
  }
  const v2 = await updateUpload(O.http, ids.C, { body: pageHtml({ title: titles.C, heading: `${titles.C} (second version)` }), baseVersion: "v1", expect: 200 });
  assert.equal(v2.json?.versionId, "v2", `the update minted v2: ${JSON.stringify(v2.json)}`);
  const rec = {};
  for (const k of ["A", "B", "C"]) rec[k] = await readDoc(target, `docs/${ids[k]}`);
  const created = ["C", "A", "B"].map((k) => millis(rec[k].createdAt));
  const updated = Object.fromEntries(["A", "B", "C"].map((k) => [k, millis(rec[k].updatedAt)]));
  precondition(created[0] < created[1] && created[1] < created[2], `createdAt rises C < A < B: ${created}`);
  precondition(updated.C > updated.B && updated.B > updated.A, `updatedAt: C's second version is the newest: ${JSON.stringify(updated)}`);
  ctx.ev.json("records", { ids, created, updated });

  ctx.step("the version trigger counts each current version and summarizes it on its document: the version, its publish and its words (SPEC §4)");
  const latest = {};
  for (const k of ["A", "B", "C"]) {
    latest[k] = await eventually(async () => {
      const l = (await readDoc(target, `docs/${ids[k]}`))?.latest;
      return l && typeof l.words === "number" && l.version === (k === "C" ? "v2" : "v1") ? l : false;
    }, { timeout: PAGE_LOAD_MS, message: `${k}'s summary of its current version` });
  }
  assert.ok(Object.values(latest).every((l) => l.words > 0 && l.channel && l.origin === "upload"), `every summary counts words and says how it arrived: ${JSON.stringify(latest)}`);

  ctx.step("the owner signs in; the sort control reads Recently updated, and the cards are Charlie, Bravo, Alpha (updatedAt desc), distinct from title and creation order");
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(O.account.email, O.account.password);
  await waitDocCards(u.page, Object.values(ids));
  const sort = u.page.locator("#workspace-sort");
  assert.deepEqual(
    { value: await sort.inputValue(), label: (await sort.locator("option:checked").textContent())?.trim() },
    { value: "recent", label: "Recently updated" },
    "the default sort",
  );
  assert.deepEqual(await docOrder(u.page), [ids.C, ids.B, ids.A], "Recently updated: newest publish first");
  const meta = await u.page.$$eval(".doc-card .doc-card-meta", (els) => els.map((e) => e.textContent ?? ""));
  assert.ok(meta.length === 3 && meta.every((t) => /\d+ min read/.test(t) && /Updated /.test(t)), `each card says how long it is and when it was updated: ${JSON.stringify(meta)}`);

  ctx.step("renaming Alpha moves its record's updatedAt past everything, and Recently updated does not move: a rename is not an update");
  const renamed = await O.http.postJson("/organize", { kind: "doc", id: ids.A, op: "rename", name: `${titles.A} renamed` });
  assert.equal(renamed.status, 200, `the rename: ${renamed.status}`);
  const afterRename = await readDoc(target, `docs/${ids.A}`);
  precondition(millis(afterRename.updatedAt) > updated.C, "the rename bumped Alpha's updatedAt past Charlie's publish");
  await u.page.locator(".doc-card", { hasText: `${titles.A} renamed` }).waitFor({ timeout: PAGE_LOAD_MS });
  assert.deepEqual(await docOrder(u.page), [ids.C, ids.B, ids.A], "a rename is not an update: Recently updated still reads Charlie, Bravo, Alpha");

  ctx.step("Name sorts by title; Most read and Recently read, with no reads to sort on, keep the query's createdAt desc (SPEC §5)");
  await sort.selectOption("name");
  assert.deepEqual(await docOrder(u.page), [ids.A, ids.B, ids.C], "Name: by title");
  await sort.selectOption("views");
  assert.deepEqual(await docOrder(u.page), [ids.B, ids.A, ids.C], "Most read with no views: the listener's createdAt desc");
  await sort.selectOption("lastViewed");
  assert.deepEqual(await docOrder(u.page), [ids.B, ids.A, ids.C], "Recently read with no reads: the listener's createdAt desc");
  await sort.selectOption("recent");
  assert.deepEqual(await docOrder(u.page), [ids.C, ids.B, ids.A], "back to Recently updated");

  ctx.step("real counted reads distinguish Most read from Recently read and from creation order");
  for (const k of ["B", "B", "B", "C", "C", "A"]) {
    const r = await V.http.postJson("/view", { docId: ids[k], versionId: rec[k].currentVersion, sessionId: `a14-${rand4()}-${rand4()}-${Date.now()}`, ms: 0 });
    assert.equal(r.status, 200, `a counted read for ${k}`);
  }
  const readOrder = async (value, expected, message) => {
    await sort.selectOption(value);
    await eventually(async () => JSON.stringify(await docOrder(u.page)) === JSON.stringify(expected), { timeout: PAGE_LOAD_MS, message });
    assert.deepEqual(await docOrder(u.page), expected, message);
  };
  await readOrder("views", [ids.B, ids.C, ids.A], "Most read uses nonzero view totals");
  await readOrder("lastViewed", [ids.A, ids.C, ids.B], "Recently read uses distinct last-read times");
  await readOrder("recent", [ids.C, ids.B, ids.A], "reading does not change Recently updated");

  ctx.step("let the workspace settle: its cover backfill fills in all three covers, and then the page starts nothing for 2.5 s");
  const watch = watchRequests(u.page);
  await eventually(async () => {
    for (const k of ["A", "B", "C"]) {
      const t = (await readDoc(target, `docs/${ids[k]}`))?.thumb;
      if (!t?.cover || t.versionId !== rec[k].currentVersion) throw new Error(`${k} has no cover for ${rec[k].currentVersion} yet`);
    }
    const loaded = await u.page.$$eval(".doc-card-thumb img", (imgs) => imgs.filter((i) => i.complete && i.naturalWidth > 0).length);
    if (loaded !== 3) throw new Error(`${loaded} covers drawn`);
    return true;
  }, { timeout: 240_000, interval: 300, message: "three covers stored and drawn" });
  await quiet(watch, 2_500, "the settled workspace");

  const query = `bravo ${tag}`;
  ctx.step(`type "${query}" into Search one key at a time, then "zz" so nothing matches, and wait 2 s for anything deferred`);
  const t0 = Date.now();
  await u.page.locator("#workspace-search").pressSequentially(query, { delay: 40 });
  await eventually(async () => JSON.stringify(await docOrder(u.page)) === JSON.stringify([ids.B]), { timeout: 5_000, message: "only Bravo's card" });
  await u.page.locator("#workspace-search").pressSequentially("zz", { delay: 40 });
  await u.page.locator(".empty-state", { hasText: `Nothing matches “${query}zz”.` }).waitFor({ timeout: 5_000 });
  await sleep(DEBOUNCE_WINDOW_MS); // a debounced search would have fired by now
  const during = watch.since(t0);
  ctx.ev.json("search-window-requests", during.map(({ req, ...r }) => r));
  const sent = during.filter((r) => !isListenBackchannel(r));
  assert.deepEqual(sent.map(describe), [], `searching sent ${sent.length} network request(s)`);

  ctx.step("clearing the search brings every card back in the default order");
  await u.page.locator("#workspace-search").fill("");
  await eventually(async () => JSON.stringify(await docOrder(u.page)) === JSON.stringify([ids.C, ids.B, ids.A]), { timeout: 5_000, message: "all three cards, Recently updated" });
  watch.stop();

  ctx.step("a document filed in a folder is not a root card, but searching reaches it");
  const folderName = `Shelf ${tag}`;
  const folderId = await createFolderAs(O, folderName);
  const deltaTitle = `Delta ${tag}`;
  const delta = await publish(O.http, { body: pageHtml({ title: deltaTitle, heading: deltaTitle }), filename: "index.html", title: deltaTitle, folderId, name: "a14-1-d" });
  await u.page.locator(`a.doc-card-title[href="/folder/${folderId}"]`).waitFor({ timeout: 90_000 });
  assert.deepEqual([...(await docOrder(u.page))].sort(), [ids.A, ids.B, ids.C].sort(), "the root shows only the root's documents");
  await u.page.locator("#workspace-search").fill(`delta ${tag}`);
  await eventually(async () => JSON.stringify(await docOrder(u.page)) === JSON.stringify([delta.docId]), { timeout: 90_000, message: "searching from the root finds the filed document" });
  assert.deepEqual(await folderOrder(u.page), [], "the folder's name does not match, so its card is not shown");
  noPageErrors([u]);
});

// --- A14.2 ----------------------------------------------------------------------

/** The breadcrumb as text, and which crumb is the current page. */
async function breadcrumb(page) {
  return page.locator('nav.breadcrumb[aria-label="Folder path"]').evaluate((nav) => ({
    crumbs: Array.from(nav.querySelectorAll("a, span[aria-current]")).map((e) => e.textContent.trim()),
    current: nav.querySelector("[aria-current=page]")?.textContent.trim() ?? null,
    links: Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href")),
  }));
}

/** The rail's current row, and every folder name it shows. */
async function rail(page) {
  return page.locator('nav.folder-rail[aria-label="Folders"]').evaluate((nav) => ({
    current: nav.querySelector(".folder-link[aria-current=page] .folder-name")?.textContent.trim() ?? null,
    names: Array.from(nav.querySelectorAll(".folder-link .folder-name")).map((e) => e.textContent.trim()),
  }));
}

/** Press the toolbar's Folder button, name the folder in the prompt, read POST /folder's answer. */
async function newFolderUi(u, name) {
  const mark = u.responseMark();
  const asked = await answerDialog(u.page, () => u.page.locator(".workspace-toolbar").getByRole("button", { name: "Folder", exact: true }).click(), { value: name });
  const res = await pageAnswer(u, mark, "POST", "/folder");
  const json = await res.json().catch(() => null);
  assert.deepEqual({ type: asked.type, message: asked.message, status: res.status }, { type: "prompt", message: "Folder name", status: 200 }, `POST /folder: ${JSON.stringify(json)}`);
  precondition(json?.folderId, "POST /folder answered a folderId");
  ledgerUi("folder", json.folderId, u.email);
  return json.folderId;
}

scenario("A14.2 a folder made with the Folder button, and one made inside it, deep-link: the URL survives a reload and a fresh navigation with its breadcrumb, rail and contents", { tiers: BOTH, timeoutMs: 300_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O } = await sessions(["owner"]);
  const tag = tagFor();
  const outer = `Outer ${tag}`;
  const inner = `Inner ${tag}`;
  const rootDoc = await publish(O.http, { body: pageHtml({ title: `Root doc ${tag}`, heading: "Root" }), filename: "index.html", title: `Root doc ${tag}`, name: "a14-2-root" });

  ctx.step("the owner signs in and makes a folder with the toolbar's Folder button");
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(O.account.email, O.account.password);
  await waitDocCards(u.page, [rootDoc.docId]);
  const outerId = await newFolderUi(u, outer);
  await u.page.locator(`a.doc-card-title[href="/folder/${outerId}"]`).waitFor({ timeout: 90_000 });
  const outerRec = await readDoc(target, `folders/${outerId}`);
  assert.deepEqual(
    { name: outerRec?.name, parentId: outerRec?.parentId, ancestors: outerRec?.ancestors, depth: outerRec?.depth, ownerEmail: outerRec?.ownerEmail, members: outerRec?.members },
    { name: outer, parentId: null, ancestors: [], depth: 0, ownerEmail: O.account.email, members: [O.account.email] },
    "folders/{id} for a root folder",
  );

  ctx.step("opening its card goes to /folder/<id>; a folder made there is made inside it");
  await u.page.locator(`a.doc-card-title[href="/folder/${outerId}"]`).click();
  await u.page.waitForURL((url) => url.pathname === `/folder/${outerId}`);
  const innerId = await newFolderUi(u, inner);
  const innerRec = await readDoc(target, `folders/${innerId}`);
  assert.deepEqual(
    { parentId: innerRec?.parentId, ancestors: innerRec?.ancestors, depth: innerRec?.depth },
    { parentId: outerId, ancestors: [outerId], depth: 1 },
    "folders/{id} for a folder made inside another",
  );
  const filed = await publish(O.http, { body: pageHtml({ title: `Filed doc ${tag}`, heading: "Filed" }), filename: "index.html", title: `Filed doc ${tag}`, folderId: outerId, name: "a14-2-filed" });
  await waitDocCards(u.page, [filed.docId], { what: "the outer folder" });
  assert.deepEqual(await folderOrder(u.page), [innerId], "the outer folder shows the inner folder");

  ctx.step("into the inner folder, then reload: the same URL, the trail Everything / outer / inner, the rail open to it");
  await u.page.locator(`a.doc-card-title[href="/folder/${innerId}"]`).click();
  await u.page.waitForURL((url) => url.pathname === `/folder/${innerId}`);
  await u.page.reload({ waitUntil: "load" });
  assert.equal(new URL(u.page.url()).pathname, `/folder/${innerId}`, "the reload kept the folder's URL");
  const afterReload = await eventually(async () => {
    const b = await breadcrumb(u.page);
    if (b.current !== inner) throw new Error(`breadcrumb ${JSON.stringify(b)}`);
    return b;
  }, { timeout: 90_000, message: "the breadcrumb names the inner folder after the reload" });
  assert.deepEqual(afterReload, { crumbs: ["Everything", outer, inner], current: inner, links: ["/", `/folder/${outerId}`] }, "the breadcrumb after the reload");
  const railAfter = await rail(u.page);
  assert.equal(railAfter.current, inner, "the rail marks the inner folder current");
  assert.ok(railAfter.names.includes(outer) && railAfter.names.includes(inner), `the rail is open down to the inner folder: ${JSON.stringify(railAfter.names)}`);
  assert.equal(await u.page.locator(".empty-state h2", { hasText: "Nothing here yet" }).count(), 1, "the inner folder is empty, and says so");

  ctx.step("a fresh navigation straight to the outer folder's URL shows its folder and document, and not the root's");
  await u.goto(`/folder/${outerId}`);
  await waitDocCards(u.page, [filed.docId], { what: "the outer folder, deep-linked" });
  assert.deepEqual(await folderOrder(u.page), [innerId]);
  assert.deepEqual(await breadcrumb(u.page), { crumbs: ["Everything", outer], current: outer, links: ["/"] });

  ctx.step("and the root shows the root's document and the outer folder, not what is filed");
  await u.goto("/");
  await waitDocCards(u.page, [rootDoc.docId], { what: "the root" });
  assert.deepEqual(await folderOrder(u.page), [outerId]);
  noPageErrors([u]);
});

// --- A14.3 ----------------------------------------------------------------------

scenario("A14.3 upload dialog: only the listed types, an invalid id is a 400 that stores nothing, a taken id becomes {id}-[a-z0-9]{6}, the title comes from <title>, then og:title, then the file name (Markdown: its first H1; a typed title wins), and the marking checkbox is applied", { tiers: BOTH, timeoutMs: 540_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  // Two accounts: O publishes the probes over HTTP; U uses the dialog. U's
  // workspace then holds only the dialog's documents, so its cover backfill
  // (one capture per card) is not thirty captures competing with the uploads.
  const { owner: O, uploader: U } = await sessions(["owner", "uploader"]);
  const email = O.account.email;
  const tag = tagFor();
  const html = pageHtml({ title: `Titled ${tag}`, heading: "Titled" });

  ctx.step("POST /publish takes .html, .htm, .md, .markdown and .zip");
  const accepted = [
    ["index.html", html, "html"],
    ["page.htm", html, "html"],
    ["notes.md", `# Notes ${tag}\n\nText.\n`, "markdown"],
    ["notes.markdown", `# Notes again ${tag}\n\nText.\n`, "markdown"],
  ];
  // Independent of one another, so sent together: a loaded stack stretches each POST /publish.
  const zip = await zipBundle({ "index.html": html, "notes.txt": "beside the entry" }, target);
  const [acceptedRes, z] = await Promise.all([
    Promise.all(accepted.map(([filename, body]) => publish(O.http, { body, filename, name: `a14-3-${filename}` }))),
    publish(O.http, { body: zip, filename: "bundle.zip", name: "a14-3-zip" }),
  ]);
  accepted.forEach(([filename, , format], i) => assert.deepEqual({ status: acceptedRes[i].status, format: acceptedRes[i].json?.format }, { status: 200, format }, filename));
  assert.deepEqual({ status: z.status, format: z.json?.format, fileCount: z.json?.fileCount }, { status: 200, format: "html", fileCount: 2 }, "bundle.zip");

  ctx.step("…and refuses any other single file with a 400 that names the types, storing nothing");
  const before = await ownedDocIds(email);
  const refusedNames = ["notes.txt", "slides.pdf", "image.png", "README"];
  const refusedRes = await Promise.all(refusedNames.map((filename) => publish(O.http, { body: "not a document", filename, name: "a14-3-refused", expect: 400 })));
  refusedNames.forEach((filename, i) => assert.deepEqual({ status: refusedRes[i].status, error: refusedRes[i].json?.error }, { status: 400, error: TYPE_ERROR }, filename));
  assert.deepEqual(await ownedDocIds(email), before, "a refused type created no document");

  ctx.step("an id outside lowercase letters, digits and single inner hyphens, or over 60 characters, is a 400 that stores nothing");
  const r4 = rand4();
  const bad = [`Upper-case-${r4}`, `under_score-${r4}`, `-leading-${r4}`, `trailing-${r4}-`, `double--hyphen-${r4}`, `dot.ted-${r4}`, `space d-${r4}`, "a".repeat(61)];
  const base = docIdFor(target, "sixty");
  const sixty = `${base}-${"x".repeat(60 - base.length - 1)}`;
  const [badRes, s60] = await Promise.all([
    Promise.all(bad.map((id) => publish(O.http, { body: html, filename: "index.html", id, expect: 400 }))),
    publish(O.http, { body: html, filename: "index.html", id: sixty }),
  ]);
  for (const [i, id] of bad.entries()) {
    assert.deepEqual({ status: badRes[i].status, error: badRes[i].json?.error }, { status: 400, error: BAD_DOC_ID }, `id ${JSON.stringify(id)}`);
    assert.equal(await readDoc(target, `docs/${id}`), null, `nothing at docs/${id}`);
    assert.deepEqual(await listObjects(target, `docs/${id}/`), [], `no bytes under docs/${id}/`);
  }
  assert.deepEqual({ length: sixty.length, docId: s60.docId }, { length: 60, docId: sixty }, "a 60-character id is taken as asked");

  ctx.step("a taken id is not refused: the second and third publish land at the id plus six random characters, and the first keeps its bytes");
  const wanted = docIdFor(target, "taken");
  const bodies = [1, 2, 3].map((n) => pageHtml({ title: `Taken ${n} ${tag}`, heading: `Taken ${n}` }));
  const first = await publish(O.http, { body: bodies[0], filename: "index.html", id: wanted });
  const second = await publish(O.http, { body: bodies[1], filename: "index.html", id: wanted });
  const third = await publish(O.http, { body: bodies[2], filename: "index.html", id: wanted });
  const suffixed = new RegExp(`^${wanted}-[a-z0-9]{6}$`);
  assert.equal(first.docId, wanted);
  assert.match(second.docId, suffixed, "the second publish");
  assert.match(third.docId, suffixed, "the third publish");
  assert.notEqual(second.docId, third.docId, "each taken publish gets its own suffix");
  assert.equal((await readObject(target, `docs/${wanted}/v1/index.html`))?.toString("utf8"), bodies[0], "the first document's bytes are untouched");
  assert.equal((await readObject(target, `docs/${second.docId}/v1/index.html`))?.toString("utf8"), bodies[1], "the second's bytes are under its own id");

  ctx.step("with no title: <title>, then og:title, then the file name; Markdown's first H1 (ATX or setext), then the file name; a title given wins");
  const titled = [
    ["title only", file("t1.html", pageHtml({ title: `From title ${tag}`, heading: "x" })), `From title ${tag}`],
    ["og:title only", file("t2.html", pageHtml({ og: `From og ${tag}`, heading: "x" })), `From og ${tag}`],
    ["both", file("t3.html", pageHtml({ title: `Title wins ${tag}`, og: `Og loses ${tag}`, heading: "x" })), `Title wins ${tag}`],
    ["neither", file(`stem-${tag}.html`, pageHtml({ heading: "No title here" })), `stem-${tag}`],
    ["markdown ATX", file("m1.md", `Intro line\n\n# Heading one ${tag}\n\n# Heading two\n`), `Heading one ${tag}`],
    ["markdown setext", file("m2.md", `Setext heading ${tag}\n=====\n\nText.\n`), `Setext heading ${tag}`],
    ["markdown without H1", file(`mdstem-${tag}.md`, "## Only a level two\n\nText.\n"), `mdstem-${tag}`],
  ];
  const titledRes = await Promise.all(titled.map(([, f]) => publish(O.http, { body: f.data, filename: f.name, id: false })));
  for (const [i, [label, , want]] of titled.entries()) {
    const r = titledRes[i];
    assert.equal(r.json?.title, want, `${label}: the answer's title`);
    const d = await readDoc(target, `docs/${r.docId}`);
    assert.deepEqual({ title: d?.title, slug: d?.slug }, { title: want, slug: slugify(want) }, `${label}: the record`);
  }
  const given = await publish(O.http, { body: html, filename: "index.html", title: `Given ${tag}`, id: false });
  assert.equal(given.json?.title, `Given ${tag}`, "a given title wins over <title>");

  ctx.step("the dialog: its file input accepts exactly the listed types, and choosing a .txt is refused with the hint and leaves Upload disabled");
  const uEmail = U.account.email;
  const u = await ctx.users.user({ name: "uploader" });
  await u.signInUi(uEmail, U.account.password);
  await u.page.locator(".workspace-toolbar").waitFor({ timeout: PAGE_LOAD_MS });
  const watch = watchRequests(u.page);
  await u.page.locator(".workspace-toolbar").getByRole("button", { name: "Upload", exact: true }).click();
  const dlg = u.page.getByRole("dialog", { name: "Upload a document" });
  await dlg.waitFor();
  assert.equal(await dlg.locator('input[type="file"]').getAttribute("accept"), ACCEPT, "the file input's accept list");
  const uploadBtn = dlg.getByRole("button", { name: "Upload", exact: true });
  assert.equal(await uploadBtn.isDisabled(), true, "Upload is disabled with no file");
  const mark = u.toastMark();
  await dlg.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("plain text") });
  const refusal = await u.waitForToast(() => true, { since: mark, timeout: 10_000 });
  assert.deepEqual({ kind: refusal.kind, text: refusal.text }, { kind: "error", text: `${UPLOAD_HINT}. That file is not one of those.` }, "the refusal toast");
  assert.equal(await uploadBtn.isDisabled(), true, "Upload stays disabled");
  assert.deepEqual(watch.list.filter((r) => pathOf(r.url) === "/publish").map(describe), [], "a refused file is never sent");
  await dismissToasts(u);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await dlg.waitFor({ state: "detached" });

  ctx.step("an invalid Address is the server's 400, shown as a toast; the dialog stays open and nothing is stored");
  const titledFile = file("titled.html", html);
  const docsBefore = await ownedDocIds(uEmail);
  const badId = `Not_Valid-${rand4()}`;
  const mark2 = u.toastMark();
  const refused = await uploadThroughDialog(u, { f: titledFile, id: badId });
  assert.deepEqual({ status: refused.status, error: refused.json?.error }, { status: 400, error: BAD_DOC_ID }, "POST /publish with an invalid id");
  const shown = await u.waitForToast((t) => t.kind === "error", { since: mark2, timeout: 10_000 });
  assert.equal(shown.text, BAD_DOC_ID_TOAST, "the toast says why, the server's refusal as a sentence");
  assert.equal(await refused.dlg.isVisible(), true, "the dialog stays open");
  assert.deepEqual(await ownedDocIds(uEmail), docsBefore, "nothing was stored");
  await dismissToasts(u);

  ctx.step("a free Address, Title empty, marking unchecked: the document is at that id, titled by its <title>, unmarked");
  const freeId = docIdFor(target, "dialog");
  await refused.dlg.locator("#upload-id").fill(freeId);
  const mark3 = u.responseMark();
  await refused.dlg.getByRole("button", { name: "Upload", exact: true }).click();
  const okRes = await pageAnswer(u, mark3, "POST", "/publish");
  assert.equal(okRes.status, 200);
  assert.equal((await okRes.json()).docId, freeId);
  ledgerUi("doc", freeId, uEmail);
  await u.page.waitForURL((url) => url.pathname === `/d/${freeId}`);
  const d1 = await readDoc(target, `docs/${freeId}`);
  assert.deepEqual({ title: d1?.title, enabled: d1?.marking?.enabled, folderId: d1?.folderId, trusted: d1?.trusted }, { title: `Titled ${tag}`, enabled: false, folderId: null, trusted: false });

  ctx.step("the same Address again, with the marking box checked: a suffixed id, and a marked document");
  await gotoWorkspace(u);
  const again = await uploadOk(u, uEmail, { f: titledFile, id: freeId, marking: true });
  assert.match(again.docId, new RegExp(`^${freeId}-[a-z0-9]{6}$`), "a taken id from the dialog");
  const d2 = await readDoc(target, `docs/${again.docId}`);
  assert.deepEqual({ title: d2?.title, marking: d2?.marking }, { title: `Titled ${tag}`, marking: { enabled: true, label: "", footer: "" } }, "the checkbox's marking");

  ctx.step("from inside a folder, a Markdown file with no Title or Address: titled and addressed by its first H1, filed in that folder");
  const folderId = await createFolderAs(U, `Uploads ${tag}`);
  await gotoWorkspace(u, folderId);
  const mdTitle = `Dialog heading ${tag}`;
  const md = await uploadOk(u, uEmail, { f: file("dialog.md", `# ${mdTitle}\n\nBody.\n`) });
  const d3 = await readDoc(target, `docs/${md.docId}`);
  assert.deepEqual({ docId: md.docId, title: d3?.title, folderId: d3?.folderId }, { docId: slugify(mdTitle), title: mdTitle, folderId });

  ctx.step("a file with neither <title> nor og:title is titled by its name; a typed Title wins over <title>");
  await gotoWorkspace(u);
  const stem = await uploadOk(u, uEmail, { f: file(`dialog-stem-${tag}.html`, pageHtml({ heading: "untitled" })) });
  assert.equal((await readDoc(target, `docs/${stem.docId}`))?.title, `dialog-stem-${tag}`);
  await gotoWorkspace(u);
  const typed = await uploadOk(u, uEmail, { f: titledFile, title: `Typed ${tag}` });
  assert.deepEqual({ docId: typed.docId, title: (await readDoc(target, `docs/${typed.docId}`))?.title }, { docId: slugify(`Typed ${tag}`), title: `Typed ${tag}` });
  watch.stop();
  noPageErrors([u]);
});

scenario("A14.3b unchecking an account-default export stamp publishes an explicitly unmarked document", { tiers: BOTH, timeoutMs: 240_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const [account] = await cast(target, ["owner"]);
  const marking = { enabled: true, label: "Account label", footer: "Account footer" };
  await writeUser(target, account.uid, { uid: account.uid, email: account.email, defaultMarking: marking });
  await openSession(target, account, { timeoutMs: REQUEST_MS, cutoffError: true });
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(account.email, account.password);
  await u.page.getByRole("button", { name: "Upload", exact: true }).click();
  const dlg = u.page.getByRole("dialog", { name: "Upload a document" });
  await dlg.locator("#upload-marking").waitFor();
  await eventually(() => dlg.locator("#upload-marking").isChecked(), { timeout: PAGE_LOAD_MS, message: "the account default arrives in the open dialog" });
  await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
  const made = await uploadOk(u, account.email, { f: file("unstamped.html", pageHtml({ title: `Unstamped ${tagFor()}`, heading: "Explicit off" })), marking: false });
  assert.equal((await readDoc(target, `docs/${made.docId}`))?.marking?.enabled, false, "an explicit unchecked stamp overrides the account default");
});

// --- A14.4 and A14.4b -------------------------------------------------------------

/** Turn on the account's default marking from the Account page, and wait for the record. */
async function defaultMarkingOn(u, uid) {
  await u.goto("/account");
  const box = u.page.locator("#default-marking");
  await box.waitFor({ timeout: PAGE_LOAD_MS });
  if (!(await box.isChecked())) await box.check();
  return eventually(async () => {
    const m = (await readDoc(target, `users/${uid}`))?.defaultMarking;
    if (m?.enabled !== true) throw new Error(`defaultMarking ${JSON.stringify(m)}`);
    return m;
  }, { timeout: 60_000, message: "users/{uid}.defaultMarking is on" });
}

/** Documents this owner gained since `before`, with their v1 records. */
async function newDocs(email, before) {
  const ids = (await ownedDocIds(email)).filter((id) => !before.includes(id));
  const out = [];
  for (const id of ids) out.push({ id, doc: await readDoc(target, `docs/${id}`), v1: await readDoc(target, `docs/${id}/versions/v1`) });
  return out;
}

scenario("A14.4 drag and drop behaves as the dialog: the same types, one upload per accepted file, the folder it was dropped on or in, the account's default marking; the dialog's own drop zone refuses the same files", { tiers: BOTH, timeoutMs: 420_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O } = await sessions(["owner"]);
  const email = O.account.email;
  const tag = tagFor();
  const folderName = `Drop box ${tag}`;
  const folderId = await createFolderAs(O, folderName);
  const seed = await publish(O.http, { body: pageHtml({ title: `Seed ${tag}`, heading: "Seed" }), filename: "index.html", title: `Seed ${tag}`, name: "a14-4-seed" });

  ctx.step("the owner signs in and turns on Stamp new documents by default on the Account page");
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(email, O.account.password);
  const marking = await defaultMarkingOn(u, O.account.uid);
  await gotoWorkspace(u);
  await waitDocCards(u.page, [seed.docId]);
  await u.page.locator(`a.doc-card-title[href="/folder/${folderId}"]`).waitFor({ timeout: PAGE_LOAD_MS });
  const watch = watchRequests(u.page);

  ctx.step("a file dragged over the workspace lights it up as a drop target named for where it lands; leaving puts it out");
  const over = await dropFiles(u.page, ".workspace-main", [file("x.html", "<p>x</p>")], { events: ["dragenter", "dragover"] });
  assert.deepEqual(over, [{ type: "dragenter", claimed: true }, { type: "dragover", claimed: true }], "the workspace claims a file drag");
  await u.page.locator(".drop-hint", { hasText: "Drop to upload into Everything" }).waitFor({ timeout: 5_000 });
  await dropFiles(u.page, ".workspace-main", [file("x.html", "<p>x</p>")], { events: ["dragleave"] });
  await u.page.locator(".drop-hint").waitFor({ state: "detached", timeout: 5_000 });

  ctx.step("dropping a .txt alone is refused with the hint, and nothing is sent");
  const before = await ownedDocIds(email);
  let mark = u.toastMark();
  const dropped = await dropFiles(u.page, ".workspace-main", [file("notes.txt", "plain", "text/plain")]);
  assert.equal(dropped.at(-1).claimed, true, "the page claims the drop, so the browser does not navigate to the file");
  const t1 = await u.waitForToast(() => true, { since: mark, timeout: 10_000 });
  assert.deepEqual({ kind: t1.kind, text: t1.text }, { kind: "error", text: `${UPLOAD_HINT}. That is not one of those.` });
  await sleep(ABSENCE_SETTLE_MS);
  assert.deepEqual(watch.list.filter((r) => pathOf(r.url) === "/publish").map(describe), [], "a refused drop sends nothing");
  await dismissToasts(u);

  ctx.step("dropping an .html, an .md and a .txt together: the .txt is named as refused, the other two upload one after the other");
  mark = u.toastMark();
  const t0 = Date.now();
  await dropFiles(u.page, ".workspace-main", [
    file(`drop-a-${tag}.html`, pageHtml({ title: `Dropped page ${tag}`, heading: "A" }), "text/html"),
    file(`drop-b-${tag}.md`, `# Dropped notes ${tag}\n\nText.\n`, "text/markdown"),
    file("drop-c.txt", "plain", "text/plain"),
  ]);
  const refusedSome = await u.waitForToast((t) => t.kind === "error", { since: mark, timeout: 10_000 });
  assert.equal(refusedSome.text, `${UPLOAD_HINT}. 1 of those are not.`);
  await dismissToasts(u);
  await eventually(() => u.log.toasts.slice(mark).filter((t) => t.kind === "info" && t.text.startsWith("Uploaded ")).length === 2, { timeout: 180_000, message: "two Uploaded toasts" });
  const posts = watch.since(t0).filter((r) => r.method === "POST" && pathOf(r.url) === "/publish");
  assert.equal(posts.length, 2, `one POST /publish per accepted file: ${posts.map(describe).join("; ")}`);
  const filenames = posts.map((r) => new URL(r.url).searchParams.get("filename"));
  assert.deepEqual(filenames, [`drop-a-${tag}.html`, `drop-b-${tag}.md`], "in the order dropped, the .txt never sent");
  const atRoot = await newDocs(email, before);
  for (const d of atRoot) ledgerUi("doc", d.id, email);
  assert.deepEqual(
    atRoot.map((d) => ({ format: d.v1?.format, folderId: d.doc?.folderId, marking: d.doc?.marking, publishedVia: d.v1?.publishedVia, trusted: d.doc?.trusted })).sort((a, b) => a.format.localeCompare(b.format)),
    [
      { format: "html", folderId: null, marking, publishedVia: "upload", trusted: false },
      { format: "markdown", folderId: null, marking, publishedVia: "upload", trusted: false },
    ],
    "two documents at the root, each with the account's default marking",
  );

  ctx.step("dropping on a folder's card files the document in that folder");
  const before2 = await ownedDocIds(email);
  mark = u.toastMark();
  await dropFiles(u.page, `.doc-card:has(a[href="/folder/${folderId}"])`, [file(`on-card-${tag}.html`, pageHtml({ title: `On card ${tag}`, heading: "C" }), "text/html")]);
  await u.waitForToast((t) => t.kind === "info" && t.text.startsWith("Uploaded "), { since: mark, timeout: 180_000 });
  const onCard = await newDocs(email, before2);
  for (const d of onCard) ledgerUi("doc", d.id, email);
  assert.deepEqual(onCard.map((d) => ({ folderId: d.doc?.folderId, members: d.doc?.members })), [{ folderId, members: [email] }], "filed in the folder dropped on");

  ctx.step("inside the folder, a .zip dropped on the workspace lands in that folder, and the hint names it");
  await gotoWorkspace(u, folderId);
  await waitDocCards(u.page, onCard.map((d) => d.id), { what: "the folder" });
  await dropFiles(u.page, ".workspace-main", [file("z.zip", Buffer.alloc(0))], { events: ["dragenter", "dragover"] });
  await u.page.locator(".drop-hint", { hasText: `Drop to upload into ${folderName}` }).waitFor({ timeout: 5_000 });
  await dropFiles(u.page, ".workspace-main", [file("z.zip", Buffer.alloc(0))], { events: ["dragleave"] });
  const before3 = await ownedDocIds(email);
  mark = u.toastMark();
  const zipped = await zipBundle({ "index.html": pageHtml({ title: `Zipped ${tag}`, heading: "Z" }) }, target);
  await dropFiles(u.page, ".workspace-main", [file(`bundle-${tag}.zip`, zipped, "application/zip")]);
  await u.waitForToast((t) => t.kind === "info" && t.text.startsWith("Uploaded "), { since: mark, timeout: 180_000 });
  const inFolder = await newDocs(email, before3);
  for (const d of inFolder) ledgerUi("doc", d.id, email);
  assert.deepEqual(inFolder.map((d) => ({ folderId: d.doc?.folderId, format: d.v1?.format, marking: d.doc?.marking })), [{ folderId, format: "html", marking }]);

  ctx.step("the dialog's drop zone: a .txt is refused with the hint; an .html is taken and named; the marking box starts checked from the account default");
  await u.page.locator(".workspace-toolbar").getByRole("button", { name: "Upload", exact: true }).click();
  const dlg = u.page.getByRole("dialog", { name: "Upload a document" });
  await dlg.waitFor();
  assert.equal(await dlg.locator("#upload-marking").isChecked(), true, "seeded from the account default");
  mark = u.toastMark();
  await dropFiles(u.page, ".upload-dropzone", [file("zone.txt", "plain", "text/plain")]);
  const t3 = await u.waitForToast(() => true, { since: mark, timeout: 10_000 });
  assert.deepEqual({ kind: t3.kind, text: t3.text }, { kind: "error", text: `${UPLOAD_HINT}. That file is not one of those.` });
  assert.equal(await dlg.getByRole("button", { name: "Upload", exact: true }).isDisabled(), true);
  await dismissToasts(u);
  await dropFiles(u.page, ".upload-dropzone", [file("zone.html", pageHtml({ title: "Zone", heading: "Zone" }), "text/html")]);
  await dlg.locator(".upload-dropzone strong", { hasText: "zone.html" }).waitFor({ timeout: 5_000 });
  assert.equal(await dlg.getByRole("button", { name: "Upload", exact: true }).isDisabled(), false, "a dropped .html can be uploaded");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  watch.stop();
  noPageErrors([u]);
});

// Browser drops use the same documented title and permanent-address defaults as
// an untitled upload dialog (SPEC §2, §4; the 0.2.0 browser upload contract).
scenario("A14.4b a dropped file is titled, and so addressed, as the dialog titles it: an HTML file by its <title>, a Markdown file by its first H1, never by the file name", { tiers: BOTH, timeoutMs: 300_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O } = await sessions(["owner"]);
  const email = O.account.email;
  const tag = tagFor();
  const htmlTitle = `Quarterly review ${tag}`;
  const mdTitle = `Release notes ${tag}`;

  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(email, O.account.password);
  await u.page.locator(".empty-state h2", { hasText: "Nothing here yet" }).waitFor({ timeout: PAGE_LOAD_MS });

  ctx.step(`drop q3-${tag}.html (<title>${htmlTitle}</title>) and notes-${tag}.md (# ${mdTitle}) on the workspace`);
  const before = await ownedDocIds(email);
  const mark = u.toastMark();
  await dropFiles(u.page, ".workspace-main", [
    file(`q3-${tag}.html`, pageHtml({ title: htmlTitle, heading: "Q3" }), "text/html"),
    file(`notes-${tag}.md`, `# ${mdTitle}\n\nText.\n`, "text/markdown"),
  ]);
  await eventually(() => u.log.toasts.slice(mark).filter((t) => t.kind === "info" && t.text.startsWith("Uploaded ")).length === 2, { timeout: 180_000, message: "two Uploaded toasts" });
  const made = await newDocs(email, before);
  for (const d of made) ledgerUi("doc", d.id, email);
  precondition(made.length === 2, `two documents were made (${made.length})`);
  const got = made.map((d) => ({ format: d.v1?.format, title: d.doc?.title, docId: d.id })).sort((a, b) => a.format.localeCompare(b.format));
  ctx.ev.json("dropped", got);

  ctx.step("each is titled by its own title and addressed by that title's slug, as the dialog, the CLI and MCP do");
  assert.deepEqual(got, [
    { format: "html", title: htmlTitle, docId: slugify(htmlTitle) },
    { format: "markdown", title: mdTitle, docId: slugify(mdTitle) },
  ], "a dropped document uses its embedded title and that title's permanent address");
});

// --- A14.5 and A14.5b -------------------------------------------------------------

scenario("A14.5 actions menus: Rename keeps the docId, the document's delete entry is disabled with its reason and /organize answers 400 (404 to a stranger), and deleting a folder lifts its children one level", { tiers: BOTH, timeoutMs: 480_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O, editor: E, stranger: S } = await sessions(["owner", "editor", "stranger"]);
  const email = O.account.email;
  const tag = tagFor();
  const title = `Menu doc ${tag}`;
  const doc = await publish(O.http, { body: pageHtml({ title, heading: "Menu" }), filename: "index.html", title, name: "a14-5-doc" });
  const docId = doc.docId;
  await share(target, { owner: O, doc: docId, account: E.account, role: "editor" });
  const recBefore = await readDoc(target, `docs/${docId}`);

  ctx.step("the owner signs in; Rename… prompts with the current title; the new title shows on the same card");
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(email, O.account.password);
  await waitDocCards(u.page, [docId]);
  const renamed = `Renamed doc ${tag}`;
  let menu = await openActions(u.page, docCard(u.page, docId), title);
  const mark = u.responseMark();
  const asked = await answerDialog(u.page, () => menu.getByRole("menuitem", { name: "Rename…" }).click(), { value: renamed });
  assert.deepEqual({ type: asked.type, message: asked.message, defaultValue: asked.defaultValue }, { type: "prompt", message: "New title", defaultValue: title });
  assert.equal((await pageAnswer(u, mark, "POST", "/organize")).status, 200, "POST /organize rename");
  await eventually(async () => (await docCard(u.page, docId).locator("a.doc-card-title").textContent()) === renamed, { timeout: 90_000, message: "the card shows the new title" });
  const recAfter = await readDoc(target, `docs/${docId}`);
  assert.deepEqual(
    { docId: recAfter?.docId, title: recAfter?.title, slug: recAfter?.slug, createdAt: millis(recAfter?.createdAt), currentVersion: recAfter?.currentVersion },
    { docId, title: renamed, slug: slugify(renamed), createdAt: millis(recBefore.createdAt), currentVersion: "v1" },
    "the record keeps its id",
  );
  assert.equal(await readDoc(target, `docs/${slugify(renamed)}`), null, "no document appears at the new title's slug");
  assert.equal((await O.http.get(`/content/${docId}/v1/index.html`)).status, 200, "the content is still at the old address");

  ctx.step("the delete entry is there, disabled, with the reason as its tooltip");
  menu = await openActions(u.page, docCard(u.page, docId), renamed);
  const del = menu.getByRole("menuitem", { name: DELETE_LABEL });
  assert.deepEqual({ count: await del.count(), disabled: await del.isDisabled(), reason: await del.getAttribute("title") }, { count: 1, disabled: true, reason: DELETE_REASON });
  await u.page.keyboard.press("Escape");

  ctx.step("POST /organize delete: 400 for the owner and an editor, the absent id's 404 for a stranger, 401 anonymously; the document survives");
  const body = { kind: "doc", id: docId, op: "delete" };
  const [rO, rE, rS, rAbsent, rAnon] = await Promise.all([
    O.http.postJson("/organize", body),
    E.http.postJson("/organize", body),
    S.http.postJson("/organize", body),
    S.http.postJson("/organize", { ...body, id: absentDocId(target, "a14-5-absent") }),
    ctx.http({ actor: "anon", timeoutMs: REQUEST_MS, cutoffError: true }).postJson("/organize", body),
  ]);
  assert.deepEqual(
    { owner: [rO.status, rO.json?.error], editor: [rE.status, rE.json?.error], stranger: rS.status, absent: rAbsent.status, anonymous: rAnon.status },
    { owner: [400, DOC_DELETE_ERROR], editor: [400, DOC_DELETE_ERROR], stranger: 404, absent: 404, anonymous: 401 },
  );
  assert.ok(await readDoc(target, `docs/${docId}`), "the document is still there");
  assert.deepEqual(await listObjects(target, `docs/${docId}/v1/`), [`docs/${docId}/v1/index.html`], "and so are its bytes");

  ctx.step("a folder renamed from its menu keeps its id");
  const pName = `Parent ${tag}`;
  const P = await createFolderAs(O, `Parent draft ${tag}`);
  await u.page.locator(`a.doc-card-title[href="/folder/${P}"]`).waitFor({ timeout: 90_000 });
  menu = await openActions(u.page, folderCard(u.page, P), `Parent draft ${tag}`);
  const fMark = u.responseMark();
  await answerDialog(u.page, () => menu.getByRole("menuitem", { name: "Rename…" }).click(), { value: pName });
  assert.equal((await pageAnswer(u, fMark, "POST", "/organize")).status, 200);
  assert.deepEqual(await readDoc(target, `folders/${P}`).then((f) => ({ folderId: f?.folderId, name: f?.name })), { folderId: P, name: pName });

  ctx.step("P holds F, F holds G and a document; deleting F from its menu (confirmed) lifts G and the document into P");
  const F = await createFolderAs(O, `Middle ${tag}`, P);
  const [G, inF] = await Promise.all([
    createFolderAs(O, `Leaf ${tag}`, F),
    publish(O.http, { body: pageHtml({ title: `In F ${tag}`, heading: "F" }), filename: "index.html", title: `In F ${tag}`, folderId: F, name: "a14-5-inf" }),
  ]);
  const H = await createFolderAs(O, `Grandchild ${tag}`, G);
  const inH = await publish(O.http, { body: pageHtml({ title: `In H ${tag}`, heading: "H" }), filename: "index.html", title: `In H ${tag}`, folderId: H, name: "a14-5-inh" });
  await gotoWorkspace(u, P);
  await u.page.locator(`a.doc-card-title[href="/folder/${F}"]`).waitFor({ timeout: 90_000 });

  ctx.step("dismissing the confirmation deletes nothing");
  const watch = watchRequests(u.page);
  menu = await openActions(u.page, folderCard(u.page, F), `Middle ${tag}`);
  const dismissed = await answerDialog(u.page, () => menu.getByRole("menuitem", { name: "Delete folder" }).click(), { accept: false });
  assert.deepEqual({ type: dismissed.type, message: dismissed.message }, { type: "confirm", message: folderDeleteConfirm(`Middle ${tag}`) });
  await sleep(ABSENCE_SETTLE_MS);
  assert.deepEqual(watch.list.filter((r) => pathOf(r.url) === "/organize").map(describe), [], "a dismissed delete sends nothing");
  assert.ok(await readDoc(target, `folders/${F}`), "F is still there");

  menu = await openActions(u.page, folderCard(u.page, F), `Middle ${tag}`);
  const dMark = u.responseMark();
  await answerDialog(u.page, () => menu.getByRole("menuitem", { name: "Delete folder" }).click(), { accept: true });
  assert.equal((await pageAnswer(u, dMark, "POST", "/organize")).status, 200, "POST /organize delete folder");
  watch.stop();
  assert.equal(await readDoc(target, `folders/${F}`), null, "F is gone");
  const g1 = await readDoc(target, `folders/${G}`);
  assert.deepEqual({ parentId: g1?.parentId, ancestors: g1?.ancestors, depth: g1?.depth }, { parentId: P, ancestors: [P], depth: 1 }, "G is lifted into P");
  assert.equal((await readDoc(target, `docs/${inF.docId}`))?.folderId, P, "the document is lifted into P");
  const h1 = await readDoc(target, `folders/${H}`);
  assert.deepEqual({ parentId: h1?.parentId, ancestors: h1?.ancestors, depth: h1?.depth }, { parentId: G, ancestors: [P, G], depth: 2 }, "the deeper descendant is recomputed after F is removed");
  assert.equal((await readDoc(target, `docs/${inH.docId}`))?.folderId, H, "the deeper document stays in its own folder");
  await waitDocCards(u.page, [inF.docId], { what: "P after F is deleted" });
  await eventually(async () => JSON.stringify(await folderOrder(u.page)) === JSON.stringify([G]), { timeout: 90_000, message: "P now shows G" });

  ctx.step("deleting P, at the root, lifts G and the document to the root");
  await gotoWorkspace(u);
  await u.page.locator(`a.doc-card-title[href="/folder/${P}"]`).waitFor({ timeout: 90_000 });
  menu = await openActions(u.page, folderCard(u.page, P), pName);
  const pMark = u.responseMark();
  await answerDialog(u.page, () => menu.getByRole("menuitem", { name: "Delete folder" }).click(), { accept: true });
  assert.equal((await pageAnswer(u, pMark, "POST", "/organize")).status, 200);
  const g2 = await readDoc(target, `folders/${G}`);
  assert.deepEqual({ parentId: g2?.parentId, ancestors: g2?.ancestors, depth: g2?.depth }, { parentId: null, ancestors: [], depth: 0 }, "G is at the root");
  const h2 = await readDoc(target, `folders/${H}`);
  assert.deepEqual({ parentId: h2?.parentId, ancestors: h2?.ancestors, depth: h2?.depth }, { parentId: G, ancestors: [G], depth: 1 }, "the deeper descendant is recomputed after P is removed");
  const deepDoc = await readDoc(target, `docs/${inH.docId}`);
  assert.deepEqual({ folderId: deepDoc?.folderId, members: deepDoc?.members }, { folderId: H, members: [email] }, "the deeper document survives both folder deletions");
  const lifted = await readDoc(target, `docs/${inF.docId}`);
  assert.deepEqual({ folderId: lifted?.folderId, members: lifted?.members }, { folderId: null, members: [email] }, "the document is at the root");
  noPageErrors([u]);
});

/** The MoveDialog from a card's menu: choose `to` (a folder name, or null for Everything) and press Move. */
async function moveUi(u, card, title, to) {
  const menu = await openActions(u.page, card, title);
  await menu.getByRole("menuitem", { name: "Move…" }).click();
  const dlg = u.page.getByRole("dialog", { name: `Move “${title}”` });
  await dlg.waitFor({ timeout: 10_000 });
  await dlg.getByRole("option", { name: to ?? "Everything (no folder)", exact: true }).click();
  const mark = u.responseMark();
  await dlg.getByRole("button", { name: "Move", exact: true }).click();
  const res = await pageAnswer(u, mark, "POST", "/organize");
  await dlg.waitFor({ state: "detached", timeout: 10_000 });
  return res.status;
}

scenario("A14.5b Move… into a shared folder makes its readers the document's members, Move… out takes them away, a reader's folder menu cannot delete it, and deleting the folder lifts the document out of their reach", {
  tiers: BOTH,
  effects: ["email:POST /folder-access"],
  needs: ["email", "mailpit", "mail-fail-recipient"],
  timeoutMs: 420_000,
  inconclusiveOnCaseTimeout: true,
}, async (ctx) => {
  const { owner: O, viewer: V } = await sessions(["owner", "viewer"]);
  const email = O.account.email;
  const vEmail = V.account.email;
  const tag = tagFor();
  const fName = `Shared shelf ${tag}`;
  const F = await createFolderAs(O, fName);
  const shim = shimControl(target);
  const box = mailbox(target);
  const g = await shareFolder(target, { owner: O, folder: F, account: V.account, role: "viewer", timeoutMs: REQUEST_MS });
  const invitation = `${email} shared “${fName}” with you`;
  const sends = async () => (await shim.requests({ to: vEmail })).map((r) => [r.subject, r.status]);
  precondition(JSON.stringify(await sends()) === JSON.stringify([[invitation, 200]]), "the folder grant sent exactly its own invitation");
  precondition(g.status === 200, `POST /folder-access shared the folder (${g.status})`);
  precondition((await readDoc(target, `folders/${F}`))?.members?.includes(vEmail), "the folder's members include the viewer");
  const title = `Moved doc ${tag}`;
  const doc = await publish(O.http, { body: pageHtml({ title, heading: "Moved" }), filename: "index.html", title, name: "a14-5b-doc" });
  const docId = doc.docId;
  const content = `/content/${docId}/v1/index.html`;
  const members = async () => [...((await readDoc(target, `docs/${docId}`))?.members ?? [])].sort();
  precondition(JSON.stringify(await members()) === JSON.stringify([email]), "the document starts with its owner alone");
  precondition((await V.http.get(content)).status === 404, "the viewer cannot read it yet");

  ctx.step("the owner moves the document into the shared folder from its menu");
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(email, O.account.password);
  await waitDocCards(u.page, [docId]);
  assert.equal(await moveUi(u, docCard(u.page, docId), title, fName), 200, "POST /organize move in");
  const inside = await readDoc(target, `docs/${docId}`);
  assert.deepEqual({ folderId: inside?.folderId, members: [...inside.members].sort() }, { folderId: F, members: [email, vEmail].sort() }, "filed: the folder's reader is a member");
  assert.equal((await V.http.get(content)).status, 200, "the folder's reader now reads it");
  assert.deepEqual(await sends(), [[invitation, 200]], "moving into a shared folder sends no new invitation");
  await waitDocCards(u.page, [], { what: "the root after the move" });

  ctx.step("from inside the folder, the owner moves it back to Everything");
  await gotoWorkspace(u, F);
  await waitDocCards(u.page, [docId], { what: "the shared folder" });
  assert.equal(await moveUi(u, docCard(u.page, docId), title, null), 200, "POST /organize move out");
  const outside = await readDoc(target, `docs/${docId}`);
  assert.deepEqual({ folderId: outside?.folderId, members: outside?.members }, { folderId: null, members: [email] }, "out of the folder, its reader is no longer a member");
  assert.equal((await V.http.get(content)).status, 404, "the reader is back to the absent id's 404");
  assert.deepEqual(await sends(), [[invitation, 200]], "moving out of a shared folder sends no invitation");

  ctx.step("the reader's workspace shows the folder, whose Delete entry is disabled with its reason; their POST /organize delete is 403");
  const v = await ctx.users.user({ name: "viewer" });
  await v.signInUi(vEmail, V.account.password);
  await v.page.locator(`a.doc-card-title[href="/folder/${F}"]`).waitFor({ timeout: 90_000 });
  const vMenu = await openActions(v.page, folderCard(v.page, F), fName);
  const vDelete = vMenu.getByRole("menuitem", { name: "Delete folder" });
  assert.deepEqual({ disabled: await vDelete.isDisabled(), reason: await vDelete.getAttribute("title") }, { disabled: true, reason: `Only ${email} can delete this folder.` });
  await v.page.keyboard.press("Escape");
  assert.equal((await V.http.postJson("/organize", { kind: "folder", id: F, op: "delete" })).status, 403, "a reader may not delete the folder");

  ctx.step("filed again, then the folder deleted from the owner's menu: the document is lifted to the root and its reader loses it");
  await O.http.postJson("/organize", { kind: "doc", id: docId, op: "move", targetFolderId: F }, { expect: 200 });
  precondition((await members()).includes(vEmail), "filed again");
  assert.deepEqual(await sends(), [[invitation, 200]], "API filing sends no new invitation");
  await gotoWorkspace(u);
  await u.page.locator(`a.doc-card-title[href="/folder/${F}"]`).waitFor({ timeout: 90_000 });
  const menu = await openActions(u.page, folderCard(u.page, F), fName);
  const mark = u.responseMark();
  await answerDialog(u.page, () => menu.getByRole("menuitem", { name: "Delete folder" }).click(), { accept: true });
  assert.equal((await pageAnswer(u, mark, "POST", "/organize")).status, 200);
  const lifted = await readDoc(target, `docs/${docId}`);
  assert.deepEqual({ folderId: lifted?.folderId, members: lifted?.members }, { folderId: null, members: [email] });
  assert.equal((await V.http.get(content)).status, 404);
  assert.deepEqual(await sends(), [[invitation, 200]], "deleting a shared folder sends no new invitation");
  await box.expectMailboxes({ [vEmail]: [invitation] }, { timeout: REQUEST_MS });
  noPageErrors([u, v]);
});

// --- A14.6 ----------------------------------------------------------------------

/** POST /visibility as the owner, private, with an expiry. */
async function expireAt(session, docId, at) {
  const r = await session.http.postJson("/visibility", { docId, visibility: "private", publicEdit: false, expiresAt: at });
  precondition(r.status === 200 && r.json?.expiresAt === at, `POST /visibility set the expiry (${r.status} ${JSON.stringify(r.json)})`);
}

/** Each document's cover POSTs in `watch`, with their answers. */
async function coverCounts(watch, docs) {
  const out = {};
  for (const [k, id] of Object.entries(docs)) {
    const posts = coverPosts(watch, id);
    const statuses = [];
    for (const p of posts) statuses.push((await p.req.response().catch(() => null))?.status() ?? null);
    out[k] = { posts: posts.length, statuses };
  }
  return out;
}

/** The backfill reached this exact document and its content request completed. */
async function backfillFetched(watch, docId, since = 0) {
  await eventually(async () => {
    const requests = watch.since(since).filter((r) => r.method === "GET" && pathOf(r.url).startsWith(`/content/${docId}/v1/`));
    for (const r of requests) if ((await r.req.response().catch(() => null))?.status() === 200) return true;
    return false;
  }, { timeout: 240_000, message: "the backfill fetched the trusted document before its absence window" });
}

/** Until docs/{id} names a stored cover (a throwing predicate: eventually() takes any value but false as success). */
async function coverStored(id, what) {
  await eventually(async () => {
    const t = (await readDoc(target, `docs/${id}`))?.thumb;
    if (typeof t?.cover !== "string") throw new Error(`no cover on docs/${id}: ${JSON.stringify(t)}`);
    return true;
  }, { timeout: 240_000, interval: 300, message: what });
}

/** The cards that draw a cover image, by id. */
async function cardsWithCover(page) {
  return page.$$eval(".doc-card", (cards) =>
    cards.filter((c) => c.querySelector(".doc-card-thumb img")).map((c) => decodeURIComponent((c.querySelector("a.doc-card-title")?.getAttribute("href") ?? "").replace(/^\/d\//, ""))),
  );
}

scenario("A14.6 cover backfill: one cover POST per card that lacks one, none for a trusted scripted deck, a document not on screen or a reload; an expired document gets its cover from its owner's workspace only and stays a placeholder for its editor", { tiers: BOTH, timeoutMs: 600_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O, editor: E } = await sessions(["owner", "editor"]);
  const email = O.account.email;
  const tag = tagFor();
  const deck = readSample(target, "deck-animated");
  precondition(/<script\b/i.test(deck.bytes.toString("utf8")), "the deck-animated sample has a script");

  ctx.step("the owner publishes two plain documents, the scripted deck twice (one trusted for everyone), one filed in a folder, and two shared with an editor, one of which expires");
  const mk = async (k, extra = {}) => (await publish(O.http, { body: pageHtml({ title: `${k} ${tag}`, heading: `${k} ${tag}` }), filename: "index.html", title: `${k} ${tag}`, name: `a14-6-${k}`, ...extra })).docId;
  // Independent of one another, so made together: a loaded stack stretches each POST /publish.
  const folderId = await createFolderAs(O, `Covers shelf ${tag}`);
  const made = await Promise.all([
    mk("Plain one"),
    mk("Plain two"),
    publish(O.http, { body: deck.bytes, filename: "index.html", title: `Deck sandboxed ${tag}`, name: "a14-6-deck-u" }).then((r) => r.docId),
    publish(O.http, { body: deck.bytes, filename: "index.html", title: `Deck trusted ${tag}`, name: "a14-6-deck-t" }).then((r) => r.docId),
    mk("Filed", { folderId }),
    mk("Expiring"),
    mk("Editor control"),
  ]);
  const docs = Object.fromEntries(["plain1", "plain2", "deckUntrusted", "deckTrusted", "filed", "expired", "control"].map((k, i) => [k, made[i]]));
  // Trusted as the operator trusts it: POST /trust is a superadmin's (ADR 0021).
  await trustAsOperator(target, docs.deckTrusted);
  precondition((await readDoc(target, `docs/${docs.deckTrusted}`))?.trusted === true, "the second deck is trusted for everyone");
  await Promise.all(["expired", "control"].map((k) => share(target, { owner: O, doc: docs[k], account: E.account, role: "editor" })));
  for (const id of Object.values(docs)) precondition(!(await readDoc(target, `docs/${id}`))?.thumb, `${id} starts with no cover`);

  ctx.step("the expiring document's date is set a few seconds ahead and allowed to pass (the product's own clock)");
  const at = Date.now() + 15_000; // ahead of a loaded stack's POST /visibility, which refuses a date already past
  await expireAt(O, docs.expired, at);
  await sleep(Math.max(0, at - Date.now()) + 1_000);

  ctx.step("the editor's workspace: their backfill covers the control document, and sends nothing for the expired one, whose card stays a placeholder");
  const e = await ctx.users.user({ name: "editor" });
  const eWatch = watchRequests(e.page);
  await e.signInUi(E.account.email, E.account.password);
  await waitDocCards(e.page, [docs.expired, docs.control], { what: "the editor's workspace" });
  await coverStored(docs.control, "the editor's backfill stored the control's cover");
  await sleep(BACKFILL_SETTLE_MS);
  const eCounts = await coverCounts(eWatch, { control: docs.control, expired: docs.expired });
  ctx.ev.json("editor-cover-posts", eCounts);
  assert.deepEqual(eCounts.control, { posts: 1, statuses: [200] }, "the editor's backfill ran: one cover POST for the control");
  assert.deepEqual(eCounts.expired, { posts: 0, statuses: [] }, "no cover POST for an expired document from an editor's workspace");
  assert.deepEqual((await cardsWithCover(e.page)).sort(), [docs.control], "the expired card is a placeholder for the editor");

  ctx.step("the owner's workspace: exactly one cover POST for each card without one (the expired document's included), none for the trusted scripted deck, the covered control or the filed document");
  const o = await ctx.users.user({ name: "owner" });
  const oWatch = watchRequests(o.page);
  await o.signInUi(email, O.account.password);
  const rootIds = [docs.plain1, docs.plain2, docs.deckUntrusted, docs.deckTrusted, docs.expired, docs.control];
  await waitDocCards(o.page, rootIds, { what: "the owner's workspace" });
  const owed = ["plain1", "plain2", "deckUntrusted", "expired"];
  await eventually(async () => {
    for (const k of owed) if (!(await readDoc(target, `docs/${docs[k]}`))?.thumb?.cover) throw new Error(`${k} has no cover yet`);
    return true;
  }, { timeout: 240_000, interval: 300, message: "every owed cover stored" });
  await backfillFetched(oWatch, docs.deckTrusted);
  await sleep(BACKFILL_SETTLE_MS);
  const oCounts = await coverCounts(oWatch, docs);
  ctx.ev.json("owner-cover-posts", oCounts);
  for (const k of owed) assert.deepEqual(oCounts[k], { posts: 1, statuses: [200] }, `one cover POST for ${k}`);
  assert.deepEqual(oCounts.deckTrusted, { posts: 0, statuses: [] }, "no cover POST for the trusted scripted deck");
  assert.deepEqual(oCounts.control, { posts: 0, statuses: [] }, "no cover POST for a card that has one");
  assert.deepEqual(oCounts.filed, { posts: 0, statuses: [] }, "no cover POST for a document that is not on screen");
  for (const k of owed) {
    const t = (await readDoc(target, `docs/${docs[k]}`))?.thumb;
    assert.deepEqual({ versionId: t?.versionId, cover: typeof t?.cover }, { versionId: "v1", cover: "string" }, `${k}: thumb on the record`);
  }
  assert.equal((await readDoc(target, `docs/${docs.deckTrusted}`))?.thumb, undefined, "the trusted scripted deck has no cover");
  await eventually(async () => JSON.stringify((await cardsWithCover(o.page)).sort()) === JSON.stringify([...owed.map((k) => docs[k]), docs.control].sort()), { timeout: 60_000, message: "the owner's cards draw every stored cover" });

  ctx.step("a reload sends no cover POST at all; opening the folder sends exactly one, for the filed document");
  const tReload = Date.now();
  await o.page.reload({ waitUntil: "load" });
  await waitDocCards(o.page, rootIds, { what: "the reloaded workspace" });
  await backfillFetched(oWatch, docs.deckTrusted, tReload);
  await sleep(BACKFILL_SETTLE_MS);
  const afterReload = oWatch.since(tReload).filter((r) => r.method === "POST" && pathOf(r.url) === "/thumb");
  assert.deepEqual(afterReload.map(describe), [], "no cover POST after a reload");
  assert.deepEqual((await coverCounts(oWatch, { filed: docs.filed })).filed, { posts: 0, statuses: [] }, "the filed document had no cover POST before opening its folder");
  const tFolder = Date.now();
  await o.page.locator(`a.doc-card-title[href="/folder/${folderId}"]`).click();
  await waitDocCards(o.page, [docs.filed], { what: "the folder" });
  await coverStored(docs.filed, "the filed document's cover stored");
  await sleep(BACKFILL_SETTLE_MS);
  assert.deepEqual((await coverCounts({ list: oWatch.since(tFolder) }, { filed: docs.filed })).filed, { posts: 1, statuses: [200] }, "one cover POST for the filed document, once on screen");

  ctx.step("the editor reloads: the expired card is still a placeholder though its cover is stored, and nothing is sent for it");
  const tE = Date.now();
  await e.page.reload({ waitUntil: "load" });
  await waitDocCards(e.page, [docs.expired, docs.control], { what: "the editor's reloaded workspace" });
  await sleep(BACKFILL_SETTLE_MS);
  assert.deepEqual((await cardsWithCover(e.page)).sort(), [docs.control], "the expired card stays a placeholder for the editor");
  const eLate = eWatch.since(tE).filter((r) => r.url.includes(docs.expired) && (pathOf(r.url).startsWith("/thumb") || pathOf(r.url).startsWith("/content")));
  assert.deepEqual(eLate.map(describe), [], "the editor requests nothing of the expired document's");
  eWatch.stop();
  oWatch.stop();
  noPageErrors([o, e]);
});

// --- A14.7 / A14.8 ---------------------------------------------------------------

/** The workspace's revision action opens the real shared upload dialog. */
async function openVersionDialog(u, docId, title) {
  const menu = await openActions(u.page, docCard(u.page, docId), title);
  await menu.getByRole("menuitem", { name: "Upload a new version…" }).click();
  const dlg = u.page.getByRole("dialog", { name: "Upload a new version", exact: true });
  await dlg.waitFor({ state: "visible" });
  return dlg;
}

async function chooseVersionFile(dlg, f) {
  await dlg.locator('input[type="file"]').setInputFiles({ name: f.name, mimeType: f.type || "application/octet-stream", buffer: f.data });
}

/** Read the exact immutable entry selected by the published version record. */
async function publishedEntry(docId, versionId) {
  const version = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  precondition(version?.entry, `the ${versionId} record names its entry`);
  return readObject(target, `${version.storagePrefix ?? `docs/${docId}/${versionId}`}/${version.entry}`);
}

async function submitVersion(u, dlg) {
  const mark = u.responseMark();
  await dlg.getByRole("button", { name: "Publish", exact: true }).click();
  const res = await pageAnswer(u, mark, "POST", "/publish");
  return { status: res.status, json: await res.json().catch(() => null) };
}

scenario("A14.7 Upload a new version from the workspace preserves the address, explains refusals, retries, reports identical files and blocks an outdated open dialog", { tiers: BOTH, timeoutMs: 420_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O } = await sessions(["owner"]);
  const title = `Revision ${tagFor()}`;
  const doc = await publish(O.http, { body: pageHtml({ title, heading: "Original" }), filename: "index.html", title, name: "a14-7" });
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(O.account.email, O.account.password);
  await waitDocCards(u.page, [doc.docId]);
  const next = file("revision.html", pageHtml({ title: "Authored next title", heading: "Revised body" }), "text/html");

  ctx.step("the card action opens a dialog naming its document, fixed base and permanent address; Publish needs a file");
  let dlg = await openVersionDialog(u, doc.docId, title);
  assert.equal(await dlg.getByRole("button", { name: "Publish", exact: true }).isDisabled(), true, "a revision cannot publish without a file");
  assert.match(await dlg.textContent(), /after v1, at the same address/);
  assert.match(await dlg.textContent(), /Comments stay on v1/);

  ctx.step("a Markdown file cannot change the HTML document's format: the refusal is readable, the dialog stays open, and the head is untouched");
  await chooseVersionFile(dlg, file("wrong.md", "# Wrong format\n", "text/markdown"));
  let toastAt = u.toastMark();
  const refused = await submitVersion(u, dlg);
  assert.equal(refused.status, 400, "a format-changing browser revision is refused");
  const refusal = await u.waitForToast(() => true, { since: toastAt, timeout: 10_000 });
  assert.deepEqual({ kind: refusal.kind, text: refusal.text }, { kind: "error", text: "This document is HTML, so an update to it cannot be Markdown." }, "the revision refusal explains the format conflict");
  assert.equal(await dlg.isVisible(), true, "a refused revision keeps its dialog open");
  assert.equal((await readDoc(target, `docs/${doc.docId}`))?.currentVersion, "v1", "a refused revision does not change the head");
  await dismissToasts(u);

  ctx.step("choose a valid replacement and retry in the same dialog: v2 at the same id, with its actual new bytes and success message");
  await chooseVersionFile(dlg, next);
  toastAt = u.toastMark();
  const updated = await submitVersion(u, dlg);
  assert.deepEqual({ status: updated.status, id: updated.json?.docId, version: updated.json?.versionId }, { status: 200, id: doc.docId, version: "v2" }, "the browser revision preserves the document address");
  await dlg.waitFor({ state: "detached" });
  assert.equal((await u.waitForToast(() => true, { since: toastAt, timeout: 10_000 })).text, "Published v2.", "the revision success message names the new version");
  assert.equal((await publishedEntry(doc.docId, "v2"))?.toString("utf8"), next.data.toString("utf8"), "the browser revision stores the selected bytes");
  await dismissToasts(u);

  ctx.step("the same file is a no-op and says so, without minting a third version");
  dlg = await openVersionDialog(u, doc.docId, title);
  await chooseVersionFile(dlg, next);
  toastAt = u.toastMark();
  const duplicate = await submitVersion(u, dlg);
  assert.deepEqual({ status: duplicate.status, version: duplicate.json?.versionId, deduped: duplicate.json?.deduped }, { status: 200, version: "v2", deduped: true }, "an identical browser revision is deduplicated");
  assert.equal((await u.waitForToast(() => true, { since: toastAt, timeout: 10_000 })).text, "No changes — the file is identical to v2.", "the identical-file message names the retained version");
  await dismissToasts(u);

  ctx.step("another publisher advances the head while the dialog is open: the dialog explains it and disables Publish before any request");
  dlg = await openVersionDialog(u, doc.docId, title);
  await chooseVersionFile(dlg, next);
  await updateUpload(O.http, doc.docId, { body: pageHtml({ title, heading: "Another publisher" }), baseVersion: "v2", expect: 200 });
  await dlg.getByRole("status").filter({ hasText: "v3 was published while this was open" }).waitFor({ timeout: PAGE_LOAD_MS });
  assert.equal(await dlg.getByRole("button", { name: "Publish", exact: true }).isDisabled(), true, "an outdated open revision dialog cannot publish");
  assert.equal((await readDoc(target, `docs/${doc.docId}`))?.currentVersion, "v3");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  noPageErrors([u]);
});

scenario("A14.8 dropping a file onto an open document offers a confirmed revision, cancel sends nothing, and a refused file can be replaced before publishing", { tiers: BOTH, timeoutMs: 360_000, inconclusiveOnCaseTimeout: true }, async (ctx) => {
  const { owner: O } = await sessions(["owner"]);
  const title = `Drop revision ${tagFor()}`;
  const doc = await publish(O.http, { body: pageHtml({ title, heading: "Original drop target" }), filename: "index.html", title, name: "a14-8" });
  const u = await ctx.users.user({ name: "owner" });
  await u.signInUi(O.account.email, O.account.password);
  await u.goto(`/d/${doc.docId}`);
  await u.page.locator("iframe.doc-frame").waitFor({ state: "attached", timeout: PAGE_LOAD_MS });
  const frame = await u.frame();
  await frame.locator("h1").filter({ hasText: "Original drop target" }).waitFor({ timeout: PAGE_LOAD_MS });
  const watch = watchRequests(u.page);
  const next = file("dropped.html", pageHtml({ title, heading: "Dropped replacement" }), "text/html");
  const dlg = u.page.getByRole("dialog", { name: "Upload a new version", exact: true });

  ctx.step("a drop in the actual content frame opens the confirmation dialog with the selected file, without publishing");
  assert.equal((await dropFiles(frame, "body", [next])).at(-1).claimed, true, "the document frame consumes the file drop");
  await dlg.waitFor();
  assert.equal(await dlg.locator(".upload-dropzone strong").textContent(), next.name, "the document drop preselects its file");
  assert.match(await dlg.textContent(), /after v1, at the same address/);
  assert.deepEqual(watch.list.filter((r) => pathOf(r.url) === "/publish").map(describe), [], "dropping a revision never publishes before confirmation");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await dlg.waitFor({ state: "detached" });
  assert.equal((await readDoc(target, `docs/${doc.docId}`))?.currentVersion, "v1", "cancelled dropped revision leaves the head unchanged");

  ctx.step("a dropped Markdown file receives the format refusal, remains replaceable, and does not replace the published bytes");
  await dropFiles(frame, "body", [file("wrong.md", "# Wrong format\n", "text/markdown")]);
  await dlg.waitFor();
  let toastAt = u.toastMark();
  assert.equal((await submitVersion(u, dlg)).status, 400);
  assert.equal((await u.waitForToast(() => true, { since: toastAt, timeout: 10_000 })).text, "This document is HTML, so an update to it cannot be Markdown.", "a dropped revision explains its format refusal");
  assert.equal(await dlg.isVisible(), true);
  assert.equal((await readDoc(target, `docs/${doc.docId}`))?.currentVersion, "v1");
  await dismissToasts(u);

  ctx.step("replace the refused file in the open dialog and confirm: exactly one version is minted and shown at the same address");
  await chooseVersionFile(dlg, next);
  toastAt = u.toastMark();
  const updated = await submitVersion(u, dlg);
  assert.deepEqual({ status: updated.status, id: updated.json?.docId, version: updated.json?.versionId }, { status: 200, id: doc.docId, version: "v2" }, "a confirmed dropped revision preserves the address");
  await dlg.waitFor({ state: "detached" });
  assert.equal((await u.waitForToast(() => true, { since: toastAt, timeout: 10_000 })).text, "Published v2.");
  assert.equal(new URL(u.page.url()).pathname, `/d/${doc.docId}`, "the dropped revision stays at its permanent address");
  await (await u.frame()).locator("h1").filter({ hasText: "Dropped replacement" }).waitFor({ timeout: PAGE_LOAD_MS });
  assert.equal((await publishedEntry(doc.docId, "v2"))?.toString("utf8"), next.data.toString("utf8"), "the dropped revision stores its selected bytes");
  watch.stop();
  noPageErrors([u]);
});

// --- A14.7b / A14.8b -------------------------------------------------------------

const REVISION_REFUSALS = Object.freeze({
  pending: "1 suggested edit is waiting for a decision. Only the owner or an approver can accept or reject it, and no new version can be published until then. If it is yours, you may withdraw it.",
  accepted: 'This document\'s unpublished draft holds 1 accepted suggestion, and publishing this would replace the draft and lose it. Publish the draft first, with commit_draft or "Save as new version" in the app, then read the document again and update it.',
  expired: "This document has expired — change or clear its expiry to edit it.",
  revoked: "You can no longer publish to this document.",
  editing: "Somebody has this document open in the editor, where this would be lost, so it was not published. Try again once they have left it, or ask them to do it there.",
});

/** The refusal fixtures use real product requests; no fabricated document state. */
async function stageRevisionSuggestion(owner, docId, body, accepted) {
  const exact = "Original refusal text";
  const replacement = "Accepted replacement text";
  const created = answered(await owner.http.postJson("/suggestion", {
    op: "create", docId, versionId: "v1",
    anchor: { elementId: "revision-text", exact, prefix: "", suffix: "", start: 0, end: exact.length },
    replacement,
  }), "create revision refusal suggestion");
  precondition(created.status === 200 && created.json?.annId, "the suggestion fixture was created through the product");
  if (!accepted) return;
  for (const op of ["claim", "accept"]) {
    if (op === "accept") {
      const saved = answered(await owner.http.postJson("/draft", { docId, baseVersion: "v1", html: body.replace(exact, replacement) }), "save accepted revision fixture");
      precondition(saved.status === 200, "the proposed text is actually saved in the draft");
    }
    const decided = answered(await owner.http.postJson("/suggestion", { op, docId, versionId: "v1", annId: created.json.annId, replacement }), `revision fixture ${op}`);
    precondition(decided.status === 200, `the fixture suggestion was ${op === "claim" ? "claimed" : "accepted"}`);
  }
}

async function revisionRefusalState(docId) {
  const doc = await readDoc(target, `docs/${docId}`);
  return {
    currentVersion: doc?.currentVersion,
    draft: doc?.draft ?? null,
    versions: (await readCollection(target, `docs/${docId}/versions`)).map(({ id, data }) => ({ id, data })).sort((a, b) => a.id.localeCompare(b.id)),
    bytes: (await publishedEntry(docId, "v1"))?.toString("utf8"),
    // The unrelated cover backfill may finish while a workspace dialog is
    // open. Version and draft objects, including generations, must not move.
    objects: (await listObjects(target, `docs/${docId}/`, { meta: true })).filter((object) => !object.name.startsWith(`docs/${docId}/thumbs/`)),
  };
}

/** Each entrance uses the same refusal dialog but different surrounding state. */
async function revisionRefusals(ctx, entrance) {
  const { owner: O, editor: E } = await sessions(["owner", "editor"]);
  const u = await ctx.users.user({ name: `revision-${entrance}-owner` });
  const e = await ctx.users.user({ name: `revision-${entrance}-editor` });
  await u.signInUi(O.account.email, O.account.password);
  await e.signInUi(E.account.email, E.account.password);
  const next = file("replacement.html", pageHtml({ heading: "Replacement that must not publish" }), "text/html");

  for (const reason of ["pending", "accepted", "expired", "revoked", "editing"]) {
    ctx.step(`${entrance}: ${reason} keeps its published version and draft; the person sees the specific refusal`);
    const title = `${entrance} ${reason} ${tagFor()}`;
    const body = pageHtml({ title, heading: "Original refusal text" }).replace("<h1 ", '<h1 id="revision-text" ');
    const doc = await publish(O.http, { body, filename: "index.html", title, name: `a14-${entrance}-${reason}` });
    if (["revoked", "editing"].includes(reason)) await share(target, { owner: O, doc: doc.docId, account: E.account, role: "editor" });
    if (["pending", "accepted"].includes(reason)) await stageRevisionSuggestion(O, doc.docId, body, reason === "accepted");
    const actor = reason === "revoked" ? e : u;
    let dlg;
    if (entrance === "workspace") {
      await gotoWorkspace(actor);
      await docCard(actor.page, doc.docId).waitFor({ state: "visible", timeout: PAGE_LOAD_MS });
      dlg = await openVersionDialog(actor, doc.docId, title);
      await chooseVersionFile(dlg, next);
    } else {
      await actor.open(doc.docId, { timeout: PAGE_LOAD_MS });
      const frame = await actor.frame();
      await frame.locator("#revision-text").waitFor({ timeout: PAGE_LOAD_MS });
      await dropFiles(frame, "body", [next]);
      dlg = actor.page.getByRole("dialog", { name: "Upload a new version", exact: true });
      await dlg.waitFor({ state: "visible" });
    }
    // Change authority after the dialog has opened: the request, rather than
    // the initial menu's visibility, must enforce the current grant and expiry.
    if (reason === "revoked") await share(target, { owner: O, doc: doc.docId, account: E.account, role: "viewer" });
    if (reason === "expired") {
      const at = Date.now() + 15_000;
      await expireAt(O, doc.docId, at);
      await sleep(Math.max(0, at - Date.now()) + 100);
    }
    if (reason === "editing") {
      await e.open(doc.docId, { timeout: PAGE_LOAD_MS });
      await e.enterEdit({ waitShared: true, timeout: PAGE_LOAD_MS });
      await eventually(async () => {
        const status = await rtdbGet(target, `status/${doc.docId}/peers`);
        return Object.values(status ?? {}).some((p) => p.email === E.account.email && p.mode === "edit");
      }, { timeout: PAGE_LOAD_MS, message: "the live editor's presence actually reached the server" });
    }
    const before = await revisionRefusalState(doc.docId);
    if (reason === "editing" && entrance === "drop") {
      const watch = watchRequests(actor.page);
      try {
        await eventually(async () => {
          const status = dlg.getByRole("status");
          assert.ok(await status.count() && (await status.textContent()).includes("has it open in the editor"), "the dropped revision explains the active editor");
          return true;
        }, { timeout: PAGE_LOAD_MS, message: "the dropped revision explains the active editor" });
        assert.equal(await dlg.getByRole("button", { name: "Publish", exact: true }).isDisabled(), true, "the dropped revision cannot publish over a visible active editor");
        await sleep(ABSENCE_SETTLE_MS);
        assert.deepEqual(watch.list.filter((r) => pathOf(r.url) === "/publish").map(describe), [], "the blocked dropped revision sends no publish request");
      } finally { watch.stop(); }
    } else {
      const mark = actor.toastMark();
      const refused = await submitVersion(actor, dlg);
      assert.equal(refused.status, reason === "revoked" ? 403 : 409, `${entrance} ${reason}: the server refuses this revision`);
      const toast = await actor.waitForToast((t) => t.kind === "error", { since: mark, timeout: 10_000 });
      assert.equal(toast.text, REVISION_REFUSALS[reason], `${entrance} ${reason}: the revision refusal explains the current obstacle`);
      assert.equal(await dlg.isVisible(), true, `${entrance} ${reason}: a refusal keeps the selected file and dialog available`);
      assert.equal(await dlg.locator(".upload-dropzone strong").textContent(), next.name, `${entrance} ${reason}: the refused file remains selected`);
      assert.deepEqual(await dlg.locator("button[aria-busy]").evaluateAll((buttons) => buttons.map((button) => ({ busy: button.getAttribute("aria-busy"), label: button.textContent.trim() }))), [{ busy: "false", label: "Publish" }], `${entrance} ${reason}: a refusal releases progress`);
      await dismissToasts(actor);
    }
    assert.deepEqual(await revisionRefusalState(doc.docId), before, `${entrance} ${reason}: a refused revision changes no head, version, draft or stored bytes`);
    await dlg.getByRole("button", { name: "Cancel", exact: true }).click();
    await dlg.waitFor({ state: "detached" });
    if (reason === "editing") await e.goto("/");
  }
  noPageErrors([u, e]);
}

scenario("A14.7b workspace revision refusals preserve bytes and explain pending suggestions, accepted drafts, expiry, revoked editing and active editors", {
  tiers: ["local"], effects: ["email:POST /access", "email:POST /suggestion"], needs: ["rtdb-rules"], timeoutMs: 720_000, inconclusiveOnCaseTimeout: true,
}, async (ctx) => revisionRefusals(ctx, "workspace"));

scenario("A14.8b dropped revision refusals preserve bytes and explain pending suggestions, accepted drafts, expiry, revoked editing and active editors", {
  tiers: ["local"], effects: ["email:POST /access", "email:POST /suggestion"], needs: ["rtdb-rules"], timeoutMs: 720_000, inconclusiveOnCaseTimeout: true,
}, async (ctx) => revisionRefusals(ctx, "drop"));
