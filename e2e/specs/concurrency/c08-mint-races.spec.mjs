// SPDX-License-Identifier: Apache-2.0
// Concurrency C8, C9, C9b: N mints racing on one base, in the app and through update_document, make exactly one version whose stored bytes are the winner's, tell every loser so, and leave a draft saved afterwards alone (SPEC §2, §4, §6a, §16).

/**
 * THE SCENARIOS (each n: [2, 5, 10, 20]; races K trials per N by the plan,
 * serial positive controls 2/1/1/1)
 *
 * C8   N × "Save as new version" in the app. N editors are "Shared" on
 *      crdt-paragraphs, each types a token into its own paragraph, and the
 *      session settles (settleLive: the plan's live-editing conditions).
 *        C8 race (SYNC-H)  every editor presses Save; each page saves its
 *             draft (POST /draft) and its POST /commit is HELD in the browser
 *             until all N are held, then released in one loop; the overlap
 *             proof (max(send) < min(firstByte), the browser's own timing)
 *             or INCONCLUSIVE. Oracles: I6 (exactly one version on v1, and
 *             the document points at it), one "Published vN." toast and N−1
 *             conflict toasts ("…newer version…"), I7 (REHASH of the new
 *             version equals its record, and its stored entry is the draft
 *             every commit read), and a draft the owner saves on the new
 *             version afterwards survives the server settling (counts stable
 *             for 10 s).
 *        C8 S4b (SYNC-P, amplify-c08-mint-races) a LATE loser: every commit
 *             is held at commit-before-read (after the endpoint's base check,
 *             before the draft is read); the first is let go and publishes,
 *             deleting the draft; the losers are let go to read it (now
 *             absent) and held at commit-after-read; the owner saves a fresh
 *             draft on the new version; the losers are let go. S4b
 *             (functions/src/lib/draft.ts commitDraft: the base files alone
 *             hash to v1's contentHash, so the dedup branch answers 200
 *             deduped and deletes `draft` and docs/{d}/draft/ whatever base
 *             they now hold) predicts "No changes to publish" for every loser
 *             and the fresh draft gone. Its own oracle is that prediction and
 *             nothing wider: no loser told "No changes to publish" with its
 *             POST /commit answered 200 deduped, and the fresh draft not gone
 *             (docs/{d}.draft and docs/{d}/draft/{entry} both there). Every
 *             other deviation is not S4b's and FAILS: a missing or second
 *             "Published", a loser's error or save-failed toast, a conflict
 *             toast whose POST /commit was not a 409, the fresh draft there
 *             but on another base or without its marker (an editor's
 *             autosave over it: the C12/S8 class, seen once while authoring).
 *        C8 S4 (SYNC-P, amplify-mint-join) DIVERGENT drafts: the first
 *             commit is held at mint-before-id after reading draft D1; each
 *             loser then types one more token and presses Save, so its
 *             commit reads a later draft, and is held there too; the first is
 *             let go to upload v2/ and is held at mint-after-upload; the
 *             losers are let go to choose v2 as well (the first has no record
 *             yet) and upload over it, and are held there too; the first
 *             commits, then the losers (STALE). S4 (draft.ts commitDraft
 *             uploads to docs/{d}/v(N+1)/ with no precondition) predicts the
 *             loser's bytes under the winner's record. Its own oracle: I7
 *             failing with a LOSER's bytes stored (judgeI7Split); I7 failing
 *             any other way (nobody's sent bytes, nothing stored, REHASH off
 *             with the winner's entry) is not S4's and FAILS. The same split
 *             is every S4 case's (C9 race, C9 S4, C9b S4).
 *        C8 serial positive control  the same saves one after another.
 *             An editor's base follows the current version (app/src/pages/
 *             DocViewer.tsx: editing is { baseVersion: doc.currentVersion }),
 *             so a Save pressed after a publish is a new edit on the new
 *             version, not a loser. So each other editor types a token,
 *             autosaves it on v1 and presses Save, and its POST /commit (on
 *             v1, as in the race) waits in its own browser; the first then
 *             publishes alone, the owner saves a fresh draft on it, and each
 *             held commit reaches the server in turn. Every C8 oracle must
 *             PASS. The positive control of all three.
 *
 * C9   N × update_document on the same base v1, with nobody in the editor
 *      (v0.16.0 refuses an update under an editor, SPEC §6a). N agents are N
 *      MCP tokens of the owner, each sending its own content.
 *        C9 race (SYNC-T)  N worker threads fire tools/call at one instant
 *             (lib/sync.mjs syncHttp, given the target: every request and its
 *             warm-up asked of the isolation check and the production guard
 *             before any is sent, each traced into the case's http.jsonl;
 *             spread ≤ 15 ms and the overlap proof, or INCONCLUSIVE).
 *             Oracles: exactly one update succeeds (not deduplicated), N−1
 *             are refused as stale ("Somebody published a newer version…" or
 *             "the document is at vN now, not v1"), I6, and I7 against the
 *             winner's content. S4 (functions/src/lib/
 *             publish.ts commitNewVersion uploads before its transaction) makes
 *             I7 fail only when a loser chose the same id and its upload ended
 *             after the winner's, which a natural race reaches by chance (at
 *             N=2 in 5 of 6 trials of the last round). So one trial says S4
 *             was seen or was NOT REPRODUCED, never that it is fixed: a
 *             loser's bytes under the winner's record is S4's own oracle
 *             failing (a TODO); I7 holding ends the trial NOT REPRODUCED
 *             (ctx.notReproduced: neither a pass nor run.mjs's exit 3; it
 *             used to read "passed unexpectedly", the defect looks fixed),
 *             with whether a collision happened at all (collisionOf: a loser
 *             refused "…while this one was uploading" had uploaded to
 *             v(max+1) as it read it; with no version prefix left without a
 *             record, every such loser uploaded to the minted id and the
 *             winner's upload merely ended last). summary.md reads S4's rate
 *             over the K trials from those outcomes ("C9 … [N=2]: S4 seen in
 *             s of K trials (k not reproduced)"); each trial also appends a
 *             row to the invocation's c08-mint-races.jsonl ({scenario: "C9
 *             race", s4Seen, whose, collision}) for what it saw. C9 S4 is the
 *             case that decides whether S4 is fixed; once it is, drop
 *             C9_RACE_DEFECT and a trial whose I7 holds PASSES.
 *        C9 S4 (SYNC-P, amplify-c08-mint-races) the same N updates made
 *             deterministic: all held at update-before-id, the first let go
 *             to upload and held at update-after-upload, the rest let go to
 *             choose the same id and upload over it, then the first commits
 *             alone and its call is awaited (it succeeded: its version is
 *             current) before the rest are let go. Its own oracle: I7 with a
 *             loser's bytes stored.
 *        C9 serial positive control  the same N updates one after another:
 *             one success, N−1 stale, I6, I7. Must PASS.
 *
 * C9b  update_document mixed with in-app commits (SPEC §6a: "/publish?update=,
 *      the CLI and update_document are refused with 409 { error, editors }
 *      while anybody has the document open in the editor").
 *        C9b mixed (SYNC-P, amplify-mint-join)  ceil(N/2) editors press Save
 *             and their commits are held at mint-before-id (past the base
 *             check, every one in flight); while they are held, N−ceil(N/2)
 *             agents fire update_document on v1 (SYNC-T). Oracles: every
 *             update is refused for the editors, uploads nothing (nothing
 *             under v2/ yet) and leaves the draft and its live log alone
 *             (controls-c09b-refusal-drops-draft plants a refusal that
 *             uploads and drops them); then the commits are let go: one
 *             "Published", the rest conflict, I6 (the version is the
 *             editor's), I7.
 *        C9b S4 across the two mint paths (SYNC-P, both amplify sets)  the
 *             window §6a names ("somebody who opens the editor between the
 *             question and the new version"): N−1 agents pass the editors
 *             question while nobody edits and are held at update-before-id;
 *             p1 then opens the editor and presses Save, and its commit
 *             uploads v2/ and is held at mint-after-upload; the agents are let
 *             go to choose v2 too and upload over it; p1 commits, the agents
 *             are refused as stale. S4 on both paths at once. Its own
 *             oracle: I7 with a loser's bytes stored.
 *        C9b S4b across the two mint paths (SYNC-P, amplify-c08-mint-races)
 *             the same window with the UPDATE winning: p1 edits alone and
 *             leaves (its draft on v1); the N−1 agents pass the editors
 *             question while nobody edits and are held at update-before-id;
 *             p1 opens the editor and presses Save, and its commit passes
 *             POST /commit's base check (v1 is current, functions/src/
 *             index.ts:1330) and is held at commit-before-read; the first
 *             agent is let go alone and its call awaited: it mints v2 and
 *             drops the draft (publish.ts dropReplacedDraft); p1's commit is
 *             let go to read, held at commit-after-read to prove the draft
 *             prefix it read was empty (else INCONCLUSIVE: the window was not
 *             reached), and let go; then the other agents (v3, stale). S4b
 *             (draft.ts commitDraft: v1's files alone hash to v1's
 *             contentHash, so the dedup branch answers 200 deduped) predicts
 *             "No changes to publish". Its own oracle, narrowed as C8 S4b's:
 *             p1 is not told "No changes to publish" with a 200 deduped.
 *             Others: p1's Save is a conflict toast with POST /commit 409
 *             and publishes nothing; exactly one update (the first) succeeds
 *             and the rest are stale (with p1: one success, N−1 stale); the
 *             update, once current, dropped the draft (SPEC §6a); I6 (v2 via
 *             mcp); I7 (v2 holds the agent's bytes).
 *        C9b S4b serial positive control  the same, with p1's POST /commit
 *             held in its own browser (holdRequests, as C8 serial) instead
 *             of in the server past the base check, so it reaches the server
 *             only once the agent's version is current: 409 and a conflict
 *             toast, and every other oracle the same. Must PASS.
 *             controls-c09b-stale-commit-deduped plants a stale /commit
 *             answered 200 deduped, and this control goes red.
 *        C9b serial positive control  p1 edits and publishes first, then the
 *             agents update on v1 one after another: one "Published", N−1
 *             stale, I6, I7. Must PASS.
 *
 * STACK. The gated cases need the gate service and both amplify sets:
 *   node e2e/run.mjs run --suite concurrency --spec c08-mint-races.spec.mjs \
 *     --patches amplify-mint-join --patches amplify-c08-mint-races --n 2 --trials 2
 * Without them those cases are SKIPPED with the missing capability; the
 * races and the serial controls run on any stack, but for C9b S4b's serial
 * control, whose agents pass the editors question at update-before-id
 * before the editor opens. A held request must be let
 * go well inside the Hosting emulator's 60 s cut-off; one that got Hosting's
 * 504 instead is the stack's answer, not the product's, and the case is
 * INCONCLUSIVE.
 *
 * SPEC: §2 "versions immutable — a commit always mints a NEW vN+1", "POST
 * /commit … 409 if stale … dedups on contentHash (identical bytes → no-op,
 * clear the draft, deduped: true)"; §4 "Versions are immutable"; §9.1 the
 * content hash; §16 "The stale-base 409 stays, and now means only what it
 * always meant: somebody PUBLISHED a new version while you were editing";
 * §6a "No update is made under somebody's editor … Once the version is
 * current, the draft's files and its live log are dropped (§16); a refused
 * or deduplicated update leaves both alone. A race remains … somebody who
 * opens the editor between the question and the new version loses what they
 * type in that window" (docs/architecture/spec.md:776-785: the window C9b S4
 * and C9b S4b open; losing the typing is allowed there, being told "No
 * changes to publish" instead of the stale 409 is not).
 *
 * In a `defect:` case only that defect's own oracle is an AssertionError (a
 * TODO); every other oracle that fails there is a plain error, a FAIL, so
 * one defect never hides another failure. A failed sync precondition (a
 * request never held, no overlap, a peer never "Shared", a gated window not
 * reached) is INCONCLUSIVE, never FAIL. Only the C9 race, a natural race that
 * held but reaches S4's window by chance, ends a trial NOT REPRODUCED.
 *
 * Joining is live.mjs joinShared on every target: one POST /access on a
 * local stack, share() per editor through the operator script elsewhere (no
 * email, so no `effects`). On production joinShared ends a case INCONCLUSIVE
 * at its S16 stop (scripts/set-access.mjs writes no RTDB mirror) before any
 * editor is in the document, so the C8 race and the C8 serial control (the
 * BOTH-tier in-app cases) become measurable there once S16 is fixed. The
 * gated cases are LOCAL: an amplify set is applied to a local stack copy.
 */

