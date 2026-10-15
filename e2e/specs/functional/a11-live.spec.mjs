// SPDX-License-Identifier: Apache-2.0
// A11 live editing with two peers: shared state, presence, the overlay rule, follow, who may join the log, revocation, cleanup, the rules and the wire round trip (SPEC §6b, §16).

/**
 * Catalogue A11.1–A11.12, two peers each, every case with its own accounts
 * and document (the shared stack has other specs on it). What each case
 * stands on:
 *
 *   A11.1   SPEC §6b "Several people may type into one document at the same
 *           time; their edits merge"; the toolbar's `.share-state` says so.
 *           The 1 s bound is the plan's ("sub-second propagation").
 *   A11.2   SPEC §16 "One colour per person": one palette paints the chip and
 *           the caret, derived from the email so it is stable between
 *           sessions; mode is encoded by dot SHAPE (`data-mode`). The caret it
 *           reads is the bar peers.ts draws at the END of a selection; a
 *           collapsed caret alone is A11.2b's.
 *   A11.3   SPEC §16 "Ephemeral presence is an overlay, never inline DOM", and
 *           usePeerPresence.ts: the overlay does not exist while editing. Its
 *           positive control is a selection's caret, as in A11.2.
 *   A11.4   usePeerPresence.ts follow mode: scroll bound to a peer's
 *           `viewport`, released by any deliberate gesture.
 *   A11.5   SPEC §16 "A suggester is not in it, and never joins the shared log".
 *   A11.6   SPEC §16 shared draft reads require editAccess. A viewer must
 *           not decode an editor's unpublished keystrokes (S26 regression).
 *   A11.7   SPEC §16 "A public open-editing document also carries the key `*`";
 *           SPEC §6b joining waits for the log (suspect S27: a `*` editor can
 *           write `y` but not read it, so it seeds a second copy).
 *   A11.8   SPEC §16/§17 an unlisted open-editing link holder edits "through
 *           /draft instead … and are not merged live with the members"
 *           (suspect S24: shown "Shared" while not merged).
 *   A11.9   SPEC §16 the mirror is replaced whole "so revocations propagate";
 *           SPEC §2 `/draft` refuses a caller who may not read with 404.
 *   A11.10  presence.ts: `onDisconnect` drops a person "the instant their tab
 *           closes".
 *   A11.11  database.rules.json status/$docId: peers/$uid `.validate`, the
 *           `$other` rules, `y/$entry` `.validate`; SPEC §16 withdrew `lock`
 *           and `requests`.
 *   A11.12  SPEC §6b "a document survives a round trip through the wire format
 *           byte-identical; the sample bundles are the fixtures that hold it".
 *
 * Three cases this unit's runs turned up, each tagged with its own defect id:
 *
 *   A11.2b  SPEC §16 spec.md:1516 "`focus` — selection or caret, as an
 *           ephemeral `Anchor`", and spec.md:1575 "Peer carets and selections
 *           update at 200 ms": a collapsed caret an editor clicks is broadcast
 *           as NO focus (anchor.ts:55 describeAnchorFromSelection returns null
 *           when the selection is collapsed, and usePeerPresence.ts:95-96 sends
 *           that null), so a reader never sees where an editor is typing
 *           (X-a11-live-1, class P).
 *   A11.7b  SPEC §16 `*` on a public open-editing document survives a share,
 *           because persistDocMembership (folders.ts) refreshes the mirror
 *           without the open-editing flag (X-a11-live-3).
 *   A11.12b SPEC §6a spec.md:732-733 "Containers the author left empty for
 *           their script to fill are outlined in edit mode": the joiner never
 *           re-marks after the adopt. useInlineEditor.ts:136 marks the loaded
 *           body once; sync.ts:272-281 then replaces it from the wire, which
 *           rightly never carries data-bshd-empty (binding.ts:108, ADR 0010),
 *           and local marking must be restored after the adopt (regression X-a11-live-2).
 *
 * Harness facts this spec relies on:
 *  - The RTDB emulator treats ANY `Authorization: Bearer …` as the admin, so a
 *    request as a user goes through lib/rtdb.mjs rtdbAs, which sends the ID
 *    token only as `?auth=` and strips the header.
 *  - An RTDB DENY is evidence only where ns=<projectId>, the namespace the app
 *    uses, enforces the tree's database.rules.json. A stack built before the
 *    harness bound them there ran with none (S31), so every case that asserts
 *    an RTDB verdict first proves it live (rulesEnforced: rtdbRulesStatus, on
 *    a local stack; on production the deployed rules are the product's own).
 *  - Websocket frames come from User.log.wsFrames, kept from the context's
 *    creation; propagation is timed by lib/frame.mjs arrival probes, in the
 *    page, on one clock.
 *  - In a `defect:` case every AssertionError counts as the defect's oracle,
 *    so everything that is setup there is a precondition().
 *  - Every case declares ON_STACK (lib/test.mjs): a wait or a budget that ran
 *    out while the shared stack stalled, with a page's or a request's evidence
 *    of it, ends INCONCLUSIVE; an assertion, a defect's oracle or a wait on a
 *    stack that kept answering is judged as before.
 *
 * Only e2e/lib/ talks to the stack.
 */

import { presenceModes, presenceFor } from "../../lib/presence.mjs";
import assert from "node:assert/strict";
import { after } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { openSession } from "../../lib/session.mjs";
import { publish, readSample } from "../../lib/seed.mjs";
import { setVisibility, share, unshare } from "../../lib/grant.mjs";
import { closeAdmin, emailKey, readDoc, rtdbGet } from "../../lib/admin.mjs";
import { eventually } from "../../lib/assert.mjs";
import { armArrival, bodyHash, frameGeometry, framePointToPage, waitForArrival } from "../../lib/frame.mjs";
import { rtdbAs, rtdbRulesStatus } from "../../lib/rtdb.mjs";
import { makeToken } from "../../lib/tokens.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
/** The plan's live-editing deadline for N = 2. */
const SETTLE_N2_MS = 15_000;
/**
 * How long an autosave may take to answer: a debounce plus one POST /draft,
 * about a second on an idle stack, but 14-22 s measured on a shared stack whose
 * Firestore emulator was saturated. 45 s, the lib's own frame-load deadline.
 * Only setup and the record wait on it; no oracle is a bound on it.
 */
const AUTOSAVE_MS = 45_000;
/**
 * Each case's own bound. A case takes 2-25 s on an idle stack; on a shared
 * stack whose Firestore emulator was saturated, setup alone (accounts, a
 * publish, a share, two UI sign-ins) took up to 166 s, and a case that had
 * reached its oracle at 85 s was cut off by 120 s in its own cleanup. No
 * oracle is a bound on it.
 */
const CASE_MS = 300_000;
/** A11.12 round-trips five samples, each opened by two peers. */
const ROUND_TRIP_MS = 2 * CASE_MS;
/** The file's budget (lib/budget.mjs): every case at its own bound, above the computed ceiling. */
export const E2E_FILE_TIMEOUT_MS = 16 * CASE_MS;
/**
 * Every case's stack options (lib/test.mjs, README "When the stack does not
 * answer"). `inconclusiveOnHttpStall` implies `inconclusiveOnCaseTimeout` (the
 * body runs against a budget, `timeoutMs` less 20 s, whose running out is a
 * wait the length of the case), and so `inconclusiveOnPageStall` and
 * `inconclusiveOnStackTimeout`; `inconclusiveOnRequestStall` adds the case's
 * own requests Hosting cut off as evidence beside its pages'.
 */
const ON_STACK = Object.freeze({ inconclusiveOnRequestStall: true, inconclusiveOnHttpStall: true });
/** The fixture's body: one sentinel heading and 40 paragraphs. */
const FIXTURE_TOP = 41;
/** An empty Yjs update (no structs, empty delete set): harmless to every peer that applies it. */
const EMPTY_UPDATE = "AAA=";
/** The samples A11.12 round-trips, by the plan's letters. */
const ROUND_TRIP = [["H", "bikeshed-tour"], ["B", "design-review-shortener"], ["M", "markdown-reference"], ["D", "deck-animated"], ["Q", "deck-quarter-review"]];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tokenSeq = 0;
/** A checksummed token (lib/tokens.mjs) for this run, `peer` and a fresh sequence number. */
const token = (peer) => makeToken(target.runId, peer, (tokenSeq += 1));

// --- Setup -------------------------------------------------------------------

/**
 * An owner with a session, the fixture published as v1, and the
 * rest of the cast as accounts; `roles` maps cast role → the grant on the
 * document (null: no grant). Only the roles in `sessions` get an HTTP session
 * (and an ID token). `browsers` lists [user name, cast role, opts] to sign in
 * through the UI, WHILE the document is set up: the two are independent, and
 * on a loaded shared stack each takes tens of seconds.
 */
async function world(ctx, { roles = {}, sessions = [], browsers = [], title = "A11 live", fixture = FIXTURE, visibility = null, publicEdit = false } = {}) {
  const names = Object.keys(roles);
  // Opted out of notices before any session, as production's accounts are.
  const accounts = await cast(target, ["owner", ...names], { notifications: false });
  const byRole = { owner: accounts[0], ...Object.fromEntries(names.map((n, i) => [n, accounts[i + 1]])) };
  const signingIn = Promise.all(browsers.map(([name, role]) => browserUser(ctx, name, byRole[role])));
  const setup = (async () => {
    const owner = await openSession(target, accounts[0]);
    const up = await publish(owner.http, { fixture, title: `${title} ${runTag(target.runId)}-${rand4()}`, name: "a11-live" });
    precondition(up.status === 200 && up.versionId === "v1", `the owner published v1 (got ${up.status} ${JSON.stringify(up.json)?.slice(0, 200)})`);
    const docId = up.docId;
    let linkToken = null;
    if (visibility) {
      // lib/grant.mjs: the window it opens is the case's, made private again when the case ends.
      const v = await setVisibility(target, { owner, doc: docId, visibility, publicEdit });
      precondition(v.visibility === visibility && v.publicEdit === publicEdit, `POST /visibility ${visibility}${publicEdit ? " with open editing" : ""}: ${v.status} ${JSON.stringify(v.json)?.slice(0, 200)}`);
      linkToken = v.linkToken;
    }
    const people = {};
    await Promise.all(names.map(async (name) => {
      const role = roles[name];
      const account = byRole[name];
      if (role) {
        const g = await share(target, { owner, doc: docId, account, role });
        precondition(g.status === 200 && g.mirror?.ok, `shared with ${name} as ${role}; RTDB mirror ${JSON.stringify(g.mirror)}`);
      }
      people[name] = { account, session: sessions.includes(name) ? await openSession(target, account) : null };
    }));
    return { owner, docId, linkToken, people };
  })();
  const [signed, { owner, docId, linkToken, people }] = await Promise.all([signingIn, setup]);
  const users = Object.fromEntries(browsers.map(([name], i) => [name, signed[i]]));
  ctx.step(`owner ${accounts[0].email} published ${docId}${visibility ? ` (${visibility}${publicEdit ? ", open editing" : ""})` : ""}; ${names.map((n) => `${n} ${people[n].account.email}${roles[n] ? ` as ${roles[n]}` : ""}`).join("; ")}${browsers.length ? `; signed in through the UI: ${browsers.map(([n]) => n).join(", ")}` : ""}`);
  return { owner, ownerAcct: accounts[0], docId, linkToken, people, users };
}

