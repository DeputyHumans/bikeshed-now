// SPDX-License-Identifier: Apache-2.0
// Self-test: webThread, webReply and webResolve send the app's own comment writes, and fail when app/src/firestore.ts, its tokens or the rules move away from them (SPEC §4, §6).

/**
 * Two halves.
 *
 * WHAT IS SENT: clientFirestore over http.mjs with a fake fetch standing in
 * for the emulator. The expected Firestore writes are written out by hand
 * from app/src/firestore.ts and the web SDK's setDoc / updateDoc (see
 * firestore-set.test.mjs): createAnnotation and addComment are setDoc, the
 * whole document with NO precondition and createdAt a REQUEST_TIME
 * transform; setResolved is updateDoc, a mask of resolved and resolvedBy on a
 * document that must exist. Then ABORTED (retried, as the SDK does), a
 * refusal (thrown at once), and every malformed argument (nothing sent).
 *
 * DRIFT: this checkout's app/src/firestore.ts, app/src/brand/tokens.ts,
 * app/src/annotation/anchor.ts and firestore.rules are read, and the keys,
 * colour and write kind lib/web.mjs sends are compared with them; anchorIn's
 * quote context is compared with the app's own dom-anchor-text-quote. A
 * change to the app's write shape fails here, not silently in a spec.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { createHttp } from "../lib/http.mjs";
import { clientFirestore } from "../lib/firestore-client.mjs";
import { REPO_ROOT } from "../lib/paths.mjs";
import {
  ANCHOR_CONTEXT,
  ANCHOR_KEYS,
  ANNOTATION_COLOR,
  ANNOTATION_KEYS,
  COMMENT_KEYS,
  RESOLVE_KEYS,
  WEB_ABORT_RETRIES,
  anchorIn,
  annotationData,
  annotationPath,
  autoId,
  commentData,
  commentPath,
  resolveData,
  webActor,
  webAnnotationWrite,
  webReply,
  webResolve,
  webThread,
} from "../lib/web.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const PROJECT = "demo-web";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const LOCAL = Object.freeze({
  kind: "local",
  runId: "2610110840-webw",
  runDir: tempDir("e2e-webw-"),
  projectId: PROJECT,
  origin: "http://127.0.0.1:39031",
  firestoreUrl: "http://127.0.0.1:39033",
  stack: { ports: { hosting: 39031, auth: 39032, firestore: 39033 } },
});
const COMMIT = `${LOCAL.firestoreUrl}/v1/${ROOT}:commit`;
const DOC = "e2e-0webw-doc-abcd";

/** A viewer whose address has capitals: the app writes it lower-cased. */
const ACCT = Object.freeze({ role: "viewer", uid: "uid-V1", email: "Viewer-0webw-abcd@Example.com" });
const LOWER = "viewer-0webw-abcd@example.com";
const TEXT = "Paragraph 3. Amber basil cedar delta ember fable garnet harbor island juniper. Kestrel lantern meadow.";

const fsErr = (status, code, message = code) => ({ status, json: { error: { code: status, status: code, message } } });
const ABORTED = fsErr(409, "ABORTED", "Transaction lock timeout");
const DENIED = fsErr(403, "PERMISSION_DENIED", "Missing or insufficient permissions.");
const NOT_FOUND = { status: 404, json: { error: { code: 404, status: "NOT_FOUND", message: "no document" } } };
const FOUND = (name) => ({ status: 200, json: { name, fields: {}, createTime: "2026-10-11T08:40:00Z", updateTime: "2026-10-11T08:40:00Z" } });

/** The emulator: each request takes the next scripted answer, else a commit succeeds and a read finds nothing. */
function server(...script) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url: String(url), method: init.method, headers: { ...init.headers }, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const next = script.shift();
    const { status, json } = typeof next === "function" ? next(call) : next ?? (call.method === "GET" ? NOT_FOUND : { status: 200, json: { writeResults: [{}], commitTime: "2026-10-11T08:40:00Z" } });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch, fs: clientFirestore(LOCAL, { idToken: "tok-viewer", http: createHttp(LOCAL, { evidence: false, fetch }) }) };
}

