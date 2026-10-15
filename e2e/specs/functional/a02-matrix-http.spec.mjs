// SPDX-License-Identifier: Apache-2.0
// A2 permission matrix over HTTP and MCP: every actor against c1–c5 and c9–c16, 404 parity with an absent id, MCP role refusals and tool names (SPEC §1.4, §2, §17, §19).

/**
 * The actor × operation table is DATA (MATRIX below): one row per actor, one
 * column per operation, each cell the status SPEC §1.4b, §2 and §17 give, as
 * checked against functions/src/index.ts and functions/src/lib/acl.ts. Every
 * row is its own scenario, named by its actor, and a failing scenario lists
 * every bad cell as `<actor>×<op>`, not only the first.
 *
 * Operations (the plan's numbering; c6–c8, c17 and c18 are a02-matrix-data's):
 *
 *   c1   GET  /content/<doc>/<v>/index.html     c10  GET  /draft/<doc>
 *   c2   GET  /download/<doc>/<v>               c11  POST /commit
 *   c3   POST /unlock                           c12  POST /publish?update=<doc>
 *   c4   POST /view                             c13  POST /organize rename
 *   c5   POST /fork {op: create}                c14  POST /organize move (to the root)
 *   c9   POST /draft                            c15  POST /access (a removal, no mail),
 *                                                    /visibility, /trust, /marking
 *                                               c16  POST /thumb (a 16×16 cover)
 *
 * Every refusal that is a 404 or a 401 is also sent, by the same actor, for an
 * id that does not exist: status, body bytes and every header but Date must be
 * the same (SPEC §1.4b: "the same 404 as an absent id"; §2: auth-first). The
 * absent id comes from seed.absentDocId, so the production guard lets a write
 * name it once it has proved docs/<id> empty; only POST /access (c15a), an
 * email route there, is never sent on production, absent id or not. After the
 * row, the absent id must still hold nothing at all.
 *
 * A refusal must also have stored nothing (SPEC §2: the role check comes
 * before the write). The document's state is read through Admin before the
 * row and after every cell — the whole docs/<id> record (updatedAt included,
 * which every settings, membership and rename write moves), its versions, its
 * link grants, every Storage object under docs/<id>/ and the bytes of the
 * draft's — and a cell answered anything but 200 must leave it exactly as it
 * found it. Nothing else writes docs/<id> while a row runs: the only writers
 * are the row's own requests (each awaits its writes before answering), and
 * the change-log triggers write docs/<id>/events, which is not read. For a
 * refused POST /commit to be visible at all there must be a draft to commit
 * (with none, commitDraft answers 409 and writes nothing whoever asks), so a
 * row whose actor may not commit starts with a draft the owner saved.
 *
 * Forks (c5) go through seed.fork, so a fork the matrix makes is ledgered;
 * POST /visibility, in setup and as c15v, goes through grant.setVisibility,
 * so a window a row opens closes with its case; POST /thumb through
 * thumbs.postThumb, with the stack tree's capture revision.
 *
 * Execution order inside a row is fixed (EXEC): reads on v1 first, then the
 * draft, its read-back, the commit (v2), the upload (v3), rename, move, the
 * owner-only settings, the thumbnail on whatever is current, and /visibility
 * last, because an owner's POST /visibility without `expiresAt` clears an
 * expiry in older versions (S25); the expired rows stay expired until the end.
 *
 * Every client here throws E2E_STACK_CUTOFF for Hosting's cut-off 504
 * (`cutoffError`), and every case declares inconclusiveOnStackTimeout: a
 * request the stack never answered — a setup publish, a cell, an Admin read —
 * measured nothing, so the case ends INCONCLUSIVE, not FAIL. Any answer, a
 * quicker 504 included, is still judged.
 *
 * Cells the SPEC and the source disagree on are their own scenarios with a
 * `defect:` tag, so a known defect never hides the rest of its row:
 *
 *   X-a02-matrix-http-1  POST /organize rename and move skip the expiry check
 *   X-a02-matrix-http-2  owner-only endpoints and POST /thumb answer a
 *                        link-grant reader 404, where §1.4b says 403
 *
 * Only e2e/lib/ talks to the stack.
 */

import assert from "node:assert/strict";
import { after } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { currentTarget, precondition, scenario, stackDidNotAnswer } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { absentDocId, fork, publish } from "../../lib/seed.mjs";
import { setVisibility as postVisibility, share } from "../../lib/grant.mjs";
import { postThumb } from "../../lib/thumbs.mjs";
import { closeAdmin, listObjects, readCollection, readDoc, readObject } from "../../lib/admin.mjs";
import { sameBytes, sameHeadersExceptDate } from "../../lib/assert.mjs";
import { createHttp } from "../../lib/http.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A row is up to 32 requests in sequence (16 cells, a parity probe for each
 * refusal). On a shared stack under load single writes have taken 30 s
 * (POST /commit, /organize), so a case gets ten minutes, not three.
 */
const CASE_MS = 600_000;

/**
 * The file's budget (lib/budget.mjs): the fourteen row cases come from a loop
 * the scan cannot see. A loaded shared stack has taken some 32 minutes over
 * all nineteen cases; ninety leaves room without letting a hang run on.
 */
export const E2E_FILE_TIMEOUT_MS = 9 * CASE_MS;

/**
 * The default request timeout of every client this spec makes (http.mjs
 * createHttp's `timeoutMs`, which openSession and mcpClient pass on, and which
 * publish, fork, share, setVisibility, postThumb and mintToken inherit through
 * the client they are given). On a shared stack whose Firestore emulator is
 * saturated a POST /access has taken over 60 s, the library's default, and
 * failed a case in setup, so each client here waits three minutes.
 */
const REQUEST_MS = 180_000;

/**
 * A client for `actor`, logged to the running case's evidence; Hosting's
 * cut-off 504 throws E2E_STACK_CUTOFF (the case is then INCONCLUSIVE).
 */
const client = (actor) => createHttp(target, { actor, timeoutMs: REQUEST_MS, cutoffError: true });