/** A signed-in browser user (its websocket frames are in `log.wsFrames` from the context's creation). */
async function browserUser(ctx, name, account) {
  const u = await ctx.users.user({ name });
  const s = await u.signInUi(account.email, account.password);
  precondition(s.status === "ok", `${name} signed in through /signup`);
  return u;
}

/** Frames that name `status/{doc}/y`, which only a browser in the shared log ever sends. */
function logFrames(frames, docId) {
  const needle = `/status/${docId}/y`;
  return frames.filter((f) => f.includes(needle));
}

/** Both into edit mode until each toolbar says Shared. */
async function bothShared(...users) {
  for (const u of users) {
    const { share: state } = await u.enterEdit({ waitShared: true });
    precondition(state === "shared", `${u.name} joined the live session (share-state ${state})`);
  }
}

/** `.share-state`, as the toolbar shows it: {state, text} or null when there is none. */
async function shareBadge(user) {
  return user.page.evaluate(() => {
    const el = document.querySelector(".share-state");
    return el ? { state: el.getAttribute("data-state"), text: el.textContent.trim() } : null;
  });
}

/** One element's text in the user's document frame, or null. */
async function paraText(user, id) {
  return (await user.frame()).evaluate((i) => document.getElementById(i)?.textContent ?? null, id);
}

/** Wait until every listed paragraph holds what it should, on one peer. */
async function waitText(user, expect, { timeout = SETTLE_N2_MS, what } = {}) {
  return eventually(async () => {
    for (const [id, want] of Object.entries(expect)) {
      const got = await paraText(user, id);
      if (got !== want) throw new Error(`${user.name}: #${id} = ${JSON.stringify(got?.slice(-60))}`);
    }
    return true;
  }, { timeout, interval: 100, message: what ?? `${user.name} holds the expected text` });
}

/** I1: both frames' body.innerHTML hashes equal on 3 consecutive samples. */
async function converged(a, b, { timeout = SETTLE_N2_MS } = {}) {
  return eventually(async () => {
    const [x, y] = await Promise.all([bodyHash(await a.frame()), bodyHash(await b.frame())]);
    if (x.hash !== y.hash) throw new Error(`hashes differ: ${x.hash.slice(0, 12)} (${x.length}) vs ${y.hash.slice(0, 12)} (${y.length})`);
    return x.hash;
  }, { timeout, interval: 250, stableSamples: 3, message: "I1 convergence" });
}

/** Both peers have no unsaved work (autosave settled). */
async function settledSaves(...users) {
  return eventually(async () => {
    const states = await Promise.all(users.map((u) => u.saveState()));
    if (states.some((s) => s === "dirty" || s === "saving" || s === "error")) throw new Error(`save states ${JSON.stringify(states)}`);
    return states;
  }, { timeout: AUTOSAVE_MS, interval: 500, stableSamples: 3, message: "autosave settled" });
}

// --- The live log and the rules -------------------------------------------------

/** An RTDB client evaluated by the rules as the holder of `idToken` (lib/rtdb.mjs: `?auth=` only, no Bearer header). */
const rtdbFor = (ctx, label, idToken) => rtdbAs(target, { idToken, http: ctx.http({ actor: `${label}-rtdb` }) });

/** ALLOW or DENY from an rtdbAs result; anything else (a 400, a 404, an unparsable token) is not a verdict. */
function rtdbVerdict(r, what) {
  precondition(r.verdict !== null, `${what}: the database answered ${r.status} ${r.error ?? JSON.stringify(r.json)?.slice(0, 300)}, which is neither an allow nor a rules denial`);
  return r.verdict;
}

/**
 * An RTDB verdict is only evidence where ns=<projectId> enforces the tree's
 * rules: proved live, per case, on a local stack (the shared stack predates
 * the `rtdb-rules` capability, so `needs` would skip rather than check). On
 * production the deployed rules are the product's own.
 */
async function rulesEnforced(ctx) {
  if (target.kind !== "local") return;
  const s = await rtdbRulesStatus(target, { http: ctx.http({ actor: "rtdb-rules" }) });
  precondition(s.ok, `RTDB rules in ns=${s.namespace}: ${s.reason}`);
  ctx.step(`RTDB ns=${s.namespace} enforces the tree's ${s.file} (${s.bytes} bytes, sha256 ${s.sha256.slice(0, 12)}; an anonymous read answers ${s.anonymousStatus})`);
}

/** The live log's entries as the admin sees them: {key: base64}. */
async function logEntries(docId) {
  return (await rtdbGet(target, `status/${docId}/y`)) ?? {};
}

/** Wait until the live log has at least `min` entries and holds still for 2 s (the plan's `y` settle). */
async function logSettled(docId, { min = 1, timeout = SETTLE_N2_MS } = {}) {
  return eventually(async () => {
    const keys = Object.keys(await logEntries(docId)).sort();
    if (keys.length < min) throw new Error(`${keys.length} entries`);
    return keys;
  }, { timeout, interval: 400, stableSamples: 6, message: `status/${docId}/y holds still for 2 s` });
}

/** Does any base64 entry, decoded, contain `text` as UTF-8? */
function logContains(entries, text) {
  const needle = Buffer.from(text, "utf8");
  return Object.values(entries).some((v) => typeof v === "string" && Buffer.from(v, "base64").includes(needle));
}

const newEntry = (who) => `e2e-${runTag(target.runId)}-${who}-${rand4()}`;

// --- Presence ----------------------------------------------------------------

/** The presence chips a user sees: name, data-mode, dot shape, colour, follow state. */
async function chips(user) {
  return user.page.evaluate(() =>
    [...document.querySelectorAll(".presence-bar .presence-chip")].map((b) => {
      const dot = b.querySelector(".presence-dot");
      return {
        name: b.querySelector(".presence-name")?.textContent ?? "",
        mode: dot?.getAttribute("data-mode") ?? null,
        dotRadius: dot ? getComputedStyle(dot).borderTopLeftRadius : null,
        editingIcon: Boolean(b.querySelector('[aria-label="Editing"]')),
        color: getComputedStyle(b).color,
        pressed: b.getAttribute("aria-pressed"),
        title: b.getAttribute("title"),
      };
    }),
  );
}

async function chipFor(user, email) {
  return (await chips(user)).find((c) => c.name === email.toLowerCase()) ?? null;
}

/** The peer overlay in a user's document frame: does it exist, and what is drawn in it. */
async function overlay(user) {
  return (await user.frame()).evaluate(() => {
    const layer = document.getElementById("bshd-peers");
    const style = document.getElementById("bshd-peer-style");
    const marked = [...document.querySelectorAll("[data-bshd]")].map((e) => e.getAttribute("data-bshd")).filter((v) => v === "peers" || v === "peer-style");
    const label = layer?.querySelector(".bshd-peer-label");
    return {
      layer: Boolean(layer),
      style: Boolean(style),
      marked,
      carets: layer ? layer.querySelectorAll(".bshd-peer-caret").length : 0,
      labelText: label?.textContent ?? null,
      labelColor: label ? getComputedStyle(label).backgroundColor : null,
      editable: document.body?.getAttribute("contenteditable") ?? null,
      url: location.pathname,
    };
  });
}

/** Put a collapsed caret at the end of `id` in the user's frame with a real click. */
async function caretAt(user, id) {
  return user.typeInFrame(`#${id}`, "");
}

/**
 * Select a passage with a real drag. A11.2 and A11.3 read the caret bar the
 * overlay draws at a SELECTION's end (peers.ts): a collapsed caret alone is
 * broadcast as no focus at all, which is A11.2b's defect (X-a11-live-1).
 */
async function selectIn(user, id, exact) {
  const r = await user.selectText(`#${id}`, exact);
  precondition(r.text === exact, `${user.name} selected ${JSON.stringify(exact)} (got ${JSON.stringify(r.text)} via ${r.via})`);
  return r;
}

/** Read one person explicitly from their raw, independently owned session records. */
async function serverPeer(docId, uid) {
  return presenceFor(await rtdbGet(target, `status/${docId}/peers`), uid);
}

/** The focus a peer has broadcast, as the server holds it (null when none). */
async function serverFocus(docId, uid) {
  return (await serverPeer(docId, uid))?.focus ?? null;
}

/** The frame's scroll fraction, computed as the product computes it (peers.ts scrollFraction). */
async function scrollFrac(user) {
  return (await user.frame()).evaluate(() => {
    const el = document.documentElement;
    const max = Math.max(1, el.scrollHeight - innerHeight);
    return { frac: Math.min(1, Math.max(0, scrollY / max)), y: scrollY, max };
  });
}

/** A real wheel gesture over the middle of the user's document frame. */
async function wheelInFrame(user, dy) {
  const g = await frameGeometry(user.page);
  const p = framePointToPage(g, { x: Math.min(300, g.layout.width / 2), y: Math.min(300, g.layout.height / 2) });
  await user.page.mouse.move(p.x, p.y);
  await user.page.mouse.wheel(0, dy);
  // A wheel scroll may animate: wait until the position stops moving.
  return eventually(async () => (await scrollFrac(user)).y, { timeout: 5_000, interval: 100, stableSamples: 4, message: `${user.name}'s scroll settles` });
}

// --- Latency -----------------------------------------------------------------