const s = (v) => ({ stringValue: v });
const i = (n) => ({ integerValue: String(n) });
const map = (fields) => ({ mapValue: { fields } });
const actorValue = map({ uid: s("uid-V1"), email: s(LOWER), channel: s("web") });
const CREATED_AT = [{ fieldPath: "createdAt", setToServerValue: "REQUEST_TIME" }];
const AUTO = /^[A-Za-z0-9]{20}$/;

// --- What is sent -----------------------------------------------------------------

test("webThread: createAnnotation then addComment, each setDoc's write (no precondition, no mask, createdAt the server's), email lower-cased", async () => {
  const srv = server();
  const anchor = anchorIn(TEXT, "e2e-3", "Amber basil cedar");
  const t = await webThread(srv.fs, ACCT, { docId: DOC, versionId: "v1", anchor, body: "first words" });
  assert.match(t.annId, AUTO);
  assert.match(t.commentId, AUTO);
  assert.deepEqual(t.anchor, anchor);
  assert.equal(t.path, `docs/${DOC}/versions/v1/annotations/${t.annId}`);
  assert.deepEqual(srv.calls.map((c) => [c.method, c.url, c.headers.authorization]), [["POST", COMMIT, "Bearer tok-viewer"], ["POST", COMMIT, "Bearer tok-viewer"]]);

  const annName = `${ROOT}/docs/${DOC}/versions/v1/annotations/${t.annId}`;
  assert.deepEqual(srv.calls[0].body, {
    writes: [{
      update: {
        name: annName,
        fields: {
          annId: s(t.annId),
          anchor: map({ elementId: s("e2e-3"), exact: s("Amber basil cedar"), prefix: s("Paragraph 3. "), suffix: s(" delta ember fable garnet harbor"), start: i(13), end: i(30) }),
          authorUid: s("uid-V1"),
          authorEmail: s(LOWER),
          actor: actorValue,
          color: s("#b5257b"),
          resolved: { booleanValue: false },
        },
      },
      updateTransforms: CREATED_AT,
    }],
  }, "createAnnotation as the SDK's setDoc sends it");
  assert.deepEqual(srv.calls[1].body, {
    writes: [{
      update: { name: `${annName}/comments/${t.commentId}`, fields: { commentId: s(t.commentId), body: s("first words"), authorUid: s("uid-V1"), authorEmail: s(LOWER), actor: actorValue } },
      updateTransforms: CREATED_AT,
    }],
  }, "addComment as the SDK's setDoc sends it");
  assert.deepEqual([...Object.keys(srv.calls[0].body.writes[0].update.fields), "createdAt"], [...ANNOTATION_KEYS]);
  assert.deepEqual([...Object.keys(srv.calls[1].body.writes[0].update.fields), "createdAt"], [...COMMENT_KEYS]);

  const chosen = server();
  const c = await webThread(chosen.fs, { uid: "uid-V1", account: { email: ACCT.email } }, { docId: DOC, versionId: "v2", anchor, body: "", annId: "e2e-1-salt", commentId: "e2e-1-c" });
  assert.deepEqual([c.annId, c.commentId], ["e2e-1-salt", "e2e-1-c"], "the case's own ids, and a session as the author");
  assert.equal(chosen.calls[1].body.writes[0].update.name, `${ROOT}/docs/${DOC}/versions/v2/annotations/e2e-1-salt/comments/e2e-1-c`);
  assert.deepEqual(chosen.calls[1].body.writes[0].update.fields.authorEmail, s(LOWER));
});