import { readLiveLogs } from "../../lib/live-log.mjs";
import assert from "node:assert/strict";
import { AssertionError } from "node:assert";
import { createHash } from "node:crypto";
import { after } from "node:test";
import { currentTarget, precondition, scenario } from "../../lib/test.mjs";
import { cast, rand4, runTag } from "../../lib/accounts.mjs";
import { mintToken, openSession } from "../../lib/session.mjs";
import { publish, readFixture } from "../../lib/seed.mjs";
import { readDraftObject, draftStoragePrefix, closeAdmin, listObjects, readDoc, readObject, rtdbGet } from "../../lib/admin.mjs";
import { eventually, settleStill } from "../../lib/assert.mjs";
import { tokenLog } from "../../lib/tokens.mjs";
import { idSelector } from "../../lib/frame.mjs";
import { rehashVersion } from "../../lib/bytes.mjs";
import { ACCEPT, DEFAULT_PROTOCOL, parseMcpBody, toolOutcome } from "../../lib/mcp.mjs";
import { gates, requireHeld } from "../../lib/gates.mjs";
import { holdRequests, requireConclusive, syncHttp } from "../../lib/sync.mjs";
import { assertInvariant, checkI6, checkI7, readVersions } from "../../lib/invariants.mjs";
import { joinShared, settleLive, typeProbe } from "../../lib/live.mjs";
import { measure } from "../../lib/evidence.mjs";

const target = currentTarget();
after(() => (target ? closeAdmin(target) : undefined));

const FIXTURE = "crdt-paragraphs.html";
const BOTH = ["local", "prod"];
const LOCAL = ["local"];
const MINT_JOIN = ["gates", "patch:amplify-mint-join"];
const RACES = ["gates", "patch:amplify-c08-mint-races"];
const N = [2, 5, 10, 20];
/** Serial positive controls show the oracle passes without the race; no statistics needed. */
const SERIAL_TRIALS = { 2: 2, 5: 1, 10: 1, 20: 1 };
const LIVE = { inconclusiveOnStackTimeout: true, inconclusiveOnPageStall: true };
const APP_CASE_MS = 900_000;
const MCP_CASE_MS = 420_000;
const KEY_DELAY_MS = 25;
/** A Save's outcome toast: POST /draft, then POST /commit, on a loaded stack. */
const COMMIT_MS = 150_000;
/** How long a gate or a browser hold may wait for its callers: well inside Hosting's 60 s cut-off for those already held. */
const HELD_MS = 40_000;
/** A request of the case's own, past Hosting's cut-off so a stalled one ends in its 504. */
const HTTP_MS = 150_000;
/** The plan's server settle: counts stable for 10 s. */
const SERVER_STABLE_MS = 10_000;
const SERVER_DEADLINE_MS = 120_000;

/** The losers' words (app/src/edit.ts StaleVersionError, DocViewer onStale): User.saveAsNewVersion's "conflict". */
const CONFLICT_OUTCOME = "conflict";
/** commitNewVersion's STALE: the update had already uploaded its bytes to v(max+1) as it read it (functions/src/lib/publish.ts). */
const UPLOADED_STALE_RE = /Somebody published a newer version while this one was uploading/;
/** update_document's own base check, before anything is uploaded (functions/src/mcp/tools.ts). */
const EARLY_STALE_RE = /the document is at v\d+ now, not v\d+/;
const STALE_RE = new RegExp(`${UPLOADED_STALE_RE.source}|${EARLY_STALE_RE.source}`);
/** The invocation's measurement file (lib/evidence.mjs measure): one row per C9 race trial. */
const MEASURE = "c08-mint-races";
/**
 * The C9 race's known defect. While it is set, a trial whose I7 holds is NOT
 * REPRODUCED (ctx.notReproduced), never "passed unexpectedly": a natural
 * race reaches S4's window only by chance. C9 S4 decides whether S4 is
 * fixed; once it is, set this to null and such a trial PASSES.
 */
const C9_RACE_DEFECT = null;
/** editorsRefusal (functions/src/lib/presence.ts). */
const EDITORS_RE = /open in the editor, where this would be lost/;

const sha = (b) => createHash("sha256").update(b).digest("hex");
const short = (h) => (typeof h === "string" ? h.slice(0, 12) : String(h));
const paragraph = (i) => `e2e-${i + 1}`;
const isAssertion = (err) => err instanceof AssertionError || err?.code === "ERR_ASSERTION";
/** A promise that never rejects: {ok, value} or {ok: false, error}. */
const settled = (p) => p.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

// --- oracles collected, so one failing never hides another -----------------------------

/**
 * Collect oracle results. `check(fn)` runs one and keeps its AssertionError;
 * anything else is thrown at once (a harness error, an INCONCLUSIVE).
 * `own(defect)` turns what was collected into the case's outcome.
 */
function oracleSet() {
  const failed = [];
  return {
    failed,
    async check(fn) {
      try {
        await fn();
      } catch (err) {
        if (!isAssertion(err)) throw err;
        failed.push(err.message);
      }
    },
  };
}

/**
 * The case's outcome from two collections: `others` (every oracle that is
 * not the case's defect's) and `own` (the defect's). Without a defect both
 * are one AssertionError. With one, a failure in `others` is a plain error
 * (a FAIL: not this defect's oracle), and only `own` can be the TODO.
 */