/**
 * Type `tok` at the end of `id` on `from`, and measure when it is whole on
 * `from` and on `to`: an arrival probe in each page (lib/frame.mjs), timed by
 * the page's own clock as the text enters the DOM, before any poll looks. A
 * probe whose frame was replaced before the token came throws (E2E_ARRIVAL).
 */
async function measureHop(from, to, id, tok) {
  await Promise.all([armArrival(from, id, tok), armArrival(to, id, tok)]);
  await from.typeInFrame(`#${id}`, tok);
  const [local, remote] = await Promise.all([from, to].map((u) => waitForArrival(u, tok, { timeout: SETTLE_N2_MS })));
  return { from: from.name, to: to.name, id, token: tok, ms: remote.at - local.at };
}

// --- A11.1 ---------------------------------------------------------------------

scenario("A11.1 two editors both show Shared, and a token typed by either reaches the other's frame in under 1 s", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const w = await world(ctx, { roles: { editor: "editor" }, browsers: [["owner", "owner"], ["editor", "editor"]], title: "A11.1 propagation" });
  const { owner: o, editor: e } = w.users;
  await Promise.all([o.open(w.docId), e.open(w.docId)]);
  const base = {};
  for (const id of ["e2e-3", "e2e-4"]) base[id] = await paraText(o, id);

  ctx.step("both press Edit; each toolbar must say Shared (.share-state[data-state=shared])");
  await bothShared(o, e);
  for (const u of [o, e]) assert.deepEqual(await shareBadge(u), { state: "shared", text: "Shared" }, `${u.name}'s toolbar badge`);

  ctx.step("four hops, alternating: one peer types a token at the end of a paragraph; the other's frame is timed until the token is whole there, on the same clock (an observer in each page)");
  const hops = [];
  const typed = { "e2e-3": "", "e2e-4": "" };
  for (const [from, to, id, peer] of [[o, e, "e2e-3", "o"], [e, o, "e2e-4", "e"], [o, e, "e2e-3", "o"], [e, o, "e2e-4", "e"]]) {
    const tok = token(peer);
    const hop = await measureHop(from, to, id, tok);
    typed[id] += tok;
    hops.push(hop);
    ctx.step(`${hop.from} → ${hop.to}: ${tok} in #${id} arrived after ${hop.ms} ms`);
  }
  ctx.ev.json("hops", hops);

  ctx.step("I2 on both peers (each token once, in order, in its paragraph) and I1 (equal body hashes, 3 samples)");
  const expect = { "e2e-3": base["e2e-3"] + typed["e2e-3"], "e2e-4": base["e2e-4"] + typed["e2e-4"] };
  await Promise.all([waitText(o, expect), waitText(e, expect)]);
  await converged(o, e);

  const slow = hops.filter((h) => !(h.ms < 1000));
  assert.deepEqual(slow, [], `every hop under 1 s: ${hops.map((h) => `${h.from}→${h.to} ${h.ms} ms`).join(", ")}`);
  assert.deepEqual(o.log.errors.concat(e.log.errors).map((x) => x.message), [], "no uncaught page errors");
});

// --- A11.2 ---------------------------------------------------------------------

scenario("A11.2 a peer's presence chip shows data-mode=edit while they edit, in one colour that survives a mode change, a reload and the caret overlay", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const w = await world(ctx, { roles: { editor: "editor" }, browsers: [["owner", "owner"], ["editor", "editor"]], title: "A11.2 chip" });
  const ownerEmail = w.ownerAcct.email.toLowerCase();
  const editorEmail = w.people.editor.account.email.toLowerCase();
  const { owner: o, editor: e } = w.users;
  await Promise.all([o.open(w.docId), e.open(w.docId)]);

  const chipNow = (u, email, mode) =>
    eventually(async () => {
      const c = await chipFor(u, email);
      if (!c || c.mode !== mode) throw new Error(`${u.name}'s chip for ${email}: ${JSON.stringify(c)}`);
      return c;
    }, { timeout: 10_000, interval: 200, stableSamples: 2, message: `${u.name} shows ${email} as ${mode}` });

  ctx.step("both reading: each sees the other's chip with data-mode=view and a round dot");
  const viewE = await chipNow(o, editorEmail, "view");
  const viewO = await chipNow(e, ownerEmail, "view");
  ctx.step(`owner sees the editor ${JSON.stringify(viewE)}; editor sees the owner ${JSON.stringify(viewO)}`);
  assert.equal(viewE.editingIcon, false, "a reader's chip carries no Editing icon");

  ctx.step("the editor presses Edit: the owner's chip for them turns data-mode=edit, square dot, Editing icon, the same colour");
  await bothShared(e);
  const editE = await chipNow(o, editorEmail, "edit");
  ctx.step(`owner sees the editor ${JSON.stringify(editE)}`);
  assert.equal(editE.editingIcon, true, "an editor's chip carries the Editing icon");
  assert.notEqual(editE.dotRadius, viewE.dotRadius, `mode is encoded by dot shape: ${viewE.dotRadius} (view) vs ${editE.dotRadius} (edit)`);
  assert.equal(editE.color, viewE.color, "the chip colour is unchanged by the mode change");

  // The caret read here is the bar the overlay draws at the END of a
  // selection (peers.ts). A collapsed caret alone draws nothing: A11.2b.
  ctx.step("the editor selects a passage in #e2e-5: the owner's reading frame draws it, with the caret bar at its end labelled with the editor's address, in the chip's colour");
  await selectIn(e, "e2e-5", "Quill orchard russet");
  const drawn = await eventually(async () => {
    const ov = await overlay(o);
    if (!ov.layer || ov.carets < 1 || !ov.labelColor) throw new Error(JSON.stringify(ov));
    return ov;
  }, { timeout: 10_000, interval: 200, message: "the owner's overlay draws the editor's selection and its caret bar" });
  ctx.step(`overlay: ${JSON.stringify(drawn)}`);
  assert.equal(drawn.labelText, editorEmail, "the caret is labelled with the editor's name");
  assert.equal(drawn.labelColor, editE.color, "the caret label is painted in the chip's colour (one palette)");

  ctx.step("the owner reloads: the editor's chip comes back in edit mode and the same colour");
  await o.page.reload({ waitUntil: "load" });
  await o.waitForFrame();
  const reloaded = await chipNow(o, editorEmail, "edit");
  assert.equal(reloaded.color, viewE.color, "the colour survives the observer's reload");

  // The presence bar lives in the viewer toolbar, which the Formatting toolbar
  // replaces while editing: a peer's chip is seen by someone READING.
  ctx.step("the editor presses Done; reading again, they see the owner's chip as before (view, same colour)");
  await e.done();
  const backO = await chipNow(e, ownerEmail, "view");
  assert.equal(backO.color, viewO.color, "the owner's colour is the same in the editor's bar after the editor's own mode change");

  ctx.step("the owner presses Edit: the editor sees the owner's chip turn data-mode=edit in the owner's unchanged colour");
  await bothShared(o);
  const editO = await chipNow(e, ownerEmail, "edit");
  assert.equal(editO.color, viewO.color, "the owner's colour is unchanged by their mode change");
  assert.equal(editO.editingIcon, true, "the owner's chip carries the Editing icon");
  assert.equal(editO.dotRadius, editE.dotRadius, "the same square dot for every editor");
});

// --- A11.2b (found by A11.2's caret check) ------------------------------------------

/** A user's own selection in its frame: how many ranges, collapsed or not, and whether its anchor sits inside `id`. */
async function ownSelection(user, id) {
  return (await user.frame()).evaluate((i) => {
    const sel = document.getSelection();
    const el = document.getElementById(i);
    const node = sel?.anchorNode ?? null;
    return { ranges: sel?.rangeCount ?? 0, collapsed: sel ? sel.isCollapsed : null, inside: Boolean(el && node && el.contains(node)), text: sel ? sel.toString() : null };
  }, id);
}

/**
 * The peer carets and labels a reader's overlay draws, each caret with
 * whether it lies on `id`'s box. Both boxes are read with
 * getBoundingClientRect, so in the frame's own viewport, however the overlay
 * positions its layer.
 */
async function caretsOver(user, id) {
  return (await user.frame()).evaluate((i) => {
    const layer = document.getElementById("bshd-peers");
    const box = document.getElementById(i)?.getBoundingClientRect() ?? null;
    const carets = layer ? [...layer.querySelectorAll(".bshd-peer-caret")] : [];
    return {
      layer: Boolean(layer),
      labels: layer ? [...layer.querySelectorAll(".bshd-peer-label")].map((l) => l.textContent) : [],
      carets: carets.map((c) => {
        const r = c.getBoundingClientRect();
        const mid = r.top + r.height / 2;
        const on = Boolean(box) && mid >= box.top - 2 && mid <= box.bottom + 2 && r.left >= box.left - 4 && r.left <= box.right + 4;
        return { x: Math.round(r.left), y: Math.round(r.top), h: Math.round(r.height), on };
      }),
    };
  }, id);
}

/**
 * X-a11-live-1, class P. SPEC §16 names the caret apart from the selection
 * five times: spec.md:1477 "the live caret and selection", spec.md:1480
 * "carets carry name labels", spec.md:1488-1489 "per-peer caret bars and
 * selection rectangles", spec.md:1516 "`focus` — selection or caret, as an
 * ephemeral `Anchor`" (updated on `selectionchange`, 200 ms), and spec.md:1575
 * "Peer carets and selections update at 200 ms". The product sends a collapsed
 * caret as no focus at all: anchor.ts:55 describeAnchorFromSelection returns
 * null when `sel.isCollapsed`, and usePeerPresence.ts:95-96 broadcasts that
 * null. spec.md:1521-1523 ("The anchor machinery is reused verbatim. A remote
 * selection is an `Anchor` … `describeAnchorFromSelection` on the sender")
 * describes how a SELECTION travels; it does not withdraw the caret. The harm:
 * a peer who is typing has a collapsed caret, so a reader never sees where
 * anybody types, which is what spec.md:1576-1577 says the channel is for ("the
 * pointer is what the eye tracks, so it has to feel live").
 *
 * Setup cannot be booked as the defect: every step before the oracle is a
 * precondition or a wait whose timeout FAILS, and the control shows a SELECTION
 * travelling the same path to the same reader first. The oracle alone (the
 * focus on the server, the caret in the reader's overlay) is the defect's.
 */