/** Sign an account in; its session's client keeps REQUEST_MS and cutoffError. */
const signIn = (acct) => openSession(target, acct, { timeoutMs: REQUEST_MS, cutoffError: true });

/** What every case declares: a request the stack never answered measured nothing (see the header). */
const STALLS = Object.freeze({ inconclusiveOnStackTimeout: true });

/** The message every write path gives on an expired document (index.ts EXPIRED_WRITE, tools.ts refuseIfExpired). */
const EXPIRED_WRITE = "this document has expired — change or clear its expiry to edit it";

// --- the table ----------------------------------------------------------------

/** Column order of MATRIX rows. */
const COLS = ["c1", "c2", "c3", "c4", "c5", "c9", "c10", "c11", "c12", "c13", "c14", "c15a", "c15v", "c15t", "c15m", "c16"];

function row(text) {
  const vals = text.trim().split(/\s+/).map(Number);
  if (vals.length !== COLS.length || vals.some((v) => !Number.isInteger(v))) throw new Error(`MATRIX row has ${vals.length} cells: ${text}`);
  return Object.freeze(Object.fromEntries(COLS.map((c, i) => [c, vals[i]])));
}

/**
 * Expected status per actor and operation.
 *
 *   O    owner, private              V/S/E/A  viewer/suggester/editor/approver on it
 *   X    signed-in stranger          AN       anonymous
 *   LK   anonymous with the key      LKw      anonymous with a wrong key   (unlisted)
 *   G    signed-in link-grant holder, no key                              (unlisted)
 *   PE   signed-in non-member, public with open editing
 *   PEU  link-grant holder, unlisted with open editing
 *   E-exp  the editor once the private document has expired; O-exp its owner
 *
 * Notes on cells where the plan's summary and the SPEC differ (recorded as
 * plan_oracle_corrections): c3 is 404 for EVERY caller of a private document,
 * its owner included (§2 /unlock "private (to its members too…)"); c5 is a
 * read (§2 /fork "create is canRead-gated"), so every reader forks; c15 on an
 * expired document is the owner's settings, not the document — /visibility is
 * the one action that lifts the date (§17) — so O-exp gets 200 and E-exp gets the
 * 403 any member gets; c10 is an edit path that checks expiry, 409.
 *
 * E-exp×c15 is pinned as the source answers it, 403: refusal() decides by
 * canRead, which ignores expiry. §1.4b read literally ("403 only to a caller
 * who may READ") would say 404 to an editor who may no longer read, but §17
 * keeps the row, its title and its comments visible to members, so the 403
 * tells them nothing they do not see. Reported as a SPEC question, not a defect.
 */
const MATRIX = Object.freeze({
  //            c1  c2  c3  c4  c5  c9  c10 c11 c12 c13 c14 c15a c15v c15t c15m c16
  O: row("     200 200 404 200 200 200 200 200 200 200 200 200  200  200  200  200"),
  V: row("     200 200 404 200 200 403 403 403 403 403 403 403  403  403  403  403"),
  S: row("     200 200 404 200 200 403 403 403 403 403 403 403  403  403  403  403"),
  E: row("     200 200 404 200 200 200 200 200 200 200 200 403  403  403  403  200"),
  A: row("     200 200 404 200 200 200 200 200 200 200 200 403  403  403  403  200"),
  X: row("     404 404 404 404 404 404 404 404 404 404 404 404  404  404  404  404"),
  AN: row("    404 404 404 404 401 401 401 401 401 401 401 401  401  401  401  401"),
  LK: row("    200 200 200 200 401 401 401 401 401 401 401 401  401  401  401  401"),
  LKw: row("   404 404 404 404 401 401 401 401 401 401 401 401  401  401  401  401"),
  G: row("     200 200 200 200 200 403 403 403 403 403 403 403  403  403  403  403"),
  PE: row("    200 200 200 200 200 200 200 200 403 200 403 403  403  403  403  403"),
  PEU: row("   200 200 200 200 200 200 200 200 403 200 403 403  403  403  403  403"),
  "E-exp": row("404 404 404 404 404 409 409 409 409 409 409 403  403  403  403  409"),
  "O-exp": row("200 200 404 200 200 409 409 409 409 409 409 200  200  200  200  200"),
});

/**
 * Cells whose SPEC answer the source does not give (as read, before any run):
 * kept out of their row's scenario and asserted in a defect scenario of their own.
 */
const DEFECT_CELLS = Object.freeze({
  "X-a02-matrix-http-1": { "E-exp": ["c13", "c14"], "O-exp": ["c13", "c14"] },
  "X-a02-matrix-http-2": { G: ["c15a", "c15v", "c15t", "c15m", "c16"], PEU: ["c15a", "c15v", "c15t", "c15m", "c16"] },
});

function defectColsFor(key) {
  return Object.values(DEFECT_CELLS).flatMap((m) => m[key] ?? []);
}

// --- operations -----------------------------------------------------------------

/** The `k` an actor sends, if any: a query parameter on GETs, a body field on POSTs. */
const kq = (a) => (a.k ? { k: a.k } : undefined);
const kb = (a) => (a.k ? { k: a.k } : {});
const sessionId = () => `a2${randomBytes(8).toString("hex")}`;

const octet = { "content-type": "application/octet-stream" };

/**
 * POST /visibility as `actor`, keeping the document's current visibility, so
 * it opens no window; through grant.setVisibility, which restores the case's
 * window registry when the actor is refused. Whatever the status, the
 * response comes back (E2E_STATUS carries it).
 */
async function sameVisibility(a, d) {
  try {
    return (await postVisibility(target, { owner: a, doc: d.id, visibility: d.visibility, publicEdit: d.publicEdit })).response;
  } catch (err) {
    if (err?.code === "E2E_STATUS" && err.response) return err.response;
    throw err;
  }
}

/**
 * Every operation: `run(actor, doc)` sends it and resolves to the http.mjs
 * response; `ok(r, doc)` says why a 200 is not the success it should be (null
 * when it is); `after(r, doc)` moves the document's current version on a 200
 * that mints one. `local` marks a request the production guard refuses
 * whatever it names (POST /access is an email route there), so on production
 * that cell is not sent.
 */