function verdict({ defect = null, others, own = null }) {
  const ownMsgs = own?.failed ?? [];
  if (!defect) {
    const all = [...others.failed, ...ownMsgs];
    if (all.length) throw new AssertionError({ message: all.join(" | "), actual: all, expected: [], operator: "oracles" });
    return;
  }
  if (others.failed.length) {
    const err = new Error(`not ${defect}'s oracle: ${others.failed.join(" | ")}${ownMsgs.length ? ` (and ${defect}'s own: ${ownMsgs.join(" | ")})` : ""}`);
    err.code = "E2E_C08_OTHER_ORACLE";
    throw err;
  }
  if (ownMsgs.length) throw new AssertionError({ message: ownMsgs.join(" | "), actual: ownMsgs, expected: [], operator: defect });
}

// --- the server's state ----------------------------------------------------------------

/** What a mint race leaves: the pointer, the draft, every version record and every object under docs/{d}/. */
async function serverSnapshot(docId) {
  const d = await readDoc(target, `docs/${docId}`);
  const versions = await readVersions(target, docId);
  const objects = await listObjects(target, `docs/${docId}/`);
  const draft = d?.draft
    ? { baseVersion: d.draft.baseVersion ?? null, bytes: d.draft.bytes ?? null, updatedByEmail: d.draft.updatedByEmail ?? null, updatedAt: d.draft.updatedAt?.toMillis?.() ?? null }
    : null;
  const selected = versions.map((v) => `${v.storagePrefix ?? `docs/${docId}/${v.id}`}/`);
  if (d?.draft) selected.push(`${draftStoragePrefix(docId, d.draft)}/`);
  const orphanedObjects = objects.filter((name) => name.startsWith(`docs/${docId}/bundles/`) && !selected.some((prefix) => name.startsWith(prefix)));
  return {
    currentVersion: d?.currentVersion ?? null,
    draft,
    orphanedObjects,
    versions: versions.map((v) => `${v.id}<${v.parentVersion ?? "-"}:${short(v.contentHash)}:${v.publishedVia}`),
    objects,
  };
}

/**
 * The plan's server settle (lib/assert.mjs settleStill): the snapshot
 * unchanged for SERVER_STABLE_MS within SERVER_DEADLINE_MS. Running out is
 * E2E_SETTLE_TIMEOUT, worded as a wait: a FAIL on a stack that kept
 * answering (something kept writing after every request had been
 * answered), which only the stack judges (pageStall, functionKill) may
 * excuse under load. Kept in the case's evidence as server-<what>.json.
 */
async function settleServer(ctx, docId, what) {
  const state = await settleStill(() => serverSnapshot(docId), {
    quietMs: SERVER_STABLE_MS,
    deadlineMs: SERVER_DEADLINE_MS,
    what: `${what}: the server's state of ${docId}`,
    step: (line) => ctx.step(line),
  });
  ctx.ev.json(`server-${what.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, state);
  return state;
}

/** I6, and the one version minted on v1 being the one the document points at. Resolves that version's row. */
async function judgeOneVersion(ctx, docId, { via = null } = {}) {
  const versions = await readVersions(target, docId);
  const d = await readDoc(target, `docs/${docId}`);
  ctx.ev.json("versions", { currentVersion: d?.currentVersion, versions });
  const r = checkI6(versions, { base: "v1" });
  const minted = versions.filter((v) => v.id !== "v1");
  const failures = [...r.failures];
  if (minted.length !== 1) failures.push(`${minted.length} version(s) minted on top of v1 (${minted.map((v) => `${v.id} on ${v.parentVersion}`).join(", ") || "none"}), not one`);
  else if (d?.currentVersion !== minted[0].id) failures.push(`the document points at ${d?.currentVersion}, not the one version minted (${minted[0].id})`);
  if (via && minted.length === 1 && minted[0].publishedVia !== via) failures.push(`${minted[0].id} was published via ${minted[0].publishedVia}, not ${via}`);
  assertInvariant({ ...r, ok: failures.length === 0, failures });
  return minted[0];
}

/**
 * I7 on `versionId`, read and judged but not asserted: the §9.1 hash over GET
 * /download against the record's contentHash, and the stored entry against
 * `winnerBytes` (`winner` names it). `known` names other contents ({label:
 * bytes}) to say whose bytes are stored instead. Resolves {r (checkI7's
 * result, its failures naming whose entry is stored), whose, byLoser (the
 * stored entry is one of `known` other than the winner's: S4's signature)}.
 * A missing record is an AssertionError.
 */
async function readI7(ctx, http, docId, versionId, winnerBytes, { winner = "the winner", known = {} } = {}) {
  const rec = await readDoc(target, `docs/${docId}/versions/${versionId}`);
  assert.ok(rec, `I7: docs/${docId}/versions/${versionId} exists`);
  const prefix = rec.storagePrefix ?? `docs/${docId}/${versionId}`;
  const stored = await readObject(target, `${prefix}/${rec.entry}`);
  const re = await rehashVersion({ target, http, docId, versionId });
  const storedSha = stored ? sha(stored) : "absent";
  const candidates = [[winner, winnerBytes], ...Object.entries(known)];
  const whose = candidates.find(([, b]) => b && stored && sha(b) === storedSha)?.[0] ?? (stored ? "nobody's sent bytes" : "absent");
  const byLoser = whose !== winner && Object.prototype.hasOwnProperty.call(known, whose);
  ctx.ev.json(`i7-${versionId}`, { recordHash: rec.contentHash, rehash: re.contentHash, files: re.files, storedSha, winnerSha: sha(winnerBytes), whose, byLoser });
  const r = checkI7({ rehash: re.contentHash, recordHash: rec.contentHash, storedSha, winnerSha: sha(winnerBytes) });
  ctx.step(`I7 on ${versionId}: REHASH ${short(re.contentHash)} vs record ${short(rec.contentHash)}; the stored entry is ${whose}'s`);
  return { r: r.ok ? r : { ...r, failures: [...r.failures, `${versionId}'s stored entry is ${whose}'s`] }, whose, byLoser };
}

/** I7 on `versionId` (readI7), asserted whole: every way it fails is one AssertionError. */
async function judgeI7(ctx, http, docId, versionId, winnerBytes, opts = {}) {
  assertInvariant((await readI7(ctx, http, docId, versionId, winnerBytes, opts)).r);
}

/**
 * I7 on `versionId`, split for a case whose defect is S4: a failure with a
 * LOSER's entry stored (S4's signature: the loser's upload replaced the
 * winner's under the winner's record) goes to `own`; every other failure
 * (nobody's sent bytes, nothing stored, REHASH off with the winner's entry
 * stored, no record) to `others`. Resolves readI7's result, or null when it
 * could not be read.
 */
async function judgeI7Split(ctx, http, docId, versionId, winnerBytes, { winner, known, others, own }) {
  let i7 = null;
  await others.check(async () => {
    i7 = await readI7(ctx, http, docId, versionId, winnerBytes, { winner, known });
  });
  if (!i7 || i7.r.ok) return i7;
  await (i7.byLoser ? own : others).check(() => assertInvariant(i7.r));
  return i7;
}

// --- the app: a live session, its saves, their outcomes ---------------------------------------

/** N editors Shared on the fixture (lib/live.mjs joinShared), plus v1's entry name. */
async function liveSession(ctx, label, { n = ctx.n, enter = true } = {}) {
  const s = await joinShared(ctx, { n, fixture: FIXTURE, title: `${label} N=${ctx.n}`, enter });
  const v1 = await readDoc(target, `docs/${s.docId}/versions/v1`);
  precondition(typeof v1?.entry === "string", `v1 of ${s.docId} has an entry (${JSON.stringify(v1?.entry)})`);
  return { ...s, entry: v1.entry, v1Hash: v1.contentHash };
}

/** Each of `users` types one token at the end of its own paragraph (users[i] → #e2e-(i+1) of the session). */
async function typeTokens(s, log, users = s.users) {
  await Promise.all(users.map((u) => {
    const id = paragraph(s.users.indexOf(u));
    return typeProbe(u, idSelector(id), log.next(u.name, id), { delay: KEY_DELAY_MS });
  }));
}

/**
 * Each editor types one token into its own paragraph, then the session
 * settles: the plan's live-editing conditions (lib/live.mjs settleLive). Two
 * or more editors are judged on I1; a lone editor (C9b: one editor beside
 * the agents) on its body's stability, with every other condition the same
 * (nothing dirty, saving or in error, no POST /draft for 3 s, status/{d}/y
 * stable for 2 s).
 */
async function typeAndSettle(ctx, s, log) {
  await typeTokens(s, log);
  const live = await settleLive(s.users, { docId: s.docId, n: s.users.length });
  ctx.step(`${s.users.length} editor(s) typed a token each; the session settled in ${live.ms} ms (${live.alone ? "one editor: its body's stability" : `I1 over ${live.peers} peers`}; save states ${JSON.stringify(live.saveStates)}; ${live.yEntries} y entries)`);
  return live;
}

/** Record every POST /draft and POST /commit each page sends from now on. */
function captureSaves(users) {
  return new Map(users.map((u) => [u.name, u.capture({ paths: ["/draft", "/commit"], method: "POST" })]));
}

/**
 * A page's last POST /commit and POST /draft, as {status, json, html?} (null
 * when it sent none), once every captured row has settled (at most 15 s).
 */
async function answersOf(rows) {
  await eventually(() => rows.every((r) => r.settled), { timeout: 15_000, interval: 100, message: "every captured save settled" }).catch(() => undefined);
  const last = (path) => rows.filter((r) => r.path === path).at(-1) ?? null;
  const c = last("/commit");
  const d = last("/draft");
  return {
    commit: c ? { status: c.status, json: c.json, state: c.state } : null,
    draft: d ? { status: d.status, state: d.state, html: d.postJson?.html ?? null } : null,
  };
}

/** The html of a page's last ANSWERED POST /draft, now, without waiting (its commit may be held). */
function lastSavedHtml(rows) {
  return rows.filter((r) => r.path === "/draft" && r.status === 200).at(-1)?.postJson?.html ?? null;
}

/** Press Save as new version without waiting: a settled promise of {name, outcome, text, versionId}. */
function pressSave(u) {
  return settled(u.saveAsNewVersion({ timeout: COMMIT_MS }).then((r) => ({ name: u.name, outcome: r.outcome, text: r.text, versionId: r.versionId })));
}

/**
 * Every pressed Save's outcome, with what its page's POST /commit was
 * answered. A 504 at a held request is Hosting's cut-off, not the product:
 * INCONCLUSIVE. A Save that never showed an outcome is a plain error.
 */
async function outcomesOf(ctx, users, pending, caps) {
  const results = await Promise.all(pending);
  const rows = [];
  for (const [i, u] of users.entries()) {
    const a = await answersOf(caps.get(u.name));
    const r = results[i];
    rows.push(r.ok ? { ...r.value, answer: a.commit, draft: a.draft ? { status: a.draft.status } : null } : { name: u.name, outcome: "none", text: String(r.error?.message ?? r.error).slice(0, 300), answer: a.commit, draft: a.draft ? { status: a.draft.status } : null });
  }
  ctx.ev.json("saves", rows);
  const cut = rows.filter((r) => r.answer?.status === 504 || r.draft?.status === 504);
  if (cut.length) ctx.inconclusive(`the stack did not answer, so nothing was measured: Hosting's cut-off (504) answered ${cut.map((r) => r.name).join(", ")}'s save — a hold outlasted the emulator's 60 s`);
  const none = rows.filter((r) => r.outcome === "none");
  if (none.length) {
    const err = new Error(`a Save showed no outcome toast: ${none.map((r) => `${r.name}: ${r.text}`).join("; ")}`);
    err.code = "E2E_C08_NO_OUTCOME";
    throw err;
  }
  ctx.step(`outcomes: ${rows.map((r) => `${r.name} ${r.outcome}${r.versionId ? ` ${r.versionId}` : ""} (POST /commit ${r.answer ? `${r.answer.status} ${JSON.stringify(r.answer.json)}` : "not sent"})`).join("; ")}`);
  return rows;
}

/**
 * The saves' outcome toasts against "exactly `published` "Published vN."
 * toast(s), every other Save a conflict toast whose POST /commit was answered
 * 409" (SPEC §2 "409 if stale"), split for S4b: `s4b` holds S4b's signature
 * alone, a Save told "No changes to publish" whose POST /commit was answered
 * 200 deduped; `other` every other miss (a missing or extra "Published", an
 * error or save-failed toast, a "No changes" that was no dedup, a conflict
 * toast whose POST /commit was not a 409).
 */
function toastSplit(rows, { published: want = 1 } = {}) {
  const why = (r) => `${r.name}: ${r.outcome} "${r.text}"${r.answer ? ` (POST /commit ${r.answer.status} ${JSON.stringify(r.answer.json)})` : " (no POST /commit answered)"}`;
  const published = rows.filter((r) => r.outcome === "published");
  const s4b = [];
  const other = [];
  if (published.length !== want) other.push(`${published.length} "Published" toast(s), not ${want === 1 ? "one" : want}${published.length ? ` (${published.map(why).join("; ")})` : ""}`);
  for (const r of rows) {
    if (r.outcome === "published") continue;
    if (r.outcome === CONFLICT_OUTCOME && r.answer?.status === 409) continue;
    if (r.outcome === "error" && r.answer?.status === 409 && r.answer.json?.draftChanged === true) continue;
    if (r.outcome === "nochange" && r.answer?.status === 200 && r.answer.json?.deduped === true) s4b.push(why(r));
    else other.push(why(r));
  }
  return { s4b, other };
}

const toastsWanted = (want) => (want === 1 ? `one "Published vN." toast and every other editor a conflict toast` : `no Save publishes and every Save is told of the newer version (POST /commit 409, a conflict toast)`);

/** toastSplit asserted whole, both halves one AssertionError: for a case whose defect is not S4b. */
function judgeToasts(rows, label, { published = 1 } = {}) {
  const { s4b, other } = toastSplit(rows, { published });
  const failures = [...other, ...s4b];
  assert.ok(failures.length === 0, `${label}: ${toastsWanted(published)} — ${failures.join("; ")}`);
}

/** toastSplit for a case whose defect is S4b: its signature to `own`, every other miss to `others`. */
async function judgeToastsSplit(rows, label, { published = 1, others, own }) {
  const { s4b, other } = toastSplit(rows, { published });
  await others.check(() => assert.ok(other.length === 0, `${label}: ${toastsWanted(published)} — ${other.join("; ")}`));
  await own.check(() => assert.ok(s4b.length === 0, `${label}: every losing Save is told of the newer version, never "No changes to publish" (S4b: a 200 deduped onto the old version) — ${s4b.join("; ")}`));
}

/** The fixture's body with a fresh paragraph holding `marker`: a draft somebody saves on the new version. */
function freshHtml(bytes, marker) {
  const html = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  precondition(html.includes("</body>"), "the new version's entry has a </body> to put the fresh paragraph before");
  return html.replace("</body>", `<p id="c08-fresh">${marker}</p>\n</body>`);
}

/** The owner saves a fresh draft on `baseVersion` through POST /draft, as any editor's autosave does. */
async function saveFreshDraft(ctx, s, baseVersion, bytes, marker) {
  const r = await s.owner.http.postJson("/draft", { docId: s.docId, baseVersion, html: freshHtml(bytes, marker) }, { timeoutMs: HTTP_MS });
  precondition(r.status === 200, `the fresh draft on ${baseVersion} saved: POST /draft answered ${r.status} ${JSON.stringify(r.json)}`);
  ctx.step(`the owner saved a fresh draft on ${baseVersion} (marker ${marker})`);
}

/**
 * What became of a draft saved on `baseVersion` after it was published:
 * `gone` (docs/{d}.draft or its entry object deleted: S4b's dedup branch
 * deletes both) and `other` (still there, but on another base or without the
 * marker: somebody saved over it).
 */
async function freshDraftSplit(s, baseVersion, marker) {
  const d = await readDoc(target, `docs/${s.docId}`);
  const obj = await readDraftObject(target, s.docId, s.entry);
  const gone = [];
  const other = [];
  if (!d?.draft) gone.push(`docs/${s.docId}.draft is gone`);
  else if (d.draft.baseVersion !== baseVersion) other.push(`docs/${s.docId}.draft is on ${d.draft.baseVersion}, not ${baseVersion}`);
  if (!obj) gone.push(`docs/${s.docId}/draft/${s.entry} is gone`);
  else if (!obj.toString("utf8").includes(marker)) other.push(`docs/${s.docId}/draft/${s.entry} no longer holds the fresh draft's marker`);
  return { gone, other };
}

const freshWanted = (baseVersion) => `fresh draft: a draft saved on ${baseVersion} after it was published survives`;

/** The fresh draft is still the document's draft (freshDraftSplit, both halves one AssertionError). */
async function judgeFreshDraft(s, baseVersion, marker) {
  const { gone, other } = await freshDraftSplit(s, baseVersion, marker);
  const failures = [...gone, ...other];
  assert.ok(failures.length === 0, `${freshWanted(baseVersion)} — ${failures.join("; ")}`);
}

/** freshDraftSplit for a case whose defect is S4b: the draft gone to `own`, the draft overwritten to `others`. */
async function judgeFreshDraftSplit(s, baseVersion, marker, { others, own }) {
  let split = null;
  await others.check(async () => {
    split = await freshDraftSplit(s, baseVersion, marker);
  });
  if (!split) return;
  await others.check(() => assert.ok(split.other.length === 0, `${freshWanted(baseVersion)} as that draft, unchanged — ${split.other.join("; ")}`));
  await own.check(() => assert.ok(split.gone.length === 0, `${freshWanted(baseVersion)} — ${split.gone.join("; ")}`));
}

/** Release every gate this case armed, whatever happened. */
async function releaseAll(g, names) {
  for (const name of names) await g.release(name).catch(() => undefined);
}

// --- agents: N MCP tokens and their update_document ----------------------------------------

/** The fixture with a paragraph naming `label`: one agent's whole new content. */
function contentFor(label) {
  return readFixture(FIXTURE, { raw: true }).toString("utf8").replace("</body>", `<p id="c09-agent">${label}</p>\n</body>`);
}

/** `k` agents of `session` (the owner): an mcp-channel token, a client and a content each. */
async function agentsOf(ctx, session, k, tag) {
  const agents = [];
  for (let i = 0; i < k; i += 1) {
    const name = `agent-${i + 1}`;
    const { token } = await mintToken(session, { name: `e2e ${tag} ${name}`, channel: "mcp" });
    agents.push({ name, token, mcp: ctx.mcp({ token, actor: name, timeoutMs: HTTP_MS, cutoffError: true }), content: contentFor(`${tag}-${runTag(target.runId)}-${rand4()}-${name}`) });
  }
  return agents;
}

/** A fresh owner and document for the C9 cases: {owner, docId, entry}. */
async function ownedDoc(ctx, label) {
  const [acct] = await cast(target, ["owner"], { http: ctx.http({ actor: "harness" }) });
  const owner = await openSession(target, acct, { timeoutMs: 120_000 });
  const up = await publish(owner.http, { fixture: FIXTURE, title: `${label} N=${ctx.n}`, name: "c09", timeoutMs: 120_000 });
  const v1 = await readDoc(target, `docs/${up.docId}/versions/v1`);
  precondition(typeof v1?.entry === "string", `v1 of ${up.docId} has an entry`);
  return { owner, docId: up.docId, entry: v1.entry };
}

/** An update_document outcome's kind: success | deduped | stale | editors | other. */
function kindOf(out) {
  if (!out) return "other";
  if (!out.isError) return out.json?.deduped === true ? "deduped" : out.json?.versionId ? "success" : "other";
  if (STALE_RE.test(out.text)) return "stale";
  if (EDITORS_RE.test(out.text)) return "editors";
  return "other";
}

/** A settled update_document call (ctx.mcp client) → {name, kind, text, json}. A 504 at Hosting's cut-off rejects (E2E_STACK_CUTOFF). */
function callUpdate(agent, docId, baseVersion = "v1") {
  return settled(agent.mcp.call("update_document", { id: docId, content: agent.content, baseVersion }).then((out) => ({ name: agent.name, kind: kindOf(out), text: out.text?.slice(0, 300) ?? null, json: out.json ?? null })));
}

/** Settled update rows; a call that threw (Hosting's cut-off, a transport error) is thrown here, where the case's options judge it. */
async function updateRows(ctx, pending, label) {
  const rows = [];
  for (const r of await Promise.all(pending)) {
    if (!r.ok) throw r.error;
    rows.push(r.value);
  }
  ctx.ev.json(`updates-${label}`, rows);
  ctx.step(`${label}: ${rows.map((r) => `${r.name} ${r.kind}${r.json?.versionId ? ` ${r.json.versionId}` : ""}`).join("; ")}`);
  return rows;
}

/** Exactly `winners` updates succeed (none deduplicated) and every other is the `refusal` kind. Resolves the winners. */
function judgeUpdates(rows, { winners = 1, refusal = "stale", label }) {
  const ok = rows.filter((r) => r.kind === "success");
  const wrong = rows.filter((r) => r.kind !== "success" && r.kind !== refusal);
  const failures = [];
  if (ok.length !== winners) failures.push(`${ok.length} succeeded (${ok.map((r) => `${r.name} ${r.json?.versionId}`).join(", ") || "none"}), not ${winners}`);
  for (const r of wrong) failures.push(`${r.name}: ${r.kind} ${r.text ?? JSON.stringify(r.json)}`);
  assert.ok(failures.length === 0, `${label}: ${winners === 0 ? "no update succeeds" : winners === 1 ? "exactly one update succeeds" : `exactly ${winners} updates succeed`} and every other is refused as ${refusal} — ${failures.join("; ")}`);
  return ok;
}

/** One tools/call as a raw request for syncHttp. */
function toolRequest(token, name, args, id) {
  return {
    url: `${target.origin}/mcp`,
    method: "POST",
    // syncHttp adds the harness's user-agent and x-bikeshed-agent.
    headers: { authorization: `Bearer ${token}`, accept: ACCEPT, "content-type": "application/json", "mcp-protocol-version": DEFAULT_PROTOCOL },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    warm: `${target.origin}/config`,
  };
}

/**
 * Fire `agents`' update_document on `docId` at one instant (SYNC-T). The
 * guarded syncHttp asks the isolation check and the production guard about
 * every request and its warm-up before any is sent, and traces each into the
 * case's http.jsonl under the agent's name. Resolves {rows, run}.
 */
async function fireUpdates(ctx, agents, docId, label) {
  const requests = agents.map((a, i) => ({ ...toolRequest(a.token, "update_document", { id: docId, content: a.content, baseVersion: "v1" }, i + 1), actor: a.name }));
  const run = await syncHttp(requests, { target: ctx.target, timeoutMs: HTTP_MS });
  const rows = run.results.map((r, i) => {
    const name = agents[i].name;
    if (r.error) return { name, kind: "other", text: `request failed: ${r.error}`, json: null, status: null };
    let out = null;
    try {
      const messages = parseMcpBody(r.headers?.["content-type"], r.body);
      const msg = messages.find((m) => m.id === i + 1) ?? messages[0];
      out = msg?.result ? toolOutcome(msg.result) : null;
      if (!out) return { name, kind: "other", text: `no tool result: ${r.status} ${String(r.body).slice(0, 200)}`, json: null, status: r.status };
    } catch (err) {
      return { name, kind: "other", text: `unparsable answer ${r.status}: ${err.message}`, json: null, status: r.status };
    }
    return { name, kind: kindOf(out), text: out.text?.slice(0, 300) ?? null, json: out.json ?? null, status: r.status };
  });
  ctx.ev.json(`updates-${label}`, { spreadMs: run.spreadMs, limit: run.limit, overlap: run.overlap, rows, wire: run.results.map((r) => ({ i: r.i, status: r.status, firedAt: r.firedAt, sentAt: r.sentAt, firstByteAt: r.firstByteAt, endAt: r.endAt, error: r.error })) });
  ctx.step(`${label}: ${agents.length} update_document call(s) fired within ${Number(run.spreadMs).toFixed(1)} ms (overlap ${run.overlap.ok ? `proved, margin ${Number(run.overlap.marginMs).toFixed(0)} ms` : run.overlap.reason}): ${rows.map((r) => `${r.name} ${r.kind}${r.json?.versionId ? ` ${r.json.versionId}` : ""}`).join("; ")}`);
  const cut = rows.filter((r) => r.status === 504);
  if (cut.length) ctx.inconclusive(`the stack did not answer, so nothing was measured: Hosting answered 504 to ${cut.map((r) => r.name).join(", ")}`);
  return { rows, run };
}

/** Wait until nobody is in the editor (status/{d}/peers has no mode "edit"), or INCONCLUSIVE. */
async function nobodyEditing(ctx, docId) {
  await eventually(async () => {
    const peers = (await rtdbGet(target, `status/${docId}/peers`)) ?? {};
    return Object.values(peers).every((p) => p?.mode !== "edit");
  }, { timeout: 30_000, interval: 250, message: "nobody in the editor" }).catch(() => ctx.inconclusive(`the sync precondition did not hold: status/${docId}/peers still showed an editor 30 s after the last one left`));
}

/**
 * Whether a race's losers uploaded to the id the winner minted (S4's
 * window), from what they were told and what Storage kept: a loser refused
 * "…while this one was uploading" (commitNewVersion's STALE) had uploaded to
 * v(max+1) as it read it; one refused by update_document's own base check
 * uploaded nothing; a version prefix with no record is a losing upload that
 * chose a later id. {uploaded, early, orphans, collided, text}: `collided`
 * counts the losers that uploaded to `mintedId`, exactly when no prefix is
 * orphaned (every uploaded loser is then accounted for), else null (at most
 * uploaded − orphans).
 */
function collisionOf(rows, prefixes, records, mintedId) {
  const uploaded = rows.filter((r) => r.kind === "stale" && UPLOADED_STALE_RE.test(r.text ?? "")).map((r) => r.name);
  const early = rows.filter((r) => r.kind === "stale" && EARLY_STALE_RE.test(r.text ?? "")).map((r) => r.name);
  const orphans = prefixes.filter((p) => !records.includes(p));
  const collided = orphans.length === 0 ? uploaded.length : null;
  let text;
  if (uploaded.length === 0) text = `no loser uploaded anything (${early.length ? `${early.join(", ")} refused by update_document's own base check` : "none refused after an upload"}), so nothing collided on ${mintedId}`;
  else if (collided != null) text = `${uploaded.join(", ")} uploaded to ${mintedId} too (no version prefix without a record), so ${collided} upload(s) collided on ${mintedId}`;
  else text = `${uploaded.join(", ")} uploaded; ${orphans.join(", ")} hold a losing upload with no record, so at most ${Math.max(0, uploaded.length - orphans.length)} collided on ${mintedId}`;
  return { uploaded, early, orphans, collided, text };
}

/**
 * C9b S4b's start, shared with its serial control: p1 (the owner, alone)
 * edits, types a token and leaves the editor (Done saves the draft on v1),
 * and nobody is left in the editor; then N−1 agents of the owner.
 */
async function editedAndLeft(ctx, label, tag) {
  const s = await liveSession(ctx, label, { n: 1, enter: false });
  const [p1] = s.users;
  const log = tokenLog(target.runId);
  ctx.step(`${p1.name} edits alone, types a token and leaves the editor (Done saves it)`);
  await p1.enterEdit({ waitShared: true, timeout: 90_000 });
  await typeAndSettle(ctx, s, log);
  await p1.done({ timeout: 60_000 });
  await nobodyEditing(ctx, s.docId);
  precondition(await readDraftObject(target, s.docId, s.entry), "the editor's draft is saved");
  const agents = await agentsOf(ctx, s.owner, ctx.n - 1, tag);
  return { s, p1, key: s.docId, agents };
}

/**
 * The agents' update_document on v1, each held at update-before-id (past the
 * editors question): the first alone before the rest, so a count-1 release
 * lets the first go. Resolves the settled calls, in agent order.
 */
async function sendHeldUpdates(ctx, g, agents, docId, key) {
  const [a1, ...rest] = agents;
  ctx.step(`nobody is in the editor: ${a1.name} updates on v1 and is held at update-before-id, past the editors question`);
  const pending = [callUpdate(a1, docId)];
  await requireHeld(ctx, g, "update-before-id", 1, { key, timeoutMs: HELD_MS });
  if (rest.length) {
    ctx.step(`${rest.map((a) => a.name).join(", ")} update on v1: held there too`);
    pending.push(...rest.map((a) => callUpdate(a, docId)));
    await requireHeld(ctx, g, "update-before-id", agents.length, { key, timeoutMs: HELD_MS });
  }
  return pending;
}

/**
 * Let the first held update go alone (FIFO: it arrived first) and await its
 * call: it mints a version and drops the draft. One that did not succeed is
 * the product's answer to an update alone at the server: a FAIL (not
 * `defect`'s oracle).
 */
async function firstUpdateAlone(ctx, g, agent, call, defect = null) {
  ctx.step(`let ${agent.name} go alone: it chooses v2, uploads, makes it current and drops the draft`);
  await g.release("update-before-id", { count: 1 });
  const r = await call;
  if (!r.ok) throw r.error;
  if (r.value.kind !== "success") {
    const err = new Error(`${defect ? `not ${defect}'s oracle: ` : ""}the update let go alone did not succeed (${r.value.kind}: ${r.value.text ?? JSON.stringify(r.value.json)})`);
    err.code = "E2E_C08_OTHER_ORACLE";
    throw err;
  }
  ctx.step(`${agent.name} minted ${r.value.json?.versionId}`);
  return r.value;
}

/** The document's draft as the server holds it now: docs/{d}.draft and the objects under docs/{d}/draft/. */
async function captureRetiringDraft(s) {
  const d = await readDoc(target, `docs/${s.docId}`);
  precondition(d?.draft, "the draft selected for retirement exists before the write");
  s.retiringDraftPrefix = draftStoragePrefix(s.docId, d.draft);
  const objects = await listObjects(target, `${s.retiringDraftPrefix}/`);
  precondition(objects.length > 0, "the draft selected for retirement has concrete objects");
}
async function draftState(s) {
  const d = await readDoc(target, `docs/${s.docId}`);
  precondition(s.retiringDraftPrefix, "the retiring snapshot path was captured before its metadata was removed");
  return {
    currentVersion: d?.currentVersion ?? null,
    field: d?.draft ? { baseVersion: d.draft.baseVersion ?? null } : null,
    files: await listObjects(target, `${s.retiringDraftPrefix}/`),
    currentFiles: d?.draft ? await listObjects(target, `${draftStoragePrefix(s.docId, d.draft)}/`) : [],
  };
}

/**
 * C9b S4b's oracles, shared with its serial control, into `others` (and,
 * for the race, S4b's signature into `own`): p1's Save is told of the newer
 * version (POST /commit 409, a conflict toast) and publishes nothing; the
 * update let go first succeeded and every other is stale; the update, once
 * current, dropped the draft (SPEC §6a); I6 (one version on v1, via mcp);
 * I7 (it holds the first agent's bytes).
 */
async function judgeUpdateBeatsEditor(ctx, { s, saves, rows, agents, dropped, label, others, own = null }) {
  const [a1] = agents;
  if (own) await judgeToastsSplit(saves, `${label} toast`, { published: 0, others, own });
  else await others.check(() => judgeToasts(saves, `${label} toast`, { published: 0 }));
  await others.check(() => {
    const ok = judgeUpdates(rows, { label: `${label} updates` });
    assert.equal(ok[0]?.name, a1.name, `${label} updates: the update let go first (${a1.name}) is the one that succeeded`);
  });
  await others.check(() => {
    const failures = [];
    if (dropped.field) failures.push(`docs/${s.docId}.draft is still there (on ${dropped.field.baseVersion})`);
    if (dropped.files.length) failures.push(`docs/${s.docId}/draft/ still holds ${dropped.files.join(", ")}`);
    assert.ok(failures.length === 0, `${label}: the update, once current, dropped the draft (SPEC §6a) — ${failures.join("; ")}`);
  });
  let minted = null;
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "mcp" });
  });
  const known = Object.fromEntries(agents.map((a) => [a.name, Buffer.from(a.content, "utf8")]));
  if (minted) await others.check(() => judgeI7(ctx, s.owner.http, s.docId, minted.id, Buffer.from(a1.content, "utf8"), { winner: a1.name, known }));
}