scenario("A11.2b a collapsed caret an editor clicks into a paragraph reaches the server as their focus, and a reader's frame draws it there, labelled", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  ctx.step("SPEC §16 spec.md:1516: \"`focus` — selection or caret, as an ephemeral `Anchor`\" (selectionchange, 200 ms); spec.md:1575: \"Peer carets and selections update at 200 ms\"; spec.md:1480: \"carets carry name labels\"");
  const w = await world(ctx, { roles: { editor: "editor" }, browsers: [["owner", "owner"], ["editor", "editor"]], title: "A11.2b caret" });
  const editorEmail = w.people.editor.account.email.toLowerCase();
  const editorUid = w.people.editor.account.uid;
  precondition(typeof editorUid === "string" && editorUid.length > 0, "the editor's account has a uid");
  const { owner: o, editor: e } = w.users;
  await Promise.all([o.open(w.docId), e.open(w.docId)]);

  ctx.step("the editor presses Edit (Shared); the owner reads, so the owner's frame holds the overlay");
  await bothShared(e);

  ctx.step("control: the editor selects a passage in #e2e-5; it reaches the server as focus, and the owner's overlay draws its caret bar on #e2e-5, labelled with the editor's address");
  await selectIn(e, "e2e-5", "Quill orchard russet");
  // The WHOLE selection, held still: the drag's first step lands at once and
  // the rest 200 ms later (the throttle's trailing call, presence.ts:75-96).
  // That trailing call drops a pending null, so a click inside those 200 ms
  // leaves the drag's first step on the server for good (seen: "Qu" for 10 s).
  // Clicking only after this keeps that apart from the caret's own defect.
  const selFocus = await eventually(async () => {
    const f = await serverFocus(w.docId, editorUid);
    return f?.elementId === "e2e-5" && f.exact === "Quill orchard russet" ? f : false;
  }, { timeout: 10_000, interval: 200, stableSamples: 3, message: "control: the editor's whole selection reaches the server as focus and holds still" });
  const selDrawn = await eventually(async () => {
    const c = await caretsOver(o, "e2e-5");
    return c.carets.some((x) => x.on) && c.labels.includes(editorEmail) ? c : false;
  }, { timeout: 10_000, interval: 200, message: "control: the owner's overlay draws the selection's caret bar on #e2e-5, labelled" });
  ctx.step(`control: focus ${JSON.stringify(selFocus)}; the owner's overlay ${JSON.stringify(selDrawn)}`);

  ctx.step("the editor clicks at the end of #e2e-8 with the real mouse: a collapsed caret, nothing selected");
  const click = await e.clickInFrame("#e2e-8", { where: "end" });
  const mine = await ownSelection(e, "e2e-8");
  precondition(mine.ranges === 1 && mine.collapsed === true && mine.inside, `the editor's own caret is collapsed inside #e2e-8 after the click (${JSON.stringify(mine)})`);
  // The click's selectionchange reached the presence path: the server no
  // longer holds the selection, so what it holds next is the caret's.
  const changed = await eventually(async () => {
    const f = await serverFocus(w.docId, editorUid);
    return isDeepStrictEqual(f, selFocus) ? false : { focus: f };
  }, { timeout: 10_000, interval: 200, message: "the click's selectionchange replaced the selection's focus on the server" });
  ctx.step(`clicked at ${JSON.stringify(click.clickedAt)}; the editor's own selection ${JSON.stringify(mine)}; the server's focus then ${JSON.stringify(changed.focus)}`);

  ctx.step("oracle: within 10 s (the control's bound) the server holds a focus for the caret, and the owner's overlay draws a caret on #e2e-8 labelled with the editor's address");
  const seen = { focus: changed.focus, overlay: null };
  await eventually(async () => {
    seen.focus = await serverFocus(w.docId, editorUid);
    seen.overlay = await caretsOver(o, "e2e-8");
    return seen.focus !== null && seen.overlay.carets.some((x) => x.on) && seen.overlay.labels.includes(editorEmail);
  }, { timeout: 10_000, interval: 200, message: "the caret's focus and its drawing" }).catch((err) => {
    // Only "not there within 10 s" is the oracle's answer; a read that kept
    // throwing (its cause) measured nothing, and FAILS.
    if (err?.code !== "E2E_EVENTUALLY_TIMEOUT" || err.cause) throw err;
  });
  ctx.ev.json("collapsed-caret", { control: { focus: selFocus, overlay: selDrawn }, click: click.clickedAt, own: mine, seen });
  ctx.step(`after the click: focus ${JSON.stringify(seen.focus)}; the owner's overlay ${JSON.stringify(seen.overlay)}`);
  assert.notEqual(seen.focus, null, "X-a11-live-1: a collapsed caret is broadcast as no focus at all, though SPEC §16 spec.md:1516 says `focus` is \"selection or caret, as an ephemeral `Anchor`\" (anchor.ts:55 returns null for a collapsed selection)");
  assert.ok(seen.overlay.carets.some((x) => x.on) && seen.overlay.labels.includes(editorEmail), `X-a11-live-1: the reader's overlay draws no caret on #e2e-8 labelled ${editorEmail} (SPEC §16 spec.md:1575 "Peer carets and selections update at 200 ms", spec.md:1480 "carets carry name labels"): ${JSON.stringify(seen.overlay)}`);
});

// --- A11.3 ---------------------------------------------------------------------

scenario("A11.3 no edit frame ever holds the peer overlay #bshd-peers, though the reading frame beside it draws the editor's caret", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const w = await world(ctx, { roles: { editor: "editor" }, browsers: [["owner", "owner"], ["editor", "editor"]], title: "A11.3 overlay" });
  const editorEmail = w.people.editor.account.email.toLowerCase();
  const { owner: o, editor: e } = w.users;

  ctx.step("the editor edits first and types a token, so a draft exists and the owner (an editor of it) reads the draft");
  await e.open(w.docId);
  await bothShared(e);
  const tok = token("e");
  await e.typeInFrame("#e2e-2", tok);
  await settledSaves(e);
  const draft = await eventually(async () => (await readDoc(target, `docs/${w.docId}`))?.draft ?? false, { timeout: 15_000, message: "a draft record" });
  ctx.step(`draft saved by ${draft.updatedByEmail}`);
  await o.open(w.docId);
  await eventually(async () => ((await paraText(o, "e2e-2")) ?? "").includes(tok), { timeout: 15_000, message: "the owner reads the draft (the token is in its frame)" });
  await selectIn(e, "e2e-6", "Glacier yarrow anchor");

  ctx.step("positive control: the owner's READING frame holds the overlay, with the editor's caret drawn");
  const reading = await eventually(async () => {
    const ov = await overlay(o);
    if (!ov.layer || ov.carets < 1) throw new Error(JSON.stringify(ov));
    return ov;
  }, { timeout: 10_000, interval: 200, message: "the reading frame draws the editor's caret" });
  ctx.step(`reading frame: ${JSON.stringify(reading)}`);
  assert.equal(reading.labelText, editorEmail);

  ctx.step("the owner presses Edit; then each editor selects a passage, and both edit frames are sampled for any trace of the overlay");
  await bothShared(o);
  await selectIn(o, "e2e-9", "Russet pepper slate");
  await selectIn(e, "e2e-12", "Fennel garnet delta");
  // The selections have reached the server before the frames are sampled.
  await eventually(async () => {
    const peers = (await rtdbGet(target, `status/${w.docId}/peers`)) ?? {};
    const focus = Object.values(peers).map((p) => p?.focus?.elementId ?? null).sort();
    if (focus.join() !== ["e2e-12", "e2e-9"].join()) throw new Error(JSON.stringify(focus));
    return focus;
  }, { timeout: 10_000, interval: 200, message: "both selections broadcast (peers/*/focus)" });
  // Delivery to the other browser has no visible sign in an edit frame (that
  // is the point), so the frames are sampled for 3 s after the server has the
  // focus: the positive control above drew a selection well inside that.
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    for (const u of [o, e]) samples.push({ user: u.name, ...(await overlay(u)) });
    await sleep(300);
  }
  ctx.ev.json("edit-frame-samples", samples);
  const editing = samples.filter((s) => s.editable === "true");
  assert.equal(editing.length, samples.length, `every sample was taken in an edit frame: ${JSON.stringify(samples.filter((s) => s.editable !== "true").slice(0, 2))}`);
  const traces = samples.filter((s) => s.layer || s.style || s.marked.length > 0);
  assert.deepEqual(traces, [], "#bshd-peers, #bshd-peer-style and data-bshd=peers|peer-style are absent from every edit frame sample");
});

// --- A11.4 ---------------------------------------------------------------------