const OPS = Object.freeze({
  c1: {
    what: "GET /content",
    run: (a, d) => a.http.get(`/content/${d.id}/${d.v}/index.html`, { query: kq(a) }),
    ok: (r, d) => (sha(r.buffer) === sha(d.v1Bytes) ? null : `bytes are not v1's (${r.buffer.length} B)`),
  },
  c2: {
    what: "GET /download",
    run: (a, d) => a.http.get(`/download/${d.id}/${d.v}`, { query: kq(a) }),
    ok: (r) => (/application\/zip/.test(r.headers.get("content-type") ?? "") && r.buffer.subarray(0, 2).toString("latin1") === "PK" ? null : `not a zip (${r.headers.get("content-type")})`),
  },
  c3: {
    what: "POST /unlock",
    run: (a, d) => a.http.postJson("/unlock", { docId: d.id, ...kb(a) }),
    ok: (r, d) => (r.json?.docId === d.id && !("publishedAt" in (r.json ?? {})) ? null : `not the reader projection: ${r.text.slice(0, 200)}`),
  },
  c4: {
    what: "POST /view",
    run: (a, d) => a.http.postJson("/view", { docId: d.id, versionId: d.v, sessionId: sessionId(), ms: 1000, ...kb(a) }),
    ok: (r) => (typeof r.json?.ms === "number" ? null : `no ms: ${r.text.slice(0, 200)}`),
  },
  c5: {
    what: "POST /fork create",
    run: async (a, d) => (await fork(a.http, { docId: d.id, k: a.k, ownerEmail: a.email })).response,
    ok: (r, d) => (typeof r.json?.docId === "string" && r.json.docId !== d.id ? null : `no new docId: ${r.text.slice(0, 200)}`),
  },
  c9: {
    what: "POST /draft",
    run: (a, d) => a.http.postJson("/draft", { docId: d.id, baseVersion: d.v, html: d.draftHtml }),
    ok: (r, d) => (r.json?.draft?.baseVersion === d.v ? null : `no draft on ${d.v}: ${r.text.slice(0, 200)}`),
  },
  c10: {
    what: "GET /draft",
    run: (a, d) => a.http.get(`/draft/${d.id}`),
    ok: (r, d) => (r.text === d.draftHtml ? null : `not the posted draft (${r.buffer.length} B)`),
  },
  c11: {
    what: "POST /commit",
    run: (a, d) => a.http.postJson("/commit", { docId: d.id, baseVersion: d.v }),
    ok: (r) => (/^v\d+$/.test(r.json?.versionId ?? "") && r.json.deduped !== true ? null : `no new version: ${r.text.slice(0, 200)}`),
    after: (r, d) => (d.v = r.json.versionId),
  },
  c12: {
    what: "POST /publish?update=",
    run: (a, d) => a.http.request("POST", "/publish", { query: { filename: "index.html", update: d.id }, headers: octet, body: Buffer.from(d.updateHtml) }),
    ok: (r) => (/^v\d+$/.test(r.json?.versionId ?? "") && r.json.deduped !== true ? null : `no new version: ${r.text.slice(0, 200)}`),
    after: (r, d) => (d.v = r.json.versionId),
  },
  c13: {
    what: "POST /organize rename",
    run: (a, d) => a.http.postJson("/organize", { kind: "doc", id: d.id, op: "rename", name: `A2 renamed ${rand4()}` }),
    ok: (r) => (r.json?.ok === true ? null : r.text.slice(0, 200)),
  },
  c14: {
    what: "POST /organize move",
    run: (a, d) => a.http.postJson("/organize", { kind: "doc", id: d.id, op: "move" }),
    ok: (r) => (r.json?.ok === true ? null : r.text.slice(0, 200)),
  },
  c15a: {
    what: "POST /access (a removal)",
    local: true,
    run: (a, d) => a.http.postJson("/access", { docId: d.id, remove: [d.nobody] }),
    ok: (r) => (Array.isArray(r.json?.members) ? null : r.text.slice(0, 200)),
  },
  c15t: {
    what: "POST /trust",
    run: (a, d) => a.http.postJson("/trust", { docId: d.id, trusted: false }),
    ok: (r) => (r.json?.trusted === false ? null : r.text.slice(0, 200)),
  },
  c15m: {
    what: "POST /marking",
    run: (a, d) => a.http.postJson("/marking", { docId: d.id, marking: { enabled: false } }),
    ok: (r) => (r.json?.marking?.enabled === false ? null : r.text.slice(0, 200)),
  },
  c16: {
    what: "POST /thumb",
    run: (a, d) => postThumb(a.http, { docId: d.id, versionId: d.v }),
    ok: (r) => (r.json?.stored === true ? null : `not stored: ${r.text.slice(0, 200)}`),
  },
  c15v: {
    what: "POST /visibility",
    run: (a, d) => sameVisibility(a, d),
    ok: (r, d) => (r.json?.visibility === d.visibility ? null : r.text.slice(0, 200)),
  },
});

/** The order a row is sent in (see the header): /visibility last. */
const EXEC = Object.freeze(["c1", "c2", "c3", "c4", "c5", "c9", "c10", "c11", "c12", "c13", "c14", "c15a", "c15t", "c15m", "c16", "c15v"]);

// --- documents and actors -----------------------------------------------------

function page(tag, words) {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>A2 ${tag}</title></head><body><h1>A2 matrix ${tag}</h1><p id="p1">${words}</p></body></html>\n`;
}

/**
 * The owner publishes a fresh private document; `d` is what every operation
 * needs to know about it. With `draft`, the owner then saves a draft of v1 (its
 * own bytes, not the actor's), so that a refused POST /commit has something
 * it would have published.
 */
async function ownDoc(ctx, label, { draft = false } = {}) {
  const [ownerAcct] = await cast(target, ["owner"]);
  const owner = await signIn(ownerAcct);
  const tag = `${runTag(target.runId)}-${rand4()}`;
  const v1Bytes = Buffer.from(page(tag, `The first version of ${label}.`));
  const up = await publish(owner.http, { body: v1Bytes, filename: "index.html", title: `A2 ${label} ${tag}`, name: `a2-${label}` });
  precondition(up.versionId === "v1", `publish answered ${up.status} ${JSON.stringify(up.json)?.slice(0, 200)}`);
  const d = {
    id: up.docId,
    v: "v1",
    visibility: "private",
    publicEdit: false,
    v1Bytes,
    draftHtml: page(tag, `A draft of ${label}, written ${rand4()}.`),
    updateHtml: page(tag, `An uploaded version of ${label}, ${rand4()}.`),
    nobody: `nobody-${tag}@example.com`,
  };
  if (draft) {
    const r = await owner.http.postJson("/draft", { docId: d.id, baseVersion: "v1", html: page(tag, `The owner's draft of ${label}, ${rand4()}.`) });
    precondition(r.status === 200 && r.json?.draft?.baseVersion === "v1", `the owner's POST /draft: ${r.status} ${r.text.slice(0, 200)}`);
  }
  return { owner, d };
}