// =====================================================================================
// C8 — N × Save as new version
// =====================================================================================

scenario("C8 N × Save as new version (SYNC-H): N editors' commits, held in their browsers and released together, mint exactly one version (I6) whose stored bytes are the draft they read (I7 REHASH); one \"Published\" toast and N−1 conflict toasts; and a draft saved on the new version afterwards survives", {
  tiers: BOTH,
  n: N,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const s = await liveSession(ctx, "C8 race");
  const log = tokenLog(target.runId);
  await typeAndSettle(ctx, s, log);
  const caps = captureSaves(s.users);
  const hold = holdRequests(s.users.map((u) => u.page), (url) => url.pathname === "/commit", ctx.n, { method: "POST", timeoutMs: 90_000 });
  await hold.installed;
  let released = null;
  let draft = null;
  let pending = [];
  try {
    ctx.step("every editor presses Save as new version; each page saves its draft, and its POST /commit is held in the browser");
    pending = s.users.map(pressSave);
    try {
      await hold.held;
    } catch (err) {
      if (err?.code === "E2E_SYNC_TIMEOUT") ctx.inconclusive(`the sync precondition did not hold: ${err.held}/${ctx.n} POST /commit held within 90 s`);
      throw err;
    }
    draft = await readDraftObject(target, s.docId, s.entry);
    precondition(draft, `the draft every commit is about to publish is in Storage (docs/${s.docId}/draft/${s.entry})`);
    released = await hold.release();
  } finally {
    if (!released) await hold.release().catch(() => hold.unroute());
  }
  const rows = await outcomesOf(ctx, s.users, pending, caps);
  ctx.ev.json("commit-wire", released.records);
  requireConclusive(ctx, { overlap: released.overlap });
  ctx.step(`all ${ctx.n} commits were on the wire before any answer began (margin ${Number(released.overlap.marginMs).toFixed(0)} ms)`);
  await settleServer(ctx, s.docId, "after the race");

  const others = oracleSet();
  let minted = null;
  await others.check(() => judgeToasts(rows, "C8 toasts"));
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "editor" });
  });
  if (minted) await others.check(() => judgeI7(ctx, s.owner.http, s.docId, minted.id, draft));
  if (minted) {
    const marker = `c08-fresh-${runTag(target.runId)}-${rand4()}`;
    await saveFreshDraft(ctx, s, minted.id, draft, marker);
    await settleServer(ctx, s.docId, "after the fresh draft");
    await others.check(() => judgeFreshDraft(s, minted.id, marker));
  }
  verdict({ others });
});