scenario("A11.4 follow keeps the reader within 0.02 of the leader's scroll fraction, and the reader's own wheel releases it", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const w = await world(ctx, { roles: { reader: "editor" }, browsers: [["leader", "owner"], ["follower", "reader"]], title: "A11.4 follow" });
  const leaderEmail = w.ownerAcct.email.toLowerCase();
  const { leader: l, follower: f } = w.users;
  await Promise.all([l.open(w.docId), f.open(w.docId)]);

  ctx.step("the leader edits (Shared); the follower reads and presses the leader's chip");
  await bothShared(l);
  const chip = f.page.locator(".presence-bar .presence-chip", { hasText: leaderEmail });
  await chip.waitFor({ state: "visible", timeout: 15_000 });
  await chip.click();
  const following = await eventually(async () => {
    const c = await chipFor(f, leaderEmail);
    if (c?.pressed !== "true") throw new Error(JSON.stringify(c));
    return c;
  }, { timeout: 5_000, message: "the chip is pressed" });
  assert.match(following.title, /^Following .+\. Scroll to stop\.$/, "the chip says the follower is following");
  const max = (await scrollFrac(f)).max;
  precondition(max > 400, `the document scrolls in the follower's frame (max ${max} px)`);

  const tracks = async (label) => {
    const lead = await scrollFrac(l);
    const t0 = Date.now();
    const got = await eventually(async () => {
      const mine = await scrollFrac(f);
      if (Math.abs(mine.frac - lead.frac) > 0.02) throw new Error(`follower ${mine.frac.toFixed(4)} vs leader ${lead.frac.toFixed(4)}`);
      return Number(mine.frac.toFixed(4));
    }, { timeout: 10_000, interval: 100, stableSamples: 3, message: `${label}: the follower is within 0.02 of the leader` });
    ctx.step(`${label}: leader ${lead.frac.toFixed(4)}, follower ${got} after ${Date.now() - t0} ms`);
    return Date.now() - t0;
  };

  ctx.step("the leader wheels down twice; each time the follower's frame lands within 0.02 of the leader's fraction");
  await wheelInFrame(l, 900);
  const lag1 = await tracks("first scroll");
  await wheelInFrame(l, 900);
  const lag2 = await tracks("second scroll");

  ctx.step("the follower wheels in its own frame: the chip is released");
  await wheelInFrame(f, -300);
  await eventually(async () => {
    const c = await chipFor(f, leaderEmail);
    if (c?.pressed !== "false") throw new Error(JSON.stringify(c));
    return true;
  }, { timeout: 5_000, message: "the follower's wheel releases the chip" });
  const parked = await scrollFrac(f);

  ctx.step("the leader scrolls back to the top; once the server has the new viewport, the follower stays where it parked");
  await wheelInFrame(l, -5000);
  const leadTop = await scrollFrac(l);
  const leaderUid = w.owner.uid;
  await eventually(async () => {
    const v = (await serverPeer(w.docId, leaderUid))?.viewport;
    if (typeof v !== "number" || Math.abs(v - leadTop.frac) > 0.005) throw new Error(`viewport ${v}`);
    return v;
  }, { timeout: 10_000, interval: 200, message: "the leader's new viewport reached the server" });
  // Following landed within lag1/lag2 above; three times the slower of them
  // (at least 3 s) is the window in which a still-bound follower would move.
  await sleep(Math.max(3_000, 3 * Math.max(lag1, lag2)));
  const after = await scrollFrac(f);
  ctx.step(`parked at ${parked.frac.toFixed(4)}; after the leader's scroll to ${leadTop.frac.toFixed(4)}: ${after.frac.toFixed(4)}`);
  precondition(Math.abs(parked.frac - leadTop.frac) > 0.1, "the leader's new position is far from where the follower parked");
  assert.ok(Math.abs(after.frac - parked.frac) <= 0.005, `a released follower does not move with the leader (parked ${parked.frac}, now ${after.frac}, leader ${leadTop.frac})`);
});

// --- A11.5 ---------------------------------------------------------------------

scenario("A11.5 a suggester gets no Edit button, never touches the live log from the browser, and is denied a y write with their own ID token", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  await rulesEnforced(ctx);
  const w = await world(ctx, { roles: { suggester: "suggester" }, sessions: ["suggester"], browsers: [["owner", "owner"], ["suggester", "suggester"]], title: "A11.5 suggester" });
  const sug = w.people.suggester;

  ctx.step("control: the owner's browser has an Edit button, joins the log and types; its frames name status/{doc}/y");
  const { owner: o, suggester: s } = w.users;
  await o.open(w.docId);
  const ownerEdit = await o.page.locator('.viewer-toolbar [aria-label="Edit"]').count();
  await bothShared(o);
  await o.typeInFrame("#e2e-3", token("o"));
  await logSettled(w.docId, { min: 2 });

  ctx.step("the suggester signs in and opens the document; the toolbar is complete when its Fork button shows");
  await s.open(w.docId);
  await s.page.locator('.viewer-toolbar [aria-label="Fork"]').first().waitFor({ state: "visible", timeout: 15_000 });
  await o.typeInFrame("#e2e-4", token("o"));
  await eventually(async () => (await chipFor(s, w.ownerAcct.email))?.mode === "edit" || false, { timeout: 10_000, message: "the suggester sees the owner editing (presence works for them)" });
  const editButtons = await s.page.locator('.viewer-toolbar [aria-label="Edit"]').count();

  ctx.step("the suggester's own ID token writes an entry to status/{doc}/y (REST, ?auth=); the owner's identical write is the control");
  const entry = newEntry("s");
  const r = await rtdbFor(ctx, "suggester", sug.session.idToken).put(`status/${w.docId}/y/${entry}`, EMPTY_UPDATE);
  const verdict = rtdbVerdict(r, "the suggester's write");
  const ctl = await rtdbFor(ctx, "owner", w.owner.idToken).put(`status/${w.docId}/y/${newEntry("o")}`, EMPTY_UPDATE);
  precondition(rtdbVerdict(ctl, "the owner's control") === "ALLOW", "control: the owner's identical write is allowed");
  const stored = await rtdbGet(target, `status/${w.docId}/y/${entry}`);

  // User.log.wsFrames: every frame each context sent, from its creation (lib/browser.mjs).
  const sFrames = s.log.wsFrames;
  const oFrames = o.log.wsFrames;
  const sLog = logFrames(sFrames.sent, w.docId);
  const oLog = logFrames(oFrames.sent, w.docId);
  ctx.step(`suggester: Edit buttons ${editButtons}; y write ${verdict}; frames naming the log ${sLog.length} of ${sFrames.total.sent} sent (${sFrames.dropped.sent} dropped). Owner: frames naming the log ${oLog.length}`);
  precondition(ownerEdit === 1, "control: the owner's reading toolbar has an Edit button, found by the same selector");
  precondition(oLog.length > 0, "control: the owner's browser frames name status/{doc}/y, so a frame that did would be seen");
  precondition(sFrames.total.sent > 0, "the suggester's browser talks to the database (presence)");
  precondition(sFrames.dropped.sent === 0, `every frame the suggester's browser sent is still in the log (${sFrames.dropped.sent} dropped)`);
  assert.equal(editButtons, 0, "the suggester has no Edit button");
  assert.deepEqual(sLog.map((f) => f.slice(0, 200)), [], "the suggester's browser never listens to or writes status/{doc}/y");
  assert.equal(verdict, "DENY", "the suggester's y write is refused by the rules");
  assert.equal(stored, null, "nothing was written");
});

// --- A11.6 ---------------------------------------------------------------------

/** A viewer may see peers but not an editor's unsaved draft bytes (SPEC §16). */
scenario("A11.6 a viewer may not read the live log status/{doc}/y, which holds an editor's unsaved keystrokes: DENY", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  await rulesEnforced(ctx);
  const w = await world(ctx, { roles: { viewer: "viewer", stranger: null }, sessions: ["viewer", "stranger"], browsers: [["owner", "owner"]], title: "A11.6 viewer" });
  const viewer = w.people.viewer;

  ctx.step("the owner edits live and inserts a secret token in one input (one update), into #e2e-6");
  const o = w.users.owner;
  await o.open(w.docId);
  await bothShared(o);
  const secret = token("sec");
  await caretAt(o, "e2e-6");
  await o.page.keyboard.insertText(secret);
  const entries = await eventually(async () => {
    const all = await logEntries(w.docId);
    return logContains(all, secret) ? all : false;
  }, { timeout: 10_000, message: "the secret is in the live log" });
  ctx.step(`the live log holds ${Object.keys(entries).length} entries, one of them carrying the secret`);

  ctx.step("controls: the owner reads the log and sees the secret; a signed-in stranger is refused");
  const own = await rtdbFor(ctx, "owner", w.owner.idToken).get(`status/${w.docId}/y`);
  precondition(rtdbVerdict(own, "the owner's read") === "ALLOW" && logContains(own.json ?? {}, secret), "control: the owner's read returns the secret");
  const str = await rtdbFor(ctx, "stranger", w.people.stranger.session.idToken).get(`status/${w.docId}/y`);
  precondition(rtdbVerdict(str, "the stranger's read") === "DENY", "control: the rules are enforced (a stranger's read is refused)");

  ctx.step("the viewer reads status/{doc}/y with their own ID token");
  const r = await rtdbFor(ctx, "viewer", viewer.session.idToken).get(`status/${w.docId}/y`);
  const verdict = rtdbVerdict(r, "the viewer's read");
  const sees = verdict === "ALLOW" && logContains(r.json ?? {}, secret);
  const draft = await viewer.session.http.get(`/draft/${encodeURIComponent(w.docId)}/index.html`);
  ctx.step(`viewer: ${r.status} → ${verdict}; decodes the editor's secret from it: ${sees}. For contrast GET /draft as the viewer: ${draft.status} (SPEC §2 spec.md:329-332: editor-gated, a refused reader gets 404)`);
  ctx.ev.json("viewer-read", { verdict, entries: Object.keys(r.json ?? {}).length, seesSecret: sees, draftStatus: draft.status });
  precondition(draft.status === 403 || draft.status === 404, `GET /draft refuses the viewer (got ${draft.status})`);
  assert.equal(verdict, "DENY", `a viewer read the live log${sees ? ", the editor's unsaved typed secret included" : ""}; shared draft reads require editAccess (SPEC §16)`);
});

// --- A11.7 ---------------------------------------------------------------------

/** I3 in a user's frame: how many sentinels, and how many top-level elements that are not the app's. */
async function i3(user) {
  return (await user.frame()).evaluate(() => ({
    sentinels: document.querySelectorAll('[id="e2e-sentinel"]').length,
    top: [...document.body.children].filter((el) => !el.hasAttribute("data-bshd") && !el.id.startsWith("bshd-")).length,
  }));
}