/** A row whose actor may not commit starts with the owner's draft (see the header). */
const ownerDraftFor = (key) => MATRIX[key].c11 !== 200;

/**
 * POST /visibility as the owner, through grant.setVisibility (a window it
 * opens closes with the case); returns the link token for an unlisted
 * document. A request the stack never answered is rethrown as it is, so the
 * case is INCONCLUSIVE; any other failure is a setup step's.
 */
async function setVisibility(owner, d, visibility, { publicEdit = false, expiresAt } = {}) {
  const r = await postVisibility(target, { owner, doc: d.id, visibility, publicEdit, ...(expiresAt ? { expiresAt } : {}) }).catch((err) => {
    if (stackDidNotAnswer(err)) throw err;
    return precondition(false, `POST /visibility ${visibility}: ${String(err?.message ?? err).slice(0, 300)}`);
  });
  d.visibility = visibility;
  d.publicEdit = r.publicEdit === true;
  return r.linkToken;
}

/** A signed-in actor holding a link grant: POST /unlock with the key once, then never the key again. */
async function grantHolder(role, d, k) {
  const [acct] = await cast(target, [role]);
  const s = await signIn(acct);
  const r = await s.http.postJson("/unlock", { docId: d.id, k });
  precondition(r.status === 200, `the ${role}'s POST /unlock with the key: ${r.status}`);
  return { name: role, http: s.http, session: s, email: acct.email };
}

/** A key of the right shape that is not the document's. */
function wrongKey(k) {
  for (;;) {
    const w = randomBytes(16).toString("base64url");
    if (w !== k) return w;
  }
}

/** Wait out an expiry the product enforces by the clock (SPEC §17): a fixed wait is the behaviour under test. */
async function expire(owner, d, ctx) {
  const at = Date.now() + 6000;
  await setVisibility(owner, d, "private", { expiresAt: at });
  ctx.step(`expiry set to ${new Date(at).toISOString()}; waiting it out (the product decides expiry by the clock)`);
  await sleep(Math.max(0, at - Date.now()) + 1500);
}

/**
 * Each actor key → a setup returning {actor: {name, http, k?, email?}, d}. A setup
 * builds its own owner, document and accounts, so rows share nothing.
 */
const SETUPS = Object.freeze({
  async O(ctx) {
    const { owner, d } = await ownDoc(ctx, "owner", { draft: ownerDraftFor("O") });
    return { actor: { name: "owner", http: owner.http, email: owner.account.email }, d };
  },
  async V(ctx) {
    return member(ctx, "viewer", "viewer", { draft: ownerDraftFor("V") });
  },
  async S(ctx) {
    return member(ctx, "suggester", "suggester", { draft: ownerDraftFor("S") });
  },
  async E(ctx) {
    return member(ctx, "editor", "editor", { draft: ownerDraftFor("E") });
  },
  async A(ctx) {
    return member(ctx, "approver", "approver", { draft: ownerDraftFor("A") });
  },
  async X(ctx) {
    const { d } = await ownDoc(ctx, "stranger", { draft: ownerDraftFor("X") });
    const [acct] = await cast(target, ["stranger"]);
    const s = await signIn(acct);
    return { actor: { name: "stranger", http: s.http, email: acct.email }, d };
  },
  async AN(ctx) {
    const { d } = await ownDoc(ctx, "anonymous", { draft: ownerDraftFor("AN") });
    return { actor: { name: "anonymous", http: client("anonymous") }, d };
  },
  async LK(ctx) {
    const { owner, d } = await ownDoc(ctx, "link", { draft: ownerDraftFor("LK") });
    const k = precondition(await setVisibility(owner, d, "unlisted"), "an unlisted document has a link token");
    return { actor: { name: "link-holder", http: client("link-holder"), k }, d };
  },
  async LKw(ctx) {
    const { owner, d } = await ownDoc(ctx, "wrong-link", { draft: ownerDraftFor("LKw") });
    const k = precondition(await setVisibility(owner, d, "unlisted"), "an unlisted document has a link token");
    return { actor: { name: "wrong-key", http: client("wrong-key"), k: wrongKey(k) }, d };
  },
  async G(ctx) {
    const { owner, d } = await ownDoc(ctx, "grant", { draft: ownerDraftFor("G") });
    const k = precondition(await setVisibility(owner, d, "unlisted"), "an unlisted document has a link token");
    return { actor: await grantHolder("grantee", d, k), d };
  },
  async PE(ctx) {
    const { owner, d } = await ownDoc(ctx, "open-edit", { draft: ownerDraftFor("PE") });
    await setVisibility(owner, d, "public", { publicEdit: true });
    precondition(d.publicEdit, "open editing is on");
    const [acct] = await cast(target, ["openeditor"]);
    const s = await signIn(acct);
    return { actor: { name: "openeditor", http: s.http, email: acct.email }, d };
  },
  async PEU(ctx) {
    const { owner, d } = await ownDoc(ctx, "open-edit-unlisted", { draft: ownerDraftFor("PEU") });
    const k = precondition(await setVisibility(owner, d, "unlisted", { publicEdit: true }), "an unlisted document has a link token");
    precondition(d.publicEdit, "open editing is on");
    return { actor: await grantHolder("openeditor", d, k), d };
  },
  async "E-exp"(ctx) {
    const { owner, d, actor } = await member(ctx, "editor", "expired", { draft: ownerDraftFor("E-exp") });
    await expire(owner, d, ctx);
    return { actor, d };
  },
  async "O-exp"(ctx) {
    const { owner, d } = await ownDoc(ctx, "expired-owner", { draft: ownerDraftFor("O-exp") });
    await expire(owner, d, ctx);
    return { actor: { name: "owner", http: owner.http, email: owner.account.email }, d };
  },
});