scenario("C8 S4b a late losing Save as new version (SYNC-P): commits held before they read the draft, the first published (deleting its draft), the losers let go to read it and held again while a fresh draft is saved on the new version; every loser is told of the newer version and the fresh draft survives", {
  tiers: LOCAL,
  needs: RACES,
  n: N,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await liveSession(ctx, "C8 S4b");
  const key = s.docId;
  const log = tokenLog(target.runId);
  await typeAndSettle(ctx, s, log);
  const [w, ...losers] = s.users;
  const caps = captureSaves(s.users);
  const marker = `c08-fresh-${runTag(target.runId)}-${rand4()}`;
  let draft = null;
  let won = null;
  let pending = [];
  const holds = s.users.map((u) => holdRequests(u.page, (url) => url.pathname === "/commit", 1, { method: "POST", timeoutMs: 90_000 }));
  try {
    await Promise.all(holds.map((hold) => hold.installed));
    await g.hold("commit-before-read", { key });
    ctx.step("every editor saves its draft, but each commit waits in its own browser until all saves finished");
    const wp = pressSave(w);
    const lp = losers.map(pressSave);
    pending = [wp, ...lp];
    await Promise.all(holds.map((hold) => hold.held));
    // Immutable snapshot CAS is about identity, even for identical HTML. Let
    // every commit read the same last saved snapshot before separating them.
    await holds[0].release();
    await requireHeld(ctx, g, "commit-before-read", 1, { key, timeoutMs: HELD_MS });
    await Promise.all(holds.slice(1).map((hold) => hold.release()));
    await requireHeld(ctx, g, "commit-before-read", ctx.n, { key, timeoutMs: HELD_MS });
    draft = await readDraftObject(target, s.docId, s.entry);
    precondition(draft, "the draft is in Storage while every commit is held");
    ctx.step(`let ${w.name}'s commit go alone (the first to arrive)`);
    await g.release("commit-before-read", { count: 1 });
    const wr = await wp;
    won = wr.ok ? wr.value : null;
    if (!won || won.outcome !== "published") {
      const err = new Error(`not S4b's oracle: the first commit, let go alone, did not publish (${wr.ok ? `${won.outcome} "${won.text}"` : wr.error?.message})`);
      err.code = "E2E_C08_OTHER_ORACLE";
      throw err;
    }
    ctx.step(`${w.name} published ${won.versionId}, deleting the draft; the losers are let go to read it and held at commit-after-read`);
    await g.hold("commit-after-read", { key });
    await g.release("commit-before-read");
    await requireHeld(ctx, g, "commit-after-read", ctx.n - 1, { key, timeoutMs: HELD_MS });
    await saveFreshDraft(ctx, s, won.versionId, draft, marker);
    ctx.step("let the losers go");
    await g.release("commit-after-read");
  } finally {
    await Promise.all(holds.map((hold) => hold.release().catch(() => hold.unroute())));
    await releaseAll(g, ["commit-before-read", "commit-after-read"]);
  }
  const rows = await outcomesOf(ctx, s.users, pending, caps);
  await settleServer(ctx, s.docId, "after the late losers");

  const others = oracleSet();
  const own = oracleSet();
  let minted = null;
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "editor" });
  });
  if (minted) await others.check(() => judgeI7(ctx, s.owner.http, s.docId, minted.id, draft));
  // S4b's own oracle is its prediction and nothing wider: a loser's "No
  // changes to publish" with a 200 deduped, and the fresh draft deleted.
  // Any other toast, and the fresh draft overwritten, are others' (FAIL).
  await judgeToastsSplit(rows, "C8 S4b toasts", { others, own });
  await judgeFreshDraftSplit(s, won.versionId, marker, { others, own });
  verdict({ others, own });
});