scenario("A11.7 a non-member joining a public open-editing document while a member edits leaves one sentinel and receives the member's keys", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  await rulesEnforced(ctx);
  const w = await world(ctx, { roles: { openeditor: null }, browsers: [["owner", "owner"], ["openeditor", "openeditor"]], title: "A11.7 open editing", visibility: "public", publicEdit: true });
  const pe = w.people.openeditor;
  const [presence, edit] = await Promise.all([rtdbGet(target, `presenceAccess/${w.docId}`), rtdbGet(target, `editAccess/${w.docId}`)]);
  precondition((edit ?? {})["*"] === true, `editAccess/${w.docId}/* is set for a public open-editing document: ${JSON.stringify(edit)}`);
  precondition(!(presence ?? {})[emailKey(pe.account.email)], "the open editor is not a member (no presenceAccess entry)");

  ctx.step("the owner edits live (Shared) and types a token into #e2e-7");
  const { owner: o, openeditor: p } = w.users;
  await o.open(w.docId);
  await bothShared(o);
  const base8 = await paraText(o, "e2e-8");
  const t1 = token("o");
  await o.typeInFrame("#e2e-7", t1);
  const before = await logSettled(w.docId, { min: 2 });
  ctx.step(`the live log holds ${before.length} entries before the open editor arrives`);

  ctx.step("the open editor signs in, opens the public document, presses Edit");
  await p.open(w.docId);
  precondition((await p.page.locator('.viewer-toolbar [aria-label="Edit"]').count()) === 1, "open editing gives the non-member an Edit button");
  const joined = await p.enterEdit({ waitShared: false });
  ctx.step(`the open editor's share-state: ${joined.share}`);

  ctx.step("after the join, the owner types a second token into #e2e-8; the log is let settle");
  const t2 = token("o");
  await o.typeInFrame("#e2e-8", t2);
  const settled = await logSettled(w.docId, { min: before.length + 1 });
  const added = settled.filter((k) => !before.includes(k));
  ctx.step(`the log grew by ${added.length} entries`);

  const found = {};
  const failures = [];
  const ownerI3 = await eventually(() => i3(o), { timeout: 5_000, interval: 250, stableSamples: 3, message: "owner I3 stable" });
  found.ownerI3 = ownerI3;
  if (ownerI3.sentinels !== 1 || ownerI3.top !== FIXTURE_TOP) failures.push(`I3 in the member's frame: ${ownerI3.sentinels} sentinels, ${ownerI3.top} top-level elements (want 1 and ${FIXTURE_TOP})`);
  const peI3 = await i3(p);
  found.openEditorI3 = peI3;
  if (peI3.sentinels !== 1 || peI3.top !== FIXTURE_TOP) failures.push(`I3 in the open editor's frame: ${peI3.sentinels} sentinels, ${peI3.top} top-level elements`);
  try {
    await waitText(p, { "e2e-8": base8 + t2 }, { what: "the open editor receives the member's token typed after the join" });
    found.receivedT2 = true;
  } catch (err) {
    found.receivedT2 = false;
    failures.push(`the open editor never received ${t2} typed by the member after the join: #e2e-8 ends ${JSON.stringify((await paraText(p, "e2e-8"))?.slice(-40))}`);
  }
  found.t1InOpenEditor = ((await paraText(p, "e2e-7")) ?? "").includes(t1);
  // The harm, for the record: what the member's autosave keeps.
  await settledSaves(o).catch(() => undefined);
  const saved = await w.owner.http.get(`/draft/${encodeURIComponent(w.docId)}/index.html`);
  found.draftSentinels = saved.status === 200 ? saved.text.split('id="e2e-sentinel"').length - 1 : `GET /draft ${saved.status}`;
  ctx.ev.json("found", found);
  ctx.step(`found: ${JSON.stringify(found)}`);
  await ctx.oracle(() => assert.deepEqual(failures, [], "one sentinel on every peer, and the open editor merged live with the member (S27)"));
});

// --- A11.7b (found by A11.7's positive control) -------------------------------------

scenario("A11.7b sharing a public open-editing document with someone keeps editAccess/*, so open editors may still write the live log", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  await rulesEnforced(ctx);
  ctx.step("SPEC §16: \"A public open-editing document also carries the key `*`: any verified account.\" presence.ts: the mirror is refreshed by every path that recomputes members");
  const w = await world(ctx, { roles: { openeditor: null, colleague: null }, sessions: ["openeditor"], title: "A11.7b open editing after a share", visibility: "public", publicEdit: true });
  const pe = w.people.openeditor;
  const db = rtdbFor(ctx, "openeditor", pe.session.idToken);
  const star = async () => ((await rtdbGet(target, `editAccess/${w.docId}`)) ?? {})["*"] === true;
  precondition(await star(), "before the share, editAccess/* is set (POST /visibility wrote it)");
  const before = rtdbVerdict(await db.put(`status/${w.docId}/y/${newEntry("pe")}`, EMPTY_UPDATE), "the open editor's write before the share");
  precondition(before === "ALLOW", "control: before the share, the open editor's own ID token writes the live log");

  ctx.step("the owner shares the document with a colleague as a viewer (a membership change, nothing about visibility)");
  const g = await share(target, { owner: w.owner, doc: w.docId, account: w.people.colleague.account, role: "viewer" });
  precondition(g.status === 200 && g.mirror?.ok, `shared with the colleague; mirror ${JSON.stringify(g.mirror)}`);
  const rec = await readDoc(target, `docs/${w.docId}`);
  precondition(rec?.visibility === "public" && rec?.publicEdit === true, `the document is still public with open editing (${rec?.visibility}, publicEdit ${rec?.publicEdit})`);

  const after = await star();
  const write = rtdbVerdict(await db.put(`status/${w.docId}/y/${newEntry("pe")}`, EMPTY_UPDATE), "the open editor's write after the share");
  ctx.step(`after the share: editAccess/* ${after}; the open editor's log write ${write}; editAccess = ${JSON.stringify(Object.keys((await rtdbGet(target, `editAccess/${w.docId}`)) ?? {}))}`);
  assert.deepEqual({ star: after, write }, { star: true, write: "ALLOW" }, "a share leaves a public open-editing document open to every verified account in the live log");
});

// --- A11.8 ---------------------------------------------------------------------

scenario("A11.8 an unlisted open-editing link holder in the editor is not shown as Shared, or receives a member's probe keystroke within 2 s", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  // The link holder's browser meets the rules as any client does: what it may
  // join live is only what it would meet in production where they are loaded.
  await rulesEnforced(ctx);
  const w = await world(ctx, { roles: { linkeditor: null }, browsers: [["owner", "owner"], ["linkeditor", "linkeditor"]], title: "A11.8 unlisted open editing", visibility: "unlisted", publicEdit: true });
  precondition(typeof w.linkToken === "string" && w.linkToken.length >= 22, "an unlisted document has a link token");
  const edit = (await rtdbGet(target, `editAccess/${w.docId}`)) ?? {};
  precondition(edit["*"] !== true, `an unlisted open-editing document never carries editAccess/* (SPEC §16): ${JSON.stringify(edit)}`);

  ctx.step("the owner edits live (Shared)");
  const { owner: o, linkeditor: p } = w.users;
  await o.open(w.docId);
  await bothShared(o);

  ctx.step("the link holder signs in, opens the link with its key, presses Edit");
  await p.open(w.docId, { k: w.linkToken });
  precondition((await p.page.locator('.viewer-toolbar [aria-label="Edit"]').count()) === 1, "open editing gives the link holder an Edit button");
  const joined = await p.enterEdit({ waitShared: false });
  const badge = await shareBadge(p);
  ctx.step(`the link holder's share-state: ${joined.share}; badge ${JSON.stringify(badge)}`);

  ctx.step("the link holder types a token into #e2e-9; it reaches the draft through POST /draft (SPEC §16: they edit through /draft)");
  const tp = token("l");
  await p.typeInFrame("#e2e-9", tp);
  const save = await eventually(() => p.log.requests.find((r) => r.method === "POST" && new URL(r.url).pathname === "/draft") ?? false, { timeout: AUTOSAVE_MS, interval: 250, message: "the link holder's autosave posts /draft" });
  precondition(save.status === 200, `the link holder's POST /draft answered ${save.status}`);
  const drafted = await w.owner.http.get(`/draft/${encodeURIComponent(w.docId)}/index.html`);
  precondition(drafted.status === 200 && drafted.text.includes(tp), "the link holder's token is in the draft");

  ctx.step("the member types a probe token into #e2e-10; I13 asks whether a peer shown as Shared receives it within 2 s");
  const probe = token("o");
  await armArrival(p, "e2e-10", probe);
  const t0 = Date.now();
  await o.typeInFrame("#e2e-10", probe);
  // 2 s from the end of the typing; the time is taken in the link holder's page.
  let received = null;
  try {
    received = (await waitForArrival(p, probe, { timeout: 2_000 + (Date.now() - t0) })).at;
  } catch (err) {
    // Only "it did not come" is an answer; an unarmed or replaced probe measured nothing.
    if (err.code !== "E2E_ARRIVAL" || err.reason !== "timeout") throw err;
    received = null;
  }
  const shownShared = joined.share === "shared" || badge?.state === "shared";
  ctx.step(`shown as Shared: ${shownShared}; probe received: ${received ? `${received - t0} ms after typing began` : "no"}`);
  assert.ok(!shownShared || received !== null, "the link holder is shown as Shared but does not receive the member's keystrokes (S24: not merged live)");
  assert.notEqual(badge?.state, "joining", "the link holder's editor is not stuck joining");
});

// --- A11.9 ---------------------------------------------------------------------