/**
 * The owner shares a fresh private document with a new account in `role`.
 * The grant is read back from docs/<id>.members through Admin, the one place
 * both paths write: POST /access answers the member list, but production's
 * operator script (grant.share's other path) answers only its own output.
 */
async function member(ctx, role, label = role, opts = {}) {
  const { owner, d } = await ownDoc(ctx, label, opts);
  const [acct] = await cast(target, [role]);
  const granted = await share(target, { owner, doc: d.id, account: acct, role });
  const members = (await readDoc(target, `docs/${d.id}`))?.members;
  precondition(
    granted.status === 200 && Array.isArray(members) && members.includes(acct.email.toLowerCase()),
    `share as ${role}: ${granted.status}, docs/${d.id}.members ${Array.isArray(members) ? `has ${members.length} and not the ${role}` : "is missing"}`,
  );
  const s = await signIn(acct);
  return { owner, d, actor: { name: role, http: s.http, session: s, email: acct.email } };
}

// --- what a refusal must leave alone ----------------------------------------------

/** A Firestore value as plain, key-sorted JSON; a Timestamp as its exact instant. */
function plain(v) {
  if (v === null || typeof v !== "object") return v;
  if (typeof v.toMillis === "function" && "nanoseconds" in v) return `ts:${v.seconds}.${String(v.nanoseconds).padStart(9, "0")}`;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return `bytes:${sha(v)}`;
  if (typeof v.path === "string" && v.firestore) return `ref:${v.path}`;
  if (Array.isArray(v)) return v.map(plain);
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, plain(v[k])]));
}

/**
 * Everything a write to document `id` could leave behind, read through Admin:
 * the docs/<id> record, its version ids, its link grants, the Storage objects
 * under docs/<id>/ (names relative to it) and the draft objects' bytes.
 */
async function stateOf(id) {
  const prefix = `docs/${id}/`;
  const [record, versions, grants, names] = await Promise.all([
    readDoc(target, `docs/${id}`),
    readCollection(target, `docs/${id}/versions`),
    readCollection(target, `docs/${id}/linkGrants`),
    listObjects(target, prefix),
  ]);
  const drafts = names.filter((n) => n.startsWith(`${prefix}draft/`));
  const bytes = await Promise.all(drafts.map(async (n) => [n.slice(prefix.length), sha((await readObject(target, n)) ?? Buffer.alloc(0))]));
  return {
    record: record === null ? null : plain(record),
    versions: versions.map((v) => v.id).sort(),
    linkGrants: Object.fromEntries(grants.map((g) => [g.id, JSON.stringify(plain(g.data))])),
    objects: names.map((n) => n.slice(prefix.length)).sort(),
    drafts: Object.fromEntries(bytes),
  };
}

/** True when a state holds nothing at all (an id nobody ever wrote). */
const isEmptyState = (s) => s.record === null && !s.versions.length && !Object.keys(s.linkGrants).length && !s.objects.length;

/**
 * What changed from `a` to `b`, as phrases naming fields, ids and object
 * names only (never a value: the record holds an unlisted document's link
 * token). Empty when nothing did.
 */
function changes(a, b) {
  const out = [];
  if ((a.record === null) !== (b.record === null)) out.push(a.record === null ? "docs/<id> was created" : "docs/<id> was deleted");
  else if (a.record !== null) {
    const keys = [...new Set([...Object.keys(a.record), ...Object.keys(b.record)])].sort();
    const fields = keys.filter((k) => JSON.stringify(a.record[k]) !== JSON.stringify(b.record[k]));
    if (fields.length) out.push(`docs/<id> fields ${fields.join(", ")}`);
  }
  const sets = (what, x, y) => {
    const added = y.filter((n) => !x.includes(n));
    const gone = x.filter((n) => !y.includes(n));
    if (added.length || gone.length) out.push(`${what}${added.map((n) => ` +${n}`).join("")}${gone.map((n) => ` -${n}`).join("")}`);
  };
  sets("versions", a.versions, b.versions);
  sets("objects", a.objects, b.objects);
  sets("linkGrants", Object.keys(a.linkGrants), Object.keys(b.linkGrants));
  const regranted = Object.keys(a.linkGrants).filter((g) => g in b.linkGrants && a.linkGrants[g] !== b.linkGrants[g]);
  if (regranted.length) out.push(`linkGrants rewritten: ${regranted.join(", ")}`);
  const redrafted = Object.keys(a.drafts).filter((n) => n in b.drafts && a.drafts[n] !== b.drafts[n]);
  if (redrafted.length) out.push(`draft bytes rewritten: ${redrafted.join(", ")}`);
  return out;
}

// --- the row runner -------------------------------------------------------------

function brief(r) {
  const t = r.text ?? "";
  return t ? ` — ${t.replace(/\s+/g, " ").slice(0, 160)}` : "";
}

/**
 * Send `cols` of row `key` in EXEC order and compare each with MATRIX. A 200
 * must also be the success it claims (`ok`); a 409 must say the document has
 * expired; a 404 or 401 must be the same response, byte for byte and header
 * for header (Date aside), as the same request for an absent id. Any answer
 * but a 200 must have stored nothing (stateOf before and after the cell), and
 * the absent id must hold nothing once the row is done.
 * Returns the bad cells (strings) and the full cell log.
 */