scenario("C8 divergent draft snapshots (SYNC-P): the first commit reads D1, later editors save newer snapshots, and every commit uploads before transactions run; D1 is refused with draftChanged and exactly one current snapshot is published with its own bytes (I7)", {
  tiers: LOCAL,
  needs: MINT_JOIN,
  n: N,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await liveSession(ctx, "C8 S4");
  const key = s.docId;
  const log = tokenLog(target.runId);
  await typeAndSettle(ctx, s, log);
  const [w, ...losers] = s.users;
  const caps = captureSaves(s.users);
  let d1 = null;
  let latest = null;
  let pending = [];
  const later = {};
  try {
    await g.hold("mint-before-id", { key });
    await g.hold("mint-after-upload", { key });
    ctx.step(`${w.name} presses Save: its commit reads draft D1 and is held at mint-before-id`);
    const wp = pressSave(w);
    await requireHeld(ctx, g, "mint-before-id", 1, { key, timeoutMs: HELD_MS });
    d1 = await readDraftObject(target, s.docId, s.entry);
    precondition(d1, "the draft the first commit read is in Storage");
    ctx.step(`${losers.map((u) => u.name).join(", ")} each type one more token and press Save: a later draft, held at mint-before-id too`);
    const lp = losers.map((u) => settled((async () => {
      // Its own autosave first, so no debounced save is still due once the commits are let go.
      const id = paragraph(s.users.indexOf(u));
      await u.typeAndAutosave(idSelector(id), log.next(u.name, id), { delay: KEY_DELAY_MS, timeout: HELD_MS });
      const r = await pressSave(u);
      if (!r.ok) throw r.error;
      return r.value;
    })()));
    pending = [wp, ...lp];
    await requireHeld(ctx, g, "mint-before-id", ctx.n, { key, timeoutMs: HELD_MS });
    for (const u of losers) later[u.name] = lastSavedHtml(caps.get(u.name));
    latest = await readDraftObject(target, s.docId, s.entry);
    precondition(latest && !latest.equals(d1), "the later draft snapshot differs from D1");
    ctx.step(`let ${w.name}'s commit choose its id and upload; it is held at mint-after-upload`);
    await g.release("mint-before-id", { count: 1 });
    await requireHeld(ctx, g, "mint-after-upload", 1, { key, timeoutMs: HELD_MS });
    ctx.step("let the losers choose theirs (the winner has no record yet) and upload");
    await g.release("mint-before-id");
    await requireHeld(ctx, g, "mint-after-upload", ctx.n, { key, timeoutMs: HELD_MS });
    ctx.step(`let ${w.name}'s transaction go first, then the losers'`);
    await g.release("mint-after-upload", { count: 1 });
    const wr = await wp;
    if (!wr.ok) throw wr.error;
    const first = await answersOf(caps.get(w.name));
    assert.ok(first.commit?.status === 409 && first.commit.json?.draftChanged === true,
      "C8 snapshot CAS: the first commit read D1 and must refuse after a newer draft replaced it");
    assert.notEqual(wr.value.outcome, "published", "the superseded draft is never announced as published");
    await g.release("mint-after-upload");
  } finally {
    await releaseAll(g, ["mint-before-id", "mint-after-upload"]);
  }
  const rows = await outcomesOf(ctx, s.users, pending, caps);
  const state = await settleServer(ctx, s.docId, "after the divergent commits");
  assert.deepEqual(state.orphanedObjects, [], "C8 cleanup: refused commit candidates leave no unreachable immutable bundles");

  const others = oracleSet();
  const own = oracleSet();
  let minted = null;
  await others.check(() => judgeToasts(rows, "C8 S4 toasts"));
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "editor" });
  });
  const known = { [w.name]: d1, ...Object.fromEntries(Object.entries(later).map(([k, v]) => [k, v == null ? null : Buffer.from(v, "utf8")])) };
  if (minted) await judgeI7Split(ctx, s.owner.http, s.docId, minted.id, latest, { winner: "the latest draft", known, others, own });
  verdict({ others, own });
});

scenario("C8 serial positive control: the same saves one after another — every other editor types, saves its draft on v1 and presses Save, the first then publishes, a fresh draft is saved on its version, and only then does each losing commit on v1 reach the server, in turn — mint one version (I6) with the first's bytes (I7), one \"Published\" toast and N−1 conflict toasts, and the fresh draft survives", {
  tiers: BOTH,
  n: N,
  trials: SERIAL_TRIALS,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const s = await liveSession(ctx, "C8 serial");
  const log = tokenLog(target.runId);
  await typeAndSettle(ctx, s, log);
  const [w, ...losers] = s.users;
  const caps = captureSaves(s.users);
  // An editor's base follows the current version (DocViewer's mode), so a
  // Save pressed after the first published would be a new edit on it, not
  // a loser. Each loser's POST /commit therefore waits in its own browser,
  // on v1 as in the race, and reaches the server only in its turn.
  const holds = new Map(losers.map((u) => [u.name, holdRequests(u.page, (url) => url.pathname === "/commit", 1, { method: "POST", timeoutMs: 90_000 })]));
  const released = new Set();
  const pending = new Map();
  const marker = `c08-fresh-${runTag(target.runId)}-${rand4()}`;
  let first = null;
  let winnerHtml = null;
  try {
    await Promise.all([...holds.values()].map((h) => h.installed));
    for (const u of losers) {
      ctx.step(`${u.name} types one more token, autosaves it on v1 and presses Save: its POST /commit waits in its browser`);
      const id = paragraph(s.users.indexOf(u));
      await u.typeAndAutosave(idSelector(id), log.next(u.name, id), { delay: KEY_DELAY_MS, timeout: 60_000 });
      pending.set(u.name, pressSave(u));
      try {
        await holds.get(u.name).held;
      } catch (err) {
        if (err?.code === "E2E_SYNC_TIMEOUT") ctx.inconclusive(`the sync precondition did not hold: ${u.name}'s POST /commit never reached its hold within 90 s`);
        throw err;
      }
    }
    ctx.step(`${w.name} presses Save; nothing else is in flight`);
    first = await pressSave(w);
    if (!first.ok) throw first.error;
    precondition(first.value.outcome === "published", `the first Save, alone at the server, published (${first.value.outcome} "${first.value.text}")`);
    winnerHtml = (await answersOf(caps.get(w.name))).draft?.html ?? null;
    precondition(winnerHtml, `${w.name}'s own draft save before its commit was captured`);
    await saveFreshDraft(ctx, s, first.value.versionId, Buffer.from(winnerHtml, "utf8"), marker);
    for (const u of losers) {
      ctx.step(`${u.name}'s commit on v1 reaches the server`);
      released.add(u.name);
      await holds.get(u.name).release();
      await pending.get(u.name);
    }
  } finally {
    for (const [name, h] of holds) if (!released.has(name)) await h.release().catch(() => h.unroute());
  }
  const rows = await outcomesOf(ctx, s.users, [Promise.resolve(first), ...losers.map((u) => pending.get(u.name))], caps);
  await settleServer(ctx, s.docId, "after the serial saves");

  const others = oracleSet();
  let minted = null;
  await others.check(() => judgeToasts(rows, "C8 serial toasts"));
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "editor" });
  });
  if (minted) await others.check(() => judgeI7(ctx, s.owner.http, s.docId, minted.id, Buffer.from(winnerHtml, "utf8")));
  await others.check(() => judgeFreshDraft(s, first.value.versionId, marker));
  verdict({ others });
});

// =====================================================================================
// C9 — N × update_document on the same base
// =====================================================================================