scenario("A11.9 an editor revoked mid-edit can no longer write the live log, and POST /draft answers 404", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  await rulesEnforced(ctx);
  const w = await world(ctx, { roles: { editor: "editor" }, sessions: ["editor"], browsers: [["owner", "owner"], ["editor", "editor"]], title: "A11.9 revoked" });
  const ed = w.people.editor;
  const { owner: o, editor: e } = w.users;
  await Promise.all([o.open(w.docId), e.open(w.docId)]);
  await bothShared(o, e);
  const base11 = await paraText(o, "e2e-11");

  ctx.step("before: the editor's token reaches the owner live");
  const t1 = token("e");
  await e.typeInFrame("#e2e-11", t1);
  await waitText(o, { "e2e-11": base11 + t1 }, { what: "the owner receives the editor's token" });
  await settledSaves(o, e);

  ctx.step("control: before the revocation the editor's own ID token may write a log entry (the same request as after it)");
  const db = rtdbFor(ctx, "revoked", ed.session.idToken);
  const pre = await db.put(`status/${w.docId}/y/${newEntry("e")}`, EMPTY_UPDATE);
  precondition(rtdbVerdict(pre, "the editor's write before the revocation") === "ALLOW", "control: the editor's token writes the log before the revocation");

  ctx.step("the owner removes the editor (POST /access remove); both mirrors drop them");
  const rm = await unshare(target, { owner: w.owner, doc: w.docId, account: ed.account });
  precondition(rm.status === 200, `POST /access remove answered ${rm.status}`);
  const key = emailKey(ed.account.email);
  await eventually(async () => {
    const [p, x] = await Promise.all([rtdbGet(target, `presenceAccess/${w.docId}/${key}`), rtdbGet(target, `editAccess/${w.docId}/${key}`)]);
    if (p !== null || x !== null) throw new Error(`presenceAccess ${p}, editAccess ${x}`);
    return true;
  }, { timeout: 10_000, message: "the revoked editor's mirror entries are gone" });

  ctx.step("REST: the revoked editor's own ID token writes a log entry; the owner's identical write is the control");
  const entry = newEntry("e");
  const r = await db.put(`status/${w.docId}/y/${entry}`, EMPTY_UPDATE);
  const verdict = rtdbVerdict(r, "the revoked editor's write");
  const ctl = await rtdbFor(ctx, "owner", w.owner.idToken).put(`status/${w.docId}/y/${newEntry("o")}`, EMPTY_UPDATE);
  precondition(rtdbVerdict(ctl, "the owner's control") === "ALLOW", "control: the owner's identical write is allowed");

  ctx.step("HTTP: the revoked editor's session posts /draft; the owner's identical post is the control");
  const html = `<p>a11.9 ${rand4()}</p>`;
  const d = await ed.session.http.postJson("/draft", { docId: w.docId, baseVersion: "v1", html });
  const dctl = await w.owner.http.postJson("/draft", { docId: w.docId, baseVersion: "v1", html });
  precondition(dctl.status === 200, `control: the owner's identical POST /draft answered ${dctl.status}`);

  ctx.step("browser: the revoked editor, still in the editor, types a token; its autosave and its log writes must all be refused");
  const before = Object.keys(await logEntries(w.docId)).sort();
  const reqMark = e.log.requests.length;
  const t2 = token("e");
  await e.typeInFrame("#e2e-12", t2);
  const save = await eventually(() => e.log.requests.slice(reqMark).find((q) => q.method === "POST" && new URL(q.url).pathname === "/draft") ?? false, { timeout: AUTOSAVE_MS, interval: 250, message: "the revoked editor's autosave posts /draft" });
  const afterKeys = Object.keys(await logEntries(w.docId)).sort();
  const grew = afterKeys.filter((k) => !before.includes(k));
  const ownerSees = ((await paraText(o, "e2e-12")) ?? "").includes(t2);
  ctx.step(`REST write ${verdict}; POST /draft ${d.status}; browser autosave ${save.status}; log entries added while the revoked editor typed: ${grew.length}; the owner sees the token: ${ownerSees}`);

  assert.equal(verdict, "DENY", "the revoked editor's log write is refused");
  assert.equal(await rtdbGet(target, `status/${w.docId}/y/${entry}`), null, "nothing was written");
  assert.equal(d.status, 404, "POST /draft refuses the revoked editor with 404");
  assert.equal(save.status, 404, "the revoked editor's own browser autosave gets 404");
  assert.deepEqual(grew, [], "none of the revoked editor's keystrokes entered the live log");
  assert.equal(ownerSees, false, "the owner never receives the revoked editor's token");
});

// --- A11.10 --------------------------------------------------------------------

scenario("A11.10 closing an editor's tab removes their peer node and their chip within 5 s", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  const w = await world(ctx, { roles: { editor: "editor" }, browsers: [["owner", "owner"], ["editor", "editor"]], title: "A11.10 disconnect" });
  const ed = w.people.editor;
  const { owner: o, editor: e } = w.users;
  await Promise.all([o.open(w.docId), e.open(w.docId)]);
  // The owner READS: the presence bar is in the viewer toolbar, which the
  // Formatting toolbar replaces while editing.
  await bothShared(e);

  ctx.step("both peer nodes exist (the editor's in edit mode), and the reading owner shows the editor's chip");
  const nodes = await eventually(async () => {
    const peers = (await rtdbGet(target, `status/${w.docId}/peers`)) ?? {};
    const modes = presenceModes(peers);
    if (modes[w.owner.uid] !== "view" || modes[ed.account.uid] !== "edit") throw new Error(JSON.stringify(modes));
    return modes;
  }, { timeout: 10_000, message: "both peers present" });
  ctx.step(`peers: ${JSON.stringify(nodes)}`);
  await eventually(async () => (await chipFor(o, ed.account.email))?.mode === "edit" || false, { timeout: 10_000, message: "the owner shows the editor's chip" });

  ctx.step("the editor's tab is closed");
  const t0 = Date.now();
  await e.page.close();
  let goneAt = null;
  let chipGoneAt = null;
  await eventually(async () => {
    if (goneAt === null && (await serverPeer(w.docId, ed.account.uid)) === null) goneAt = Date.now() - t0;
    if (chipGoneAt === null && (await chipFor(o, ed.account.email)) === null) chipGoneAt = Date.now() - t0;
    return goneAt !== null && chipGoneAt !== null;
  }, { timeout: 15_000, interval: 100, message: "the peer node and the chip are gone" }).catch(() => undefined);
  const ownerNode = await serverPeer(w.docId, w.owner.uid);
  ctx.step(`peer node gone after ${goneAt ?? "never (15 s)"} ms; chip gone after ${chipGoneAt ?? "never (15 s)"} ms; the owner's own node: ${ownerNode?.mode}`);
  assert.equal(ownerNode?.mode, "view", "the owner's node is untouched");
  assert.ok(goneAt !== null && goneAt <= 5_000, `the closed tab's peer node is removed within 5 s (took ${goneAt ?? "more than 15 000"} ms)`);
  assert.ok(chipGoneAt !== null && chipGoneAt <= 5_000, `the closed tab's chip disappears within 5 s (took ${chipGoneAt ?? "more than 15 000"} ms)`);
});

// --- A11.11 --------------------------------------------------------------------

scenario("A11.11 with a live session running, the rules reject lock and requests nodes, unknown keys and fields, another account's peer key, a client lastChanged, an out-of-range viewport and a non-string or oversized log entry", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  await rulesEnforced(ctx);
  const w = await world(ctx, { roles: { editor: "editor" }, sessions: ["editor"], browsers: [["owner", "owner"]], title: "A11.11 rules" });
  const ed = w.people.editor;
  const edEmail = ed.account.email.toLowerCase();

  ctx.step("the owner is live in the editor (Shared), so a real peer node and a real log exist");
  const o = w.users.owner;
  await o.open(w.docId);
  await bothShared(o);
  const ownerNode = await eventually(async () => (await serverPeer(w.docId, w.owner.uid)) ?? false, { timeout: 10_000, message: "the owner's peer node" });
  const logBefore = Object.keys(await logEntries(w.docId)).sort();

  const db = rtdbFor(ctx, "editor", ed.session.idToken);
  const now = { ".sv": "timestamp" };
  const peer = { email: edEmail, mode: "edit", lastChanged: now };
  const mine = `status/${w.docId}/peers/${ed.session.uid}`;
  const cells = [
    ["the withdrawn lock node", `status/${w.docId}/lock`, { uid: ed.session.uid, email: edEmail, since: now }],
    ["the withdrawn requests node", `status/${w.docId}/requests/${ed.session.uid}`, { email: edEmail, at: now }],
    ["a key under status/{doc} the schema does not name", `status/${w.docId}/meta`, { note: "x" }],
    ["a peer field the schema does not name", mine, { ...peer, cursor: "x" }],
    ["a focus field the schema does not name", mine, { ...peer, focus: { exact: "Paragraph", color: "red" } }],
    ["a client-chosen lastChanged", mine, { ...peer, lastChanged: Date.now() - 60_000 }],
    ["a mode that is neither view nor edit", mine, { ...peer, mode: "lock" }],
    ["an email that is not the caller's", mine, { ...peer, email: w.ownerAcct.email.toLowerCase() }],
    ["another account's peer key", `status/${w.docId}/peers/${ownerNode.key}`, { ...peer, uid: ed.session.uid }],
    ["a viewport outside 0..1", mine, { ...peer, viewport: 1.5 }],
    ["a log entry that is not a string", `status/${w.docId}/y/${newEntry("n")}`, 12345],
    ["a log entry over 200 000 characters", `status/${w.docId}/y/${newEntry("big")}`, "A".repeat(200_004)],
  ];
  const got = [];
  for (const [what, path, value] of cells) {
    got.push({ what, verdict: rtdbVerdict(await db.put(path, value), what) });
  }
  ctx.step(`malformed writes: ${got.map((g) => `${g.what} → ${g.verdict}`).join("; ")}`);

  ctx.step("controls: a well-formed peer node with the server's timestamp, and a string log entry, both allowed");
  const okPeer = rtdbVerdict(await db.put(mine, peer), "the well-formed peer");
  const okEntry = newEntry("ok");
  const okLog = rtdbVerdict(await db.put(`status/${w.docId}/y/${okEntry}`, EMPTY_UPDATE), "the well-formed entry");
  const stored = (await rtdbGet(target, `status/${w.docId}`)) ?? {};
  const logAfter = Object.keys(stored.y ?? {}).sort();
  const badge = await shareBadge(o);
  ctx.ev.json("verdicts", { got, okPeer, okLog });
  ctx.step(`well-formed peer ${okPeer}, entry ${okLog}; status keys ${JSON.stringify(Object.keys(stored).sort())}; owner badge ${JSON.stringify(badge)}`);

  assert.equal(okPeer, "ALLOW", "control: a well-formed peer node is allowed");
  assert.equal(okLog, "ALLOW", "control: a string log entry is allowed");
  assert.deepEqual(got.filter((g) => g.verdict !== "DENY").map((g) => g.what), [], "every malformed write is rejected");
  assert.deepEqual(Object.keys(stored).sort(), ["peers", "y"], "nothing but peers and y exists under status/{doc}");
  assert.deepEqual(Object.keys(stored.peers).sort(), [ownerNode.key, ed.session.uid].sort(), "only the two callers' own peer nodes exist");
  assert.deepEqual(
    { email: stored.peers[ownerNode.key].email, mode: stored.peers[ownerNode.key].mode },
    { email: ownerNode.email, mode: "edit" },
    "nobody overwrote the owner's live node",
  );
  assert.deepEqual(Object.keys(stored.peers[ed.session.uid]).sort(), ["email", "lastChanged", "mode"], "the editor's node holds exactly the fields written");
  assert.deepEqual(logAfter.filter((k) => !logBefore.includes(k)), [okEntry], "the only entry added to the log is the well-formed one");
  assert.deepEqual(badge, { state: "shared", text: "Shared" }, "the live session is still Shared");
});