async function sendRow(ctx, key, { actor, d }, cols) {
  const want = MATRIX[key];
  const absent = { ...d, id: absentDocId(target, "a2-absent"), v: "v1" };
  const bad = [];
  const cells = [];
  let state = await stateOf(d.id);
  precondition(state.record !== null, `docs/${d.id} is readable through Admin`);
  for (const id of EXEC) {
    if (!cols.includes(id)) continue;
    const op = OPS[id];
    if (op.local && target.kind !== "local") {
      ctx.step(`${key}×${id} ${op.what}: not sent on ${target.kind} (the production guard refuses it)`);
      continue;
    }
    const cell = `${key}×${id} ${op.what}`;
    const r = await op.run(actor, d);
    const log = { cell: `${key}×${id}`, what: op.what, want: want[id], got: r.status };
    if (r.status !== want[id]) {
      bad.push(`${cell}: want ${want[id]}, got ${r.status}${brief(r)}`);
    } else if (r.status === 200) {
      const why = op.ok(r, d);
      if (why) bad.push(`${cell}: 200 but ${why}`);
    } else if (r.status === 409 && r.json?.error !== EXPIRED_WRITE) {
      bad.push(`${cell}: 409 but not the expired-write message: ${JSON.stringify(r.json?.error)}`);
    }
    const next = await stateOf(d.id);
    if (r.status !== 200) {
      const stored = changes(state, next);
      log.stored = stored;
      if (stored.length) bad.push(`${cell}: refused ${r.status}, yet stored: ${stored.join("; ")}`);
    }
    state = next;
    if (r.status === 200 && op.after) op.after(r, d);
    if (want[id] === 404 || want[id] === 401) {
      const ra = await op.run(actor, absent);
      const body = sameBytes(r.buffer, ra.buffer);
      const heads = sameHeadersExceptDate(r.headers, ra.headers);
      const equal = ra.status === r.status && body.equal && heads.equal;
      log.parity = { equal, absentStatus: ra.status, sameBody: body.equal, headerDiff: heads.diff };
      if (!equal) {
        bad.push(
          `${cell}: parity with an absent id broken — status ${r.status} vs ${ra.status}` +
            `${body.equal ? "" : `, body differs at byte ${body.at} (lengths ${body.lengths})`}` +
            `${heads.equal ? "" : `, headers differ: ${heads.diff.map((h) => `${h.header}=${JSON.stringify(h.a)}≠${JSON.stringify(h.b)}`).join("; ")}`}`,
        );
      }
    }
    cells.push(log);
  }
  const leftover = await stateOf(absent.id);
  if (!isEmptyState(leftover)) {
    bad.push(`${key}: the refusals sent for the absent id ${absent.id} stored something: ${changes({ record: null, versions: [], linkGrants: {}, objects: [], drafts: {} }, leftover).join("; ")}`);
  }
  ctx.ev.json(`cells-${key}`, cells);
  const mark = (p) => (!p ? "" : p.equal ? "≡" : "≢");
  const kept = (c) => (!c.stored ? "" : c.stored.length ? "!" : "∅");
  ctx.step(
    `${key}: ${cells.map((c) => `${c.cell.split("×")[1]}=${c.got}${mark(c.parity)}${kept(c)}`).join(" ")}` +
      `  (≡ equal to an absent id's, ≢ not; ∅ a refusal that stored nothing, ! one that stored something; absent id ${absent.id})`,
  );
  return { bad, cells };
}

function assertCells(key, bad) {
  assert.equal(bad.length, 0, `${key}: ${bad.length} cell(s) differ from the matrix\n  ${bad.join("\n  ")}`);
}

// --- one scenario per actor row ---------------------------------------------------

const ROW_NAMES = Object.freeze({
  O: "A2.O the owner of a private document: everything but /unlock answers 200",
  V: "A2.V a viewer: reads and forks 200, /unlock 404, every edit and owner-only operation 403",
  S: "A2.S a suggester: as a viewer on c1–c5 and c9–c16",
  E: "A2.E an editor: reads, edits, upload, rename, move and /thumb 200; owner-only operations 403",
  A: "A2.A an approver: as an editor on c1–c5 and c9–c16",
  X: "A2.X a signed-in stranger: every operation 404, byte-equal to an absent id's",
  AN: "A2.AN anonymous on a private document: reads 404, mutations 401, each equal to an absent id's",
  LK: "A2.LK anonymous with an unlisted document's key: reads 200, mutations 401",
  LKw: "A2.LKw anonymous with a wrong key: reads 404, mutations 401, each equal to an absent id's",
  G: "A2.G a link-grant holder without the key: reads and forks 200, edits 403",
  PE: "A2.PE a non-member on a public open-editing document: edits 200; upload, move, owner-only and /thumb 403",
  PEU: "A2.PEU a link-grant holder on an unlisted open-editing document: edits 200; upload and move 403",
  "E-exp": "A2.E-exp the editor of an expired document: reads 404 as for an absent id, edits 409, owner-only 403",
  "O-exp": "A2.O-exp the owner of an expired document: reads 200, edits 409, settings and /thumb 200",
});