test("webReply: addComment on an existing thread; webResolve: updateDoc of resolved and resolvedBy on a document that must exist", async () => {
  const srv = server();
  const r = await webReply(srv.fs, ACCT, { docId: DOC, versionId: "v1", annId: "ann1", body: "and again" });
  assert.match(r.commentId, AUTO);
  assert.equal(r.path, commentPath(DOC, "v1", "ann1", r.commentId));
  assert.deepEqual(srv.calls[0].body.writes[0], {
    update: { name: `${ROOT}/docs/${DOC}/versions/v1/annotations/ann1/comments/${r.commentId}`, fields: { commentId: s(r.commentId), body: s("and again"), authorUid: s("uid-V1"), authorEmail: s(LOWER), actor: actorValue } },
    updateTransforms: CREATED_AT,
  });

  const done = await webResolve(srv.fs, ACCT, { docId: DOC, versionId: "v1", annId: "ann1" });
  assert.deepEqual(done, { resolved: true, resolvedBy: { uid: "uid-V1", email: LOWER, channel: "web" }, path: annotationPath(DOC, "v1", "ann1") });
  assert.deepEqual(srv.calls[1].body.writes[0], {
    update: { name: `${ROOT}/docs/${DOC}/versions/v1/annotations/ann1`, fields: { resolved: { booleanValue: true }, resolvedBy: actorValue } },
    updateMask: { fieldPaths: [...RESOLVE_KEYS] },
    currentDocument: { exists: true },
  }, "setResolved as the SDK's updateDoc sends it");
  await webResolve(srv.fs, ACCT, { docId: DOC, versionId: "v1", annId: "ann1", resolved: false });
  assert.deepEqual(srv.calls[2].body.writes[0].update.fields.resolved, { booleanValue: false }, "reopen");
  assert.equal(srv.calls.length, 3);
});

test("webAnnotationWrite: createAnnotation's write for a batch, the very write webThread sends", async () => {
  const srv = server();
  const anchor = anchorIn(TEXT, "e2e-3", "Kestrel lantern");
  const w = webAnnotationWrite(srv.fs, ACCT, { docId: DOC, versionId: "v1", anchor, annId: "batch0000000000000001" });
  assert.equal(srv.calls.length, 0, "nothing is sent");
  assert.deepEqual(w.data, annotationData(ACCT, { annId: "batch0000000000000001", anchor }));
  await webThread(srv.fs, ACCT, { docId: DOC, versionId: "v1", anchor, body: "x", annId: "batch0000000000000001" });
  assert.deepEqual(w.write, srv.calls[0].body.writes[0]);
  assert.equal(w.path, annotationPath(DOC, "v1", "batch0000000000000001"));
  assert.match(webAnnotationWrite(srv.fs, ACCT, { docId: DOC, versionId: "v1", anchor }).annId, AUTO, "an auto-id by default");
});