scenario("C9 N × update_document on the same base (SYNC-T): N agents' updates on v1 fired at one instant; exactly one succeeds and N−1 are refused as stale, one version is minted (I6), and its stored bytes are the winner's (I7 REHASH)", {
  tiers: BOTH,
  n: N,
  defect: C9_RACE_DEFECT,
  timeoutMs: MCP_CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const d = await ownedDoc(ctx, "C9 race");
  const agents = await agentsOf(ctx, d.owner, ctx.n, "c09");
  ctx.step(`${ctx.n} agent(s) (mcp tokens of the owner) update ${d.docId} on v1 at once, each with its own content; nobody is in the editor`);
  const { rows, run } = await fireUpdates(ctx, agents, d.docId, "C9 race");
  requireConclusive(ctx, { spread: run, overlap: run.overlap });
  const state = await settleServer(ctx, d.docId, "after the race");
  const records = state.versions.map((v) => v.split("<")[0]);
  const prefixes = [...new Set(state.objects.map((o) => o.split("/")[2]).filter((p) => /^v\d+$/.test(p)))].sort();
  const note = `C9 race N=${ctx.n} #${ctx.trial}: version prefixes in Storage ${prefixes.join(", ")} for records ${records.join(", ")} (a prefix with no record is a losing upload that chose a later id)`;
  ctx.step(note);
  ctx.t.diagnostic(note);

  const others = oracleSet();
  const own = oracleSet();
  let winners = [];
  let minted = null;
  let i7 = null;
  await others.check(() => {
    winners = judgeUpdates(rows, { label: "C9 outcomes" });
  });
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, d.docId, { via: "mcp" });
  });
  const w = winners.length === 1 ? agents.find((a) => a.name === winners[0].name) : null;
  if (minted && w) {
    const known = Object.fromEntries(agents.map((a) => [a.name, Buffer.from(a.content, "utf8")]));
    i7 = await judgeI7Split(ctx, d.owner.http, d.docId, minted.id, Buffer.from(w.content, "utf8"), { winner: w.name, known, others, own });
  }
  // One trial says S4 was seen or NOT REPRODUCED; summary.md reads the rate
  // over the K trials from the outcomes (S4 seen in s of K trials), and this
  // row keeps what each trial saw.
  const collision = minted ? collisionOf(rows, prefixes, records, minted.id) : null;
  const s4Seen = own.failed.length > 0;
  const judged = others.failed.length === 0 && i7 != null;
  measure(ctx, MEASURE, {
    scenario: "C9 race",
    judged,
    s4Seen,
    i7Held: i7 ? i7.r.ok : null,
    whose: i7?.whose ?? null,
    winner: w?.name ?? null,
    minted: minted?.id ?? null,
    prefixes,
    records,
    collision,
    outcomes: rows.map((r) => ({ name: r.name, kind: r.kind, uploaded: UPLOADED_STALE_RE.test(r.text ?? ""), early: EARLY_STALE_RE.test(r.text ?? "") })),
    othersFailed: others.failed.length,
  });
  ctx.step(`C9 race: S4 ${s4Seen ? "seen (a loser's bytes under the winner's record)" : judged ? "not seen" : "not judged (another oracle failed)"}; ${collision ? collision.text : "no version minted"}`);
  if (C9_RACE_DEFECT && judged && i7.r.ok) {
    ctx.notReproduced(`S4 was not reached in this trial of the natural race: ${minted.id}'s stored entry is the winner's (${w.name}'s) — ${collision.text}${collision.collided ? `, and the winner's upload ended after theirs` : ""}. S4 needs a losing upload to ${minted.id} to end after the winner's, so this is not evidence that S4 is fixed (C9 S4, SYNC-P, decides that); each trial is a row of ${MEASURE}.jsonl`);
  }
  verdict({ defect: C9_RACE_DEFECT, others, own });
});

scenario("C9 S4 (SYNC-P): N agents' updates on v1 held before they choose a version id, the first let go to upload and held before its transaction, the rest let go to choose the same id and upload over it; the version's stored bytes are the winner's (I7)", {
  tiers: LOCAL,
  needs: RACES,
  n: N,
  timeoutMs: MCP_CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const g = gates(ctx.target);
  const d = await ownedDoc(ctx, "C9 S4");
  const key = d.docId;
  const agents = await agentsOf(ctx, d.owner, ctx.n, "c09s4");
  const [w, ...rest] = agents;
  let pending = [];
  try {
    await g.hold("update-before-id", { key });
    await g.hold("update-after-upload", { key });
    ctx.step(`${w.name} updates on v1: held at update-before-id, past every refusal`);
    const wp = callUpdate(w, d.docId);
    await requireHeld(ctx, g, "update-before-id", 1, { key, timeoutMs: HELD_MS });
    ctx.step(`${rest.map((a) => a.name).join(", ")} update on v1: held there too`);
    pending = [wp, ...rest.map((a) => callUpdate(a, d.docId))];
    await requireHeld(ctx, g, "update-before-id", ctx.n, { key, timeoutMs: HELD_MS });
    ctx.step(`let ${w.name} choose its id and upload; held at update-after-upload`);
    await g.release("update-before-id", { count: 1 });
    await requireHeld(ctx, g, "update-after-upload", 1, { key, timeoutMs: HELD_MS });
    ctx.step("let the rest choose theirs (the winner has no record yet) and upload");
    await g.release("update-before-id");
    await requireHeld(ctx, g, "update-after-upload", ctx.n, { key, timeoutMs: HELD_MS });
    ctx.step(`let ${w.name}'s transaction go alone and await its call, then let the rest go`);
    await g.release("update-after-upload", { count: 1 });
    // The rest stay held until the first's call has answered: its
    // transaction ran first, whatever the stack's speed.
    const wr = await wp;
    if (!wr.ok) throw wr.error;
    if (wr.value.kind !== "success") {
      const err = new Error(`not S4's oracle: the update let go first, alone at its transaction, did not succeed (${wr.value.kind}: ${wr.value.text ?? JSON.stringify(wr.value.json)})`);
      err.code = "E2E_C08_OTHER_ORACLE";
      throw err;
    }
    ctx.step(`${w.name} made ${wr.value.json?.versionId} current; the rest commit now`);
    await g.release("update-after-upload");
  } finally {
    await releaseAll(g, ["update-before-id", "update-after-upload"]);
  }
  const rows = await updateRows(ctx, pending, "C9 S4");
  const state = await settleServer(ctx, d.docId, "after the held updates");
  assert.deepEqual(state.orphanedObjects, [], "C9 cleanup: refused update candidates leave no unreachable immutable bundles");

  const others = oracleSet();
  const own = oracleSet();
  let minted = null;
  await others.check(() => {
    const ok = judgeUpdates(rows, { label: "C9 S4 outcomes" });
    assert.equal(ok[0]?.name, w.name, `C9 S4 outcomes: the update let go first (${w.name}) is the one that succeeded`);
  });
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, d.docId, { via: "mcp" });
  });
  const known = Object.fromEntries(agents.map((a) => [a.name, Buffer.from(a.content, "utf8")]));
  if (minted) await judgeI7Split(ctx, d.owner.http, d.docId, minted.id, Buffer.from(w.content, "utf8"), { winner: w.name, known, others, own });
  verdict({ others, own });
});

scenario("C9 serial positive control: the same N updates on v1 one after another; exactly one succeeds and N−1 are refused as stale, one version is minted (I6), and its stored bytes are the first's (I7)", {
  tiers: BOTH,
  n: N,
  trials: SERIAL_TRIALS,
  timeoutMs: MCP_CASE_MS,
  inconclusiveOnStackTimeout: true,
}, async (ctx) => {
  const d = await ownedDoc(ctx, "C9 serial");
  const agents = await agentsOf(ctx, d.owner, ctx.n, "c09serial");
  const pending = [];
  for (const a of agents) {
    ctx.step(`${a.name} updates on v1`);
    const r = await callUpdate(a, d.docId);
    pending.push(Promise.resolve(r));
  }
  const rows = await updateRows(ctx, pending, "C9 serial");
  await settleServer(ctx, d.docId, "after the serial updates");

  const others = oracleSet();
  let minted = null;
  await others.check(() => {
    const ok = judgeUpdates(rows, { label: "C9 outcomes" });
    assert.equal(ok[0]?.name, agents[0].name, `C9 outcomes: the first update (${agents[0].name}) is the one that succeeded`);
  });
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, d.docId, { via: "mcp" });
  });
  const known = Object.fromEntries(agents.map((a) => [a.name, Buffer.from(a.content, "utf8")]));
  if (minted) await others.check(() => judgeI7(ctx, d.owner.http, d.docId, minted.id, Buffer.from(agents[0].content, "utf8"), { winner: agents[0].name, known }));
  verdict({ others });
});

// =====================================================================================
// C9b — update_document mixed with in-app commits
// =====================================================================================

scenario("C9b update_document mixed with in-app commits (SYNC-P): while ceil(N/2) editors' commits are in flight (held past the base check), the other agents' updates on v1 are refused for the editors, upload nothing and leave the draft and its live log alone; then the commits mint one version (I6) with the draft's bytes (I7), one \"Published\" toast and the rest conflict", {
  tiers: LOCAL,
  needs: MINT_JOIN,
  n: N,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const g = gates(ctx.target);
  const m = Math.ceil(ctx.n / 2);
  const k = ctx.n - m;
  const s = await liveSession(ctx, "C9b mixed", { n: m });
  const key = s.docId;
  const log = tokenLog(target.runId);
  await typeAndSettle(ctx, s, log);
  const agents = await agentsOf(ctx, s.owner, k, "c09b");
  const caps = captureSaves(s.users);
  let pending = [];
  let draft = null;
  let rows = null;
  let before = null;
  let during = null;
  try {
    await g.hold("mint-before-id", { key });
    ctx.step(`${s.users.map((u) => u.name).join(", ")} press Save: every commit is held at mint-before-id, in flight past its base check`);
    pending = s.users.map(pressSave);
    await requireHeld(ctx, g, "mint-before-id", m, { key, timeoutMs: HELD_MS });
    draft = await readDraftObject(target, s.docId, s.entry);
    precondition(draft, "the draft is in Storage while the commits are held");
    before = { snap: await serverSnapshot(s.docId), draftSha: sha(draft), y: Object.keys((await readLiveLogs(target, s.docId)) ?? {}).sort() };
    ctx.step(`while they are held, ${k} agent(s) update on v1 at once`);
    ({ rows } = await fireUpdates(ctx, agents, s.docId, "C9b updates"));
    const obj = await readDraftObject(target, s.docId, s.entry);
    during = {
      snap: await serverSnapshot(s.docId),
      draftSha: obj ? sha(obj) : "absent",
      y: Object.keys((await readLiveLogs(target, s.docId)) ?? {}).sort(),
      next: await listObjects(target, `docs/${s.docId}/v2/`),
      held: (await g.counts({ key }))["mint-before-id"]?.held ?? null,
    };
    ctx.ev.json("c9b-during", { before, during });
    ctx.step(`let the ${m} commit(s) go together`);
    await g.release("mint-before-id");
  } finally {
    await releaseAll(g, ["mint-before-id"]);
  }
  const saves = await outcomesOf(ctx, s.users, pending, caps);
  if (during.held !== m) ctx.inconclusive(`the sync precondition did not hold: ${during.held}/${m} commits were still held when the updates had been answered`);
  await settleServer(ctx, s.docId, "after the mixed race");

  const others = oracleSet();
  let minted = null;
  await others.check(() => judgeUpdates(rows, { winners: 0, refusal: "editors", label: "C9b updates under editors" }));
  await others.check(() => {
    const failures = [];
    if (during.next.length) failures.push(`objects under docs/${s.docId}/v2/ before any commit had chosen an id: ${during.next.join(", ")}`);
    if (JSON.stringify(during.snap.draft) !== JSON.stringify(before.snap.draft)) failures.push(`docs/${s.docId}.draft changed: ${JSON.stringify(before.snap.draft)} → ${JSON.stringify(during.snap.draft)}`);
    if (during.draftSha !== before.draftSha) failures.push(`the draft's entry changed (${short(before.draftSha)} → ${short(during.draftSha)})`);
    if (JSON.stringify(during.y) !== JSON.stringify(before.y)) failures.push(`status/${s.docId}/y changed (${before.y.length} → ${during.y.length} entries)`);
    assert.ok(failures.length === 0, `C9b: a refused update uploads nothing and leaves the draft and its live log alone (SPEC §6a) — ${failures.join("; ")}`);
  });
  await others.check(() => judgeToasts(saves, "C9b toasts"));
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "editor" });
  });
  if (minted) await others.check(() => judgeI7(ctx, s.owner.http, s.docId, minted.id, draft));
  verdict({ others });
});