for (const [key, name] of Object.entries(ROW_NAMES)) {
  const excluded = defectColsFor(key);
  const cols = COLS.filter((c) => !excluded.includes(c));
  scenario(name, { tiers: ["local", "prod"], timeoutMs: CASE_MS, ...STALLS }, async (ctx) => {
    ctx.step(`${key}: setting up (${excluded.length ? `cells ${excluded.join(", ")} are a defect case's` : "every cell"})`);
    const fx = await SETUPS[key](ctx);
    ctx.step(`${key}: ${fx.actor.name} on ${fx.d.id} (${fx.d.visibility}${fx.d.publicEdit ? ", open editing" : ""})`);
    const { bad } = await sendRow(ctx, key, fx, cols);
    assertCells(key, bad);
  });
}

// --- the cells a known defect holds -------------------------------------------------

scenario("A2.exp-rename-move rename and move of an expired document are refused with 409, as every other write is", {
  tiers: ["local", "prod"],
  ...STALLS,
  timeoutMs: CASE_MS,
}, async (ctx) => {
  const bad = [];
  const keys = ["E-exp", "O-exp"];
  // Both documents expire together: one wait instead of two.
  const fxs = await Promise.all(keys.map((key) => SETUPS[key](ctx)));
  for (const [i, key] of keys.entries()) {
    ctx.step(`${key}: ${fxs[i].actor.name} on ${fxs[i].d.id}, expired`);
    const out = await sendRow(ctx, key, fxs[i], DEFECT_CELLS["X-a02-matrix-http-1"][key]);
    bad.push(...out.bad);
  }
  assertCells("expired rename/move", bad);
});

scenario("A2.grant-owner-only a link-grant holder may read, so the owner-only endpoints and /thumb refuse them 403, not 404", {
  tiers: ["local", "prod"],
  ...STALLS,
  timeoutMs: CASE_MS,
}, async (ctx) => {
  const bad = [];
  for (const key of ["G", "PEU"]) {
    const fx = await SETUPS[key](ctx);
    ctx.step(`${key}: ${fx.actor.name} on ${fx.d.id}, holding a link grant`);
    const out = await sendRow(ctx, key, fx, DEFECT_CELLS["X-a02-matrix-http-2"][key]);
    bad.push(...out.bad);
    const inherited = answered(await fx.actor.http.get("/access", { query: { docId: fx.d.id } }));
    if (inherited.status !== 403 || inherited.text !== "") bad.push(`GET /access: want empty 403, got ${inherited.status}`);
  }
  assertCells("grant-holder owner-only", bad);
});

// --- MCP --------------------------------------------------------------------------

/** The twenty-three tools of SPEC §19's table, in its order. */
const SPEC_TOOLS = Object.freeze([
  "list_documents", "get_document", "publish_document", "fork_document", "get_lineage", "update_document", "commit_draft",
  "suggest_edit", "revise_suggestion", "withdraw_suggestion", "accept_suggestion", "reject_suggestion", "list_folders",
  "get_folder", "create_folder", "move_document", "rename_document", "get_comments", "get_changes", "add_comment",
  "reply_to_comment", "resolve_thread", "reopen_thread",
]);
const DESTRUCTIVE = /delete|remove|share|grant|access/;

async function mcpFor(ctx, session, actor) {
  const { token } = await mintToken(session, { name: `e2e a2 ${actor}`, channel: "mcp" });
  const mcp = ctx.mcp({ actor: `${actor}-mcp`, token, timeoutMs: REQUEST_MS });
  await mcp.initialize();
  return mcp;
}

/** The arguments each probed tool needs to reach its role check (required ones present, nothing else). */
const TOOL_ARGS = Object.freeze({
  get_document: (id) => ({ id }),
  fork_document: (id) => ({ id }),
  get_lineage: (id) => ({ id }),
  update_document: (id) => ({ id, content: "<p>a2 probe</p>" }),
  commit_draft: (id) => ({ id }),
  rename_document: (id) => ({ id, title: "a2 probe" }),
  move_document: (id) => ({ id }),
  suggest_edit: (id) => ({ id, exact: "first version", replacement: "a2 probe" }),
  accept_suggestion: (id) => ({ id, threadId: "a2noSuchThread" }),
  reject_suggestion: (id) => ({ id, threadId: "a2noSuchThread" }),
  get_comments: (id) => ({ id }),
  add_comment: (id) => ({ id, exact: "first version", body: "a2 probe" }),
  reply_to_comment: (id) => ({ id, threadId: "a2noSuchThread", body: "a2 probe" }),
  resolve_thread: (id) => ({ id, threadId: "a2noSuchThread" }),
  reopen_thread: (id) => ({ id, threadId: "a2noSuchThread" }),
});

const CANNOT_EDIT = "you cannot edit that document";
const CANNOT_EDIT_BUT_SUGGEST = "you cannot edit that document, but you can suggest an edit to it with suggest_edit; its owner or an approver accepts or rejects it";
const CANNOT_COMMIT = "you cannot publish that document's draft";
const CANNOT_RENAME = "you cannot rename that document";
const CANNOT_MOVE = "you cannot move that document";
const CANNOT_SUGGEST = "you cannot suggest edits to that document";
const NOT_APPROVER = "only the owner or an approver can accept or reject a suggestion";
const absentMsg = (id) => `no document with id "${id}"`;

/** Call each [tool, expected message | (id) => message] and collect every mismatch. */
async function probeTools(mcp, who, id, expectations, bad, log) {
  for (const [tool, expected] of expectations) {
    const want = typeof expected === "function" ? expected(id) : expected;
    const out = await mcp.call(tool, TOOL_ARGS[tool](id));
    log.push({ who, tool, isError: out.isError, text: out.text.slice(0, 300) });
    if (!out.isError || out.text !== want) bad.push(`${who} ${tool}: want isError with ${JSON.stringify(want)}, got isError=${out.isError} ${JSON.stringify(out.text.slice(0, 200))}`);
  }
}

scenario("A2.mcp-roles a viewer, suggester, editor, stranger, grant holder and open editors are refused by MCP with the exact messages", {
  tiers: ["local", "prod"],
  ...STALLS,
  timeoutMs: CASE_MS,
}, async (ctx) => {
  const bad = [];
  const log = [];

  ctx.step("a private document shared with a viewer, a suggester and an editor; a stranger who is not on it");
  const { owner, d } = await ownDoc(ctx, "mcp-private");
  const accts = await cast(target, ["viewer", "suggester", "editor", "stranger"]);
  for (const [acct, role] of [[accts[0], "viewer"], [accts[1], "suggester"], [accts[2], "editor"]]) {
    const g = await share(target, { owner, doc: d.id, account: acct, role });
    precondition(g.status === 200, `share as ${role}`);
  }
  const [vS, sS, eS, xS] = await Promise.all(accts.map((a) => signIn(a)));
  const [vM, sM, eM, xM] = await Promise.all([[vS, "viewer"], [sS, "suggester"], [eS, "editor"], [xS, "stranger"]].map(([s, n]) => mcpFor(ctx, s, n)));

  await probeTools(vM, "viewer", d.id, [
    ["update_document", CANNOT_EDIT], ["commit_draft", CANNOT_COMMIT], ["rename_document", CANNOT_RENAME], ["move_document", CANNOT_MOVE],
    ["suggest_edit", CANNOT_SUGGEST], ["accept_suggestion", NOT_APPROVER], ["reject_suggestion", NOT_APPROVER],
  ], bad, log);
  await probeTools(sM, "suggester", d.id, [
    ["update_document", CANNOT_EDIT_BUT_SUGGEST], ["commit_draft", CANNOT_COMMIT], ["rename_document", CANNOT_RENAME], ["move_document", CANNOT_MOVE],
    ["accept_suggestion", NOT_APPROVER], ["reject_suggestion", NOT_APPROVER],
  ], bad, log);
  await probeTools(eM, "editor", d.id, [["accept_suggestion", NOT_APPROVER], ["reject_suggestion", NOT_APPROVER]], bad, log);

  ctx.step("the stranger gets, from every tool, exactly what an absent id gets");
  const strangerTools = ["get_document", "fork_document", "get_lineage", "update_document", "commit_draft", "rename_document", "move_document",
    "suggest_edit", "accept_suggestion", "reject_suggestion", "get_comments", "add_comment"];
  const absentId = absentDocId(target, "a2-absent");
  await probeTools(xM, "stranger", d.id, strangerTools.map((t) => [t, absentMsg]), bad, log);
  await probeTools(xM, "stranger (absent id)", absentId, strangerTools.map((t) => [t, absentMsg]), bad, log);

  ctx.step("an unlisted document whose link a grantee opened once; an open-editing public one; an open-editing unlisted one");
  const { owner: o2, d: du } = await ownDoc(ctx, "mcp-unlisted");
  const ku = precondition(await setVisibility(o2, du, "unlisted"), "link token");
  const g = await grantHolder("grantee", du, ku);
  const gM = await mcpFor(ctx, g.session, "grantee");
  await probeTools(gM, "grantee", du.id, [
    ["update_document", CANNOT_EDIT], ["commit_draft", CANNOT_COMMIT], ["rename_document", CANNOT_RENAME], ["move_document", CANNOT_MOVE],
    ["suggest_edit", CANNOT_SUGGEST], ["accept_suggestion", NOT_APPROVER], ["reject_suggestion", NOT_APPROVER],
  ], bad, log);

  const { owner: o3, d: dp } = await ownDoc(ctx, "mcp-open");
  await setVisibility(o3, dp, "public", { publicEdit: true });
  const [peA] = await cast(target, ["openeditor"]);
  const peM = await mcpFor(ctx, await signIn(peA), "openeditor");
  await probeTools(peM, "open editor (public)", dp.id, [["move_document", CANNOT_MOVE], ["accept_suggestion", NOT_APPROVER], ["reject_suggestion", NOT_APPROVER]], bad, log);

  const { owner: o4, d: dq } = await ownDoc(ctx, "mcp-open-unlisted");
  const kq4 = precondition(await setVisibility(o4, dq, "unlisted", { publicEdit: true }), "link token");
  const peu = await grantHolder("openeditor", dq, kq4);
  const peuM = await mcpFor(ctx, peu.session, "openeditor-unlisted");
  await probeTools(peuM, "open editor (unlisted, grant)", dq.id, [["move_document", CANNOT_MOVE], ["accept_suggestion", NOT_APPROVER], ["reject_suggestion", NOT_APPROVER]], bad, log);

  ctx.ev.json("mcp-refusals", log);
  assert.equal(bad.length, 0, `MCP role refusals: ${bad.length} differ\n  ${bad.join("\n  ")}`);
});

scenario("A2.mcp-expired on an expired document MCP answers its editor as for an absent id and refuses its owner's writes with the expiry message", {
  tiers: ["local", "prod"],
  ...STALLS,
  timeoutMs: CASE_MS,
}, async (ctx) => {
  const bad = [];
  const log = [];
  const { owner, d, actor } = await member(ctx, "editor", "mcp-expired");
  const oM = await mcpFor(ctx, owner, "owner");
  const eM = await mcpFor(ctx, actor.session, "editor");
  await expire(owner, d, ctx);

  ctx.step("the owner still reads it, and every write tool refuses with the expiry message");
  const read = await oM.call("get_document", { id: d.id });
  log.push({ who: "owner", tool: "get_document", isError: read.isError, text: read.text.slice(0, 200) });
  if (read.isError || read.json?.id !== d.id || read.json?.canEdit !== false) bad.push(`owner get_document: want the document with canEdit false, got isError=${read.isError} ${read.text.slice(0, 200)}`);
  await probeTools(oM, "owner", d.id, [
    ["update_document", EXPIRED_WRITE], ["commit_draft", EXPIRED_WRITE], ["rename_document", EXPIRED_WRITE], ["move_document", EXPIRED_WRITE],
    ["suggest_edit", EXPIRED_WRITE], ["accept_suggestion", EXPIRED_WRITE], ["reject_suggestion", EXPIRED_WRITE], ["add_comment", EXPIRED_WRITE],
    ["reply_to_comment", EXPIRED_WRITE], ["resolve_thread", EXPIRED_WRITE], ["reopen_thread", EXPIRED_WRITE],
  ], bad, log);

  ctx.step("the editor is told, by every tool, what an absent id is told");
  await probeTools(eM, "editor", d.id, ["get_document", "update_document", "commit_draft", "rename_document", "move_document", "fork_document", "get_comments", "add_comment"].map((t) => [t, absentMsg]), bad, log);

  ctx.ev.json("mcp-expired", log);
  assert.equal(bad.length, 0, `MCP on an expired document: ${bad.length} differ\n  ${bad.join("\n  ")}`);
});

scenario("A2.mcp-names no MCP tool name matches delete|remove|share|grant|access, and the tools are exactly SPEC §19's twenty-three", {
  tiers: ["local", "prod"],
  ...STALLS,
  timeoutMs: 120_000,
}, async (ctx) => {
  const [acct] = await cast(target, ["owner"]);
  const mcp = await mcpFor(ctx, await signIn(acct), "owner");
  const names = (await mcp.listTools()).map((t) => t.name);
  ctx.step(`tools/list: ${names.join(", ")}`);
  assert.deepEqual(names.filter((n) => DESTRUCTIVE.test(n)), [], "destructive or sharing tool names");
  assert.deepEqual([...names].sort(), [...SPEC_TOOLS].sort(), "the tool set is SPEC §19's table");
});