test("anchorIn: the app's Anchor for a selection, its quote context the app's own dom-anchor-text-quote's", async (t) => {
  const a = anchorIn(TEXT, "e2e-3", "harbor island");
  assert.deepEqual(Object.keys(a), [...ANCHOR_KEYS]);
  assert.equal(TEXT.slice(a.start, a.end), "harbor island");
  assert.equal(a.prefix, TEXT.slice(a.start - ANCHOR_CONTEXT, a.start));
  assert.deepEqual(anchorIn("short text", "", "short"), { elementId: "", exact: "short", prefix: "", suffix: " text", start: 0, end: 5 });
  assert.deepEqual(anchorIn("a b a b", "x", "a b", { at: 4 }), { elementId: "x", exact: "a b", prefix: "a b ", suffix: "", start: 4, end: 7 });
  assert.throws(() => anchorIn("a b a b", "x", "a b"), /occurs more than once in #x's text; pass \{at: <its start>\}/);
  assert.throws(() => anchorIn("aaa", "x", "aa"), /occurs more than once/, "an overlapping second occurrence counts");
  assert.throws(() => anchorIn(TEXT, "e2e-3", "not here"), /"not here" is not in #e2e-3's text/);
  assert.throws(() => anchorIn(TEXT, "e2e-3", "Amber", { at: 1 }), /"Amber" is not at 1/);
  assert.throws(() => anchorIn(TEXT, "e2e-3", ""), /exact is the selected text/);
  assert.throws(() => anchorIn(undefined, "e2e-3", "Amber"), /text is the element's textContent/);

  const lib = join(REPO_ROOT, "app", "node_modules", "dom-anchor-text-quote");
  if (!existsSync(lib)) return t.skip("app/node_modules is not installed (npm run install:all): the quote context is checked against the app's own library only when it is");
  const textQuote = createRequire(join(REPO_ROOT, "app", "package.json"))("dom-anchor-text-quote");
  const long = `${"x".repeat(50)} the quoted words ${"y".repeat(50)}`;
  for (const [text, exact] of [[TEXT, "Amber basil cedar"], [TEXT, "Kestrel lantern meadow."], [TEXT, "Paragraph 3."], [long, "the quoted words"]]) {
    const mine = anchorIn(text, "e2e-3", exact);
    const theirs = textQuote.fromTextPosition({ textContent: text }, { start: mine.start, end: mine.end });
    assert.deepEqual({ exact: mine.exact, prefix: mine.prefix, suffix: mine.suffix }, theirs, `"${exact}": the app's quote of the same position`);
  }
});

test("ABORTED is retried as the SDK retries it; a creation that landed anyway is not written again", async () => {
  const anchor = anchorIn(TEXT, "e2e-3", "Amber basil cedar");
  const retried = server(ABORTED, NOT_FOUND);
  await webThread(retried.fs, ACCT, { docId: DOC, versionId: "v1", anchor, body: "x", annId: "abortedOnce" });
  assert.deepEqual(retried.calls.map((c) => c.method), ["POST", "GET", "POST", "POST"], "the annotation: refused, read back (absent), sent again; then the comment");
  assert.equal(retried.calls[1].url, `${LOCAL.firestoreUrl}/v1/${ROOT}/docs/${DOC}/versions/v1/annotations/abortedOnce`);
  assert.deepEqual(retried.calls[2].body, retried.calls[0].body, "the same write");

  const landed = server(ABORTED, (c) => FOUND(c.url.slice(c.url.indexOf("projects/"))));
  await webThread(landed.fs, ACCT, { docId: DOC, versionId: "v1", anchor, body: "x", annId: "landedAnyway" });
  assert.deepEqual(landed.calls.map((c) => c.method), ["POST", "GET", "POST"], "found on read-back: the comment comes next");

  const resolve = server(ABORTED);
  await webResolve(resolve.fs, ACCT, { docId: DOC, versionId: "v1", annId: "a1" });
  assert.deepEqual(resolve.calls.map((c) => c.method), ["POST", "POST"], "an update is idempotent: sent again without a read");

  const stuck = server(ABORTED, NOT_FOUND, ABORTED);
  await assert.rejects(webReply(stuck.fs, ACCT, { docId: DOC, versionId: "v1", annId: "a1", body: "x", abortRetries: 1 }), (err) => {
    assert.equal(err.code, "E2E_WEB_WRITE");
    assert.match(err.message, /^addComment docs\/e2e-0webw-doc-abcd\/versions\/v1\/annotations\/a1\/comments\/[A-Za-z0-9]{20} as viewer-0webw-abcd@example\.com: 409 ABORTED Transaction lock timeout \(after 2 attempts\)$/);
    assert.equal(err.result.code, "ABORTED");
    return true;
  });
  assert.equal(stuck.calls.length, 3);
  assert.equal(WEB_ABORT_RETRIES, 5);
});

test("NEGATIVE: a refusal throws E2E_WEB_WRITE at once, never retried, and a thread whose annotation is refused writes no comment", async () => {
  const srv = server(DENIED);
  await assert.rejects(webThread(srv.fs, ACCT, { docId: DOC, versionId: "v1", anchor: anchorIn(TEXT, "e2e-3", "Amber"), body: "x" }), (err) => {
    assert.equal(err.code, "E2E_WEB_WRITE");
    assert.match(err.message, /^createAnnotation docs\/e2e-0webw-doc-abcd\/versions\/v1\/annotations\/[A-Za-z0-9]{20} as viewer-0webw-abcd@example\.com: 403 PERMISSION_DENIED Missing or insufficient permissions\.$/);
    assert.equal(err.result.verdict, "DENY");
    return true;
  });
  assert.equal(srv.calls.length, 1);
  const gone = server(NOT_FOUND);
  await assert.rejects(webResolve(gone.fs, ACCT, { docId: DOC, versionId: "v1", annId: "missing" }), /setResolved\(true\) .* 404 NOT_FOUND/);
  assert.equal(gone.calls.length, 1);
});

test("NEGATIVE: a malformed argument throws before anything is sent", async () => {
  const anchor = anchorIn(TEXT, "e2e-3", "Amber");
  const base = { docId: DOC, versionId: "v1", anchor, body: "x" };
  const cases = [
    [{ ...base, version: "v1" }, /unknown option "version" \("version" is versionId\)/],
    [{ ...base, versionId: "1" }, /versionId is a version id/],
    [{ ...base, versionId: undefined }, /versionId is a version id/],
    [{ ...base, docId: "docs/x" }, /docId is a document id/],
    [{ ...base, anchor: { ...anchor, strict: true } }, /extra \[strict\] \(strict marks an agent's server-anchored comment/],
    [{ ...base, anchor: { elementId: "e2e-3", exact: "Amber", start: 13, end: 18 } }, /missing \[prefix, suffix\]/],
    [{ ...base, anchor: { ...anchor, end: anchor.end + 1 } }, /bound the quote in the element's text/],
    [{ ...base, anchor: undefined }, /anchor is the app's Anchor/],
    [{ ...base, body: undefined }, /body is a string/],
    [{ ...base, annId: "a/b" }, /annId is a Firestore document id/],
    [{ ...base, commentId: "" }, /commentId is a Firestore document id/],
    [{ ...base, abortRetries: -1 }, /abortRetries is a whole number/],
  ];
  for (const [o, re] of cases) {
    const srv = server();
    await assert.rejects(webThread(srv.fs, ACCT, o), re, JSON.stringify(o));
    assert.equal(srv.calls.length, 0, `nothing sent for ${JSON.stringify(o)}`);
  }
  const srv = server();
  await assert.rejects(webThread(srv.fs, { email: ACCT.email }, base), /acct is an account \(\{uid, email\}, from cast\(\)\) or a session/);
  await assert.rejects(webThread({ create() {} }, ACCT, base), /fs is a clientFirestore/);
  await assert.rejects(webResolve(srv.fs, ACCT, { docId: DOC, versionId: "v1", annId: "a1", resolved: "yes" }), /resolved is true or false/);
  await assert.rejects(webReply(srv.fs, ACCT, { docId: DOC, versionId: "v1", body: "x" }), /annId is a Firestore document id/);
  assert.throws(() => webAnnotationWrite(srv.fs, ACCT, { ...base }), /unknown option "body"/);
  assert.equal(srv.calls.length, 0);
});

test("autoId: 20 characters of the SDK's 62, every one of them drawn", () => {
  const ids = Array.from({ length: 2_000 }, autoId);
  assert.ok(ids.every((id) => AUTO.test(id)));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(ids.join("")).size, 62);
});

// --- Drift: the app's own source ------------------------------------------------------

const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** The body of `export [async] function name(` up to its closing brace at column 0. */
function fnBody(src, name, where) {
  const m = new RegExp(`^export (?:async )?function ${name}\\(`, "m").exec(src);
  assert.ok(m, `${where} has no exported function ${name}`);
  const end = src.indexOf("\n}\n", m.index);
  assert.ok(end > m.index, `${where}: ${name} has no closing brace at column 0`);
  return src.slice(m.index, end);
}

/** An object literal's top-level entries: [[key, value text]], shorthand as [key, key]. Commas inside (), [], {} or a string do not split. */
function entries(literal, where) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (const ch of literal) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth += 1;
    else if (")]}".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  assert.ok(depth === 0 && quote === null, `${where}: unbalanced object literal`);
  return parts
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const m = /^([A-Za-z_$][\w$]*)\s*(?::\s*([\s\S]+))?$/.exec(e);
      assert.ok(m, `${where}: cannot read the entry ${JSON.stringify(e)}`);
      return [m[1], (m[2] ?? m[1]).replace(/\s+/g, " ").trim()];
    });
}

test("DRIFT: createAnnotation, addComment and setResolved in app/src/firestore.ts write exactly what lib/web.mjs sends", () => {
  const where = "app/src/firestore.ts";
  const src = read(where);

  const create = fnBody(src, "createAnnotation", where);
  const ann = /await setDoc\(ref, \{([\s\S]*?)\}\);/.exec(create);
  assert.ok(ann, `${where}: createAnnotation no longer writes with setDoc(ref, {…}): lib/web.mjs sends setDoc's write`);
  const annEntries = entries(ann[1], "createAnnotation");
  assert.deepEqual(annEntries.map(([k]) => k), [...ANNOTATION_KEYS], "createAnnotation's keys");
  assert.deepEqual(Object.fromEntries(annEntries.filter(([k]) => ["authorEmail", "actor", "color", "resolved", "createdAt"].includes(k))), {
    authorEmail: "emailLower",
    actor: "webActor(authorUid, emailLower)",
    color: "TOKENS.annotation",
    resolved: "false",
    createdAt: "serverTimestamp()",
  }, "createAnnotation's values");
  assert.match(create, /const emailLower = authorEmail\.toLowerCase\(\);/, "createAnnotation lower-cases the address");
  assert.match(create, /doc\(\s*collection\(db, "docs", docId, "versions", versionId, "annotations"\),?\s*\)/, "an auto-id under the version's annotations");

  const add = fnBody(src, "addComment", where);
  const com = /await setDoc\(ref, \{([\s\S]*?)\}\);/.exec(add);
  assert.ok(com, `${where}: addComment no longer writes with setDoc(ref, {…})`);
  const comEntries = entries(com[1], "addComment");
  assert.deepEqual(comEntries.map(([k]) => k), [...COMMENT_KEYS], "addComment's keys");
  assert.deepEqual(Object.fromEntries(comEntries.filter(([k]) => ["authorEmail", "actor", "createdAt"].includes(k))), { authorEmail: "emailLower", actor: "webActor(authorUid, emailLower)", createdAt: "serverTimestamp()" });
  assert.match(add, /const emailLower = authorEmail\.toLowerCase\(\);/);

  const resolve = fnBody(src, "setResolved", where);
  const upd = /await updateDoc\(\s*doc\(db, "docs", docId, "versions", versionId, "annotations", annId\),\s*\{([^}]*)\},?\s*\);/.exec(resolve);
  assert.ok(upd, `${where}: setResolved no longer is updateDoc(doc(…annotations, annId), {…})`);
  assert.deepEqual(entries(upd[1], "setResolved"), [["resolved", "resolved"], ["resolvedBy", "webActor(uid, emailLower.toLowerCase())"]]);

  const actor = /function webActor\(uid: string, emailLower: string\): Actor \{\s*return (\{[^}]*\});\s*\}/.exec(src);
  assert.ok(actor, `${where}: webActor changed shape`);
  assert.equal(actor[1].replace(/\s+/g, " "), '{ uid, email: emailLower, channel: "web" }');
  assert.deepEqual(webActor(ACCT), { uid: "uid-V1", email: LOWER, channel: "web" });
  assert.deepEqual(resolveData(ACCT, true), { resolved: true, resolvedBy: { uid: "uid-V1", email: LOWER, channel: "web" } });
  assert.deepEqual(Object.keys(commentData(ACCT, { commentId: "c", body: "b" })), COMMENT_KEYS.filter((k) => k !== "createdAt"));
});

test("DRIFT: the colour, the anchor and the rules' key lists are the ones lib/web.mjs writes", () => {
  const tokens = /^\s*annotation:\s*"(#[0-9a-fA-F]{6})",$/m.exec(read("app/src/brand/tokens.ts"));
  assert.ok(tokens, "app/src/brand/tokens.ts has no annotation token");
  assert.equal(ANNOTATION_COLOR, tokens[1], "TOKENS.annotation");

  const anchor = fnBody(read("app/src/annotation/anchor.ts"), "describeAnchorFromRange", "app/src/annotation/anchor.ts");
  const ret = /return \{([^}]*)\};/.exec(anchor);
  assert.ok(ret, "describeAnchorFromRange no longer returns an object literal");
  assert.deepEqual(entries(ret[1], "describeAnchorFromRange").map(([k]) => k), [...ANCHOR_KEYS], "the Anchor the app writes");

  const rules = read("firestore.rules");
  const lists = [...rules.matchAll(/isExactly\(\[([^\]]*)\]\)/g)].map((m) => m[1].split(",").map((k) => k.trim().replace(/^'|'$/g, "")));
  assert.ok(lists.some((l) => l.join() === ANNOTATION_KEYS.join()), `firestore.rules: no isExactly list is the annotation's ${ANNOTATION_KEYS.join(", ")} (found ${lists.map((l) => l.join(" ")).join(" | ")})`);
  assert.ok(lists.some((l) => l.join() === COMMENT_KEYS.join()), "firestore.rules: no isExactly list is the comment's");
  assert.match(rules, /affectedKeys\(\)\.hasOnly\(\['resolved', 'resolvedBy'\]\)/, "a reader may change only resolved and resolvedBy");
});