scenario("A11.11b a reader can announce view but cannot claim editing or remove another session", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  await rulesEnforced(ctx);
  const w = await world(ctx, { roles: { editor: "editor", reader: "viewer" }, sessions: ["editor", "reader"], title: "A11.11b presence authority" });
  const editor = w.people.editor.session, reader = w.people.reader.session;
  const editDb = rtdbFor(ctx, "editor", editor.idToken), readDb = rtdbFor(ctx, "reader", reader.idToken);
  const body = (person, email, mode) => ({ uid: person.uid, email: email.toLowerCase(), mode, lastChanged: { ".sv": "timestamp" } });
  const own = `status/${w.docId}/peers/reader-session`, other = `status/${w.docId}/peers/editor-session`;
  const view = body(reader, w.people.reader.account.email, "view");
  const edit = body(editor, w.people.editor.account.email, "edit");
  assert.equal(rtdbVerdict(await readDb.put(own, view), "reader view"), "ALLOW", "reader view presence remains allowed");
  assert.equal(rtdbVerdict(await editDb.put(other, edit), "editor edit"), "ALLOW", "editor edit presence remains allowed");
  assert.equal(rtdbVerdict(await readDb.put(own, { ...view, mode: "edit" }), "reader edit"), "DENY", "a reader cannot claim editing to veto publishing");
  assert.equal(rtdbVerdict(await readDb.delete(other), "another session delete"), "DENY", "a reader cannot remove another session");
  assert.equal(rtdbVerdict(await readDb.delete(own), "own session delete"), "ALLOW", "a reader can remove its own session");
  assert.deepEqual(await rtdbGet(target, `status/${w.docId}/peers`), { "editor-session": { ...edit, lastChanged: (await rtdbGet(target, other)).lastChanged } }, "only the editor's untouched session remains");
});

// --- A11.12 --------------------------------------------------------------------

/**
 * The frame's body as the wire carries it, and the edit-mode decoration on it.
 *
 * `document`: body.outerHTML of a CLONE with `data-bshd-empty` removed. That
 * attribute is the editor's outline of a container a script fills (SPEC §6a),
 * set by placeholders.ts when edit mode starts and, by design, never put on
 * the wire: binding.ts:108 drops it from the seed, and sync.ts:156 and :221
 * from every later DOM-to-CRDT write (INJECTED_ATTRS, ADR 0010's fourth
 * containment path); it is decoration, not document.
 * Nothing else is taken out. `outlined`: the ids carrying it, in order.
 */
async function bodyOuter(user) {
  return (await user.frame()).evaluate(() => {
    const outlined = [...document.body.querySelectorAll("[data-bshd-empty]")].map((el) => el.id);
    const clone = document.body.cloneNode(true);
    for (const el of clone.querySelectorAll("[data-bshd-empty]")) el.removeAttribute("data-bshd-empty");
    return { document: clone.outerHTML, outlined };
  });
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return { at: i, a: a.slice(Math.max(0, i - 80), i + 120), b: b.slice(Math.max(0, i - 80), i + 120) };
}

/** The owner's document `body` published as v1 and shared with `editor` for editing. */
async function publishShared(owner, editor, { body, filename = "index.html", title, name }) {
  const up = await publish(owner.http, { body, filename, title: `${title} ${runTag(target.runId)}-${rand4()}`, name });
  precondition(up.status === 200 && up.versionId === "v1", `${title}: published v1 (${up.status})`);
  const g = await share(target, { owner, doc: up.docId, account: editor, role: "editor" });
  precondition(g.status === 200 && g.mirror?.ok, `${title}: shared with the editor; mirror ${JSON.stringify(g.mirror)}`);
  return up.docId;
}

scenario("A11.12 joining a live session with no edits rebuilds the body byte-identical (outerHTML) for H, B, M, D and Q", { tiers: ["local", "prod"], timeoutMs: ROUND_TRIP_MS, ...ON_STACK }, async (ctx) => {
  const accounts = await cast(target, ["owner", "editor"], { notifications: false });
  const owner = await openSession(target, accounts[0]);
  const [o, e, docIds] = await Promise.all([
    browserUser(ctx, "owner", accounts[0]),
    browserUser(ctx, "editor", accounts[1]),
    Promise.all(ROUND_TRIP.map(([letter, sample]) => {
      const s = readSample(target, sample);
      return publishShared(owner, accounts[1], { body: s.bytes, filename: s.filename, title: `A11.12 ${letter}`, name: `a11-rt-${letter.toLowerCase()}` });
    })),
  ]);
  const results = [];
  for (const [i, [letter, sample]] of ROUND_TRIP.entries()) {
    const up = { docId: docIds[i] };
    ctx.step(`${letter} (${sample}, ${up.docId}): both open it; the owner opens the editor first and seeds the log from the authored DOM`);
    await Promise.all([o.open(up.docId), e.open(up.docId)]);
    await bothShared(o);
    const seeded = await logSettled(up.docId, { min: 1 });
    ctx.step(`${letter}: the log holds ${seeded.length} entr${seeded.length === 1 ? "y" : "ies"} after the seed`);

    ctx.step(`${letter}: the editor joins with no edits, so its body is rebuilt from the wire`);
    await bothShared(e);
    const joined = await logSettled(up.docId, { min: 1 });
    const [os, es] = await Promise.all([bodyOuter(o), bodyOuter(e)]);
    const [ob, eb] = [os.document, es.document];
    const r = { letter, sample, docId: up.docId, seedEntries: seeded.length, entriesAfterJoin: joined.length, equal: ob === eb, ownerBytes: ob.length, editorBytes: eb.length, outlined: { owner: os.outlined, editor: es.outlined } };
    if (!r.equal) {
      r.diff = firstDiff(ob, eb);
      ctx.ev.text(`${letter}-owner-body.html`, ob);
      ctx.ev.text(`${letter}-editor-body.html`, eb);
    }
    results.push(r);
    ctx.step(`${letter}: ${r.equal ? "identical" : `DIFFERENT at ${r.diff.at}`} (${ob.length} vs ${eb.length} chars); log entries ${seeded.length} → ${joined.length}; outlined containers: seeder ${JSON.stringify(os.outlined)}, joiner ${JSON.stringify(es.outlined)}`);
    precondition(joined.length === seeded.length, `${letter}: the joiner adopted the log and wrote nothing to it (${seeded.length} → ${joined.length} entries)`);
    await Promise.all([o.done(), e.done()]);
  }
  ctx.ev.json("round-trip", results);
  assert.deepEqual(results.filter((r) => !r.equal).map((r) => ({ letter: r.letter, at: r.diff.at, owner: r.diff.a, editor: r.diff.b })), [], "every sample's body is byte-identical on the seeder and the joiner");
});

// --- A11.12b (found by A11.12) ----------------------------------------------------

/** A container left empty for the document's own script to fill, which the editor outlines (placeholders.ts). */
const OUTLINE_DOC = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>A11.12b outline</title></head>
<body>
<h1 id="a11-title">Outlined containers</h1>
<div id="a11-filled-by-script"></div>
<p id="a11-text">A paragraph the script does not touch.</p>
<script>document.getElementById("a11-filled-by-script").textContent = "filled when it is read";</script>
</body>
</html>
`;

/**
 * X-a11-live-2, class P: SPEC §6a spec.md:732-735 "Containers the author left
 * empty for their script to fill are outlined in edit mode. Marking is an
 * **attribute** (`data-bshd-empty`) plus one injected stylesheet".
 *
 * The mechanism is that the joiner never re-marks after the adopt.
 * useInlineEditor.ts:136 runs markGeneratedContainers once, synchronously, on
 * the body the frame loaded. useSharedDocument.ts:69-72 binds only after the
 * log is ready, and when the log already holds the document, sync.ts:272-281
 * (the adopt branch) replaces the body with host.replaceChildren(materialise
 * (...)). materialise (sync.ts:61-81) copies every attribute the wire carries,
 * and the wire rightly carries no data-bshd-empty (binding.ts:108 drops it at
 * the seed, as ADR 0010's containment requires), so nothing outlines the
 * rebuilt containers. The fix re-marks the joiner's body after the adopt; it
 * must never put the attribute on the wire.
 */
scenario("A11.12b a joiner's edit frame outlines the containers the document's script fills, as the seeder's does", { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...ON_STACK }, async (ctx) => {
  ctx.step("SPEC §6a: generated containers remain outlined after shared-body adoption; the wire carries no placeholder marker");
  const accounts = await cast(target, ["owner", "editor"], { notifications: false });
  const owner = await openSession(target, accounts[0]);
  const [o, e, docId] = await Promise.all([
    browserUser(ctx, "owner", accounts[0]),
    browserUser(ctx, "editor", accounts[1]),
    publishShared(owner, accounts[1], { body: Buffer.from(OUTLINE_DOC), title: "A11.12b outline", name: "a11-outline" }),
  ]);
  const up = { docId };

  ctx.step("both open it; the owner opens the editor first (seeds); the editor joins with no edits");
  await Promise.all([o.open(up.docId), e.open(up.docId)]);
  await bothShared(o);
  const seeded = await logSettled(up.docId, { min: 1 });
  await bothShared(e);
  const joined = await logSettled(up.docId, { min: 1 });
  precondition(joined.length === seeded.length, `the joiner adopted the log (${seeded.length} → ${joined.length} entries)`);
  const [os, es] = await Promise.all([bodyOuter(o), bodyOuter(e)]);
  precondition(os.document === es.document, "the document itself round-tripped identical (A11.12)");
  precondition(os.outlined.join() === "a11-filled-by-script", `the seeder's edit frame outlines the container the script fills (${JSON.stringify(os.outlined)})`);
  const styled = await (await e.frame()).evaluate(() => Boolean(document.getElementById("bshd-edit-placeholders")));
  ctx.step(`outlined: seeder ${JSON.stringify(os.outlined)}; joiner ${JSON.stringify(es.outlined)} (the joiner's frame still has the outline stylesheet: ${styled})`);
  ctx.ev.json("outlined", { seeder: os.outlined, joiner: es.outlined, joinerHasStylesheet: styled });
  assert.deepEqual(es.outlined, os.outlined, "X-a11-live-2: the joiner's edit frame does not outline the script-filled containers the seeder's does (SPEC §6a spec.md:732-733 \"outlined in edit mode\"): the joiner never re-marks after the adopt replaces its body (useInlineEditor.ts:136 marks once; sync.ts:272-281 adopts)");
});