scenario("C9b S4 across the two mint paths (SYNC-P): N−1 agents pass the editors question while nobody edits and are held before choosing an id; an editor then opens the editor and saves, uploading v2 and held before its transaction; the agents choose v2 too and upload over it; the editor's version's stored bytes are its own (I7)", {
  tiers: LOCAL,
  needs: [...MINT_JOIN, "patch:amplify-c08-mint-races"],
  n: N,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const g = gates(ctx.target);
  const s = await liveSession(ctx, "C9b S4", { n: 1, enter: false });
  const key = s.docId;
  const [p1] = s.users;
  const log = tokenLog(target.runId);
  ctx.step(`${p1.name} edits alone, types a token and leaves the editor (Done saves it)`);
  await p1.enterEdit({ waitShared: true, timeout: 90_000 });
  await typeAndSettle(ctx, s, log);
  await p1.done({ timeout: 60_000 });
  await nobodyEditing(ctx, s.docId);
  const draftBytes = await readDraftObject(target, s.docId, s.entry);
  precondition(draftBytes, "the editor's draft is saved");
  const agents = await agentsOf(ctx, s.owner, ctx.n - 1, "c09bs4");
  const caps = captureSaves(s.users);
  let pending = [];
  let save = null;
  let editorHtml = null;
  try {
    await g.hold("update-before-id", { key });
    await g.hold("update-after-upload", { key });
    await g.hold("mint-after-upload", { key });
    ctx.step(`nobody is in the editor: ${agents.map((a) => a.name).join(", ")} update on v1 and are held at update-before-id, past the editors question`);
    pending = agents.map((a) => callUpdate(a, s.docId));
    await requireHeld(ctx, g, "update-before-id", agents.length, { key, timeoutMs: HELD_MS });
    ctx.step(`${p1.name} opens the editor and presses Save: its commit uploads v2 and is held at mint-after-upload`);
    await p1.enterEdit({ waitShared: true, timeout: 30_000 });
    save = pressSave(p1);
    await requireHeld(ctx, g, "mint-after-upload", 1, { key, timeoutMs: HELD_MS });
    editorHtml = lastSavedHtml(caps.get(p1.name));
    ctx.step("let the agents choose their id (the editor's version has no record yet) and upload");
    await g.release("update-before-id");
    await requireHeld(ctx, g, "update-after-upload", agents.length, { key, timeoutMs: HELD_MS });
    ctx.step(`let ${p1.name}'s transaction go, then the agents'`);
    await g.release("mint-after-upload");
    const sr = await save;
    if (!sr.ok || sr.value.outcome !== "published") {
      const err = new Error(`not S4's oracle: the editor's commit did not publish (${sr.ok ? `${sr.value.outcome} "${sr.value.text}"` : sr.error?.message})`);
      err.code = "E2E_C08_OTHER_ORACLE";
      throw err;
    }
    await g.release("update-after-upload");
  } finally {
    await releaseAll(g, ["update-before-id", "update-after-upload", "mint-after-upload"]);
  }
  const saves = await outcomesOf(ctx, s.users, [save], caps);
  const rows = await updateRows(ctx, pending, "C9b S4");
  await settleServer(ctx, s.docId, "after the cross-path race");

  const winner = editorHtml != null ? Buffer.from(editorHtml, "utf8") : draftBytes;
  const others = oracleSet();
  const own = oracleSet();
  let minted = null;
  await others.check(() => judgeToasts(saves, "C9b S4 toast"));
  await others.check(() => judgeUpdates(rows, { winners: 0, refusal: "stale", label: "C9b S4 updates" }));
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "editor" });
  });
  const known = { [p1.name]: winner, ...Object.fromEntries(agents.map((a) => [a.name, Buffer.from(a.content, "utf8")])) };
  if (minted) await judgeI7Split(ctx, s.owner.http, s.docId, minted.id, winner, { winner: p1.name, known, others, own });
  verdict({ others, own });
});

scenario("C9b S4b across the two mint paths (SYNC-P): N−1 agents pass the editors question while nobody edits and are held before choosing an id; an editor then opens the editor and saves, and its commit passes the base check and is held before it reads the draft; the first agent mints a version and drops the draft; the editor's commit, let go, is told of the newer version (POST /commit 409, a conflict toast), never \"No changes to publish\"", {
  tiers: LOCAL,
  needs: RACES,
  n: N,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const g = gates(ctx.target);
  const { s, p1, key, agents } = await editedAndLeft(ctx, "C9b S4b", "c09bs4b");
  const [a1, ...rest] = agents;
  const caps = captureSaves(s.users);
  let pending = [];
  let save = null;
  let dropped = null;
  let read = null;
  try {
    await g.hold("update-before-id", { key });
    await g.hold("commit-before-read", { key });
    pending = await sendHeldUpdates(ctx, g, agents, s.docId, key);
    ctx.step(`${p1.name} opens the editor and presses Save: its commit passes POST /commit's base check (v1 is current) and is held at commit-before-read`);
    await p1.enterEdit({ waitShared: true, timeout: 30_000 });
    save = pressSave(p1);
    await requireHeld(ctx, g, "commit-before-read", 1, { key, timeoutMs: HELD_MS });
    await captureRetiringDraft(s);
    await firstUpdateAlone(ctx, g, a1, pending[0], "S4b");
    dropped = await draftState(s);
    ctx.step(`after the update: current ${dropped.currentVersion}; docs/${s.docId}.draft ${dropped.field ? `on ${dropped.field.baseVersion}` : "gone"}; ${dropped.files.length} object(s) under docs/${s.docId}/draft/`);
    ctx.step(`let ${p1.name}'s commit read the draft; held at commit-after-read`);
    await g.hold("commit-after-read", { key });
    await g.release("commit-before-read");
    await requireHeld(ctx, g, "commit-after-read", 1, { key, timeoutMs: HELD_MS });
    read = await draftState(s);
    ctx.step(`${p1.name}'s commit read its captured immutable snapshot after the update; a newer draft uses a separate prefix and cannot alter that read`);
    await g.release("commit-after-read");
    await save;
    if (rest.length) {
      ctx.step(`let ${rest.map((a) => a.name).join(", ")} go: each chooses v3 and is refused as stale`);
      await g.release("update-before-id");
    }
  } finally {
    await releaseAll(g, ["update-before-id", "commit-before-read", "commit-after-read"]);
  }
  const saves = await outcomesOf(ctx, s.users, [save], caps);
  const rows = await updateRows(ctx, pending, "C9b S4b");
  ctx.ev.json("c9b-s4b-draft", { dropped, read });
  await settleServer(ctx, s.docId, "after the update and the late commit");

  const others = oracleSet();
  const own = oracleSet();
  await judgeUpdateBeatsEditor(ctx, { s, saves, rows, agents, dropped, label: "C9b S4b", others, own });
  verdict({ others, own });
});

scenario("C9b S4b serial positive control: the same update and Save one after another — N−1 agents pass the editors question while nobody edits and are held; the editor opens the editor and presses Save, and its POST /commit waits in its own browser; the first agent mints alone, and only then does the editor's commit on v1 reach the server: 409 and a conflict toast, one update succeeds and the rest are stale, one version (I6) with the agent's bytes (I7)", {
  tiers: LOCAL,
  needs: RACES,
  n: N,
  trials: SERIAL_TRIALS,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const g = gates(ctx.target);
  const { s, p1, key, agents } = await editedAndLeft(ctx, "C9b S4b serial", "c09bs4bserial");
  const [a1, ...rest] = agents;
  const caps = captureSaves(s.users);
  const hold = holdRequests(p1.page, (url) => url.pathname === "/commit", 1, { method: "POST", timeoutMs: 90_000 });
  let released = false;
  let pending = [];
  let save = null;
  let dropped = null;
  try {
    await hold.installed;
    await g.hold("update-before-id", { key });
    pending = await sendHeldUpdates(ctx, g, agents, s.docId, key);
    ctx.step(`${p1.name} opens the editor and presses Save: its POST /commit (on v1) waits in its browser, before the server's base check`);
    await p1.enterEdit({ waitShared: true, timeout: 30_000 });
    save = pressSave(p1);
    try {
      await hold.held;
    } catch (err) {
      if (err?.code === "E2E_SYNC_TIMEOUT") ctx.inconclusive(`the sync precondition did not hold: ${p1.name}'s POST /commit never reached its hold within 90 s`);
      throw err;
    }
    await captureRetiringDraft(s);
    await firstUpdateAlone(ctx, g, a1, pending[0]);
    dropped = await draftState(s);
    ctx.step(`after the update: current ${dropped.currentVersion}; docs/${s.docId}.draft ${dropped.field ? `on ${dropped.field.baseVersion}` : "gone"}; ${dropped.files.length} object(s) under docs/${s.docId}/draft/`);
    ctx.step(`${p1.name}'s commit on v1 reaches the server`);
    released = true;
    await hold.release();
    await save;
    if (rest.length) {
      ctx.step(`let ${rest.map((a) => a.name).join(", ")} go: each chooses v3 and is refused as stale`);
      await g.release("update-before-id");
    }
  } finally {
    if (!released) await hold.release().catch(() => hold.unroute());
    await releaseAll(g, ["update-before-id"]);
  }
  const saves = await outcomesOf(ctx, s.users, [save], caps);
  const rows = await updateRows(ctx, pending, "C9b S4b serial");
  await settleServer(ctx, s.docId, "after the update and the commit");

  const others = oracleSet();
  await judgeUpdateBeatsEditor(ctx, { s, saves, rows, agents, dropped, label: "C9b S4b serial", others });
  verdict({ others });
});

scenario("C9b serial positive control: the editor edits and publishes first, then the N−1 agents update on v1 one after another; one \"Published\" toast, every update refused as stale, one version (I6) with the editor's bytes (I7)", {
  // One editor and the owner's own tokens: nothing is shared, so nothing is emailed.
  tiers: BOTH,
  n: N,
  trials: SERIAL_TRIALS,
  timeoutMs: APP_CASE_MS,
  ...LIVE,
}, async (ctx) => {
  const s = await liveSession(ctx, "C9b serial", { n: 1, enter: false });
  const [p1] = s.users;
  const log = tokenLog(target.runId);
  await p1.enterEdit({ waitShared: true, timeout: 90_000 });
  await typeAndSettle(ctx, s, log);
  const agents = await agentsOf(ctx, s.owner, ctx.n - 1, "c09bserial");
  const caps = captureSaves(s.users);
  ctx.step(`${p1.name} presses Save alone`);
  const save = await pressSave(p1);
  const saves = await outcomesOf(ctx, s.users, [Promise.resolve(save)], caps);
  const editorHtml = (await answersOf(caps.get(p1.name))).draft?.html ?? null;
  precondition(editorHtml, `${p1.name}'s own draft save before its commit was captured`);
  await nobodyEditing(ctx, s.docId);
  const pending = [];
  for (const a of agents) {
    ctx.step(`${a.name} updates on v1`);
    pending.push(Promise.resolve(await callUpdate(a, s.docId)));
  }
  const rows = await updateRows(ctx, pending, "C9b serial");
  await settleServer(ctx, s.docId, "after the serial mix");

  const others = oracleSet();
  let minted = null;
  await others.check(() => judgeToasts(saves, "C9b serial toast"));
  await others.check(() => judgeUpdates(rows, { winners: 0, refusal: "stale", label: "C9b serial updates" }));
  await others.check(async () => {
    minted = await judgeOneVersion(ctx, s.docId, { via: "editor" });
  });
  const known = { [p1.name]: Buffer.from(editorHtml, "utf8"), ...Object.fromEntries(agents.map((a) => [a.name, Buffer.from(a.content, "utf8")])) };
  if (minted) await others.check(() => judgeI7(ctx, s.owner.http, s.docId, minted.id, Buffer.from(editorHtml, "utf8"), { winner: p1.name, known }));
  verdict({ others });
});
